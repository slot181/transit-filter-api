// completions.js

const axios = require('axios');

// 修改系统提示语以支持图片识别
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

// 验证消息格式的工具函数
function validateMessage(message) {
  if (!message.role || typeof message.role !== 'string') {
    return false;
  }
  if (!message.content) {
    return false;
  }

  // 处理数组格式的 content
  if (Array.isArray(message.content)) {
    return message.content.every(item => {
      if (item.type === 'text') {
        return typeof item.text === 'string';
      }
      if (item.type === 'image_url') {
        const url = typeof item.image_url === 'string' ? item.image_url : item.image_url.url;
        // 验证URL格式
        if (!url.match(/^https?:\/\/.+/)) {
          return false;
        }
        // 验证图片格式
        if (!url.match(/\.(jpg|jpeg|png|gif|webp)$/i)) {
          return false;
        }
        return true;
      }
      return false;
    });
  }

  // 如果是字符串格式的 content
  if (typeof message.content === 'string') {
    // 如果内容是JSON字符串，尝试解析它
    if (message.content.startsWith('{') || message.content.startsWith('[')) {
      try {
        JSON.parse(message.content);
        return true;  // 如果可以成功解析为JSON，认为是有效的
      } catch (e) {
        // JSON解析失败，继续检查是否为普通字符串
      }
    }
    return true;  // 普通字符串内容
  }

  return false;
}

function handleError(error) {
  return {
    error: {
      message: error.message || "An error occurred",
      type: "server_error",
      code: error.response?.status || 500
    }
  };
}

function preprocessMessages(messages) {
  return messages.map(message => {
    // 如果消息内容是字符串但看起来像JSON，尝试解析它
    if (typeof message.content === 'string' &&
      (message.content.startsWith('{') || message.content.startsWith('['))) {
      try {
        // 尝试解析JSON字符串
        const parsedContent = JSON.parse(message.content);
        // 将解析后的内容转换为文本格式
        return {
          role: message.role,
          content: JSON.stringify(parsedContent, null, 2)
        };
      } catch (e) {
        // 如果解析失败，保持原样
        return message;
      }
    }
    return message;
  });
}

async function handleStream(req, res, firstProviderUrl, secondProviderUrl, firstProviderModel, firstProviderKey, secondProviderKey) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // 检查是否包含图片内容，如果包含则设置max_tokens更大的值以适应图片描述
    const hasImageContent = req.body.messages.some(msg =>
      Array.isArray(msg.content) &&
      msg.content.some(item => item.type === 'image_url')
    );

    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...preprocessMessages(req.body.messages)  // 添加预处理步骤
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 30000  // 图片处理给予更长的超时时间
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 30000
    };

    try {
      // 构建审核请求
      const moderationRequest = {
        messages: moderationMessages,
        model: firstProviderModel,
        stream: false,
        temperature: 0,
        response_format: {
          type: "json_object"
        }
      };

      // 如果包含图片，添加相应的参数
      if (hasImageContent) {
        moderationRequest.max_tokens = req.body.max_tokens || 8192;  // 使用用户设置或默认值以适应图片描述
      } else {
        moderationRequest.max_tokens = 100;
      }

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

      // 构建第二个运营商的请求
      // 注意：确保原始请求的所有参数都被保留
      const secondProviderRequest = {
        ...req.body,
        stream: true
      };

      // 如果包含图片，确保相关参数正确设置
      if (hasImageContent) {
        secondProviderRequest.max_tokens = req.body.max_tokens || 8192;  // 使用用户设置或默认值
      }

      const response = await axios.post(
        secondProviderUrl + '/v1/chat/completions',
        secondProviderRequest,
        {
          ...secondProviderConfig,
          responseType: 'stream'
        }
      );

      response.data.pipe(res);
    } catch (providerError) {
      console.error('Provider error:', providerError);
      const errorResponse = handleError(providerError);
      res.write(`data: ${JSON.stringify(errorResponse)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
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
    // 检查是否包含图片内容
    const hasImageContent = req.body.messages.some(msg =>
      Array.isArray(msg.content) &&
      msg.content.some(item => item.type === 'image_url')
    );

    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...preprocessMessages(req.body.messages)  // 添加预处理步骤
    ];

    const firstProviderConfig = {
      headers: {
        'Authorization': `Bearer ${firstProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 30000  // 图片处理给予更长的超时时间
    };

    const secondProviderConfig = {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: hasImageContent ? 60000 : 30000
    };

    try {
      // 构建审核请求
      const moderationRequest = {
        messages: moderationMessages,
        model: firstProviderModel,
        temperature: 0,
        response_format: {
          type: "json_object"
        }
      };

      // 如果包含图片，添加相应的参数
      if (hasImageContent) {
        moderationRequest.max_tokens = req.body.max_tokens || 8192;  // 使用用户设置或默认值以适应图片描述
      } else {
        moderationRequest.max_tokens = 100;
      }

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

      // 构建第二个运营商的请求
      const secondProviderRequest = {
        ...req.body
      };

      // 如果包含图片，确保相关参数正确设置
      if (hasImageContent) {
        secondProviderRequest.max_tokens = req.body.max_tokens || 8192;  // 使用用户设置或默认值
      }

      const response = await axios.post(
        secondProviderUrl + '/v1/chat/completions',
        secondProviderRequest,
        secondProviderConfig
      );

      res.json(response.data);
    } catch (providerError) {
      console.error('Provider error:', providerError);
      const errorResponse = handleError(providerError);
      res.status(errorResponse.error.code).json(errorResponse);
    }
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

  // 验证API访问密钥
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

  // 验证消息格式
  if (!req.body.messages || !Array.isArray(req.body.messages)) {
    return res.status(400).json({
      error: {
        message: "messages is required and must be an array",
        type: "invalid_request_error",
        code: "invalid_messages"
      }
    });
  }

  // 修改消息验证部分
  for (const message of req.body.messages) {
    if (!validateMessage(message)) {
      console.error('Invalid message format:', JSON.stringify(message, null, 2));  // 添加详细日志
      return res.status(400).json({
        error: {
          message: "Invalid message format",
          type: "invalid_request_error",
          code: "invalid_message_format",
          details: "Each message must have a valid role and content",
          invalidMessage: message  // 添加具体的无效消息信息
        }
      });
    }
  }

  // 验证模型
  if (!req.body.model) {
    return res.status(400).json({
      error: {
        message: "model is required",
        type: "invalid_request_error",
        code: "invalid_model"
      }
    });
  }

  const firstProviderUrl = process.env.FIRST_PROVIDER_URL;
  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;
  const firstProviderModel = process.env.FIRST_PROVIDER_MODEL;
  const firstProviderKey = process.env.FIRST_PROVIDER_KEY;
  const secondProviderKey = process.env.SECOND_PROVIDER_KEY;

  // 检查所有必需的环境变量
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
    const errorResponse = handleError(error);
    res.status(errorResponse.error.code).json(errorResponse);
  }
};