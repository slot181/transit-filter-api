/**
 * 速率限制工具类
 * 用于按路径限制API请求速率
 */
class RateLimiter {
    constructor() {
        this.requestCounts = {};
        this.windowStartTimes = {};
        this.limits = {};

        // 初始化各路径的RPM限制
        this.limits['/v1/chat/completions'] = parseInt(process.env.CHAT_RPM || '60');
        this.limits['/v1/images/generations'] = parseInt(process.env.IMAGES_RPM || '20');
        this.limits['/v1/audio/transcriptions'] = parseInt(process.env.AUDIO_RPM || '20');
        this.limits['/v1/models'] = parseInt(process.env.MODELS_RPM || '100');

        // 每分钟重置一次计数器
        setInterval(() => this.resetCounters(), 60000);
    }

    /**
     * 检查请求是否超过速率限制
     * @param {string} path - API路径
     * @returns {boolean} 如果超过限制返回true，否则返回false
     */
    isRateLimited(path) {
        const now = Date.now();

        // 初始化路径的计数器和窗口开始时间
        if (!this.requestCounts[path]) {
            this.requestCounts[path] = 0;
            this.windowStartTimes[path] = now;
        }

        // 如果已经过了一分钟，重置该路径的计数器
        if (now - this.windowStartTimes[path] > 60000) {
            this.requestCounts[path] = 0;
            this.windowStartTimes[path] = now;
        }

        // 增加请求计数
        this.requestCounts[path]++;

        // 获取该路径的RPM限制
        const limit = this.limits[path] || 60; // 默认为每分钟60个请求

        // 检查是否超过限制
        return this.requestCounts[path] > limit;
    }

    /**
     * 获取路径当前的请求计数和限制
     * @param {string} path - API路径
     * @returns {Object} 包含当前计数和限制的对象
     */
    getRateLimitInfo(path) {
        return {
            current: this.requestCounts[path] || 0,
            limit: this.limits[path] || 60,
            remaining: Math.max(0, (this.limits[path] || 60) - (this.requestCounts[path] || 0)),
            reset: Math.ceil((this.windowStartTimes[path] || Date.now()) / 1000) + 60
        };
    }

    /**
     * 重置所有路径的计数器
     */
    resetCounters() {
        const now = Date.now();
        for (const path in this.requestCounts) {
            if (now - this.windowStartTimes[path] > 60000) {
                this.requestCounts[path] = 0;
                this.windowStartTimes[path] = now;
            }
        }
    }
}

// 创建单例实例
const rateLimiter = new RateLimiter();

module.exports = rateLimiter;