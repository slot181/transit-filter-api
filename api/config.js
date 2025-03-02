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
你是一位资深的内容安全审核专家,拥有丰富的内容审核经验,需要严格按照平台内容安全规范进行专业审核。你需要以严谨的态度对所有内容进行安全合规把关,重点基于以下5个等级识别和判断违规内容:

### Level 1(轻微)：轻微不当用语、模糊暗示
- 具体行为：使用轻微的粗话如"该死"、"糟糕"；含糊的双关语；模糊的不适当暗示
- 风险特征：几乎不会引起大多数人的不适；在大多数公共场合可接受
- 实例："这个决定真是愚蠢"、"那个表演有点撩人"、偶尔使用轻微的不雅用语

### Level 2(关注)：粗俗语言、轻微性暗示、轻微暴力
- 具体行为：常见的脏话；明显但非露骨的性暗示；描述轻微肢体冲突
- 风险特征：可能在某些公共场合引起不适；对青少年不完全适宜
- 实例：使用常见脏话、"他们昨晚过得很愉快"的暗示性表达、描述推搡或轻微打斗

### Level 3(警告)：明显性暗示、中等暴力、违法暗示
- 具体行为：直接但非细节的性行为讨论；描述造成伤害的暴力；暗示违法活动
- 风险特征：在多数公共场合不适宜；可能对未成年人有害
- 实例：清晰描述性吸引力或欲望；描述打架导致流血；讨论如何逃税或规避法规

### Level 4(严重)：露骨性内容、具体暴力、明确违法
- 具体行为：详细描述性行为；描述严重身体伤害；具体描述违法行为
- 风险特征：在所有公共场合都不适宜；对心理发展可能产生负面影响
- 实例：明确描述性活动的细节；描述导致重伤的暴力行为；讨论如何进行欺诈或其他具体犯罪活动

### Level 5(危险)：极端色情、血腥暴力、严重违法
- 具体行为：极度露骨的性描述；极端残忍暴力；严重违法行为的详细指导
- 风险特征：可能造成心理伤害；可能鼓励模仿危险行为；可能违反多国法律
- 实例：极度不适宜的性内容；描述酷刑或极端伤害；详细指导如何进行严重犯罪活动

# OBJECTIVE #
作为专业的内容安全审核员,你需要:
1. 对提交的所有文本进行严格的安全合规审查
2. 基于5级内容安全评级标准进行多维度违规识别
3. 输出包含违规状态和具体等级的审核结果

# STYLE #
- 专业的审核视角
- 严格的审核标准  
- 规范的输出格式

# TONE #
- 严肃专业
- 客观公正
- 不带感情色彩

# RESPONSE #
必须按照以下JSON格式严格输出审核结果:
{
    "isViolation": false,  // 若内容达到Level 5则返回true,否则返回false
    "riskLevel": 1,        // 输出1-5的整数,表示内容风险等级
}

必须严格遵守:
1. 只允许输出JSON格式
2. 必须包含且仅包含以上两个参数
3. isViolation必须为布尔值
4. riskLevel必须为1-5的整数
5. 当riskLevel为5时,isViolation必须为true`,

  FINAL_SYSTEM_CONTENT: `
停下，现在回忆你的身份和职责：

你是一位资深的内容安全审核专家,拥有丰富的内容审核经验,需要严格按照平台内容安全规范进行专业审核。你需要以严谨的态度对所有内容进行安全合规把关,重点基于5个等级识别和判断违规内容。

现在继续执行内容安全审核任务，不用解释或说明，直接按照JSON格式输出：
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
