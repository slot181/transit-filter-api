// config.js - 集中管理环境变量和错误常量

// 错误类型常量
const ErrorTypes = {
  INVALID_REQUEST: 'invalid_request_error',    // 请求参数错误
  AUTHENTICATION: 'authentication_error',      // 认证错误
  PERMISSION: 'permission_error',              // 权限错误
  RATE_LIMIT: 'rate_limit_error',              // 频率限制
  API: 'api_error',                            // API错误
  SERVICE: 'service_error'                     // 服务错误
};

// 错误码常量
const ErrorCodes = {
  INVALID_AUTH_KEY: 'invalid_auth_key',        // 无效的认证密钥
  CONTENT_VIOLATION: 'content_violation',      // 内容违规
  RETRY_TIMEOUT: 'retry_timeout',              // 重试超时
  STREAM_TIMEOUT: 'stream_timeout',            // 流式响应超时
  SERVICE_UNAVAILABLE: 'service_unavailable',  // 服务不可用
  INTERNAL_ERROR: 'internal_error',            // 内部错误
  INVALID_TEMPERATURE: 'invalid_temperature'   // 无效的temperature参数
};

// 集中管理的配置
const config = {
  // API认证
  authKey: process.env.AUTH_KEY,
  
  // 第一提供商配置（审核服务）
  firstProvider: {
    url: process.env.FIRST_PROVIDER_URL,
    key: process.env.FIRST_PROVIDER_KEY,
    models: process.env.FIRST_PROVIDER_MODELS 
      ? process.env.FIRST_PROVIDER_MODELS.split(',').map(model => model.trim()).filter(Boolean)
      : []
  },
  
  // 第二提供商配置（主要服务）
  secondProvider: {
    url: process.env.SECOND_PROVIDER_URL,
    key: process.env.SECOND_PROVIDER_KEY
  },
  
  // 重试和超时设置
  timeouts: {
    maxRetryTime: parseInt(process.env.MAX_RETRY_TIME || '30000'),
    retryDelay: parseInt(process.env.RETRY_DELAY || '5000'),
    streamTimeout: parseInt(process.env.STREAM_TIMEOUT || '60000'),
    maxRetryCount: parseInt(process.env.MAX_RETRY_COUNT || '5')
  }
};

// 处理错误并返回格式化后的错误信息
function handleError(error) {
  // 记录详细的错误信息用于调试
  console.error('Error details:', {
    message: error.message,
    response: error.response?.data,
    status: error.response?.status,
    statusText: error.response?.statusText,
    originalResponse: error.originalResponse // 检查是否有增强的错误信息
  });

  // 如果有服务提供商的原始错误响应，优先使用它
  if (error.response?.data?.error) {
    return {
      error: {
        message: error.response.data.error.message || "服务提供商错误",
        type: error.response.data.error.type || ErrorTypes.SERVICE,
        code: error.response.status || 500,
        provider_error: error.response.data.error // 保留原始错误信息
      }
    };
  }
  
  // 如果有增强的错误响应，使用它
  if (error.originalResponse?.data?.error) {
    return {
      error: {
        message: error.originalResponse.data.error.message || "服务提供商错误",
        type: error.originalResponse.data.error.type || ErrorTypes.SERVICE,
        code: error.originalResponse.status || 500,
        provider_error: error.originalResponse.data.error
      }
    };
  }

  // 提取原始错误信息
  let errorMessage = error.response?.data?.message
    || error.originalResponse?.data?.message
    || error.message
    || "服务器内部错误";

  // 对于重试超时的特殊处理
  if (error.isRetryTimeout) {
    errorMessage = "服务请求超时，请稍后再试";
  }

  // 对于流式响应超时的特殊处理
  if (error.isStreamTimeout) {
    errorMessage = "流式响应超时，请稍后再试";
  }

  // 返回格式化的错误响应
  return {
    error: {
      message: errorMessage,
      type: error.response?.data?.error?.type || ErrorTypes.SERVICE,
      code: error.response?.status || 500,
      original_error: error.message // 添加原始错误信息
    }
  };
}

module.exports = {
  config,
  ErrorTypes,
  ErrorCodes,
  handleError
};
