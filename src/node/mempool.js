/**
 * คิว tx ฝั่ง server: จำกัดจำนวน, กัน tx ซ้ำ, ทิ้งใบที่ค้างนาน และเรียงตาม gasPrice
 *
 *   const mempool = new Mempool(vm, { maxPerSender: 16, maxSize: 5000, ttlMs: 5 * 60_000 });
 *   mempool.add({ tx, signature });      // → { ok, hash, reason }
 *   mempool.take(block);                 // หยิบใบที่พร้อม ใส่เข้า block
 *   mempool.remove(hashes);              // ลบใบที่เข้า block แล้ว
 */
import { sortPendingTransactions } from "../core/virtualmachine.js";
import { verifyTransaction } from "../crypto/signature.js";

export const DEFAULT_MEMPOOL = {
  maxPerSender: 16,        // จำนวนใบที่ address เดียวค้างในคิวได้
  maxSize: 5000,           // จำนวนใบทั้งคิว
  ttlMs: 5 * 60_000,       // อายุของใบที่ยังไม่เข้า block
  rateWindowMs: 60_000,    // ช่วงเวลาที่นับ rate limit
  rateLimit: 60,           // จำนวน tx ที่ address เดียวส่งได้ต่อช่วงเวลา
};

export class Mempool {
  #vm;
  #options;
  #items = new Map();              // hash → { tx, signature, sender, method, request, receivedAt }
  #recent = new Map();             // sender → [timestamp, ...] สำหรับ rate limit
  #seen = new Map();               // hash → เวลาที่เคยเห็น (กันส่งซ้ำแม้เข้า block ไปแล้ว)

  constructor(vm, options = {}) {
    this.#vm = vm;
    this.#options = { ...DEFAULT_MEMPOOL, ...options };
  }

  get size() {
    return this.#items.size;
  }

  /** ใบที่รออยู่ (ข้อมูลย่อสำหรับ /pending) */
  list() {
    return [...this.#items.values()].map(({ hash, sender, tx, receivedAt }) =>
      ({ hash, sender, action: tx.action, nonce: tx.nonce, gasPrice: tx.gasPrice ?? null, receivedAt }));
  }

  has(hash) {
    return this.#items.has(hash);
  }

  /** จำนวนใบของ address นี้ที่รออยู่ */
  countOf(sender) {
    let count = 0;
    for (const item of this.#items.values()) if (item.sender === sender) count += 1;
    return count;
  }

  /** nonce ถัดไปที่ address นี้ควรใช้ (นับใบที่รออยู่ด้วย) */
  nextNonce(address) {
    const sender = String(address).toLowerCase();
    const { expectedNonce } = this.#vm.checkTransaction({ from: sender, nonce: -1 });
    return (expectedNonce ?? 0) + this.countOf(sender);
  }

  /**
   * รับ tx เข้าคิว: ตรวจลายเซ็น, rate limit, โควตา, ลำดับ nonce
   *
   * simulate (ถ้าส่งมา) ถูกเรียกหลังผ่านการตรวจราคาถูกทั้งหมดแล้วเท่านั้น
   * และครั้งที่ simulate ไม่ผ่านก็ถูกนับใน rate limit ด้วย → ยิง tx ที่รันนานซ้ำ ๆ ไม่ได้
   *   simulate(verified) → { ok, ... }   ผลถูกส่งกลับใน simulation
   *
   * @returns {{ ok: boolean, hash?: string, sender?: string, reason?: string, expectedNonce?: number, simulation?: object }}
   */
  add({ tx, signature }, { now = Date.now(), simulate } = {}) {
    let verified;
    try {
      verified = verifyTransaction({ tx, signature });
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    const { sender, hash, method, request } = verified;

    this.prune({ now });
    if (this.#seen.has(hash)) return { ok: false, hash, sender, reason: "tx นี้ถูกส่งมาแล้ว" };
    if (this.#items.size >= this.#options.maxSize) return { ok: false, hash, sender, reason: "คิวเต็ม" };
    if (!this.#allowRate(sender, now)) return { ok: false, hash, sender, reason: "ส่งถี่เกินกำหนด" };

    const inQueue = this.countOf(sender);
    if (inQueue >= this.#options.maxPerSender) return { ok: false, hash, sender, reason: "คิวของ address นี้เต็ม" };

    const expectedNonce = (this.#vm.checkTransaction(request).expectedNonce ?? 0) + inQueue;
    if (this.#vm.requireNonce && tx.nonce !== expectedNonce) {
      return { ok: false, hash, sender, reason: `nonce ต้องเป็น ${expectedNonce}`, expectedNonce };
    }

    this.#recent.set(sender, [...(this.#recent.get(sender) ?? []), now]);
    let simulation;
    if (simulate) {
      simulation = simulate(verified);
      if (!simulation.ok) return { ok: false, hash, sender, reason: simulation.error ?? "ประเมินผลไม่ผ่าน", simulation };
    }

    this.#items.set(hash, { tx, signature, hash, sender, method, request, receivedAt: now });
    this.#seen.set(hash, now);
    return simulation ? { ok: true, hash, sender, simulation } : { ok: true, hash, sender };
  }

  /** ใส่ tx ที่พร้อมลงใน block ตามลำดับราคา → คืน hash ที่ใส่ไปแล้ว */
  take(block, { limit = Infinity } = {}) {
    const included = [];
    for (const item of sortPendingTransactions([...this.#items.values()])) {
      if (included.length >= limit) break;
      if (!block.checkTransaction(item.request).ok) continue;   // nonce ยังไม่ถึงคิว หรือโควตา block เต็ม
      block[item.method](item.request);
      included.push(item.hash);
    }
    this.remove(included);
    return included;
  }

  remove(hashes) {
    for (const hash of hashes) this.#items.delete(hash);
  }

  /** ทิ้งใบที่ค้างเกิน ttl และล้างประวัติที่พ้นช่วงเวลาแล้ว */
  prune({ now = Date.now() } = {}) {
    const dropped = [];
    for (const [hash, item] of this.#items) {
      if (now - item.receivedAt > this.#options.ttlMs) {
        this.#items.delete(hash);
        dropped.push(hash);
      }
    }
    for (const [sender, times] of this.#recent) {
      const kept = times.filter((time) => now - time < this.#options.rateWindowMs);
      if (kept.length) this.#recent.set(sender, kept);
      else this.#recent.delete(sender);
    }
    for (const [hash, time] of this.#seen) {
      if (now - time > this.#options.ttlMs * 2) this.#seen.delete(hash);
    }
    return dropped;
  }

  clear() {
    this.#items.clear();
    this.#recent.clear();
    this.#seen.clear();
  }

  #allowRate(sender, now) {
    const times = (this.#recent.get(sender) ?? []).filter((time) => now - time < this.#options.rateWindowMs);
    this.#recent.set(sender, times);
    return times.length < this.#options.rateLimit;
  }
}
