/**
 * DB ของระบบ
 *   DB       — ของจริง เก็บลง LMDB
 *   MemoryDB — หน้าตาเหมือนกันทุกอย่าง แต่เก็บในหน่วยความจำ (ใช้ทดสอบ / ทดลอง)
 *
 * VM ต้องการ 3 อย่าง และทุกตัวต้องเป็น sync
 *   readKeys(keys)           → [value, ...] ตามลำดับ key (ไม่มี → undefined)
 *   writeKeys(writes)        บันทึกทั้งหมดแบบ atomic
 *                            writes = [{ type: "put", dbKey, value } | { type: "del", dbKey }]
 *   listKeys(prefix, opts)   รายชื่อ key ตาม prefix (ใช้ทำ explorer)
 */
import { open } from "lmdb";
import path from "node:path";
import crypto from "node:crypto";

const copy = (value) => (value === undefined ? undefined : structuredClone(value));
const PREFIX_END = "\uffff";

/** ตัวช่วยที่ทั้ง DB และ MemoryDB ใช้ร่วมกัน */
class BaseDB {
  /** ตรวจรูปแบบของ writes ก่อนบันทึก (ผิดแม้รายการเดียว = ไม่บันทึกเลย) */
  static checkWrites(writes) {
    if (!Array.isArray(writes)) throw new Error("writes ต้องเป็น array");
    for (const write of writes) {
      const valid = typeof write?.dbKey === "string"
        && (write.type === "del" || (write.type === "put" && write.value !== undefined));
      if (!valid) throw new Error(`write ไม่ถูกต้อง: ${JSON.stringify(write)}`);
    }
    return writes;
  }

  /** [{ dbKey, value }] ตาม prefix */
  listEntries(prefix = "", options) {
    return this.listKeys(prefix, options).map((dbKey) => ({ dbKey, value: this.readKeys([dbKey])[0] }));
  }

  /** ข้อมูลเป็น object เรียงตาม key (debug / test) */
  snapshot(prefix = "") {
    return Object.fromEntries(this.listEntries(prefix).map(({ dbKey, value }) => [dbKey, value]));
  }

  /** จัดกลุ่มตาม address: { "<address>": { code, storage: {...}, ... } } */
  tree(prefix = "") {
    const grouped = {};
    for (const { dbKey, value } of this.listEntries(prefix)) {
      const [head, kind, ...rest] = dbKey.split(":");
      const group = (grouped[head] ??= {});
      if (kind === undefined) group[dbKey] = value;
      else if (rest.length === 0) group[kind] = value;
      else (group[kind] ??= {})[rest.join(":")] = value;
    }
    return grouped;
  }

  /** JSON string อ่านง่าย (maxStringLength: ตัด string ยาว ๆ เช่นโค้ดโปรแกรม) */
  dump({ prefix = "", grouped = false, indent = 2, maxStringLength = 0 } = {}) {
    const data = grouped ? this.tree(prefix) : this.snapshot(prefix);
    const shorten = (_key, value) =>
      maxStringLength > 0 && typeof value === "string" && value.length > maxStringLength
        ? `${value.slice(0, maxStringLength)}… (${value.length} ตัวอักษร)`
        : value;
    return JSON.stringify(data, shorten, indent);
  }

  print(prefix = "", options = {}) {
    console.log(this.dump({ prefix, maxStringLength: 60, ...options }));
    return this;
  }

  toJSON() {
    return this.snapshot();
  }

  toString() {
    return this.dump();
  }
}

// ============================================================================
//  DB จริง (LMDB)
// ============================================================================

export class DB extends BaseDB {
  constructor(dbPath, { compression = true, mapSize = 100 * 1024 ** 3 } = {}) {   // จอง address space 100 GB (ใช้ดิสก์จริงเท่าที่เขียน)
    super();
    this.basekey = crypto.createHash("sha256").update(`primarydbkey|${dbPath}`).digest("hex");
    this.queue = [];
    this.server = open({ path: path.resolve(`./${dbPath}`), compression, mapSize });
  }

  // ---------- ที่ VM ใช้ ----------

  readKeys(keys) {
    if (!Array.isArray(keys)) throw new Error("keys ต้องเป็น array");
    return keys.map((key) => this.server.get(key)); // get เป็น sync (getMany ของ lmdb เป็น async)
  }

  /** บันทึกทั้งหมดใน transaction เดียว (put / del) */
  writeKeys(writes) {
    DB.checkWrites(writes);
    if (writes.length === 0) return 0;

    this.server.transactionSync(() => {
      for (const write of writes) {
        if (write.type === "del") this.server.remove(write.dbKey);
        else this.server.put(write.dbKey, write.value);
      }
    });
    return writes.length;
  }

  listKeys(prefix = "", { start, limit, reverse = false } = {}) {
    const range = reverse
      ? { start: start ?? prefix + PREFIX_END, end: prefix, reverse: true }
      : { start: start ?? prefix, end: prefix + PREFIX_END };
    if (limit !== undefined) range.limit = limit;

    const keys = [];
    for (const { key } of this.server.getRange(range)) {
      if (typeof key === "string" && key.startsWith(prefix)) keys.push(key);
    }
    return keys;
  }

  // ---------- ของเดิม ----------

  write(key, value) {
    this.queue.push({ key, value });
  }

  commit({ throwOnError = false } = {}) {
    if (!this.queue.length) return;
    const batch = [...this.queue];
    this.queue = [];
    try {
      this.server.transactionSync(() => {
        batch.forEach(({ key, value }) => this.server.put(key, value));
      });
    } catch (err) {
      this.queue.unshift(...batch);
      if (throwOnError) throw err;
    }
  }

  read(key) { return this.server.get(key); }
  readMany(keys = []) { return this.server.getMany(keys); }
  readRange(startKey, endKey) { return [...this.server.getRange({ start: startKey, end: endKey })]; }
  readRangeLimit(startKey, limit = 10) { return [...this.server.getRange({ start: startKey, limit })]; }
  exists(key) { return this.server.doesExist(key); }
  remove(key) { return this.server.remove(key); }
  count() { return [...this.server.getRange()].length; }
  iterate(cb) { for (const { key, value } of this.server.getRange()) cb(key, value); }
  update(key, fn) { this.server.put(key, fn(this.server.get(key) || {})); }

  get size() { return this.count(); }
  has(key) { return this.exists(key); }
  clear() { this.server.clearSync(); return this; }
  close() { return this.server.close(); }

  load(entries = {}) {
    this.writeKeys(Object.entries(entries).map(([dbKey, value]) => ({ type: "put", dbKey, value })));
    return this;
  }
}

// ============================================================================
//  DB ในหน่วยความจำ (ใช้ทดสอบ / ทดลอง — หน้าตาเหมือน DB ทุกอย่าง)
// ============================================================================

export class MemoryDB extends BaseDB {
  constructor(initial = {}) {
    super();
    this.data = new Map(Object.entries(initial));
  }

  readKeys(keys) {
    if (!Array.isArray(keys)) throw new Error("keys ต้องเป็น array");
    return keys.map((key) => copy(this.data.get(key)));
  }

  writeKeys(writes) {
    MemoryDB.checkWrites(writes);
    for (const write of writes) {
      if (write.type === "del") this.data.delete(write.dbKey);
      else this.data.set(write.dbKey, copy(write.value));
    }
    return writes.length;
  }

  listKeys(prefix = "", { start, limit, reverse = false } = {}) {
    let keys = [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
    if (reverse) keys.reverse();
    if (start !== undefined) keys = keys.filter((key) => (reverse ? key <= start : key >= start));
    return limit === undefined ? keys : keys.slice(0, limit);
  }

  read(key) { return copy(this.data.get(key)); }
  readMany(keys = []) { return this.readKeys(keys); }
  exists(key) { return this.data.has(key); }
  remove(key) { return this.data.delete(key); }
  count() { return this.data.size; }
  iterate(cb) { for (const [key, value] of this.data) cb(key, copy(value)); }

  get size() { return this.data.size; }
  has(key) { return this.data.has(key); }
  clear() { this.data.clear(); return this; }

  load(entries = {}) {
    for (const [dbKey, value] of Object.entries(entries)) this.data.set(dbKey, copy(value));
    return this;
  }
}
