/**
 * Limits the number of calls per time window, per key (e.g. the caller's IP)
 *
 *   const limiter = new RateLimiter({ limit: 60, windowMs: 60_000 });
 *   if (!limiter.allow(ip)) return 429;
 *
 * limit = 0 or Infinity → unlimited
 */
export const DEFAULT_RATE_LIMIT = {
  limit: 60,          // calls one key may make per window
  windowMs: 60_000,   // window length
  maxKeys: 100_000,   // max keys remembered (keeps memory bounded)
};

export class RateLimiter {
  #options;
  #hits = new Map();   // key → [timestamp, ...]

  constructor(options = {}) {
    this.#options = { ...DEFAULT_RATE_LIMIT, ...options };
  }

  get enabled() {
    const { limit } = this.#options;
    return Number.isFinite(limit) && limit > 0;
  }

  /** count this call and return true if still within the limit (rejected calls are not counted) */
  allow(key, { now = Date.now() } = {}) {
    if (!this.enabled) return true;
    const { limit, windowMs, maxKeys } = this.#options;
    const times = (this.#hits.get(key) ?? []).filter((time) => now - time < windowMs);
    if (times.length >= limit) {
      this.#hits.set(key, times);
      return false;
    }
    times.push(now);
    this.#hits.delete(key);          // move to the end of the Map → the least recently used key stays at the head
    this.#hits.set(key, times);
    if (this.#hits.size > maxKeys) this.#hits.delete(this.#hits.keys().next().value);
    return true;
  }

  /** seconds to wait before calling again (for the Retry-After header) */
  retryAfter(key, { now = Date.now() } = {}) {
    const times = this.#hits.get(key) ?? [];
    if (times.length < this.#options.limit) return 0;
    return Math.max(1, Math.ceil((times[0] + this.#options.windowMs - now) / 1000));
  }

  clear() {
    this.#hits.clear();
  }
}
