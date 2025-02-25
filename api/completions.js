// completions.js

const axios = require('axios');
const { config, ErrorTypes, ErrorCodes, handleError } = require('./config.js');

// 用于负载均衡的模型索引计数器
let moderationModelIndex = 0;

// 负载均衡选择模型的函数
function selectModerationModel(strategy = 'round-robin') {
  const models = config.firstProvider.models;
  
  // 如果没有配置模型，返回错误
  if (!models || models.length === 0) {
    throw new Error("未配置审核模型，请设置 FIRST_PROVIDER_MODELS 环境变量");
  }
  
  // 如果只有一个模型，直接返回
  if (models.length === 1) {
    return models[0];
  }
  
  // 根据策略选择模型
  switch (strategy) {
    case 'random':
      // 随机选择一个模型
      const randomIndex = Math.floor(Math.random() * models.length);
      return models[randomIndex];
      
    case 'round-robin':
    default:
      // 轮询选择模型
      const model = models[moderationModelIndex];
      moderationModelIndex = (moderationModelIndex + 1) % models.length;
      return model;
  }
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
      userMessages: userMessages.length > 500 ? userMessages.substring(0, 500) + '...' : userMessages
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
    console.warn(`[MODERATION-VIOLATION][${logId}] 内容违规，风险等级: ${result?.riskLevel || 'unknown'}`);
    console.warn(JSON.stringify(logData, null, 2));
  } else {
    console.log(`[MODERATION-PASS][${logId}] 内容审核通过，风险等级: ${result?.riskLevel || 'unknown'}`);
    console.log(JSON.stringify(logData, null, 2));
  }
  
  return logId;
}

// 添加重试函数
async function retryRequest(requestFn, maxTime) {
  const startTime = Date.now();
  let retryCount = 0;
  let lastError = null;
  
  const tryRequest = async () => {
    try {
      return await requestFn();
    } catch (error) {
      retryCount++;
      lastError = error;
      
      // 记录错误信息
      console.log(`Request failed (attempt ${retryCount}) at ${new Date().toISOString()}:`, {
        error: {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status
        }
      });
      
      // 检查是否是标记为不需要重试的错误或状态码表明不需要重试
      const nonRetryableStatuses = [400, 401, 403, 404, 422];
      if (error.nonRetryable || (error.response && nonRetryableStatuses.includes(error.response.status))) {
        console.log('Non-retryable error detected, stopping retries');
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
        console.log(`[${requestFn.name || 'Unknown'}] Max retry ${retryType} (${retryValue}) reached`);
        
        // 标记为重试超时错误并保留原始错误信息
        error.isRetryTimeout = true;
        
        // 确保错误对象包含完整的响应数据
        if (lastError && lastError.response && !error.response) {
          error.response = lastError.response;
        }
        if (lastError && lastError.originalResponse && !error.originalResponse) {
          error.originalResponse = lastError.originalResponse;
        }
        
        throw error;
      }
      
      console.log(`Waiting ${config.timeouts.retryDelay}ms before next retry...`);
      await new Promise(resolve => setTimeout(resolve, config.timeouts.retryDelay));
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
暂停一下，现在开始回顾并审查我们之前的对话，然后阅读以下提示:
# CONTEXT #
你是一位资深的内容安全审核专家，专门负责对内容进行5级风险评估。你拥有多年审核经验，深谙各类违规内容的判定标准。你深知一个内容的风险等级判定可能会影响到整个平台的安全运营，因此必须保持高度专注，确保每次评级的准确性。

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

现在开始执行内容安全审核任务，请明确确认以上职责要求。
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
  console.log('Second provider request:', {
    model: secondProviderRequest.model,
    stream: secondProviderRequest.stream,
    temperature: secondProviderRequest.temperature,
    max_tokens: secondProviderRequest.max_tokens
  });

  try {
    const response = await axios.post(
      secondProviderUrl + '/v1/chat/completions',
      secondProviderRequest,
      {
        ...secondProviderConfig,
        responseType: req.body.stream ? 'stream' : 'json'
      }
    );
    return response;
  } catch (error) {
    // 记录错误详情
    console.error('Second provider error:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });

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

async function performModeration(messages, firstProviderUrl, firstProviderConfig) {
  try {
    // 选择一个审核模型
    const selectedModel = selectModerationModel('round-robin');
    console.log(`Using moderation model: ${selectedModel}`);
    
    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...messages,
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

    console.log('Moderation Request:', {
      model: moderationRequest.model,
      temperature: moderationRequest.temperature,
      max_tokens: moderationRequest.max_tokens,
      response_format: moderationRequest.response_format,
      // 添加消息内容记录，但排除系统消息以保持日志简洁
      messages: moderationMessages.filter(msg => msg.role !== 'system').map(msg => ({
        role: msg.role,
        content: typeof msg.content === 'string' && msg.content.length > 100 
          ? msg.content.substring(0, 100) + '...' 
          : msg.content
      }))
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
            message: `检测到违规内容，请修改后重试 (ID: ${logId})`,
            type: ErrorTypes.INVALID_REQUEST,
            code: ErrorCodes.CONTENT_VIOLATION,
            details: {
              riskLevel: moderationResult.riskLevel,
              logId: logId
            }
          }
        };
        throw violationError;
      }

      return {
        passed: true,
        logId: logId,
        riskLevel: moderationResult.riskLevel
      };
    } catch (error) {
      // 如果错误已经是我们格式化过的违规错误，直接抛出
      if (error.error?.code === ErrorCodes.CONTENT_VIOLATION) {
        throw error;
      }
      
      console.error('Moderation error with model:', selectedModel, error);
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
async function handleStream(req, res, firstProviderUrl, secondProviderUrl, firstProviderKey, secondProviderKey) {
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
    let moderationPassed = false;
    try {
      const moderationResult = await performModeration(textMessages, firstProviderUrl, firstProviderConfig);
      moderationPassed = true;
      // 可以在响应头中添加审核ID，方便追踪
      res.setHeader('X-Moderation-ID', moderationResult.logId);
      res.setHeader('X-Risk-Level', moderationResult.riskLevel);
    } catch (moderationError) {
      if (moderationError.error?.code === "content_violation") {
        res.write(`data: ${JSON.stringify(moderationError)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      throw moderationError;
    }

    // 审核通过后，只重试第二个提供商的请求
    if (moderationPassed) {
      const response = await retryRequest(
        () => sendToSecondProvider(req, secondProviderUrl, secondProviderConfig),
        config.timeouts.maxRetryTime
      );
      
      // 替换原来的 response.data.pipe(res) 为自定义的流处理
      const stream = response.data;
    
      stream.on('data', (chunk) => {
        lastDataTime = Date.now(); // 更新最后收到数据的时间
        res.write(chunk);
      });

      stream.on('end', () => {
        clearInterval(checkInterval);
        res.end();
      });

      stream.on('error', (error) => {
        clearInterval(checkInterval);
        
        // 记录错误详情
        console.error('Stream error:', {
          message: error.message,
          response: error.response?.data,
          status: error.response?.status
        });

        // 直接处理并发送错误响应
        try {
          const errorResponse = handleError(error);
          res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
          res.write('data: [DONE]\n\n');
        } catch (writeError) {
          console.error('Error writing stream error response:', writeError);
        }
        res.end();
      });
    }
  } catch (error) {
    clearInterval(checkInterval);
    console.error('Stream handler error:', error.message);
    const errorResponse = handleError(error);
    try {
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
    } catch (writeError) {
      console.error('Error writing error response:', writeError.message);
    }
    res.end();
  }
}

// 处理非流式响应的函数
async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, firstProviderKey, secondProviderKey) {
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
    let moderationPassed = false;
    try {
      const moderationResult = await performModeration(textMessages, firstProviderUrl, firstProviderConfig);
      moderationPassed = true;
      // 可以在响应头中添加审核ID，方便追踪
      res.setHeader('X-Moderation-ID', moderationResult.logId);
      res.setHeader('X-Risk-Level', moderationResult.riskLevel);
    } catch (moderationError) {
      if (moderationError.error?.code === "content_violation") {
        return res.status(403).json(moderationError);
      }
      throw moderationError;
    }

    // 审核通过后，只重试第二个提供商的请求
    if (moderationPassed) {
      const response = await retryRequest(
        () => sendToSecondProvider(req, secondProviderUrl, secondProviderConfig), 
        config.timeouts.maxRetryTime
      );
      res.json(response.data);
    }

  } catch (error) {
    console.error('Normal handler error:', error.message);
    const errorResponse = handleError(error);
    try {
      res.status(errorResponse.error.code || 500).json(errorResponse);
    } catch (writeError) {
      console.error('Error sending error response:', writeError.message);
      res.status(500).json({
        error: {
          message: "服务器内部错误",
          type: ErrorTypes.SERVICE,
          code: ErrorCodes.INTERNAL_ERROR
        }
      });
    }
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      error: {
        message: "不支持的请求方法",
        type: ErrorTypes.INVALID_REQUEST,
        code: "method_not_allowed"
      }
    });
  }

  const authKey = req.headers.authorization?.replace('Bearer ', '');
  const validAuthKey = config.authKey;

  if (!authKey || authKey !== validAuthKey) {
    return res.status(401).json({
      error: {
        message: "无效的认证密钥",
        type: ErrorTypes.AUTHENTICATION,
        code: ErrorCodes.INVALID_AUTH_KEY
      }
    });
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
      res.status(errorResponse.error.code || 500).json(errorResponse);
    }
  }
};
