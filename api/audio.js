const axios = require('axios');
const { config, ErrorTypes, ErrorCodes, handleError } = require('./config.js');

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

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      error: {
        message: "无效的请求体格式",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_body"
      }
    });
  }

  const { audio, model, language } = req.body;
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({
      error: {
        message: "音频参数无效",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_audio"
      }
    });
  }

  if (!model || typeof model !== 'string') {
    return res.status(400).json({
      error: {
        message: "模型参数无效",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_model"
      }
    });
  }

  const secondProviderUrl = config.secondProvider.url;
  const secondProviderKey = config.secondProvider.key;

  if (!secondProviderUrl || !secondProviderKey) {
    return res.status(500).json({
      error: {
        message: "服务配置缺失",
        type: ErrorTypes.SERVICE,
        code: ErrorCodes.INTERNAL_ERROR
      }
    });
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

    res.json(response.data);
  } catch (error) {
    console.error('Audio transcription error:', error);
    const errorResponse = handleError(error);
    res.status(
      errorResponse.error.code >= 400 && errorResponse.error.code < 600 
        ? errorResponse.error.code 
        : 500
    ).json(errorResponse);
  }
};
