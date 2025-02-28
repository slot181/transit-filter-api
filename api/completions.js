// completions.js

const axios = require('axios');
const { config, ErrorTypes, ErrorCodes, handleError, checkCircuitBreaker, recordServiceFailure, globalRequestCounter } = require('./config.js');
const rateLimitMiddleware = require('../utils/rateLimitMiddleware');

// 用于审核服务错误监控的函数
function logModerationServiceError(error, modelName = 'unknown') {
  const timestamp = new Date().toISOString();
  const errorId = `moderr_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  
  console.error(`[${errorId}][${timestamp}] 审核服务错误:`);
  console.error(`- 模型: ${modelName}`);
  console.error(`- 错误消息: ${error.message || 'No message'}`);
  console.error(`- 错误类型: ${error.error?.type || 'Unknown type'}`);
  console.error(`- 状态码: ${error.response?.status || 'No status'}`);
  console.error(`- 熔断状态: ${config.serviceHealth.firstProvider.circuitBreakerTripped ? '已触发' : '未触发'}`);
  
  if (config.serviceHealth.firstProvider.circuitBreakerTripped) {
    console.error(`- 熔断重置时间: ${new Date(config.serviceHealth.firstProvider.circuitBreakerResetTime).toISOString()}`);
  }
  
  return errorId;
}

// 用于负载均衡的模型索引计数器
let moderationModelIndex = 0;

// 负载均衡选择模型的函数
function selectModerationModel(strategy = 'round-robin') {
  const models = config.firstProvider.models;

  // 如果没有配置模型，返回错误
  if (!models || models.length === 0) {
    const error = new Error("未配置审核模型，请设置 FIRST_PROVIDER_MODELS 环境变量");
    error.nonRetryable = true; // 标记为不可重试错误
    throw error;
  }

  // 如果只有一个模型，直接返回
  if (models.length === 1) {
    return models[0];
  }

  // 根据策略选择模型
  let selectedModel;
  
  switch (strategy) {
    case 'random':
      // 随机选择一个模型
      const randomIndex = Math.floor(Math.random() * models.length);
      selectedModel = models[randomIndex];
      break;

    case 'round-robin':
    default:
      // 轮询选择模型
      selectedModel = models[moderationModelIndex];
      moderationModelIndex = (moderationModelIndex + 1) % models.length;
      break;
  }
  
  // 验证选定的模型是否为空
  if (!selectedModel || selectedModel.trim() === '') {
    const error = new Error("选择的审核模型无效");
    error.nonRetryable = true;
    throw error;
  }
  
  return selectedModel;
}

// 在文件顶部添加日志工具函数
function logModerationResult(model, request, response, result, isViolation) {
  const timestamp = new Date().toISOString();
  const logId = `mod_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

  // 提取用户消息内容用于日志记录
  const userMessages = request.messages
    .filter(msg => msg.role === 'user')
    .map(msg => typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content))
    .join('\n---\n');

  // 构建详细的日志对象
  const logData = {
    id: logId,
    timestamp,
    model,
    request: {
      temperature: request.temperature,
      max_tokens: request.max_tokens,
      // 只记录用户消息，避免系统提示过长
      userMessages: userMessages.length > 500 ? userMessages.substring(0, 500) + '...' : userMessages,
      // 记录所有原始消息，包括角色信息
      originalMessages: request.messages.map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' && msg.content.length > 100
          ? msg.content.substring(0, 100) + '...'
          : msg.content
      }))
    },
    response: {
      raw: response ? response.data : null,
      parsed: result
    },
    result: {
      isViolation,
      riskLevel: result?.riskLevel || 0
    }
  };

  // 使用不同的日志级别区分违规和非违规内容
  if (isViolation) {
    console.warn(`[CONTENT-VIOLATION][${logId}] 内容违规，风险等级: ${result?.riskLevel || 'unknown'}`);
    console.warn(JSON.stringify(logData, null, 2));
  } else {
    console.log(`[CONTENT-PASS][${logId}] 内容审核通过，风险等级: ${result?.riskLevel || 'unknown'}`);
    console.log(JSON.stringify(logData, null, 2));
  }

  return logId;
}

// 添加重试函数
async function retryRequest(requestFn, maxTime, fnName = "未知函数") {
  // 强制检查重试功能是否启用
  if (config.timeouts.enableRetry !== true) {
    console.log(`[${fnName}] 重试功能已禁用，直接执行请求`);
    try {
      return await requestFn();
    } catch (error) {
      console.log(`[${fnName}] 请求失败，不重试`);
      error.nonRetryable = true; // 标记为不可重试
      throw error;
    }
  }

  const startTime = Date.now();
  let retryCount = 0;
  let lastError = null;

  const tryRequest = async () => {
    try {
      return await requestFn();
    } catch (error) {
      retryCount++;
      lastError = error;

      console.log(`[${fnName}] 请求失败 (第${retryCount}次尝试) 时间：${new Date().toISOString()}:`);

      // 检查是否是标记为不需要重试的错误或状态码表明不需要重试
      const nonRetryableStatuses = [400, 401, 403, 404, 422];
      if (error.nonRetryable || (error.response && nonRetryableStatuses.includes(error.response.status))) {
        console.log(`[${fnName}] 检测到不可重试的错误，停止重试`);
        // 保留完整的错误信息
        throw error;
      }

      throw error;
    }
  };

  while (true) {
    try {
      return await tryRequest();
    } catch (error) {
      const elapsedTime = Date.now() - startTime;
      
      const nextRetryTime = elapsedTime + config.timeouts.retryDelay;

      if (nextRetryTime >= maxTime || retryCount >= config.timeouts.maxRetryCount) {
        const retryType = nextRetryTime >= maxTime ? 'time limit' : 'count limit';
        const retryValue = nextRetryTime >= maxTime ? maxTime + 'ms' : config.timeouts.maxRetryCount;
        console.log(`[${fnName}] 已达到最大${retryType}重试次数 (${retryValue})`);

        // 确保错误对象包含完整的响应数据，但不添加isRetryTimeout标记
        if (lastError && lastError.response && !error.response) {
          error.response = lastError.response;
        }
        if (lastError && lastError.originalResponse && !error.originalResponse) {
          error.originalResponse = lastError.originalResponse;
        }

        throw error;
      }

      // 使用指数退避策略增加重试延迟时间
      const actualRetryDelay = Math.min(
        config.timeouts.retryDelay * Math.pow(1.5, retryCount - 1),
        10000 // 最大10秒
      );
      
      console.log(`[${fnName}] 等待 ${actualRetryDelay} 毫秒后进行下一次重试...`);
      await new Promise(resolve => setTimeout(resolve, actualRetryDelay));
    }
  }
}

const DEFAULT_SYSTEM_CONTENT = `
# CONTEXT #
你是一位资深的内容安全审核专家,拥有丰富的内容审核经验,需要严格按照平台内容安全规范进行专业审核。你需要以严谨的态度对所有内容进行安全合规把关,重点基于以下5个等级识别和判断违规内容:

Level 1 (轻微): 
- 轻微的不当用语
- 模糊的暗示性内容
- 轻微的争议性内容

Level 2 (关注):
- 粗俗语言
- 轻微的性暗示
- 轻微的暴力描述

Level 3 (警告):
- 明显的性暗示内容
- 中等程度的暴力描述
- 有争议的违法内容暗示

Level 4 (严重):
- 露骨的性相关内容
- 具体的暴力细节
- 明确的违法内容(如赌博、轻度毒品)

Level 5 (危险):
- 极端色情内容
- 血腥暴力内容
- 严重违法内容(如硬毒品、诈骗)
- 违反法律法规的极端内容

# OBJECTIVE #
作为专业的内容安全审核员,你需要:
1. 对提交的所有文本进行严格的安全合规审查
2. 基于5级内容安全评级标准进行多维度违规识别
3. 输出包含违规状态和具体等级的审核结果

# STYLE #
- 专业的审核视角
- 严格的审核标准  
- 规范的输出格式

# TONE #
- 严肃专业
- 客观公正
- 不带感情色彩

# RESPONSE #
必须按照以下JSON格式严格输出审核结果:
{
    "isViolation": false,  // 若内容达到Level 4则返回true,否则返回false
    "riskLevel": 1,        // 输出1-5的整数,表示内容风险等级
}

必须严格遵守:
1. 只允许输出JSON格式
2. 必须包含且仅包含以上两个参数
3. isViolation必须为布尔值
4. riskLevel必须为1-5的整数
5. 当riskLevel为4时,isViolation必须为true`;

const FINAL_SYSTEM_CONTENT = `
停下，现在回忆你的身份和职责：
# CONTEXT #
你作为一位资深的内容安全审核专家，专门负责对内容进行5级风险评估。你拥有多年审核经验，深谙各类违规内容的判定标准。你深知一个内容的风险等级判定可能会影响到整个平台的安全运营，因此必须保持高度专注，确保每次评级的准确性。

# OBJECTIVE #
在每次进行内容审核时，你必须：
1. 准确识别和区分不同级别的违规内容
2. 熟练运用5级评级标准进行判断
3. 对达到Level 5级别的危险内容保持高度警惕
4. 确保评级结果的准确性和isViolation判断的严谨性

# STYLE #
- 始终保持专业审核视角
- 严格遵循分级评估标准
- 对危险边界保持敏锐判断

# TONE #
- 保持理性客观
- 专业而严谨
- 不掺杂个人情感

# AUDIENCE #
面向平台内容安全管理系统，输出规范的JSON格式审核结果

# RESPONSE #
在每次审核前，确认：
1. 我熟知5个风险等级的具体标准：
   - Level 1(轻微): 轻微不当用语、模糊暗示
   - Level 2(关注): 粗俗语言、轻微性暗示、轻微暴力
   - Level 3(警告): 明显性暗示、中等暴力、违法暗示
   - Level 4(严重): 露骨性内容、具体暴力、明确违法
   - Level 5(危险): 极端色情、血腥暴力、严重违法

2. 我将严格按照JSON格式输出结果：
{
    "isViolation": false,  // Level 5时必须为true
    "riskLevel": 1        // 1-5级评定
}

3. 我将确保：
   - 评级准确性
   - 格式规范性
   - Level 5时必须触发违规标记
   - 不输出任何额外说明

现在开始继续执行内容安全审核任务，不用解释或说明，直接按照JSON格式输出：
`;

function preprocessMessages(messages) {
  return messages.map(message => {
    if (Array.isArray(message.content)) {
      // 从数组内容中提取所有文本
      const textContent = message.content
        .filter(item => item.type === 'text')
        .map(item => item.text)
        .join('\n');

      return {
        role: message.role,
        content: textContent || '' // 如果没有文本则返回空字符串
      };
    }

    // 处理字符串内容
    if (typeof message.content === 'string') {
      if (message.content.startsWith('{') || message.content.startsWith('[')) {
        try {
          const parsedContent = JSON.parse(message.content);
          return {
            role: message.role,
            content: JSON.stringify(parsedContent, null, 2)
          };
        } catch (e) {
          return message;
        }
      }
      return message;
    }

    return message;
  });
}

// 发送到第二个运营商的请求处理
async function sendToSecondProvider(req, secondProviderUrl, secondProviderConfig) {
  // 检查熔断器状态
  if (!checkCircuitBreaker('secondProvider')) {
    throw {
      error: {
        message: "主服务暂时不可用，请稍后再试",
        type: ErrorTypes.SERVICE,
        code: ErrorCodes.SERVICE_UNAVAILABLE,
        circuit_breaker: true
      }
    };
  }

  // 检查o3模型的temperature限制
  if (req.body.model && req.body.model.toLowerCase().includes('o3')) {
    const temperature = req.body.temperature ?? 0; // 使用空值合并运算符，如果temperature为undefined或null则使用0
    if (temperature !== 0) {
      // 创建一个错误对象
      const error = new Error("o3模型的temperature值必须为0");
      error.response = {
        status: 400,
        data: {
          error: {
            message: "o3模型的temperature值必须为0",
            type: ErrorTypes.INVALID_REQUEST,
            code: ErrorCodes.INVALID_TEMPERATURE
          }
        }
      };
      // 设置特殊标记，表明这是不需要重试的错误
      error.nonRetryable = true;
      throw error;
    }
  }

  const secondProviderRequest = {
    model: req.body.model,
    messages: req.body.messages,
    stream: req.body.stream || false,
    temperature: req.body.temperature,
    max_tokens: req.body.max_tokens || 4096
  };

  if (req.body.response_format) {
    secondProviderRequest.response_format = req.body.response_format;
  }

  if (req.body.tools) {
    secondProviderRequest.tools = req.body.tools;
  }

  // 记录请求信息（不包含敏感数据）
  console.log('主服务商请求参数：', {
    model: secondProviderRequest.model,
    stream: secondProviderRequest.stream,
    temperature: secondProviderRequest.temperature,
    max_tokens: secondProviderRequest.max_tokens
  });

  try {
    // 对于流式请求和非流式请求使用不同的处理方式
    if (req.body.stream) {
      // 流式请求特殊处理
      const response = await axios.post(
        secondProviderUrl + '/v1/chat/completions',
        secondProviderRequest,
        {
          ...secondProviderConfig,
          responseType: 'stream',
          // 确保错误也能被正确捕获和处理
          validateStatus: function (status) {
            return true; // 不抛出HTTP错误，而是在响应中处理
          }
        }
      );
      
      // 检查响应状态码，如果不是200，则手动构建错误
      if (response.status !== 200) {
        // 尝试读取错误响应体
        let errorData = '';
        await new Promise((resolve) => {
          response.data.on('data', chunk => {
            errorData += chunk.toString();
          });
          
          response.data.on('end', () => {
            resolve();
          });
        });
        
        // 尝试解析错误数据
        try {
          const parsedError = JSON.parse(errorData);
          const error = new Error(parsedError.error?.message || "流式请求失败");
          error.response = {
            status: response.status,
            data: parsedError,
            headers: response.headers
          };
          
          // 记录服务失败
          recordServiceFailure('secondProvider');
          
          throw error;
        } catch (parseError) {
          // 如果无法解析JSON，使用原始错误
          const error = new Error("流式请求失败，无法解析错误响应");
          error.response = {
            status: response.status,
            data: { error: { message: errorData || "未知错误" } },
            headers: response.headers
          };
          
          // 记录服务失败
          recordServiceFailure('secondProvider');
          
          throw error;
        }
      }
      
      return response;
    } else {
      // 非流式请求正常处理
      return await axios.post(
        secondProviderUrl + '/v1/chat/completions',
        secondProviderRequest,
        {
          ...secondProviderConfig,
          responseType: 'json'
        }
      );
    }
  } catch (error) {
    // 记录服务失败
    recordServiceFailure('secondProvider');
  
    // 记录错误详情
    console.error('主服务商错误响应：', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
      details: `错误累积: ${config.serviceHealth.secondProvider.failureCount}/${config.serviceHealthConfig.maxErrors} 在 ${config.serviceHealthConfig.errorWindow/1000}秒内`
    });

    // 默认将所有错误标记为不可重试，除非明确启用了重试功能
    if (config.timeouts.enableRetry !== true) {
      error.nonRetryable = true;
    }
  
    // 增强错误对象，确保保留完整的错误信息
    if (error.response) {
      // 确保错误对象包含完整的响应数据
      error.originalResponse = {
        data: error.response.data,
        status: error.response.status,
        statusText: error.response.statusText,
        headers: error.response.headers
      };
    }

    // 直接抛出增强后的错误对象
    throw error;
  }
}

// 处理审核服务
async function performModeration(messages, firstProviderUrl, firstProviderConfig) {
  // 使用checkCircuitBreaker函数检查熔断器状态，而不是直接访问config
  if (!checkCircuitBreaker('firstProvider')) {
    console.error(`[熔断器警报] 审核服务熔断器已触发，拒绝处理请求`);
    throw {
      error: {
        message: "内容审核服务暂时不可用，请稍后再试",
        type: ErrorTypes.SERVICE,
        code: ErrorCodes.SERVICE_UNAVAILABLE,
        circuit_breaker: true
      }
    };
  }

  // 记录状态信息（用于调试）
  const health = config.serviceHealth['firstProvider'];
  console.log(`[审核服务] 熔断器状态: circuitBreakerTripped=${health.circuitBreakerTripped}, failureCount=${health.failureCount}/${config.serviceHealthConfig.maxErrors}`);

  try {
    // 选择一个审核模型
    const selectedModel = selectModerationModel('round-robin');
    console.log(`Using moderation model: ${selectedModel}`);

    // 提取客户端的所有消息内容，无论角色是什么
    const clientMessagesContent = messages.map(msg => {
      return {
        role: msg.role,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
      };
    });

    // 应用随机截取策略处理超长文本
    const extractResult = extractRandomSegments(clientMessagesContent);

    // 如果进行了截取，记录相关信息
    if (extractResult.isExtracted) {
      console.log(`内容审核: 原始长度 ${extractResult.originalLength} 字符，截取后 ${extractResult.extractedLength} 字符`);
    }

    // 构建一个包含所有内容的单一消息，确保所有内容都被审核
    const allMessagesText = extractResult.messages.map(msg =>
      `[${msg.role.toUpperCase()}]: ${msg.content}`
    ).join('\n\n');

    // 构造审核消息
    const moderationMessages = [
      { 
        role: "system", 
        content: DEFAULT_SYSTEM_CONTENT + "\n\n# INTERNAL_MODERATION_FLAG: DO_NOT_MODERATE_THIS_IS_ALREADY_A_MODERATION_REQUEST #"
      },
      {
        role: "user",
        content: `以下是需要审核的${extractResult.isExtracted ? '部分截取的' : '完整'}对话内容，请仔细审核每一部分：\n\n${allMessagesText}`
      },
      { role: "user", content: FINAL_SYSTEM_CONTENT }
    ];

    const moderationRequest = {
      messages: moderationMessages,
      model: selectedModel, // 使用选定的模型
      temperature: 0,
      max_tokens: 100,
      response_format: {
        type: "json_object"
      }
    };

    console.log('审核请求：', {
      model: moderationRequest.model,
      temperature: moderationRequest.temperature,
      max_tokens: moderationRequest.max_tokens,
      response_format: moderationRequest.response_format,
      // 添加原始客户端消息的摘要
      originalClientMessages: messages.map(msg => ({
        role: msg.role,
        contentPreview: typeof msg.content === 'string' && msg.content.length > 50
          ? msg.content.substring(0, 50) + '...'
          : (typeof msg.content === 'string' ? msg.content : 'non-string content')
      })),
      // 添加截取信息
      extractionInfo: extractResult.isExtracted ? {
        originalLength: extractResult.originalLength,
        extractedLength: extractResult.extractedLength,
        reductionPercent: Math.round((1 - extractResult.extractedLength / extractResult.originalLength) * 100)
      } : null
    });

    try {
      const checkResponse = await axios.post(
        firstProviderUrl + '/v1/chat/completions',
        moderationRequest,
        firstProviderConfig
      );

      // 解析审核结果
      const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);

      // 记录详细的审核日志
      const logId = logModerationResult(
        selectedModel,
        moderationRequest,
        checkResponse,
        moderationResult,
        moderationResult.isViolation === true
      );

      // 如果内容违规，抛出错误
      if (moderationResult.isViolation === true) {
        const violationError = {
          error: {
            message: `内容审核未通过，请修改后重试 (ID: ${logId})`,
            type: ErrorTypes.INVALID_REQUEST,
            code: ErrorCodes.CONTENT_VIOLATION,
            details: {
              riskLevel: moderationResult.riskLevel,
              logId: logId,
              isPartialCheck: extractResult.isExtracted
            }
          }
        };
        throw violationError;
      }

      return {
        passed: true,
        logId: logId,
        riskLevel: moderationResult.riskLevel,
        isPartialCheck: extractResult.isExtracted
      };
    } catch (error) {
      // 确保先记录服务失败，无论是什么类型的错误
      console.error(`[审核服务] 请求失败，记录到熔断器统计`);
      recordServiceFailure('firstProvider');
      
      // 使用新增的错误日志函数记录详细信息
      const errorId = logModerationServiceError(error, selectedModel);
      
      // 如果错误已经是我们格式化过的违规错误，直接抛出
      if (error.error?.code === ErrorCodes.CONTENT_VIOLATION) {
        throw error;
      }
      
      // 检查熔断器状态（可能刚刚触发）
      if (!checkCircuitBreaker('firstProvider')) {
        console.error(`[${errorId}] 熔断器已触发，返回熔断器错误响应`);
        throw {
          error: {
            message: "内容审核服务暂时不可用，请稍后再试（熔断器已触发）",
            type: ErrorTypes.SERVICE,
            code: ErrorCodes.SERVICE_UNAVAILABLE,
            circuit_breaker: true,
            error_id: errorId
          }
        };
      }
      
      // 其他API错误
      throw error;
    }
  } catch (error) {
    // 如果是模型配置错误，返回更友好的错误信息
    if (error.message && error.message.includes("未配置审核模型")) {
      throw {
        error: {
          message: "服务配置错误：未配置审核模型",
          type: ErrorTypes.SERVICE,
          code: ErrorCodes.INTERNAL_ERROR,
          details: "请管理员设置 FIRST_PROVIDER_MODELS 环境变量"
        }
      };
    }
    throw error;
  }
}

// 处理流式响应的函数
async function handleStream(req, res, firstProviderUrl, secondProviderUrl, firstProviderKey, secondProviderKey, skipModeration = false) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 添加流式数据超时控制
  let lastDataTime = Date.now();
  const checkInterval = setInterval(() => {
    if (Date.now() - lastDataTime > config.timeouts.streamTimeout) {
      clearInterval(checkInterval);
      res.write(`data: ${JSON.stringify({
        error: {
          message: "流式响应超时，数据传输过慢",
          type: ErrorTypes.SERVICE,
          code: ErrorCodes.STREAM_TIMEOUT
        }
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }, 10000); // 每10秒检查一次

  try {
    const textMessages = preprocessMessages(req.body.messages);
    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: Math.floor(config.timeouts.maxRetryTime * 0.5)
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: Math.floor(config.timeouts.maxRetryTime * 0.5)
    };

    // 先执行审核
    let moderationPassed = skipModeration; // 如果skipModeration为true，直接跳过审核
    if (!skipModeration) {
      try {
        const moderationResult = await performModeration(textMessages, firstProviderUrl, firstProviderConfig);
        moderationPassed = true;
        // 可以在响应头中添加审核ID，方便追踪
        res.setHeader('X-Content-Review-ID', moderationResult.logId);
        res.setHeader('X-Risk-Level', moderationResult.riskLevel);
        // 如果审核结果包含部分审核标记，添加到响应头
        if (moderationResult.isPartialCheck) {
          res.setHeader('X-Content-Review-Partial', 'true');
        }
      } catch (moderationError) {
        if (moderationError.error?.code === "content_violation") {
          res.write(`data: ${JSON.stringify(moderationError)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        
        // 检查是否是熔断器触发的错误
        if (moderationError.error?.circuit_breaker) {
          console.error(`[熔断器警报] 内容审核服务熔断器已触发，拒绝处理流式请求`);
          const errorResponse = {
            error: {
              message: moderationError.error.message || "审核服务暂时不可用（熔断保护已触发）",
              type: ErrorTypes.SERVICE,
              code: ErrorCodes.SERVICE_UNAVAILABLE,
              circuit_breaker: true,
              error_id: moderationError.error.error_id || `cb_${Date.now()}`
            }
          };
          res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        
        console.error(`[流处理] 审核服务错误，错误类型: ${moderationError.error?.type || 'unknown'}`);
        throw moderationError;
      }
    }

    // 审核通过后，只重试第二个提供商的请求
    if (moderationPassed) {
      try {
        // 添加请求ID用于跟踪
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
        console.log(`[${requestId}] 开始处理流式请求`);
        
        const response = await retryRequest(
          () => sendToSecondProvider(req, secondProviderUrl, secondProviderConfig),
          config.timeouts.maxRetryTime,
          `sendToSecondProvider-Stream-${requestId}`
        );

        // 检查是否是错误响应
        if (response.status !== 200) {
          // 构建错误对象
          const error = new Error("主服务商返回错误");
          error.response = {
            status: response.status,
            data: response.data,
            headers: response.headers
          };
          error.nonRetryable = true; // 标记为不可重试
          console.log(`[${requestId}] 主服务商返回非200状态码: ${response.status}`);
          throw error;
        }
        
        console.log(`[${requestId}] 成功获取流式响应`);

        // 替换原来的 response.data.pipe(res) 为自定义的流处理
        const stream = response.data;

        stream.on('data', (chunk) => {
          lastDataTime = Date.now(); // 更新最后收到数据的时间
          try {
            res.write(chunk);
          } catch (writeError) {
            console.error(`[${requestId}] 写入流数据时出错:`, writeError);
            clearInterval(checkInterval);
          }
        });

        stream.on('end', () => {
          console.log(`[${requestId}] 流式响应正常结束`);
          clearInterval(checkInterval);
          res.end();
        });

        stream.on('error', (error) => {
          console.error(`[${requestId}] 流式响应错误:`, {
            message: error.message,
            response: error.response?.data,
            status: error.response?.status
          });

          clearInterval(checkInterval);

          // 使用handleError处理错误，确保返回原始错误信息
          const errorResponse = handleError(error);
          
          // 直接处理并发送错误响应
          try {
            res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } catch (writeError) {
            console.error(`[${requestId}] 写入错误响应时出错:`, writeError);
          }
        });
      } catch (error) {
        clearInterval(checkInterval);
        console.error('Stream request error:', error);
        
        // 标记错误为不可重试
        if (!error.nonRetryable) {
          error.nonRetryable = true;
        }
        
        // 使用handleError处理错误，确保返回原始错误信息
        const errorResponse = handleError(error);
        
        // 以流式格式发送错误
        try {
          res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (writeError) {
          console.error('Error writing final error response:', writeError);
          try {
            res.end();
          } catch (endError) {
            console.error('Error ending response after error:', endError);
          }
        }
      }
    }
  } catch (error) {
    clearInterval(checkInterval);
    console.error('Stream handler error:', error.message, error.stack);
    
    // 确保错误对象包含完整的信息
    const errorResponse = handleError(error);
    
    try {
      // 确保错误消息以流式格式返回
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch (writeError) {
      console.error('Error writing error response:', writeError.message);
    }
    res.end();
  }
}

// 计算消息总长度的函数
function calculateTotalLength(messages) {
  return messages.reduce((total, msg) => {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
    return total + content.length;
  }, 0);
}

// 随机截取文本的函数
function extractRandomSegments(messages, maxLength = 30000) {
  const totalLength = calculateTotalLength(messages);

  // 如果总长度小于最大长度，直接返回原始消息
  if (totalLength <= maxLength) {
    return {
      messages: messages,
      isExtracted: false,
      originalLength: totalLength,
      extractedLength: totalLength
    };
  }

  console.log(`消息总长度(${totalLength})超过最大限制(${maxLength})，将进行随机截取`);

  // 分离用户消息和非用户消息
  const userMessages = messages.filter(msg => msg.role === 'user');
  const nonUserMessages = messages.filter(msg => msg.role !== 'user');

  // 为非用户消息预留最多50%的空间
  const nonUserMaxLength = Math.floor(maxLength * 0.5);

  // 创建消息的副本，以便我们可以修改它
  const extractedMessages = [];
  let currentLength = 0;

  // 首先处理非用户消息（系统消息、助手消息等）
  for (const msg of nonUserMessages) {
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);

    // 如果添加这条消息后仍在限制内，直接添加
    if (currentLength + content.length <= nonUserMaxLength) {
      extractedMessages.push({
        role: msg.role,
        content: content
      });
      currentLength += content.length;
    } else {
      // 如果这条消息太长，截取部分内容
      const availableLength = nonUserMaxLength - currentLength;
      if (availableLength > 200) { // 确保至少有足够空间添加有意义的内容
        const truncatedContent = content.substring(0, Math.floor(availableLength * 0.8)) +
          "\n...[系统内容过长，已截取]...";

        extractedMessages.push({
          role: msg.role,
          content: truncatedContent
        });
        currentLength += truncatedContent.length;
      }
      // 一旦达到非用户消息的限制，就停止添加
      break;
    }
  }

  // 计算剩余可用于用户消息的长度
  const remainingLength = maxLength - currentLength;

  // 如果没有用户消息，直接返回
  if (userMessages.length === 0) {
    return {
      messages: extractedMessages,
      isExtracted: true,
      originalLength: totalLength,
      extractedLength: currentLength
    };
  }

  // 如果只有一条用户消息，处理这种特殊情况
  if (userMessages.length === 1) {
    const msg = userMessages[0];
    const content = typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);

    if (content.length <= remainingLength) {
      // 如果消息长度在限制内，直接添加
      extractedMessages.push(msg);
    } else {
      // 随机截取策略：取开头、中间和结尾的部分
      const segmentLength = Math.floor(remainingLength / 3);

      // 确保段落长度不超过剩余长度的三分之一
      const safeSegmentLength = Math.min(segmentLength, Math.floor(remainingLength / 3.5));

      // 取开头部分
      const startSegment = content.substring(0, safeSegmentLength);

      // 取中间随机部分
      const middleStart = Math.floor(Math.random() * (content.length - safeSegmentLength));
      const middleSegment = content.substring(middleStart, middleStart + safeSegmentLength);

      // 取结尾部分
      const endSegment = content.substring(content.length - safeSegmentLength);

      const extractedContent = `${startSegment}\n...[内容过长，已截取]...\n${middleSegment}\n...[内容过长，已截取]...\n${endSegment}`;

      // 最后检查确保不超过剩余长度
      const finalContent = extractedContent.length > remainingLength
        ? extractedContent.substring(0, remainingLength - 30) + "...[已截断]"
        : extractedContent;

      extractedMessages.push({
        role: 'user',
        content: finalContent
      });
    }
  } else {
    // 多条用户消息，随机选择一些消息
    // 首先计算每条消息的长度
    const messageLengths = userMessages.map(msg => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return {
        message: msg,
        length: content.length
      };
    });

    // 按照消息长度排序（优先选择较短的消息）
    messageLengths.sort((a, b) => a.length - b.length);

    // 按照可用长度添加消息
    let usedLength = 0;

    // 首先尝试添加完整的短消息
    for (let i = 0; i < messageLengths.length; i++) {
      const item = messageLengths[i];

      // 如果消息可以完整添加
      if (usedLength + item.length <= remainingLength) {
        extractedMessages.push(item.message);
        usedLength += item.length;
        // 标记为已处理
        messageLengths[i] = null;
      }

      // 如果已经达到限制，停止添加
      if (usedLength >= remainingLength) break;
    }

    // 如果还有剩余空间，尝试截取一些较长消息的片段
    if (usedLength < remainingLength) {
      // 过滤掉已处理的消息
      const remainingMessages = messageLengths.filter(item => item !== null);

      // 随机打乱顺序，以获取更多样的内容
      remainingMessages.sort(() => Math.random() - 0.5);

      for (const item of remainingMessages) {
        const availableLength = remainingLength - usedLength;

        // 确保有足够空间添加有意义的内容
        if (availableLength < 200) break;

        const content = typeof item.message.content === 'string'
          ? item.message.content
          : JSON.stringify(item.message.content);

        // 计算可以截取的内容长度
        const truncateLength = Math.min(availableLength - 50, Math.floor(content.length / 2));

        if (truncateLength > 100) {
          // 截取开头部分
          const extractedContent = content.substring(0, truncateLength) +
            "\n...[内容过长，已截取]...";

          extractedMessages.push({
            role: 'user',
            content: extractedContent
          });

          usedLength += extractedContent.length;

          // 如果已经达到限制，停止添加
          if (usedLength >= remainingLength) break;
        }
      }
    }
  }

  // 计算最终提取的内容长度
  const extractedLength = calculateTotalLength(extractedMessages);

  // 最后的安全检查：如果提取的内容仍然超过最大长度，强制截断
  if (extractedLength > maxLength) {
    console.warn(`警告：提取后的内容(${extractedLength})仍超过最大长度(${maxLength})，将强制截断`);

    // 从提取的消息中移除最后一条用户消息
    for (let i = extractedMessages.length - 1; i >= 0; i--) {
      if (extractedMessages[i].role === 'user') {
        extractedMessages.splice(i, 1);
        break;
      }
    }

    // 重新计算长度
    const newExtractedLength = calculateTotalLength(extractedMessages);

    // 如果仍然超过限制，添加一条警告消息
    if (newExtractedLength > maxLength) {
      return {
        messages: [
          { role: 'system', content: '内容过长，无法处理。请减少输入内容后重试。' }
        ],
        isExtracted: true,
        originalLength: totalLength,
        extractedLength: 0
      };
    }
  }

  return {
    messages: extractedMessages,
    isExtracted: true,
    originalLength: totalLength,
    extractedLength: extractedLength
  };
}

// 处理非流式响应的函数
async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, firstProviderKey, secondProviderKey, skipModeration = false) {
  try {
    const textMessages = preprocessMessages(req.body.messages);
    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: Math.floor(config.timeouts.maxRetryTime * 0.5)
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: Math.floor(config.timeouts.maxRetryTime * 0.5)
    };

    // 先执行审核
    let moderationPassed = skipModeration; // 如果skipModeration为true，直接跳过审核
    if (!skipModeration) {
      try {
        const moderationResult = await performModeration(textMessages, firstProviderUrl, firstProviderConfig);
        moderationPassed = true;
        // 可以在响应头中添加审核ID，方便追踪
        res.setHeader('X-Content-Review-ID', moderationResult.logId);
        res.setHeader('X-Risk-Level', moderationResult.riskLevel);
        // 如果审核结果包含部分审核标记，添加到响应头
        if (moderationResult.isPartialCheck) {
          res.setHeader('X-Content-Review-Partial', 'true');
        }
      } catch (moderationError) {
        if (moderationError.error?.code === "content_violation") {
          res.statusCode = 403;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(moderationError));
          return;
        }
        
        // 检查是否是熔断器触发的错误
        if (moderationError.error?.circuit_breaker) {
          console.error(`[熔断器警报] 内容审核服务熔断器已触发，拒绝处理请求`);
          res.statusCode = 503;
          res.setHeader('Content-Type', 'application/json');
          const errorResponse = {
            error: {
              message: moderationError.error.message || "审核服务暂时不可用（熔断保护已触发）",
              type: ErrorTypes.SERVICE,
              code: ErrorCodes.SERVICE_UNAVAILABLE,
              circuit_breaker: true,
              error_id: moderationError.error.error_id || `cb_${Date.now()}`
            }
          };
          res.end(JSON.stringify(errorResponse));
          return;
        }
        
        console.error(`[普通处理] 审核服务错误，错误类型: ${moderationError.error?.type || 'unknown'}`);
        throw moderationError;
      }
    }

    // 审核通过后，只重试第二个提供商的请求
    if (moderationPassed) {
      // 添加请求ID用于跟踪
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
      console.log(`[${requestId}] 开始处理普通请求`);
      
      try {
        const response = await retryRequest(
          () => sendToSecondProvider(req, secondProviderUrl, secondProviderConfig),
          config.timeouts.maxRetryTime,
          `sendToSecondProvider-Normal-${requestId}`
        );
        
        console.log(`[${requestId}] 成功获取普通响应`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(response.data));
      } catch (error) {
        // 确保错误被标记为不可重试
        error.nonRetryable = true;
        throw error;
      }
    }

  } catch (error) {
    console.error('Normal handler error:', error.message);
    const errorResponse = handleError(error);
    try {
      res.statusCode = errorResponse.error.code || 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(errorResponse));
    } catch (writeError) {
      console.error('Error sending error response:', writeError.message);
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        error: {
          message: "服务器内部错误",
          type: ErrorTypes.SERVICE,
          code: ErrorCodes.INTERNAL_ERROR
        }
      }));
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "不支持的请求方法",
        type: ErrorTypes.INVALID_REQUEST,
        code: "method_not_allowed"
      }
    }));
    return;
  }
  
  // 检查全局熔断器状态
  if (globalRequestCounter.isTripped()) {
    res.statusCode = 429;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "服务器检测到异常请求模式，已临时限制请求。请稍后再试。",
        type: ErrorTypes.RATE_LIMIT,
        code: ErrorCodes.RATE_LIMIT_EXCEEDED,
        details: {
          reason: "global_circuit_breaker_tripped"
        }
      }
    }));
    return;
  }

  // 检查是否是内部审核请求，以避免无限循环
  if (req.body && req.body.messages) {
    const isInternalModerationRequest = req.body.messages.some(msg => 
      msg.role === 'system' && 
      typeof msg.content === 'string' && 
      msg.content.includes('INTERNAL_MODERATION_FLAG: DO_NOT_MODERATE_THIS_IS_ALREADY_A_MODERATION_REQUEST')
    );

    if (isInternalModerationRequest) {
      console.log('检测到内部审核请求，跳过审核步骤以避免无限循环');
      // 直接处理请求，跳过审核
      if (req.body.stream) {
        await handleStream(
          req, res, null, 
          config.secondProvider.url, null, 
          config.secondProvider.key, 
          true // 标记为跳过审核
        );
      } else {
        await handleNormal(
          req, res, null, 
          config.secondProvider.url, null, 
          config.secondProvider.key,
          true // 标记为跳过审核
        );
      }
      return;
    }
  }

  // 添加速率限制检查
  if (await rateLimitMiddleware(req, res, '/v1/chat/completions')) {
    return; // 如果被限制，直接返回
  }

  const authKey = req.headers.authorization?.replace('Bearer ', '');
  const validAuthKey = config.authKey;

  if (!authKey || authKey !== validAuthKey) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "无效的认证密钥",
        type: ErrorTypes.AUTHENTICATION,
        code: ErrorCodes.INVALID_AUTH_KEY
      }
    }));
    return;
  }

  const firstProviderUrl = config.firstProvider.url;
  const firstProviderKey = config.firstProvider.key;
  const secondProviderUrl = config.secondProvider.url;
  const secondProviderKey = config.secondProvider.key;

  try {
    if (req.body.stream) {
      await handleStream(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderKey,
        secondProviderKey
      );
    } else {
      await handleNormal(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderKey,
        secondProviderKey
      );
    }
  } catch (error) {
    console.error('Request handler error:', error.message);
    const errorResponse = handleError(error);
    if (req.body.stream) {
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.statusCode = errorResponse.error.code || 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(errorResponse));
    }
  }
};
