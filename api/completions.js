// api/completions.js
const axios = require('axios');

// 默认的系统提示语
const DEFAULT_SYSTEM_CONTENT = `你是一个内容审核助手,负责对文本和图片内容进行安全合规审核。你需要重点识别和判断以下违规内容:
- 色情和暴露内容
- 恐怖暴力内容
- 违法违规内容(如毒品、赌博等)
# OBJECTIVE #
对用户提交的文本或图片进行内容安全审查,检测是否包含色情、暴力、违法等违规内容,并输出布尔类型的审核结果。
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

// 处理流式响应
async function handleStream(req, res, firstProviderUrl, secondProviderUrl, userApiKey) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    // 构建审核请求消息
    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...req.body.messages
    ];

    // 首先请求第一个运营商进行内容检查
    const checkResponse = await axios.post(firstProviderUrl + '/v1/chat/completions', {
      messages: moderationMessages,
      model: process.env.FIRST_PROVIDER_MODEL || 'gpt-3.5-turbo',
      stream: false,
      temperature: 0,  // 使用确定性输出
      max_tokens: 100  // 限制输出长度
    }, {
      headers: {
        'Authorization': `Bearer ${userApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    // 解析审核结果
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
      throw new Error('Invalid moderation response format');
    }

    // 如果通过审核，请求第二个运营商
    const response = await axios.post(secondProviderUrl + '/v1/chat/completions', {
      ...req.body,
      model: process.env.SECOND_PROVIDER_MODEL || req.body.model,
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

// 处理普通请求
async function handleNormal(req, res, firstProviderUrl, secondProviderUrl, userApiKey) {
  try {
    // 构建审核请求消息
    const moderationMessages = [
      { role: "system", content: DEFAULT_SYSTEM_CONTENT },
      ...req.body.messages
    ];

    // 首先请求第一个运营商进行内容检查
    const checkResponse = await axios.post(firstProviderUrl + '/v1/chat/completions', {
      messages: moderationMessages,
      model: process.env.FIRST_PROVIDER_MODEL || 'gpt-3.5-turbo',
      temperature: 0,
      max_tokens: 100
    }, {
      headers: {
        'Authorization': `Bearer ${userApiKey}`,
        'Content-Type': 'application/json'
      }
    });

    // 解析审核结果
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
      throw new Error('Invalid moderation response format');
    }

    // 如果通过审核，请求第二个运营商
    const response = await axios.post(secondProviderUrl + '/v1/chat/completions', {
      ...req.body,
      model: process.env.SECOND_PROVIDER_MODEL || req.body.model
    }, {
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

  if (!req.body.messages || !Array.isArray(req.body.messages)) {
    return res.status(400).json({
      error: {
        message: "messages is required and must be an array",
        type: "invalid_request_error",
        code: "invalid_messages"
      }
    });
  }

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

  const firstProviderUrl = process.env.FIRST_PROVIDER_URL;
  const secondProviderUrl = process.env.SECOND_PROVIDER_URL;

  if (req.body.stream) {
    await handleStream(req, res, firstProviderUrl, secondProviderUrl, userApiKey);
  } else {
    await handleNormal(req, res, firstProviderUrl, secondProviderUrl, userApiKey);
  }
};