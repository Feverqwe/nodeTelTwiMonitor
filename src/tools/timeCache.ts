const QuickLRU = require('quick-lru');

class TimeCache<KeyType extends unknown, ValueType extends unknown> extends QuickLRU {
  private readonly ttl: number;
  constructor(options: typeof QuickLRU.Options) {
    super(options);
    this.ttl = options.ttl;
  }

  get(key: KeyType) {
    let result = super.get(key);
    if (result && result.expiresAt < Date.now()) {
      this.delete(key);
      result = undefined;
    }
    return result && result.data;
  }

  set(key: KeyType, value: ValueType) {
    return super.set(key, {
      data: value,
      expiresAt: Date.now() + this.ttl
    });
  }
}

export default TimeCache;