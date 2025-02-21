const axios = require('axios');
const { handleError } = require('./completions');

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

  const { prompt, n, size } = req.body;
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({
      error: {
        message: "prompt is required and must be a string",
        type: "invalid_request_error",
        code: "invalid_prompt"
      }
    });
  }

  if (n && (typeof n !== 'number' || n <= 0)) {
    return res.status(400).json({
      error: {
        message: "n must be a positive number",
        type: "invalid_request_error",
        code: "invalid_n"
      }
    });
  }

  if (size && !['256x256', '512x512', '1024x1024'].includes(size)) {
    return res.status(400).json({
      error: {
        message: "size must be one of '256x256', '512x512', '1024x1024'",
        type: "invalid_request_error",
        code: "invalid_size"
      }
    });
  }

  const SECOND_PROVIDER_URL = process.env.SECOND_PROVIDER_URL;
  const SECOND_PROVIDER_KEY = process.env.SECOND_PROVIDER_KEY;

  if (!SECOND_PROVIDER_URL || !SECOND_PROVIDER_KEY) {
    return res.status(500).json({
      error: {
        message: "Second provider configuration is missing",
        type: "configuration_error",
        code: "provider_not_configured"
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
