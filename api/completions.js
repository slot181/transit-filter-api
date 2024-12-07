// completions.js

// 处理错误并返回格式化后的错误信息
function handleError(error) {
  console.error('Error details:', {
    message: error.message,
    response: error.response?.data,
    config: {
      url: error.config?.url,
      headers: error.config?.headers,
      data: error.config?.data
    }
  });

  if (error.response) {
    return {
      error: {
        message: error.response.data?.error?.message || error.message,
        type: "api_error",
        code: error.response.status,
        provider_error: error.response.data,
        path: error.config?.url,
        method: error.config?.method
      }
    };
  }

  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
    return {
      error: {
        message: "Provider service is unavailable",
        type: "connection_error",
        code: 503,
        details: error.message
      }
    };
  }

  const sanitizedError = {
    message: error.message,
    stack: error.stack,
    code: error.code,
    name: error.name
  };

  return {
    error: {
      message: sanitizedError.message,
      type: "internal_error",
      code: 500,
      details: sanitizedError
    }
  };
}

const axios = require('axios');

const DEFAULT_SYSTEM_CONTENT = `你是一个内容审核助手,负责对文本和图片内容进行安全合规审核。你需要重点识别和判断以下违规内容:
- 色情和暴露内容
- 恐怖暴力内容
- 违法违规内容(如毒品、赌博等)
# OBJECTIVE #
对用户提交的文本或图片进行内容安全审查,检测是否包含色情、暴力、违法等违规内容,并输出布尔类型的审核结果。
如果消息中包含图片，请仔细分析图片内容。
# STYLE #
- 简洁的
- 直接的
- 标准JSON格式
# TONE #
- 严格的
- 客观的
# RESPONSE #
请仅返回如下JSON格式:
{
    "isViolation": false  // 含有色情/暴力/违法内容返回true,否则返回false
}`;

function validateMessage(message) {
  if (!message.role || typeof message.role !== 'string') {
    return false;
  }
  if (!message.content) {
    return false;
  }

  if (Array.isArray(message.content)) {
    return message.content.every(item => {
      if (item.type === 'text') {
        return typeof item.text === 'string';
      }
      if (item.type === 'image_url') {
        if (typeof item.image_url === 'string') {
          if (!item.image_url.match(/^https?:\/\/.+/)) {
            return false;
          }
          if (!item.image_url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
            return false;
          }
          return true;
        } else if (typeof item.image_url === 'object' && typeof item.image_url.url === 'string') {
          const url = item.image_url.url;
          if (url.startsWith('data:image/') && url.includes(';base64,')) {
            return true;
          }
          if (!url.match(/^https?:\/\/.+/)) {
            return false;
          }
          if (!url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
            return false;
          }
          return true;
        }
        return false;
      }
      return false;
    });
  }

  if (typeof message.content === 'string') {
    if (message.content.startsWith('{') || message.content.startsWith('[')) {
      try {
        JSON.parse(message.content);
        return true;
      } catch (e) {
      }
    }
    return true;
  }

  return false;
}

function preprocessMessages(messages) {
  return messages.map(message => {
    if (typeof message.content === 'string' &&
      (message.content.startsWith('{') || message.content.startsWith('['))) {
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
  });
}

// 发送到第二个运营商的请求处理
async function sendToSecondProvider(req, secondProviderUrl, secondProviderConfig) {
  // 构造基础请求
  const secondProviderRequest = {
    model: req.body.model,
    messages: req.body.messages,
    stream: req.body.stream || false,
    temperature: req.body.temperature || 0.7,
    max_tokens: req.body.max_tokens || 2000
  };

  // 可选参数按需添加
  if (req.body.response_format) {
    secondProviderRequest.response_format = req.body.response_format;
  }

  if (req.body.tools) {
    secondProviderRequest.tools = req.body.tools;
  }

  console.log('Second provider request:', JSON.stringify({
    ...secondProviderRequest,
    messages: secondProviderRequest.messages.map(msg => ({
      ...msg,
      content: Array.isArray(msg.content) 
        ? 'Array content (logged separately)'
        : msg.content
    }))
  }, null, 2));

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
}

// 创建审核请求
function createModerationRequest(messages, model, tools, response_format) {
  const moderationRequest = {
    messages: messages,
    model: model,
    temperature: 0,
    max_tokens: 100
  };

  // 只有在参数存在时才添加
  if (response_format) {
    moderationRequest.response_format = response_format;
  }

  if (tools) {
    moderationRequest.tools = tools;
  }

  return moderationRequest;
}

async function handleStream(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // 提取文本消息进行审核
    const textMessages = preprocessMessages(req.body.messages.filter(msg =>
      !Array.isArray(msg.content) || !msg.content.some(item => item.type === 'image_url')
    ));

    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...textMessages
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 45000
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000
    };

    // 创建审核请求
    const moderationRequest = createModerationRequest(
      moderationMessages,
      firstProviderModel,
      req.body.tools,
      req.body.response_format
    );

    console.log('Moderation Request:', moderationRequest);

    const checkResponse = await axios.post(
      firstProviderUrl + '/v1/chat/completions',
      moderationRequest,
      firstProviderConfig
    );

    try {
      const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);
      if (moderationResult.isViolation === true) {
        res.write(`data: ${JSON.stringify({
          error: {
            message: "Content violation detected",
            type: "content_filter_error",
            code: "content_violation"
          }
        })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
    } catch (parseError) {
      console.error('Moderation parsing error:', parseError);
      throw new Error('Invalid moderation response format');
    }

    // 如果审核通过，发送到第二个运营商
    const response = await sendToSecondProvider(req, secondProviderUrl, secondProviderConfig);
    response.data.pipe(res);

  } catch (error) {
    console.error('Stream handler error:', error);
    const errorResponse = handleError(error);
    res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  try {
    const textMessages = preprocessMessages(req.body.messages.filter(msg =>
      !Array.isArray(msg.content) || !msg.content.some(item => item.type === 'image_url')
    ));

    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...textMessages
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 45000
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      timeout: 60000
    };

    const moderationRequest = createModerationRequest(
      moderationMessages,
      firstProviderModel,
      req.body.tools,
      req.body.response_format
    );

    console.log('Moderation Request:', moderationRequest);

    const checkResponse = await axios.post(
      firstProviderUrl + '/v1/chat/completions',
      moderationRequest,
      firstProviderConfig
    );

    try {
      const moderationResult = JSON.parse(checkResponse.data.choices[0].message.content);
      if (moderationResult.isViolation === true) {
        return res.status(403).json({
          error: {
            message: "Content violation detected",
            type: "content_filter_error",
            code: "content_violation"
          }
        });
      }
    } catch (parseError) {
      console.error('Moderation parsing error:', parseError);
      throw new Error('Invalid moderation response format');
    }

    const response = await sendToSecondProvider(req, secondProviderUrl, secondProviderConfig);
    res.json(response.data);

  } catch (error) {
    console.error('Normal handler error:', error);
    const errorResponse = handleError(error);
    res.status(errorResponse.error.code).json(errorResponse);
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
        message: "Method not allowed",
        type: "invalid_request_error",
        code: 405
      }
    });
  }

  const authKey = req.headers.authorization?.replace('Bearer ', '');
  const validAuthKey = process.env.AUTH_KEY;

  if (!authKey || authKey !== validAuthKey) {
    return res.status(401).json({
      error: {
        message: "Invalid authentication key",
        type: "invalid_request_error",
        code: "invalid_auth_key"
      }
    });
  }

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      error: {
        message: "Invalid request body",
        type: "invalid_request_error",
        code: "invalid_body"
      }
    });
  }

  if (!req.body.messages || !Array.isArray(req.body.messages)) {
    return res.status(400).json({
      error: {
        message: "messages is required and must be an array",
        type: "invalid_request_error",
        code: "invalid_messages"
      }
    });
  }

  for (const message of req.body.messages) {
    if (!validateMessage(message)) {
      console.error('Invalid message format:', JSON.stringify(message, null, 2));
      return res.status(400).json({
        error: {
          message: "Invalid message format",
          type: "invalid_request_error",
          code: "invalid_message_format",
          details: "Each message must have a valid role and content",
          invalidMessage: message
        }
      });
    }
  }

  if (!req.body.model) {
    return res.status(400).json({
      error: {
        message: "model is required",
        type: "invalid_request_error",
        code: "invalid_model"
      }
    });
  }

  // response_format 验证改为可选
  if (req.body.response_format !== undefined && typeof req.body.response_format !== 'object') {
    return res.status(400).json({
      error: {
        message: "Invalid response_format",
        type: "invalid_request_error",
        code: "invalid_response_format"
      }
    });
  }

  // tools 验证改为可选
  if (req.body.tools !== undefined && !Array.isArray(req.body.tools)) {
    return res.status(400).json({
      error: {
        message: "tools must be an array",
        type: "invalid_request_error",
        code: "invalid_tools"
      }
    });
  }

  const firstProviderUrl = process.env.FIRST_PROVIDER_URL;
  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;
  const firstProviderModel = process.env.FIRST_PROVIDER_MODEL;
  const firstProviderKey = process.env.FIRST_PROVIDER_KEY;
  const secondProviderKey = process.env.SECOND_PROVIDER_KEY;

  const missingVars = [];
  if (!firstProviderUrl) missingVars.push('FIRST_PROVIDER_URL');
  if (!secondProviderUrl) missingVars.push('SECOND_PROVIDER_URL');
  if (!firstProviderModel) missingVars.push('FIRST_PROVIDER_MODEL');
  if (!firstProviderKey) missingVars.push('FIRST_PROVIDER_KEY');
  if (!secondProviderKey) missingVars.push('SECOND_PROVIDER_KEY');
  if (!validAuthKey) missingVars.push('AUTH_KEY');

  if (missingVars.length > 0) {
    return res.status(500).json({
      error: {
        message: "Missing required environment variables",
        type: "configuration_error",
        code: "provider_not_configured",
        details: `Missing: ${missingVars.join(', ')}`
      }
    });
  }

  // 验证 URL 格式
  if (!firstProviderUrl.startsWith('http')) {
    return res.status(500).json({
      error: {
        message: "Invalid first provider URL",
        type: "configuration_error",
        code: "invalid_provider_url"
      }
    });
  }

  if (!secondProviderUrl.startsWith('http')) {
    return res.status(500).json({
      error: {
        message: "Invalid second provider URL",
        type: "configuration_error",
        code: "invalid_provider_url"
      }
    });
  }

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
    console.error('Request handler error:', {
      message: error.message,
      stack: error.stack,
      response: error.response?.data
    });
    const errorResponse = handleError(error);
    if (req.body.stream) {
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    } else {
      res.status(errorResponse.error.code).json(errorResponse);
    }
  }
};
