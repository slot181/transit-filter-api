const axios = require('axios');
const { handleError, ErrorTypes, ErrorCodes } = require('./completions.js');

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

  if (!req.body || typeof req.body !== 'object') {
    return res.status(400).json({
      error: {
        message: "无效的请求体格式",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_body"
      }
    });
  }

  const { prompt, n, size } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({
      error: {
        message: "提示词参数无效",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_prompt"
      }
    });
  }

  if (n && (typeof n !== 'number' || n <= 0)) {
    return res.status(400).json({
      error: {
        message: "生成数量必须为正数",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_n"
      }
    });
  }

  if (size && !['256x256', '512x512', '1024x1024'].includes(size)) {
    return res.status(400).json({
      error: {
        message: "尺寸必须是 '256x256'、'512x512' 或 '1024x1024' 之一",
        type: ErrorTypes.INVALID_REQUEST,
        code: "invalid_size"
      }
    });
  }

  const SECOND_PROVIDER_URL = process.env.SECOND_PROVIDER_URL;
  const SECOND_PROVIDER_KEY = process.env.SECOND_PROVIDER_KEY;

  if (!SECOND_PROVIDER_URL || !SECOND_PROVIDER_KEY) {
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
      `${SECOND_PROVIDER_URL}/v1/images/generations`,
      { prompt, n: n || 1, size: size || '512x512' },
      {
        headers: {
          'Authorization': `Bearer ${SECOND_PROVIDER_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    console.error('Image generation error:', error);
    const errorResponse = handleError(error);
    res.status(
      errorResponse.error.code >= 400 && errorResponse.error.code < 600 
        ? errorResponse.error.code 
        : 500
    ).json(errorResponse);
  }
};
