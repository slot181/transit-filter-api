const axios = require('axios');

function handleError(error) {
  console.error('Error details:', error);

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

  return {
    error: {
      message: error.message,
      type: "internal_error",
      code: 500
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
    res.status(errorResponse.error.code).json(errorResponse);
  }
};
