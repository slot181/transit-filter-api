const rateLimiter = require('./rateLimit');
const { ErrorTypes, ErrorCodes } = require('../api/config');

/**
 * 速率限制中间件
 * @param {Object} req - 请求对象
 * @param {Object} res - 响应对象
 * @param {string} path - API路径
 * @returns {boolean} 如果请求被限制返回true，否则返回false
 */
async function rateLimitMiddleware(req, res, path) {
    // 获取客户端IP
    const ip = req.headers['x-forwarded-for'] ||
        req.connection.remoteAddress ||
        '0.0.0.0';

    // 检查速率限制
    if (await rateLimiter.isRateLimited(path, ip)) {
        const rateLimitInfo = rateLimiter.getRateLimitInfo(path, ip);

        // 设置速率限制响应头
        res.setHeader('X-RateLimit-Limit', rateLimitInfo.limit);
        res.setHeader('X-RateLimit-Remaining', rateLimitInfo.remaining);
        res.setHeader('X-RateLimit-Reset', rateLimitInfo.reset);

        // 返回429状态码
        res.statusCode = 429;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            error: {
                message: `请求过于频繁，请稍后再试。当前路径限制为每分钟${rateLimitInfo.limit}个请求。`,
                type: ErrorTypes.RATE_LIMIT,
                code: ErrorCodes.RATE_LIMIT_EXCEEDED,
                details: {
                    limit: rateLimitInfo.limit,
                    remaining: rateLimitInfo.remaining,
                    reset: rateLimitInfo.reset
                }
            }
        }));
        return true;
    }

    // 设置速率限制响应头
    const rateLimitInfo = rateLimiter.getRateLimitInfo(path, ip);
    res.setHeader('X-RateLimit-Limit', rateLimitInfo.limit);
    res.setHeader('X-RateLimit-Remaining', rateLimitInfo.remaining);
    res.setHeader('X-RateLimit-Reset', rateLimitInfo.reset);

    return false;
}

module.exports = rateLimitMiddleware;