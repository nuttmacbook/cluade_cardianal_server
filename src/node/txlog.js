/**
 * บันทึกสถานะของ tx ที่ "ไม่ได้เข้า block" แบบ off-chain (ไม่อยู่ใน block · ไม่เข้า hash / stateRoot · รูปแบบเชนเหมือนเดิม)
 *   - rejected: ถูกปฏิเสธหลังตรวจลายเซ็นแล้ว (nonce ผิด / โควตาเต็ม / ส่งถี่ / simulate ไม่ผ่าน / TIMEOUT ตอนปิด block / หมดอายุในคิว)
 *   - replaced: ถูกแทนที่ด้วยใบ nonce เดิมที่ราคาแก๊สสูงกว่า
 *
 *   const log = new TxLog({ file: "data/rejected-tx.jsonl", maxEntries: 100_000, maxAgeMs: 30 * 86_400_000 });
 *   log.record({ hash, sender, nonce, action, reason, stage });   // hash เดิมซ้ำ = แทนที่ค่าเดิม (ล่าสุดชนะ)
 *   log.get(hash);                                              // → entry | null
 *   log.list({ address, limit, cursor });                       // ใหม่ไปเก่า → { items, next }
 *
 * เก็บลงดิสก์เป็น JSON lines (1 บรรทัด = 1 entry ต่อท้ายไฟล์) · ไม่ส่ง file = อยู่ในหน่วยความจำอย่างเดียว
 * มีขอบเขตเสมอ: ไม่เกิน maxEntries รายการ และไม่เก่ากว่า maxAgeMs (เก่าสุดถูกทิ้งก่อน)
 * ไฟล์ถูกเขียนใหม่ (compact) เมื่อจำนวนบรรทัดเกิน 2 เท่าของที่เก็บอยู่ → ขนาดไฟล์ไม่โตไม่รู้จบ
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TX_LOG = {
  maxEntries: 100_000,
  maxAgeMs: 30 * 24 * 60 * 60_000,   // 30 วัน
  maxScan: 10_000,                   // list() ไล่ไม่เกินเท่านี้ต่อครั้ง (ข้ามรายการที่ถูกแทนที่แล้ว) → ต้นทุนต่อ request มีเพดาน
  maxText: 500,                      // ตัด string ยาว ๆ (เช่น reason) ไม่ให้ไฟล์โต
};
export const MAX_LIST_LIMIT = 100;

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : value ?? null);

/** ลำดับ seq จากน้อยไปมาก + ตัวชี้หัว (ทิ้งของเก่าโดยไม่ต้อง shift ทั้ง array) */
class SeqList {
  items = [];
  head = 0;
  push(seq) { this.items.push(seq); }
  get length() { return this.items.length - this.head; }
  first() { return this.items[this.head]; }
  dropFirst() {
    this.head += 1;
    if (this.head > 1024 && this.head * 2 > this.items.length) { this.items = this.items.slice(this.head); this.head = 0; }
  }
  /** ตำแหน่งสุดท้ายที่ seq < cursor (ไม่มี = -1) · ไม่ส่ง cursor = ตัวท้ายสุด */
  lastBefore(cursor) {
    let lo = this.head, hi = this.items.length;   // หาตัวแรกที่ >= cursor
    if (cursor === undefined) return hi - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.items[mid] < cursor) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
}

export class TxLog {
  #file;
  #options;
  #entries = new Map();   // seq → entry
  #byHash = new Map();    // hash → seq ล่าสุด
  #order = new SeqList();
  #bySender = new Map();  // sender → SeqList
  #nextSeq = 1;
  #lines = 0;             // จำนวนบรรทัดในไฟล์ (นับรวมบรรทัดที่ถูกแทนที่ / หมดอายุแล้ว)

  constructor({ file = null, ...options } = {}) {
    this.#file = file ? path.resolve(file) : null;
    this.#options = { ...DEFAULT_TX_LOG, ...options };
    if (this.#file) this.#load();
  }

  get size() {
    return this.#entries.size;
  }

  get file() {
    return this.#file;
  }

  /** บันทึก (hash เดิม = แทนที่ของเดิม) · คืน entry ที่เก็บ */
  record(raw, { now = Date.now() } = {}) {
    if (typeof raw?.hash !== "string" || !raw.hash) return null;
    const entry = this.#clean({ ...raw, at: raw.at ?? now, seq: this.#nextSeq });
    this.#insert(entry);
    this.#prune(now);
    if (this.#file) {
      fs.appendFileSync(this.#file, `${JSON.stringify(entry)}\n`);
      this.#lines += 1;
      if (this.#lines > Math.max(1000, this.#entries.size * 2)) this.#compact();
    }
    return { ...entry };
  }

  /** entry ของ hash นี้ (ไม่มี / หมดอายุแล้ว → null) */
  get(hash, { now = Date.now() } = {}) {
    const seq = this.#byHash.get(lower(hash));
    const entry = seq === undefined ? undefined : this.#entries.get(seq);
    if (!entry || now - entry.at > this.#options.maxAgeMs) return null;
    return { ...entry };
  }

  /**
   * ใหม่ไปเก่า · address = เฉพาะของผู้ส่งคนนี้ · cursor = ค่า next ของหน้าก่อน
   * ไล่ไม่เกิน maxScan ตำแหน่งต่อครั้ง (ได้ไม่ครบ limit แต่ยังมีต่อ → next ชี้ไปตำแหน่งที่หยุด)
   */
  list({ address, limit = 20, cursor, now = Date.now() } = {}) {
    const size = Math.min(Math.max(Math.floor(Number(limit)) || 20, 1), MAX_LIST_LIMIT);
    const list = address ? this.#bySender.get(lower(address)) : this.#order;
    const from = cursor === undefined || cursor === null || cursor === "" ? undefined : Number(cursor);
    if (!list || (from !== undefined && !Number.isFinite(from))) return { items: [], next: null };

    const items = [];
    let i = list.lastBefore(from);
    let scanned = 0;
    for (; i >= list.head && items.length < size && scanned < this.#options.maxScan; i -= 1, scanned += 1) {
      const entry = this.#entries.get(list.items[i]);
      if (entry && now - entry.at <= this.#options.maxAgeMs) items.push({ ...entry });
    }
    const more = i >= list.head;
    const next = more ? String(items.length === size ? items.at(-1).seq : list.items[i + 1]) : null;
    return { items, next };
  }

  clear() {
    this.#entries.clear();
    this.#byHash.clear();
    this.#bySender.clear();
    this.#order = new SeqList();
    if (this.#file) this.#compact();
  }

  // ---------- ภายใน ----------

  #clean(entry) {
    const max = this.#options.maxText;
    const out = {};
    for (const [key, value] of Object.entries(entry)) {
      if (value === undefined) continue;
      out[key] = typeof value === "string" && value.length > max ? `${value.slice(0, max)}…` : value;
    }
    out.hash = lower(out.hash);
    if (out.sender) out.sender = lower(out.sender);
    return out;
  }

  #insert(entry) {
    const old = this.#byHash.get(entry.hash);
    if (old !== undefined) this.#entries.delete(old);   // seq เก่ายังค้างใน SeqList → ถูกข้ามตอน list / prune
    this.#entries.set(entry.seq, entry);
    this.#byHash.set(entry.hash, entry.seq);
    this.#order.push(entry.seq);
    if (entry.sender) {
      if (!this.#bySender.has(entry.sender)) this.#bySender.set(entry.sender, new SeqList());
      this.#bySender.get(entry.sender).push(entry.seq);
    }
    this.#nextSeq = Math.max(this.#nextSeq, entry.seq + 1);
  }

  /** ทิ้งจากหัว (เก่าสุด) จนกว่าจะไม่เกิน maxEntries และไม่มีอันที่เก่ากว่า maxAgeMs */
  #prune(now) {
    const { maxEntries, maxAgeMs } = this.#options;
    while (this.#order.length) {
      const seq = this.#order.first();
      const entry = this.#entries.get(seq);
      if (entry && this.#entries.size <= maxEntries && now - entry.at <= maxAgeMs) break;
      this.#order.dropFirst();
      if (!entry) continue;
      this.#entries.delete(seq);
      if (this.#byHash.get(entry.hash) === seq) this.#byHash.delete(entry.hash);
      const own = entry.sender ? this.#bySender.get(entry.sender) : null;
      if (own) {
        while (own.length && !this.#entries.has(own.first())) own.dropFirst();
        if (!own.length) this.#bySender.delete(entry.sender);
      }
    }
  }

  #load() {
    let text = "";
    try { text = fs.readFileSync(this.#file, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      return;
    }
    const lines = text.split("\n").filter(Boolean);
    for (const line of lines) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }   // บรรทัดเสีย (เช่นเครื่องดับกลางการเขียน) → ข้าม
      if (typeof entry?.hash !== "string" || !Number.isSafeInteger(entry.seq) || entry.seq < this.#nextSeq) continue;
      this.#insert(this.#clean(entry));
    }
    this.#lines = lines.length;
    this.#prune(Date.now());
    if (this.#lines > Math.max(1000, this.#entries.size * 2)) this.#compact();
  }

  /** เขียนไฟล์ใหม่จากรายการที่ยังเก็บอยู่ (เขียนไฟล์ชั่วคราวแล้ว rename → ไม่มีช่วงที่ไฟล์ว่าง) */
  #compact() {
    const live = [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
    const temp = `${this.#file}.tmp`;
    fs.writeFileSync(temp, live.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    fs.renameSync(temp, this.#file);
    this.#lines = live.length;
  }
}
