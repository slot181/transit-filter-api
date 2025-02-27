/**
 * 速率限制工具类
 * 用于按路径和IP限制API请求速率
 */
class RateLimiter {
    constructor() {
        this.requestCounts = {};
        this.windowStartTimes = {};
        this.limits = {};
        this.ipRequestCounts = {}; // 按IP跟踪请求
        this.ipWindowStartTimes = {}; // 按IP跟踪窗口开始时间

        // 初始化各路径的RPM限制
        this.limits['/v1/chat/completions'] = parseInt(process.env.CHAT_RPM || '60');
        this.limits['/v1/images/generations'] = parseInt(process.env.IMAGES_RPM || '20');
        this.limits['/v1/audio/transcriptions'] = parseInt(process.env.AUDIO_RPM || '20');
        this.limits['/v1/models'] = parseInt(process.env.MODELS_RPM || '100');

        // 全局IP限制 - 每分钟最多300个请求
        this.globalIpLimit = parseInt(process.env.GLOBAL_IP_RPM || '300');

        // 每分钟重置一次计数器
        setInterval(() => this.resetCounters(), 60000);
    }

    /**
     * 检查请求是否超过速率限制
     * @param {string} path - API路径
     * @param {string} ip - 客户端IP地址
     * @returns {boolean} 如果超过限制返回true，否则返回false
     */
    async isRateLimited(path, ip) {
        const now = Date.now();
        const pathKey = path;
        const ipKey = `${ip}`;
        const globalIpKey = `global:${ip}`;

        // 初始化路径的计数器和窗口开始时间
        if (!this.requestCounts[pathKey]) {
            this.requestCounts[pathKey] = 0;
            this.windowStartTimes[pathKey] = now;
        }

        // 初始化IP的计数器和窗口开始时间
        if (!this.ipRequestCounts[ipKey]) {
            this.ipRequestCounts[ipKey] = {};
        }
        if (!this.ipRequestCounts[ipKey][pathKey]) {
            this.ipRequestCounts[ipKey][pathKey] = 0;
            this.ipWindowStartTimes[ipKey] = this.ipWindowStartTimes[ipKey] || {};
            this.ipWindowStartTimes[ipKey][pathKey] = now;
        }

        // 初始化全局IP计数器
        if (!this.ipRequestCounts[globalIpKey]) {
            this.ipRequestCounts[globalIpKey] = 0;
            this.ipWindowStartTimes[globalIpKey] = now;
        }

        // 如果已经过了一分钟，重置该路径的计数器
        if (now - this.windowStartTimes[pathKey] > 60000) {
            this.requestCounts[pathKey] = 0;
            this.windowStartTimes[pathKey] = now;
        }

        // 如果已经过了一分钟，重置该IP+路径的计数器
        if (now - this.ipWindowStartTimes[ipKey][pathKey] > 60000) {
            this.ipRequestCounts[ipKey][pathKey] = 0;
            this.ipWindowStartTimes[ipKey][pathKey] = now;
        }

        // 如果已经过了一分钟，重置该IP的全局计数器
        if (now - this.ipWindowStartTimes[globalIpKey] > 60000) {
            this.ipRequestCounts[globalIpKey] = 0;
            this.ipWindowStartTimes[globalIpKey] = now;
        }

        // 增加请求计数
        this.requestCounts[pathKey]++;
        this.ipRequestCounts[ipKey][pathKey]++;
        this.ipRequestCounts[globalIpKey]++;

        // 获取该路径的RPM限制
        const pathLimit = this.limits[pathKey] || 60; // 默认全局特定路径RPM限制
        const ipPathLimit = Math.floor(pathLimit * 0.25); // IP特定路径RPM限制为全局特地路径RPM限制的25%
        const globalIpLimit = this.globalIpLimit; // 全局IP路径RPM限制

        // 检查是否超过任一限制
        const isPathLimited = this.requestCounts[pathKey] > pathLimit;
        const isIpPathLimited = this.ipRequestCounts[ipKey][pathKey] > ipPathLimit;
        const isGlobalIpLimited = this.ipRequestCounts[globalIpKey] > globalIpLimit;

        // 记录异常请求模式
        if (isPathLimited || isIpPathLimited || isGlobalIpLimited) {
            console.warn(`[速率限制] IP: ${ip}, 请求路径: ${path}, 全局路径计数: ${this.requestCounts[pathKey]}/${pathLimit}, IP路径计数: ${this.ipRequestCounts[ipKey][pathKey]}/${ipPathLimit}, 全局IP路径计数: ${this.ipRequestCounts[globalIpKey]}/${globalIpLimit}`);
        }

        return isPathLimited || isIpPathLimited || isGlobalIpLimited;
    }

    /**
     * 获取路径当前的请求计数和限制
     * @param {string} path - API路径
     * @param {string} ip - 客户端IP地址
     * @returns {Object} 包含当前计数和限制的对象
     */
    getRateLimitInfo(path, ip) {
        const pathKey = path;
        const ipKey = `${ip}`;
        const globalIpKey = `global:${ip}`;
        const pathLimit = this.limits[pathKey] || 60;
        const ipPathLimit = Math.max(Math.floor(pathLimit * 1.5), pathLimit);
        const globalIpLimit = this.globalIpLimit;

        // 计算剩余请求数（取三个限制中的最小值）
        const pathRemaining = Math.max(0, pathLimit - (this.requestCounts[pathKey] || 0));
        const ipPathRemaining = Math.max(0, ipPathLimit - ((this.ipRequestCounts[ipKey] && this.ipRequestCounts[ipKey][pathKey]) || 0));
        const globalIpRemaining = Math.max(0, globalIpLimit - (this.ipRequestCounts[globalIpKey] || 0));
        const remaining = Math.min(pathRemaining, ipPathRemaining, globalIpRemaining);

        // 计算重置时间（取三个窗口中最早的重置时间）
        const pathReset = Math.ceil((this.windowStartTimes[pathKey] || Date.now()) / 1000) + 60;
        const ipPathReset = Math.ceil(((this.ipWindowStartTimes[ipKey] && this.ipWindowStartTimes[ipKey][pathKey]) || Date.now()) / 1000) + 60;
        const globalIpReset = Math.ceil((this.ipWindowStartTimes[globalIpKey] || Date.now()) / 1000) + 60;
        const reset = Math.min(pathReset, ipPathReset, globalIpReset);

        return {
            current: this.requestCounts[pathKey] || 0,
            limit: pathLimit,
            remaining: remaining,
            reset: reset,
            details: {
                path: {
                    current: this.requestCounts[pathKey] || 0,
                    limit: pathLimit,
                    remaining: pathRemaining
                },
                ipPath: {
                    current: (this.ipRequestCounts[ipKey] && this.ipRequestCounts[ipKey][pathKey]) || 0,
                    limit: ipPathLimit,
                    remaining: ipPathRemaining
                },
                globalIp: {
                    current: this.ipRequestCounts[globalIpKey] || 0,
                    limit: globalIpLimit,
                    remaining: globalIpRemaining
                }
            }
        };
    }

    /**
     * 重置所有路径的计数器
     */
    resetCounters() {
        const now = Date.now();
        
        // 重置路径计数器
        for (const path in this.requestCounts) {
            if (now - this.windowStartTimes[path] > 60000) {
                this.requestCounts[path] = 0;
                this.windowStartTimes[path] = now;
            }
        }
        
        // 重置IP计数器
        for (const ip in this.ipRequestCounts) {
            if (ip.startsWith('global:')) {
                // 重置全局IP计数器
                if (now - this.ipWindowStartTimes[ip] > 60000) {
                    this.ipRequestCounts[ip] = 0;
                    this.ipWindowStartTimes[ip] = now;
                }
            } else {
                // 重置IP+路径计数器
                for (const path in this.ipRequestCounts[ip]) {
                    if (this.ipWindowStartTimes[ip] && now - this.ipWindowStartTimes[ip][path] > 60000) {
                        this.ipRequestCounts[ip][path] = 0;
                        this.ipWindowStartTimes[ip][path] = now;
                    }
                }
            }
        }
        
        // 清理超过5分钟未活动的IP记录，防止内存泄漏
        this.cleanupInactiveIps(now);
    }
    
    /**
     * 清理不活跃的IP记录
     * @param {number} now - 当前时间戳
     */
    cleanupInactiveIps(now) {
        const inactiveThreshold = 300000; // 5分钟
        
        for (const ip in this.ipRequestCounts) {
            let isActive = false;
            
            if (ip.startsWith('global:')) {
                // 检查全局IP是否活跃
                if (now - this.ipWindowStartTimes[ip] < inactiveThreshold) {
                    isActive = true;
                }
            } else {
                // 检查IP+路径是否活跃
                for (const path in this.ipWindowStartTimes[ip]) {
                    if (now - this.ipWindowStartTimes[ip][path] < inactiveThreshold) {
                        isActive = true;
                        break;
                    }
                }
            }
            
            // 如果IP不活跃，删除相关记录
            if (!isActive) {
                delete this.ipRequestCounts[ip];
                delete this.ipWindowStartTimes[ip];
            }
        }
    }
}

// 创建单例实例
const rateLimiter = new RateLimiter();

module.exports = rateLimiter;
