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
  INVALID_TEMPERATURE: 'invalid_temperature',  // 无效的temperature参数
  RATE_LIMIT_EXCEEDED: 'rate_limit_exceeded',  // 超过速率限制
};

// 全局请求计数器，用于检测异常请求模式
const globalRequestCounter = {
  count: 0,
  startTime: Date.now(),
  threshold: 1000, // 1秒内超过1000个请求视为异常
  isCircuitBreakerTripped: false,
  circuitBreakerResetTime: 0,
  
  // 增加请求计数
  increment() {
    this.count++;
    
    // 每秒重置一次计数器
    const now = Date.now();
    if (now - this.startTime > 1000) {
      console.log(`请求计数器重置: ${this.count} 请求/秒`);
      this.count = 0;
      this.startTime = now;
    }
    
    // 检查是否触发熔断器
    if (this.count > this.threshold && !this.isCircuitBreakerTripped) {
      console.error(`检测到异常请求模式: ${this.count} 请求/秒，触发全局熔断器`);
      this.isCircuitBreakerTripped = true;
      this.circuitBreakerResetTime = now + 60000; // 熔断器保持60秒
    }
    
    // 检查是否重置熔断器
    if (this.isCircuitBreakerTripped && now > this.circuitBreakerResetTime) {
      console.log(`全局熔断器重置`);
      this.isCircuitBreakerTripped = false;
    }
    
    return this.isCircuitBreakerTripped;
  },
  
  // 检查熔断器状态
  isTripped() {
    // 如果熔断器已触发，检查是否可以重置
    if (this.isCircuitBreakerTripped) {
      const now = Date.now();
      if (now > this.circuitBreakerResetTime) {
        console.log(`全局熔断器重置`);
        this.isCircuitBreakerTripped = false;
        this.count = 0;
        return false;
      }
      return true;
    }
    return false;
  }
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
    maxRetryTime: parseInt(process.env.MAX_RETRY_TIME || '90000'),
    retryDelay: parseInt(process.env.RETRY_DELAY || '2000'),
    streamTimeout: parseInt(process.env.STREAM_TIMEOUT || '300000'),
    maxRetryCount: parseInt(process.env.MAX_RETRY_COUNT || '5'),
    enableRetry: process.env.ENABLE_RETRY === 'true' // 明确需要设置为'true'才启用重试
  },
  
  // 速率限制设置
  rateLimits: {
    chat: parseInt(process.env.CHAT_RPM || '60'),
    images: parseInt(process.env.IMAGES_RPM || '20'),
    audio: parseInt(process.env.AUDIO_RPM || '20'),
    models: parseInt(process.env.MODELS_RPM || '100')
  },
  
  // 服务商熔断配置
  serviceHealthConfig: {
    maxErrors: parseInt(process.env.MAX_PROVIDER_ERRORS || '100'),
    errorWindow: parseInt(process.env.PROVIDER_ERROR_WINDOW || '60000'),
  },
  
  // 服务健康状态监控
  serviceHealth: {
    firstProvider: {
      isHealthy: true,
      failureCount: 0,
      lastFailureTime: 0,
      lastCheckTime: 0,
      circuitBreakerTripped: false,
      circuitBreakerResetTime: 0
    },
    secondProvider: {
      isHealthy: true,
      failureCount: 0,
      lastFailureTime: 0,
      lastCheckTime: 0,
      circuitBreakerTripped: false,
      circuitBreakerResetTime: 0
    }
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

  // 处理可能是字符串形式的错误响应
  if (typeof error.response?.data === 'string') {
    try {
      // 尝试解析JSON字符串
      const parsedData = JSON.parse(error.response.data);
      if (parsedData.error) {
        return {
          error: {
            message: parsedData.error.message || "服务提供商错误",
            type: parsedData.error.type || ErrorTypes.SERVICE,
            code: error.response.status || 500,
            provider_error: parsedData.error
          }
        };
      }
    } catch (parseError) {
      // 解析失败，使用原始字符串作为错误消息
      console.log('无法将错误响应解析为 JSON：', parseError.message);
    }
  }

  // 提取原始错误信息
  let errorMessage = error.response?.data?.message
    || (typeof error.response?.data === 'string' ? error.response.data : null)
    || error.originalResponse?.data?.message
    || error.message
    || "服务器内部错误";

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

// 检查熔断器状态
function checkCircuitBreaker(provider) {
  const health = config.serviceHealth[provider];
  
  // 如果熔断器已触发，检查是否可以重置
  if (health.circuitBreakerTripped) {
    if (Date.now() > health.circuitBreakerResetTime) {
      console.log(`[熔断器] ${provider} 服务熔断器重置`);
      health.circuitBreakerTripped = false;
      health.failureCount = 0;
      return true;
    }
    return false;
  }
  
  return true;
}

// 记录服务失败
function recordServiceFailure(provider) {
  const health = config.serviceHealth[provider];
  const now = Date.now();
  
  // 增加失败计数
  health.failureCount++;
  health.lastFailureTime = now;
  
  // 清除过期的错误计数（超出时间窗口的）
  const errorWindow = config.serviceHealthConfig.errorWindow;
  if (health.lastCheckTime && now - health.lastCheckTime > errorWindow) {
    console.log(`[熔断器] ${provider} 重置错误计数器，因为已超过错误窗口时间`);
    health.failureCount = 1; // 重置为1，因为当前这次错误
  }
  
  health.lastCheckTime = now;
  
  // 如果在错误窗口时间内失败次数超过最大错误数，触发熔断器
  if (health.failureCount > config.serviceHealthConfig.maxErrors) {
    console.error(`[熔断器警报] ${provider} 服务在${errorWindow/1000}秒内失败次数达到${health.failureCount}次，已超过阈值${config.serviceHealthConfig.maxErrors}，触发熔断器！`);
    health.circuitBreakerTripped = true;
    // 熔断器保持60秒
    health.circuitBreakerResetTime = now + 60000;
    health.failureCount = 0;
  }
}

module.exports = {
  config,
  ErrorTypes,
  ErrorCodes,
  handleError,
  checkCircuitBreaker,
  recordServiceFailure,
  globalRequestCounter
};
