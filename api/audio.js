const axios = require('axios');
const { config, ErrorTypes, ErrorCodes, handleError } = require('./config.js');
const rateLimitMiddleware = require('../utils/rateLimitMiddleware');

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
  
  // 添加速率限制检查
  if (await rateLimitMiddleware(req, res, '/v1/audio/transcriptions')) {
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

  const { audio, model, language } = req.body;
  if (!audio || typeof audio !== 'string') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "音频参数无效",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_audio"
      }
    }));
    return;
  }

  if (!model || typeof model !== 'string') {
    res.statusCode = 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "模型参数无效",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_model"
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
      `${secondProviderUrl}/v1/audio/transcriptions`,
      { audio, model, language },
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
    console.error('Audio transcription error:', error);
    const errorResponse = handleError(error);
    res.statusCode = errorResponse.error.code >= 400 && errorResponse.error.code < 600 
      ? errorResponse.error.code 
      : 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(errorResponse));
  }
};
