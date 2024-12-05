// api/v1/chat/completions.js
const axios = require('axios');

// 处理流式响应的函数
async function handleStream(req, res, firstProviderUrl, secondProviderUrl, userApiKey) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // 首先请求第一个运营商进行内容检查
    const checkResponse = await axios.post(firstProviderUrl + '/v1/chat/completions', {
      messages: req.body.messages,
      stream: false,
      model: req.body.model,
      temperature: req.body.temperature,
      presence_penalty: req.body.presence_penalty,
      frequency_penalty: req.body.frequency_penalty,
      max_tokens: req.body.max_tokens,
    }, {
      headers: {
        'Authorization': `Bearer ${userApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    // 分析响应，判断是否允许继续处理
    if (checkResponse.data.allowed === false) {
      res.write(`data: ${JSON.stringify({
        error: {
          message: "Content not allowed",
          type: "invalid_request_error",
          code: "content_filter",
          details: checkResponse.data.reason
        }
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // 如果通过检查，则请求第二个运营商并进行流式传输
    const response = await axios.post(secondProviderUrl + '/v1/chat/completions', {
      ...req.body,
      stream: true
    }, {
      headers: {
        'Authorization': `Bearer ${userApiKey}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream'
    });

    response.data.pipe(res);
  } catch (error) {
    res.write(`data: ${JSON.stringify({
      error: {
        message: error.message,
        type: "api_error",
        code: error.response?.status || 500
      }
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

// 处理普通请求的函数
async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, userApiKey) {
  try {
    // 首先请求第一个运营商进行内容检查
    const checkResponse = await axios.post(firstProviderUrl + '/v1/chat/completions', {
      messages: req.body.messages,
      model: req.body.model,
      temperature: req.body.temperature,
      presence_penalty: req.body.presence_penalty,
      frequency_penalty: req.body.frequency_penalty,
      max_tokens: req.body.max_tokens,
    }, {
      headers: {
        'Authorization': `Bearer ${userApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    // 分析响应，判断是否允许继续处理
    if (checkResponse.data.allowed === false) {
      return res.status(403).json({
        error: {
          message: "Content not allowed",
          type: "invalid_request_error",
          code: "content_filter",
          details: checkResponse.data.reason
        }
      });
    }

    // 如果通过检查，则请求第二个运营商
    const response = await axios.post(secondProviderUrl + '/v1/chat/completions', req.body, {
      headers: {
        'Authorization': `Bearer ${userApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message,
        type: "api_error",
        code: error.response?.status || 500
      }
    });
  }
}

// 主处理函数
module.exports = async (req, res) => {
  // CORS 设置
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

  // 验证请求格式
  if (!req.body.messages || !Array.isArray(req.body.messages)) {
    return res.status(400).json({
      error: {
        message: "messages is required and must be an array",
        type: "invalid_request_error",
        code: "invalid_messages"
      }
    });
  }

  // 获取用户的 API Key
  const userApiKey = req.headers.authorization?.replace('Bearer ', '');
  if (!userApiKey) {
    return res.status(401).json({
      error: {
        message: "No API key provided",
        type: "invalid_request_error",
        code: "no_api_key"
      }
    });
  }

  // 从环境变量获取运营商 URL
  const firstProviderUrl = process.env.FIRST_PROVIDER_URL;
  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;

  // 根据是否需要流式传输选择不同的处理方式
  if (req.body.stream) {
    await handleStream(req, res, firstProviderUrl, secondProviderUrl, userApiKey);
  } else {
    await handleNormal(req, res, firstProviderUrl, secondProviderUrl, userApiKey);
  }
};