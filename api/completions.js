// completions.js

const axios = require('axios');

const MAX_RETRY_TIME = parseInt(process.env.MAX_RETRY_TIME || '30000'); // 最大重试时间控制
const RETRY_DELAY = parseInt(process.env.RETRY_DELAY || '5000'); // 重试间隔时间控制
const STREAM_TIMEOUT = parseInt(process.env.STREAM_TIMEOUT || '60000'); // 流式超时控制

// 错误类型常量
const ErrorTypes = {
  INVALID_REQUEST: 'invalid_request_error',    // 请求参数错误
  AUTHENTICATION: 'authentication_error',       // 认证错误
  PERMISSION: 'permission_error',              // 权限错误
  RATE_LIMIT: 'rate_limit_error',             // 频率限制
  API: 'api_error',                           // API错误
  SERVICE: 'service_error'                    // 服务错误
};

// 错误码常量
const ErrorCodes = {
  ONE_HUB_ERROR: 'one_hub_error',           // onehub类型错误
  INVALID_AUTH_KEY: 'invalid_auth_key',         // 无效的认证密钥
  CONTENT_VIOLATION: 'content_violation',        // 内容违规
  RETRY_TIMEOUT: 'retry_timeout',               // 重试超时
  STREAM_TIMEOUT: 'stream_timeout',             // 流式响应超时
  SERVICE_UNAVAILABLE: 'service_unavailable',    // 服务不可用
  INTERNAL_ERROR: 'internal_error'              // 内部错误
};

// 添加重试函数
async function retryRequest(requestFn, maxTime) {
  const startTime = Date.now();
  let lastProviderError = null;
  let retryCount = 0;
  
  const tryRequest = async () => {
    try {
      const response = await requestFn();
      return response;
    } catch (error) {
      // 更详细地解析和保存服务商错误
      if (error.response?.data) {
        // 如果错误信息在 error 字段中
        if (error.response.data.error) {
          lastProviderError = error.response.data.error;
        }
        // 如果错误信息直接在 data 中
        else {
          lastProviderError = {
            message: error.response.data.message,
            type: error.response.data.type,
            code: error.response.data.code
          };
        }
      } else if (error.providerError) {
        lastProviderError = error.providerError;
      }
      
      retryCount++;
      console.log(`Request failed (attempt ${retryCount}) at ${new Date().toISOString()}, error:`, {
        message: error.message,
        providerError: lastProviderError
      });
      
      throw error;
    }
  };
  
  while (true) {
    try {
      return await tryRequest();
    } catch (error) {
      const elapsedTime = Date.now() - startTime;
      const nextRetryTime = elapsedTime + RETRY_DELAY;
      
      if (nextRetryTime >= maxTime) {
        console.log(`Max retry time ${maxTime}ms reached, stopping retries`);
        // 优先使用原始错误的类型和错误码
        throw {
          message: lastProviderError?.message || `服务请求超时，请稍后再试。`,
          type: lastProviderError?.type || ErrorTypes.SERVICE,
          code: lastProviderError?.code || ErrorCodes.RETRY_TIMEOUT,
          providerError: lastProviderError,
          isRetryTimeout: true  // 添加明确的标识
        };
      }
      
      console.log(`Waiting ${RETRY_DELAY}ms before next retry...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
}

const DEFAULT_SYSTEM_CONTENT = `
# CONTEXT #
你是一位资深的内容安全审核专家,拥有丰富的内容审核经验,需要严格按照平台内容安全规范进行专业审核。你需要以严谨的态度对所有内容进行安全合规把关,重点识别和判断以下违规内容:
- 色情和暴露内容(包括但不限于裸露、性暗示等)
- 恐怖暴力内容(包括但不限于血腥、暴力等)
- 违法违规内容(包括但不限于毒品、赌博、诈骗等)
- 其他可能违反法律法规的内容

# OBJECTIVE #
作为专业的内容安全审核员,你需要:
1. 对提交的所有文本进行严格的安全合规审查
2. 基于内容安全审核标准进行多维度违规识别
3. 输出准确的布尔类型审核结果

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
    "isViolation": false,  // 若检测到任何违规内容则返回true,否则返回false
}

任何非JSON格式的额外说明都不允许输出。
必须只有一个参数，且参数名为"isViolation"，且值为布尔类型。
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

// 处理错误并返回格式化后的错误信息
function handleError(error) {
  console.error('Error:', error.message, error.providerError);

  // 获取错误消息的辅助函数
  const getErrorMessage = (error) => {
    // 直接从错误对象获取消息
    if (error.message) {
      return error.message;
    }
    // 从 providerError 获取消息
    if (error.providerError?.message) {
      return error.providerError.message;
    }
    // 从 response.data 获取消息
    if (error.response?.data?.error?.message) {
      return error.response.data.error.message;
    }
    if (error.response?.data?.message) {
      return error.response.data.message;
    }
    return "服务器内部错误，请稍后重试";
  };

  // 重试超时错误 - 增强错误识别逻辑
  if (error.code === ErrorCodes.RETRY_TIMEOUT ||
      error.isRetryTimeout ||
      error.providerError?.code === ErrorCodes.RETRY_TIMEOUT) {
    return {
      error: {
        message: translateErrorMessage(getErrorMessage(error)),
        type: ErrorTypes.SERVICE,
        code: ErrorCodes.RETRY_TIMEOUT
      }
    };
  }

  // 流式响应超时
  if (error.message?.includes('Stream response timeout')) {
    return {
      error: {
        message: "流式响应超时",
        type: ErrorTypes.SERVICE,
        code: ErrorCodes.STREAM_TIMEOUT
      }
    };
  }

  // 认证错误
  if (error.code === 'invalid_auth_key') {
    return {
      error: {
        message: "无效的认证密钥",
        type: ErrorTypes.AUTHENTICATION,
        code: ErrorCodes.INVALID_AUTH_KEY
      }
    };
  }

  // 内容违规
  if (error.code === 'content_violation') {
    return {
      error: {
        message: "内容违规",
        type: ErrorTypes.INVALID_REQUEST,
        code: ErrorCodes.CONTENT_VIOLATION
      }
    };
  }

  // one_hub_error 类型错误处理
  if (
    error.type === 'one_hub_error' ||
    error.providerError?.type === 'one_hub_error' ||
    error.response?.data?.type === 'one_hub_error'
  ) {
    return {
      error: {
        message: error.message || error.providerError?.message || error.response?.data?.message,
        type: ErrorTypes.API,
        code: ErrorCodes.ONE_HUB_ERROR
      }
    };
  }

  // 网络错误
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
    return {
      error: {
        message: "服务暂时不可用，请稍后重试",
        type: ErrorTypes.SERVICE,
        code: ErrorCodes.SERVICE_UNAVAILABLE
      }
    };
  }

  // 处理其他所有错误
  return {
    error: {
      message: translateErrorMessage(getErrorMessage(error)),
      type: ErrorTypes.SERVICE,
      code: ErrorCodes.INTERNAL_ERROR
    }
  };
}

// 添加错误消息翻译函数
function translateErrorMessage(message) {
  const errorMessages = {
    'Invalid authentication credentials': '无效的认证凭据',
    'Rate limit exceeded': '请求频率超限',
    'The model is overloaded': '模型负载过高，请稍后重试',
    'The server had an error processing your request': '服务器处理请求时发生错误',
    'Bad gateway': '网关错误',
    'Gateway timeout': '网关超时',
    'Service unavailable': '服务不可用',
    'Request timeout': '请求超时',
    'Too many requests': '请求次数过多',
    'Internal server error': '服务器内部错误',
    'Content violation detected': '检测到违规内容',
    'Invalid request': '无效的请求',
    'Not found': '资源未找到',
    'Unauthorized': '未授权访问',
    'Forbidden': '禁止访问',
    'Max retry time exceeded': '请求超过最大重试时间',
    'Stream response timeout': '流式响应超时',
  };

  return errorMessages[message] || message;
}

// 发送到第二个运营商的请求处理
async function sendToSecondProvider(req, secondProviderUrl, secondProviderConfig) {
  const makeRequest = async () => {
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

    console.log('Second provider request:', {
      ...secondProviderRequest,
      messages: secondProviderRequest.messages.map(msg => ({
        ...msg,
        content: Array.isArray(msg.content)
          ? msg.content.map(item => item.type === 'text' ? item.text : '[图片]').join('\n')
          : msg.content
      }))
    });

    if (req.body.stream) {
      return await axios.post(
        secondProviderUrl + '/v1/chat/completions',
        secondProviderRequest,
        {
          ...secondProviderConfig,
          responseType: 'stream'
        }
      );
    }

    return await axios.post(
      secondProviderUrl + '/v1/chat/completions',
      secondProviderRequest,
      secondProviderConfig
    );
  };

  return await retryRequest(makeRequest, MAX_RETRY_TIME);
}

async function performModeration(messages, firstProviderUrl, firstProviderModel, firstProviderConfig) {
  const moderationMessages = [
    { role: "system", content: DEFAULT_SYSTEM_CONTENT },
    ...messages,
    { role: "user", content: "请根据上述审核规范对全部消息内容进行安全审查" }
  ];

  const moderationRequest = {
    messages: moderationMessages,
    model: firstProviderModel,
    temperature: 0,
    max_tokens: 100,
    response_format: {
      type: "json_object"
    }
  };

  console.log('Moderation Request:', moderationRequest);

  const checkResponse = await axios.post(
    firstProviderUrl + '/v1/chat/completions',
    moderationRequest,
    firstProviderConfig
  );

  const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);
  if (moderationResult.isViolation === true) {
    throw {
      error: {
        message: "检测到违规内容，请修改后重试",
        type: ErrorTypes.INVALID_REQUEST,
        code: ErrorCodes.CONTENT_VIOLATION
      }
    };
  }

  return true;
}

// 处理流式响应的函数
async function handleStream(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // 添加流式数据超时控制
  let lastDataTime = Date.now();
  const checkInterval = setInterval(() => {
    if (Date.now() - lastDataTime > STREAM_TIMEOUT) {
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
      timeout: Math.floor(MAX_RETRY_TIME * 0.5)
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: Math.floor(MAX_RETRY_TIME * 0.5)
    };

    // 先执行审核
    let moderationPassed = false;
    try {
      await performModeration(textMessages, firstProviderUrl, firstProviderModel, firstProviderConfig);
      moderationPassed = true;
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
        MAX_RETRY_TIME
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
        console.error('Stream error:', error);
        const errorResponse = handleError(error);
        res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
        res.write('data: [DONE]\n\n');
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
async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  try {
    const textMessages = preprocessMessages(req.body.messages);
    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: Math.floor(MAX_RETRY_TIME * 0.5)
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: Math.floor(MAX_RETRY_TIME * 0.5)
    };

    // 先执行审核
    let moderationPassed = false;
    try {
      await performModeration(textMessages, firstProviderUrl, firstProviderModel, firstProviderConfig);
      moderationPassed = true;
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
        MAX_RETRY_TIME
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
  const validAuthKey = process.env.AUTH_KEY;

  if (!authKey || authKey !== validAuthKey) {
    return res.status(401).json({
      error: {
        message: "无效的认证密钥",
        type: ErrorTypes.AUTHENTICATION,
        code: ErrorCodes.INVALID_AUTH_KEY
      }
    });
  }

  const firstProviderUrl = process.env.FIRST_PROVIDER_URL;
  const firstProviderKey = process.env.FIRST_PROVIDER_KEY;
  const firstProviderModel = process.env.FIRST_PROVIDER_MODEL;
  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;
  const secondProviderKey = process.env.SECOND_PROVIDER_KEY;

  try {
    if (req.body.stream) {
      await handleStream(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderModel,
        firstProviderKey,
        secondProviderKey
      );
    } else {
      await handleNormal(
        req,
        res,
        firstProviderUrl,
        secondProviderUrl,
        firstProviderModel,
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
