const axios = require('axios');
const { config, ErrorTypes, ErrorCodes, handleError } = require('./config.js');

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

  if (!req.body || typeof req.body !== 'object') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "无效的请求体格式",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_body"
      }
    }));
    return;
  }

  const { prompt, n, size } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "提示词参数无效",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_prompt"
      }
    }));
    return;
  }

  if (n && (typeof n !== 'number' || n <= 0)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "生成数量必须为正数",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_n"
      }
    }));
    return;
  }

  if (size && !['256x256', '512x512', '1024x1024'].includes(size)) {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "尺寸必须是 '256x256'、'512x512' 或 '1024x1024' 之一",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_size"
      }
    }));
    return;
  }

  const secondProviderUrl = config.secondProvider.url;
  const secondProviderKey = config.secondProvider.key;

  if (!secondProviderUrl || !secondProviderKey) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "服务配置缺失",
        type: ErrorTypes.SERVICE,
        code: ErrorCodes.INTERNAL_ERROR
      }
    }));
    return;
  }

  try {
    const response = await axios.post(
      `${secondProviderUrl}/v1/images/generations`,
      { prompt, n: n || 1, size: size || '512x512' },
      {
        headers: {
          'Authorization': `Bearer ${secondProviderKey}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response.data));
  } catch (error) {
    console.error('Image generation error:', error);
    const errorResponse = handleError(error);
    res.statusCode = errorResponse.error.code >= 400 && errorResponse.error.code < 600 
      ? errorResponse.error.code 
      : 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(errorResponse));
  }
};
