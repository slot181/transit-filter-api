const axios = require('axios');

function handleError(error) {
  console.error('Error:', error.message);

  // 优先处理服务商返回的错误结构
  if (error.response?.data) {
    const providerError = error.response.data.error || error.response.data;
    return {
      error: {
        message: providerError.message || error.message,
        type: providerError.type || "api_error",
        code: providerError.code || error.response.status,
        param: providerError.param,
        // 保留原始错误信息用于调试
        provider_details: error.response.data 
      }
    };
  }

  // 处理网络连接类错误
  if (error.code === 'ECONNREFUSED' || error.code === 'ECONNABORTED') {
    return {
      error: {
        message: "服务暂时不可用，请稍后重试",
        type: "connection_error",
        code: 503
      }
    };
  }

  // 通用错误格式
  return {
    error: {
      message: error.message || '服务器内部错误',
      type: "internal_error",
      code: error.status || 500
    }
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      error: {
        message: "Method not allowed",
        type: "invalid_request_error",
        code: 405
      }
    });
  }

  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;
  const secondProviderKey = process.env.SECOND_PROVIDER_KEY;

  if (!secondProviderUrl || !secondProviderKey) {
    return res.status(500).json({
      error: {
        message: "Missing required environment variables",
        type: "configuration_error",
        code: "provider_not_configured",
        details: "Missing: SECOND_PROVIDER_URL, SECOND_PROVIDER_KEY"
      }
    });
  }

  try {
    const response = await axios.get(`${secondProviderUrl}/v1/models`, {
      headers: {
        'Authorization': `Bearer ${secondProviderKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });

    res.json(response.data);
  } catch (error) {
    const errorResponse = handleError(error);
    res.status(
      errorResponse.error.code >= 400 && errorResponse.error.code < 600 
        ? errorResponse.error.code 
        : 500
    ).json(errorResponse);
  }
};
