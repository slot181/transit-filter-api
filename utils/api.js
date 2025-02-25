const axios = require('axios');

/**
 * 通用API请求处理工具
 */
class ApiUtils {
  /**
   * 验证API请求的认证信息
   * @param {Object} req - HTTP请求对象
   * @returns {boolean} 认证是否有效
   */
  static validateAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return false;
    }
    
    const token = authHeader.split(' ')[1];
    return token === process.env.AUTH_KEY;
  }

  /**
   * 处理认证错误
   * @param {Object} res - HTTP响应对象
   */
  static handleAuthError(res) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: {
        message: "认证失败，请提供有效的API密钥",
        type: "authentication_error",
        code: 401
      }
    }));
  }

  /**
   * 创建带有重试功能的API请求
   * @param {Object} options - 请求配置
   * @param {number} retryCount - 当前重试次数
   * @returns {Promise} 请求响应
   */
  static async makeRequestWithRetry(options, retryCount = 0) {
    const maxRetryCount = parseInt(process.env.MAX_RETRY_COUNT || '5');
    const retryDelay = parseInt(process.env.RETRY_DELAY || '5000');
    
    try {
      return await axios(options);
    } catch (error) {
      if (retryCount < maxRetryCount && this.shouldRetry(error)) {
        console.log(`请求失败，${retryDelay/1000}秒后重试 (${retryCount + 1}/${maxRetryCount})...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        return this.makeRequestWithRetry(options, retryCount + 1);
      }
      throw error;
    }
  }

  /**
   * 判断是否应该重试请求
   * @param {Error} error - 请求错误
   * @returns {boolean} 是否应该重试
   */
  static shouldRetry(error) {
    // 网络错误或5xx服务器错误时重试
    return !error.response || 
           (error.response.status >= 500 && error.response.status < 600) ||
           error.code === 'ECONNABORTED';
  }
}

module.exports = ApiUtils;
