/**
 * จำกัดจำนวนครั้งต่อช่วงเวลา แยกตาม key (เช่น IP ของผู้เรียก)
 *
 *   const limiter = new RateLimiter({ limit: 60, windowMs: 60_000 });
 *   if (!limiter.allow(ip)) return 429;
 *
 * limit = 0 หรือ Infinity → ไม่จำกัด
 */
export const DEFAULT_RATE_LIMIT = {
  limit: 60,          // จำนวนครั้งที่ key เดียวเรียกได้ต่อช่วงเวลา
  windowMs: 60_000,   // ช่วงเวลาที่นับ
  maxKeys: 100_000,   // จำนวน key สูงสุดที่จำไว้ (กันหน่วยความจำโตไม่จำกัด)
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

  /** นับครั้งนี้และคืน true ถ้ายังไม่เกินกำหนด (ครั้งที่ถูกปฏิเสธไม่ถูกนับ) */
  allow(key, { now = Date.now() } = {}) {
    if (!this.enabled) return true;
    const { limit, windowMs, maxKeys } = this.#options;
    const times = (this.#hits.get(key) ?? []).filter((time) => now - time < windowMs);
    if (times.length >= limit) {
      this.#hits.set(key, times);
      return false;
    }
    times.push(now);
    this.#hits.delete(key);          // ย้ายไปท้าย Map → key ที่ไม่ได้ใช้นานสุดอยู่หัว
    this.#hits.set(key, times);
    if (this.#hits.size > maxKeys) this.#hits.delete(this.#hits.keys().next().value);
    return true;
  }

  /** วินาทีที่ต้องรอก่อนเรียกได้อีก (ไว้ใส่ header Retry-After) */
  retryAfter(key, { now = Date.now() } = {}) {
    const times = this.#hits.get(key) ?? [];
    if (times.length < this.#options.limit) return 0;
    return Math.max(1, Math.ceil((times[0] + this.#options.windowMs - now) / 1000));
  }

  clear() {
    this.#hits.clear();
  }
}
