const axios = require('axios');
const { config, handleError } = require('./config.js');
const rateLimitMiddleware = require('../utils/rateLimitMiddleware');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "Method not allowed",
        type: "invalid_request_error",
        code: 405
      }
    }));
    return;
  }
  
  // 添加速率限制检查
  if (await rateLimitMiddleware(req, res, '/v1/models')) {
    return; // 如果被限制，直接返回
  }

  const secondProviderUrl = config.secondProvider.url;
  const secondProviderKey = config.secondProvider.key;

  if (!secondProviderUrl || !secondProviderKey) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "Missing required environment variables",
        type: "configuration_error",
        code: "provider_not_configured",
        details: "Missing: SECOND_PROVIDER_URL, SECOND_PROVIDER_KEY"
      }
    }));
    return;
  }

  try {
    const response = await axios.get(`${secondProviderUrl}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response.data));
  } catch (error) {
    const errorResponse = handleError(error);
    res.statusCode = errorResponse.error.code >= 400 && errorResponse.error.code < 600 
      ? errorResponse.error.code 
      : 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(errorResponse));
  }
};
