/**
 * คิว tx ฝั่ง server: จำกัดจำนวน, กัน tx ซ้ำ, ทิ้งใบที่ค้างนาน และเรียงตาม gasPrice
 *
 *   const mempool = new Mempool(vm, { maxPerSender: 16, maxSize: 5000, ttlMs: 5 * 60_000 });
 *   mempool.add({ tx, signature });      // → { ok, hash, reason }
 *   mempool.take(block);                 // หยิบใบที่พร้อม ใส่เข้า block
 *   mempool.remove(hashes);              // ลบใบที่เข้า block แล้ว
 *   mempool.replacedBy(hash);            // ใบที่ถูกแทนที่ → hash ของใบใหม่ (จำไว้ ttlMs · ส่ง replacedLog = จำถาวรแบบมีเพดาน)
 *
 * tx ที่ถูกปฏิเสธ (ผ่านการตรวจลายเซ็นแล้วแต่ไม่ได้รัน) ถูกจำไว้ตามลำดับที่เกิด แล้ว take() ใส่ลง block ถัดไป
 * (block.recordRejected · ไม่เกิน maxRejectedPerBlock ต่อ block ที่เกินยกไป block ถัดไป) → explorer / GET /tx ตอบ "rejected" จากข้อมูลเชน
 *   stage: "sendtx" (ปฏิเสธตอนรับเข้าคิว: nonce ผิด / โควตาเต็ม / ส่งถี่ / simulate ไม่ผ่าน)
 *          "block"  (VM ไม่รับตอนปิด block เช่น TIMEOUT / แก๊สของ block เต็ม)
 *          "expired" (ค้างในคิวเกิน ttlMs)
 *   tx ที่ลายเซ็นผิด / ส่งซ้ำ ไม่ถูกบันทึก (hash / sender เชื่อไม่ได้ หรือมีสถานะจริงอยู่แล้ว)
 *
 * replacedLog (ไม่บังคับ · ดู src/node/txlog.js): ใบที่ถูกแทนที่ → { hash, replacedBy, sender, nonce, at } บันทึกแบบ off-chain
 * (การแทนที่เป็นเรื่องปกติ ไม่ใช่การปฏิเสธ จึงไม่เข้า block) · มีไฟล์ = อยู่รอด restart
 *
 * การแทนที่ (replace-by-fee): ส่ง nonce เดิมของใบที่ยังรออยู่ + gasPrice สูงกว่าเดิมอย่างน้อย replaceBumpPercent %
 * ใบใหม่จะเป็น action อะไรก็ได้ → ยกเลิกใบเดิมได้ด้วยการโอน 0 ให้ตัวเอง
 */
import { sortPendingTransactions, parseNative } from "../core/virtualmachine.js";
import { verifyTransaction } from "../crypto/signature.js";

export const DEFAULT_MEMPOOL = {
  maxPerSender: 16,        // จำนวนใบที่ address เดียวค้างในคิวได้
  maxSize: 5000,           // จำนวนใบทั้งคิว
  ttlMs: 5 * 60_000,       // อายุของใบที่ยังไม่เข้า block
  rateWindowMs: 60_000,    // ช่วงเวลาที่นับ rate limit
  rateLimit: 60,           // จำนวน tx ที่ address เดียวส่งได้ต่อช่วงเวลา
  replaceBumpPercent: 10,  // แทนที่ใบที่รออยู่ (nonce เดิม) ได้เมื่อ gasPrice ใหม่ ≥ เดิม × (100 + ค่านี้) / 100
  maxRejectedPerBlock: 1000,   // tx ที่ถูกปฏิเสธที่ใส่ลง block ได้ต่อ block (ที่เกินรอ block ถัดไป)
  maxRejectedQueue: 100_000,   // จำได้สูงสุดเท่านี้ระหว่างรอเข้า block (เกิน = ทิ้งอันเก่าสุด)
  recordRejected: true,        // false = ไม่จำ tx ที่ถูกปฏิเสธ
  replacedLog: null,       // TxLog ของใบที่ถูกแทนที่ (ไม่ส่ง = จำในหน่วยความจำ ttlMs อย่างเดียว)
};

const DUPLICATE = "tx นี้ถูกส่งมาแล้ว";
export const EXPIRED_REASON = "ค้างในคิวเกินเวลาที่กำหนด (ไม่ได้เข้า block)";

export class Mempool {
  #vm;
  #options;
  #items = new Map();              // hash → { tx, signature, sender, method, request, receivedAt }
  #recent = new Map();             // sender → [timestamp, ...] สำหรับ rate limit
  #seen = new Map();               // hash → เวลาที่เคยเห็น (กันส่งซ้ำแม้เข้า block ไปแล้ว)
  #byNonce = new Map();            // "sender:nonce" → hash ของใบที่รออยู่ (หาใบที่จะถูกแทนที่)
  #replaced = new Map();           // hash เดิม → { replacedBy, at } จำไว้ ttlMs ให้ GET /tx/:hash ตอบได้
  #rejections = new Map();         // hash → entry ของ tx ที่ถูกปฏิเสธ รอใส่ลง block ถัดไป (ตามลำดับที่เกิด)

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
   * nonce รับได้ในช่วง [nonce บนเชน, nonce บนเชน + จำนวนที่รออยู่]:
   *   = ถัดไป              → ต่อท้ายคิว
   *   = ใบที่รออยู่ของคนเดิม → แทนที่ (ดู #replace) · ผลมี replaced: hash ของใบเดิม
   *
   * @returns {{ ok: boolean, hash?: string, sender?: string, reason?: string, expectedNonce?: number, replaced?: string, simulation?: object }}
   */
  add({ tx, signature }, { now = Date.now(), simulate } = {}) {
    const result = this.#add({ tx, signature }, { now, simulate });
    // ลายเซ็นผิด = ไม่มี hash / sender ที่เชื่อได้ · ส่งซ้ำ = hash นี้มีสถานะจริงอยู่แล้ว (รอ / เข้า block / ถูกแทนที่)
    if (!result.ok && result.hash && result.sender && result.reason !== DUPLICATE) {
      this.#reject(tx, { hash: result.hash, sender: result.sender, reason: result.reason, code: result.simulation?.errorCode, stage: "sendtx" });
    }
    return result;
  }

  #add({ tx, signature }, { now, simulate }) {
    let verified;
    try {
      verified = verifyTransaction({ tx, signature });
    } catch (error) {
      return { ok: false, reason: error.message };
    }
    const { sender, hash, method, request } = verified;

    this.prune({ now });
    if (this.#seen.has(hash)) return { ok: false, hash, sender, reason: DUPLICATE };
    const inQueue = this.countOf(sender);
    const chainNonce = this.#vm.checkTransaction(request).expectedNonce ?? 0;
    const target = this.#vm.requireNonce && Number.isInteger(tx.nonce) && tx.nonce >= chainNonce && tx.nonce < chainNonce + inQueue
      ? this.#items.get(this.#byNonce.get(`${sender}:${tx.nonce}`))
      : undefined;
    if (target) return this.#replace(target, { tx, signature, verified, now, simulate });

    if (this.#items.size >= this.#options.maxSize) return { ok: false, hash, sender, reason: "คิวเต็ม" };
    if (!this.#allowRate(sender, now)) return { ok: false, hash, sender, reason: "ส่งถี่เกินกำหนด" };
    if (inQueue >= this.#options.maxPerSender) return { ok: false, hash, sender, reason: "คิวของ address นี้เต็ม" };

    const expectedNonce = chainNonce + inQueue;
    if (this.#vm.requireNonce && tx.nonce !== expectedNonce) {
      return { ok: false, hash, sender, reason: `nonce ต้องเป็น ${expectedNonce}`, expectedNonce };
    }

    this.#recent.set(sender, [...(this.#recent.get(sender) ?? []), now]);
    let simulation;
    if (simulate) {
      simulation = simulate(verified);
      if (!simulation.ok) return { ok: false, hash, sender, reason: simulation.error ?? "ประเมินผลไม่ผ่าน", simulation };
    }

    this.#insert({ tx, signature, hash, sender, method, request, receivedAt: now });
    return simulation ? { ok: true, hash, sender, simulation } : { ok: true, hash, sender };
  }

  /** ใบที่ถูกแทนที่ → hash ของใบใหม่ (null ถ้าไม่รู้จัก หรือพ้น ttlMs แล้ว) */
  replacedBy(hash, { now = Date.now() } = {}) {
    const entry = this.#replaced.get(hash);
    if (entry && now - entry.at <= this.#options.ttlMs) return entry.replacedBy;
    return this.#options.replacedLog?.get(hash, { now })?.replacedBy ?? null;
  }

  /** จำนวน tx ที่ถูกปฏิเสธที่รอใส่ลง block */
  get rejectedPending() {
    return this.#rejections.size;
  }

  /** tx ที่ถูกปฏิเสธที่ยังรอเข้า block (ข้อมูลเดียวกับที่จะอยู่ใน block) */
  pendingRejections() {
    return [...this.#rejections.values()].map((entry) => ({ ...entry }));
  }

  /** tx ที่ถูกปฏิเสธแล้วแต่ยังไม่ได้ใส่ลง block (ไม่มี → null) */
  pendingRejection(hash) {
    const entry = this.#rejections.get(String(hash ?? "").toLowerCase());
    return entry ? { ...entry } : null;
  }

  /** จำ tx ที่ถูกปฏิเสธ (hash เดิมถูกปฏิเสธซ้ำ = ย้ายไปท้าย เหลืออันล่าสุด) */
  #reject(tx, { hash, sender, reason, code, stage }) {
    if (!this.#options.recordRejected) return;
    const text = String(reason ?? "");
    this.#rejections.delete(hash);
    this.#rejections.set(hash, {
      hash, sender,
      nonce: Number.isSafeInteger(tx?.nonce) ? tx.nonce : null,
      action: typeof tx?.action === "string" ? tx.action : "call",
      to: typeof tx?.to === "string" && tx.to ? tx.to.toLowerCase() : null,
      gasPrice: String(this.#priceOf(tx?.gasPrice)),
      reason: text.length > 500 ? text.slice(0, 500) : text,
      code: code ?? null,
      stage,
    });
    while (this.#rejections.size > this.#options.maxRejectedQueue) this.#rejections.delete(this.#rejections.keys().next().value);
  }

  /** gasPrice ขั้นต่ำที่ใบแทนที่ต้องเสนอ (BigInt) */
  minimumReplacementPrice(oldGasPrice) {
    const old = this.#priceOf(oldGasPrice);
    const bump = BigInt(this.#options.replaceBumpPercent);
    return (old * (100n + bump) + 99n) / 100n;   // ปัดขึ้น → +10% ของ 1 wei ต้องเป็น 2 ไม่ใช่ 1
  }

  /**
   * แทนที่ใบที่รออยู่ (nonce เดิม): ไม่กินโควตา maxPerSender / maxSize เพิ่ม แต่นับ rate limit
   * simulate ไม่ผ่าน → ใบเดิมยังอยู่
   */
  #replace(target, { tx, signature, verified, now, simulate }) {
    const { sender, hash, method, request } = verified;
    if (!this.#allowRate(sender, now)) return { ok: false, hash, sender, reason: "ส่งถี่เกินกำหนด" };

    const minimum = this.minimumReplacementPrice(target.tx.gasPrice);
    if (this.#priceOf(tx.gasPrice) < minimum) {
      return { ok: false, hash, sender, reason: `ราคาแก๊สต่ำเกินไปสำหรับการแทนที่ (ต้องอย่างน้อย ${minimum})`,
        replaces: target.hash, minimumGasPrice: `${minimum}` };
    }

    this.#recent.set(sender, [...(this.#recent.get(sender) ?? []), now]);
    let simulation;
    if (simulate) {
      simulation = simulate(verified);
      if (!simulation.ok) return { ok: false, hash, sender, reason: simulation.error ?? "ประเมินผลไม่ผ่าน", simulation };
    }

    this.#delete(target.hash);
    this.#replaced.set(target.hash, { replacedBy: hash, at: now });
    try {
      this.#options.replacedLog?.record({ hash: target.hash, replacedBy: hash, sender, nonce: tx.nonce, action: target.tx.action ?? "call" }, { now });
    } catch (error) { console.error("บันทึกใบที่ถูกแทนที่ไม่สำเร็จ:", error.message); }
    this.#insert({ tx, signature, hash, sender, method, request, receivedAt: now });
    const result = { ok: true, hash, sender, replaced: target.hash };
    return simulation ? { ...result, simulation } : result;
  }

  /** gasPrice ที่ไม่ได้ระบุ = ราคาตั้งต้นของ VM · อ่านแบบเดียวกับ VM (BigInt wei) */
  #priceOf(gasPrice) {
    return parseNative(gasPrice ?? this.#vm.gas.price) ?? 0n;
  }

  #insert(item) {
    this.#rejections.delete(item.hash);   // เคยถูกปฏิเสธแล้วส่งใหม่ผ่าน → ไม่ต้องบันทึกว่าถูกปฏิเสธ
    this.#items.set(item.hash, item);
    this.#byNonce.set(`${item.sender}:${item.tx.nonce}`, item.hash);
    this.#seen.set(item.hash, item.receivedAt);
  }

  #delete(hash) {
    const item = this.#items.get(hash);
    if (!item) return;
    this.#items.delete(hash);
    const key = `${item.sender}:${item.tx.nonce}`;
    if (this.#byNonce.get(key) === hash) this.#byNonce.delete(key);
  }

  /** ใส่ tx ที่พร้อมลงใน block ตามลำดับราคา → คืน hash ที่ใส่ไปแล้ว */
  take(block, { limit = Infinity, now = block.timestamp ?? Date.now() } = {}) {
    this.prune({ now });   // ใบที่หมดอายุ → ถูกปฏิเสธ (expired) และบันทึกใน block นี้
    const included = [];
    // ใบของ address เดียวกันถูกหยิบตามลำดับ nonce เสมอ (ใบแทนที่ใช้ nonce เดิม → ลำดับไม่เสีย)
    for (const item of sortPendingTransactions([...this.#items.values()], { defaultGasPrice: this.#vm.gas.price })) {
      if (included.length >= limit) break;
      if (!block.checkTransaction(item.request).ok) continue;   // nonce ยังไม่ถึงคิว หรือโควตา block เต็ม
      const result = block[item.method](item.request);
      // VM ไม่รับเข้า block (TIMEOUT / แก๊สของ block เต็ม ฯลฯ) → หลุดจากคิวไปเลย จึงบันทึกไว้ให้ /tx ตอบได้
      included.push(item.hash);
      if (result?.accepted === false) {
        this.remove([item.hash]);
        this.#reject(item.tx, { hash: item.hash, sender: item.sender, reason: result.error?.message ?? "ไม่ถูกรับเข้า block",
          code: result.error?.code, stage: "block" });
      }
    }
    this.remove(included);
    this.#drainRejections(block);
    return included;
  }

  /** ใส่ tx ที่ถูกปฏิเสธลง block ตามลำดับที่เกิด ไม่เกิน maxRejectedPerBlock (ที่เหลือรอ block ถัดไป) */
  #drainRejections(block) {
    if (typeof block.recordRejected !== "function") return;
    let count = 0;
    for (const [hash, entry] of this.#rejections) {
      if (count >= this.#options.maxRejectedPerBlock) break;
      this.#rejections.delete(hash);
      try { block.recordRejected(entry); count += 1; } catch (error) { console.error("บันทึก tx ที่ถูกปฏิเสธไม่สำเร็จ:", error.message); }
    }
  }

  remove(hashes) {
    for (const hash of hashes) this.#delete(hash);
  }

  /** ทิ้งใบที่ค้างเกิน ttl และล้างประวัติที่พ้นช่วงเวลาแล้ว */
  prune({ now = Date.now() } = {}) {
    const dropped = [];
    for (const [hash, item] of this.#items) {
      if (now - item.receivedAt > this.#options.ttlMs) {
        this.#delete(hash);
        dropped.push(hash);
        this.#reject(item.tx, { hash, sender: item.sender, reason: EXPIRED_REASON, stage: "expired" });
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
    for (const [hash, { at }] of this.#replaced) {
      if (now - at > this.#options.ttlMs) this.#replaced.delete(hash);
    }
    return dropped;
  }

  clear() {
    this.#items.clear();
    this.#recent.clear();
    this.#seen.clear();
    this.#byNonce.clear();
    this.#replaced.clear();
    this.#rejections.clear();
  }

  #allowRate(sender, now) {
    const times = (this.#recent.get(sender) ?? []).filter((time) => now - time < this.#options.rateWindowMs);
    this.#recent.set(sender, times);
    return times.length < this.#options.rateLimit;
  }
}
