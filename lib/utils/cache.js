class Cache {
  constructor(ttl) {
      this.data = new Map();
      this.ttl = ttl;
      this.check();
  }

  /**
   * 设置缓存键值对，如果key已经存在，则会覆盖。
   * @param {string} key 键
   * @param {object} value 值
   * @param {number} ttl 过期时间，秒计
   */
  set(key, value, ttl) {
      ttl = ttl ? ttl : this.ttl;
      const now = Date.now() / 1000;
      this.data.set(key, {
          time: now + ttl,
          value
      });
  }

  /**
   * 删除键值对
   * @param {string} key 键
   */
  del(key) {
      this.data.delete(key);
  }

  /**
   * 获取缓存键值对，如果不存在或已过期，返回false
   * @param {string} key 
   */
  get(key) {
      const now = Date.now() / 1000;
      const info = this.data.get(key);

      if (!info) {
          return false;
      } else if (!info.time || !info.value || info.time < now) {
          this.data.delete(key);
          return false;
      }

      return info.value;
  }

  /** 定时检查是否有过期的数据，如果有就删除 */
  check() {
      setInterval(() => {
          const now = Date.now() / 1000;
          this.data.forEach((info, key) => {
              if (!info || !info.value || !info.time || info.value < now) {
                  this.data.delete(key);
              }
          });
      }, 30 * 60 * 1000);
  }
}

module.exports = Cache;