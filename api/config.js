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
  threshold: 500, // 1秒内超过500个请求视为异常
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
      // 完全简化，不需要任何熔断相关字段
      isHealthy: true
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
  // 如果是审核服务提供商，只检查主服务提供商的熔断状态
  if (provider === 'firstProvider') {
    const mainServiceHealth = config.serviceHealth['secondProvider'];
    // 检查主服务熔断器是否已到期
    if (mainServiceHealth.circuitBreakerTripped && Date.now() > mainServiceHealth.circuitBreakerResetTime) {
      console.log(`[熔断器] 主服务熔断器已到期，重置熔断状态，时间：${new Date().toISOString()}`);
      mainServiceHealth.circuitBreakerTripped = false;
      mainServiceHealth.failureCount = 0;
    }
    
    // 如果主服务熔断，审核服务也熔断
    if (mainServiceHealth.circuitBreakerTripped) {
      console.log(`[熔断器] 审核服务跟随主服务熔断状态，当前主服务已熔断`);
      return false;
    }
    return true;
  }
  
  // 以下处理主服务熔断状态
  const health = config.serviceHealth[provider];
  
  // 检查熔断器是否已到期
  if (health.circuitBreakerTripped && Date.now() > health.circuitBreakerResetTime) {
    console.log(`[熔断器] ${provider} 服务熔断器已到期，重置熔断状态，时间：${new Date().toISOString()}`);
    health.circuitBreakerTripped = false;
    health.failureCount = 0;
    return true;
  }
  
  return !health.circuitBreakerTripped;
}

// 记录服务失败
function recordServiceFailure(provider) {
  // 如果是审核服务商，直接返回不做处理
  if (provider === 'firstProvider') {
    return;
  }
  
  // 只处理主服务商的失败记录
  const health = config.serviceHealth[provider];
  const now = Date.now();
  
  // 添加此段：检查是否超过错误窗口时间，如果超过则重置计数
  if (health.lastFailureTime > 0 && now - health.lastFailureTime > config.serviceHealthConfig.errorWindow) {
    console.log(`[熔断器] ${provider} 服务错误窗口期已过(${config.serviceHealthConfig.errorWindow/1000}秒)，重置错误计数`);
    health.failureCount = 0;
  }
  
  // 增加失败计数
  health.failureCount++;
  health.lastFailureTime = now;
  health.lastCheckTime = now;
  
  // 触发熔断器的条件判断
  if (health.failureCount > config.serviceHealthConfig.maxErrors) {
    console.error(`[熔断器警报] ${provider} 主服务在 ${config.serviceHealthConfig.errorWindow/1000} 秒内失败 ${health.failureCount} 次，已超过阈值 ${config.serviceHealthConfig.maxErrors}，触发熔断`);
    health.circuitBreakerTripped = true;
    health.circuitBreakerResetTime = now + 60000; // 熔断60秒
    health.failureCount = 0;
    console.log(`[熔断器] 主服务已熔断，将在 ${new Date(health.circuitBreakerResetTime).toISOString()} 恢复`);
  }
}

// 定时检查熔断器状态，自动重置过期的熔断器
const circuitBreakerCheckInterval = setInterval(() => {
  const now = Date.now();
  
  // 只检查主服务熔断器状态
  const mainServiceHealth = config.serviceHealth['secondProvider'];
  if (mainServiceHealth.circuitBreakerTripped && now > mainServiceHealth.circuitBreakerResetTime) {
    console.log(`[定时器] 主服务熔断器已到期，自动重置，当前时间：${new Date().toISOString()}`);
    mainServiceHealth.circuitBreakerTripped = false;
    mainServiceHealth.failureCount = 0;
  }
  
  // 添加此段：检查错误计数时间窗口
  if (!mainServiceHealth.circuitBreakerTripped && 
      mainServiceHealth.lastFailureTime > 0 && 
      now - mainServiceHealth.lastFailureTime > config.serviceHealthConfig.errorWindow) {
    console.log(`[定时器] 主服务错误计数窗口(${config.serviceHealthConfig.errorWindow/1000}秒)已过期，自动重置，当前时间：${new Date().toISOString()}`);
    mainServiceHealth.failureCount = 0;
  }
}, 10000); // 每10秒检查一次

// 处理进程退出时清理定时器
process.on('exit', () => {
  clearInterval(circuitBreakerCheckInterval);
});

// 审核提示词配置
const moderationPrompts = {
  DEFAULT_SYSTEM_CONTENT: `
# CONTEXT #
你作为一位资深的内容安全审核专家，专门负责对内容进行5级风险评估。你拥有多年审核经验，深谙各类违规内容的判定标准。你深知一个内容的风险等级判定可能会影响到整个平台的安全运营，因此必须保持高度专注，确保每次评级的准确性。

# OBJECTIVE #
在每次进行内容审核时，你必须：
1. 准确识别和区分不同级别的违规内容
2. 熟练运用5级评级标准进行判断
3. 对达到Level 5级别的危险内容保持高度警惕
4. 确保评级结果的准确性和isViolation判断的严谨性

# STYLE #
- 始终保持专业审核视角
- 严格遵循分级评估标准
- 对危险边界保持敏锐判断

# TONE #
- 保持理性客观
- 专业而严谨
- 不掺杂个人情感

# AUDIENCE #
面向平台内容安全管理系统，输出规范的JSON格式审核结果

# RESPONSE #
在每次审核前，确认：
1. 我熟知5个风险等级的具体标准：
   - Level 1(轻微): 轻微不当用语、模糊暗示
   - Level 2(关注): 粗俗语言、轻微性暗示、轻微暴力
   - Level 3(警告): 明显性暗示、中等暴力、违法暗示
   - Level 4(严重): 露骨性内容、具体暴力、明确违法
   - Level 5(危险): 极端色情、血腥暴力、严重违法

2. 我将严格按照JSON格式输出结果：
{
    "isViolation": false,  // Level 5时必须为true
    "riskLevel": 1        // 1-5级评定
}

3. 我将确保：
   - 评级准确性
   - 格式规范性
   - Level 5时必须触发违规标记（其它等级不触发）
   - 不输出任何额外说明`,

  FINAL_SYSTEM_CONTENT: `
停下，现在回忆你的身份和职责：
# CONTEXT #
你作为一位资深的内容安全审核专家，专门负责对内容进行5级风险评估。你拥有多年审核经验，深谙各类违规内容的判定标准。你深知一个内容的风险等级判定可能会影响到整个平台的安全运营，因此必须保持高度专注，确保每次评级的准确性。

# OBJECTIVE #
在每次进行内容审核时，你必须：
1. 准确识别和区分不同级别的违规内容
2. 熟练运用5级评级标准进行判断
3. 对达到Level 5级别的危险内容保持高度警惕
4. 确保评级结果的准确性和isViolation判断的严谨性

# STYLE #
- 始终保持专业审核视角
- 严格遵循分级评估标准
- 对危险边界保持敏锐判断

# TONE #
- 保持理性客观
- 专业而严谨
- 不掺杂个人情感

# AUDIENCE #
面向平台内容安全管理系统，输出规范的JSON格式审核结果

# RESPONSE #
在每次审核前，确认：
1. 我熟知5个风险等级的具体标准：
   - Level 1(轻微): 轻微不当用语、模糊暗示
   - Level 2(关注): 粗俗语言、轻微性暗示、轻微暴力
   - Level 3(警告): 明显性暗示、中等暴力、违法暗示
   - Level 4(严重): 露骨性内容、具体暴力、明确违法
   - Level 5(危险): 极端色情、血腥暴力、严重违法

2. 我将严格按照JSON格式输出结果：
{
    "isViolation": false,  // Level 5时必须为true
    "riskLevel": 1        // 1-5级评定
}

3. 我将确保：
   - 评级准确性
   - 格式规范性
   - Level 5时必须触发违规标记（其它等级不触发）
   - 不输出任何额外说明

现在开始继续执行内容安全审核任务，不用解释或说明，直接按照JSON格式输出：
`
};

module.exports = {
  config,
  ErrorTypes,
  ErrorCodes,
  handleError,
  checkCircuitBreaker,
  recordServiceFailure,
  globalRequestCounter,
  moderationPrompts
};
