/**
 * 请求限制中间件
 * 基于请求路径和参数进行限制，而不是IP（因为请求可能通过代理转发）
 */
class RateLimiter {
  constructor(options = {}) {
    // 每个key的最大请求数
    this.maxRequests = options.maxRequests || 100;
    // 时间窗口（毫秒）
    this.windowMs = options.windowMs || 60000; // 默认1分钟
    // 存储请求记录
    this.requests = new Map();
    // 清理间隔
    this.cleanupInterval = null;

    // 启动清理任务
    this.startCleanup();
  }

  /**
   * 生成请求的唯一key（基于路径和参数）
   */
  getKey(req) {
    const path = req.path || req.url.split('?')[0];
    const params = req.params || {};
    const query = req.query || {};

    // 对于地址相关的请求，使用地址作为key的一部分
    let key = path;

    if (params.hash) {
      key += `:${params.hash}`;
    }
    if (query.address) {
      key += `:${query.address}`;
    }
    if (params.name) {
      key += `:${params.name}`;
    }

    return key;
  }

  /**
   * 检查是否超过限制
   */
  check(key) {
    const now = Date.now();
    const record = this.requests.get(key);

    if (!record) {
      // 第一次请求
      this.requests.set(key, {
        count: 1,
        resetTime: now + this.windowMs
      });
      return { allowed: true, remaining: this.maxRequests - 1 };
    }

    // 检查是否在时间窗口内
    if (now > record.resetTime) {
      // 时间窗口已过，重置
      record.count = 1;
      record.resetTime = now + this.windowMs;
      return { allowed: true, remaining: this.maxRequests - 1 };
    }

    // 增加计数
    record.count++;

    if (record.count > this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: record.resetTime
      };
    }

    return {
      allowed: true,
      remaining: this.maxRequests - record.count
    };
  }

  /**
   * 中间件函数
   */
  middleware() {
    return (req, res, next) => {
      const key = this.getKey(req);
      const result = this.check(key);

      // 设置响应头
      res.setHeader('X-RateLimit-Limit', this.maxRequests);
      res.setHeader('X-RateLimit-Remaining', result.remaining);
      if (result.resetTime) {
        res.setHeader('X-RateLimit-Reset', Math.ceil(result.resetTime / 1000));
      }

      if (!result.allowed) {
        return res.status(429).json({
          error: 'Too Many Requests',
          message: `Rate limit exceeded. Try again after ${Math.ceil((result.resetTime - Date.now()) / 1000)} seconds.`
        });
      }

      next();
    };
  }

  /**
   * 启动清理任务，定期清理过期的记录
   */
  startCleanup() {
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, record] of this.requests.entries()) {
        if (now > record.resetTime) {
          this.requests.delete(key);
        }
      }
    }, this.windowMs);
  }

  /**
   * 停止清理任务
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.requests.clear();
  }
}

module.exports = RateLimiter;
