/**
 * System DB
 *   DB       — the real one, stored in LMDB
 *   MemoryDB — identical interface, but kept in memory (for tests / experiments)
 *
 * The VM needs 3 things, all of them sync
 *   readKeys(keys)           → [value, ...] in key order (missing → undefined)
 *   writeKeys(writes)        writes everything atomically
 *                            writes = [{ type: "put", dbKey, value } | { type: "del", dbKey }]
 *   listKeys(prefix, opts)   list keys by prefix (used by the explorer)
 */
import { open } from "lmdb";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";

const copy = (value) => (value === undefined ? undefined : structuredClone(value));
const PREFIX_END = "\uffff";
/** LMDB reserved size, default 1 TB (on 64-bit this is only address space, not disk) · once full, writes fail and the chain stops sealing blocks */
export const DEFAULT_MAP_SIZE = 1024 ** 4;

/** "1T" / "500G" / "64M" / byte count → bytes */
export function parseSize(text) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(String(text ?? ""));
  if (!match) throw new Error(`Invalid size: ${text} (e.g. 1T, 500G, 64M)`);
  const power = { "": 0, k: 1, m: 2, g: 3, t: 4 }[match[2].toLowerCase()];
  return Math.floor(Number(match[1]) * 1024 ** power);
}

/** Helpers shared by DB and MemoryDB */
class BaseDB {
  /** Validate writes before saving (a single bad entry = nothing is saved) */
  static checkWrites(writes) {
    if (!Array.isArray(writes)) throw new Error("writes must be an array");
    for (const write of writes) {
      const valid = typeof write?.dbKey === "string"
        && (write.type === "del" || (write.type === "put" && write.value !== undefined));
      if (!valid) throw new Error(`Invalid write: ${JSON.stringify(write)}`);
    }
    return writes;
  }

  /** [{ dbKey, value }] by prefix */
  listEntries(prefix = "", options) {
    return this.listKeys(prefix, options).map((dbKey) => ({ dbKey, value: this.readKeys([dbKey])[0] }));
  }

  /** Data as an object sorted by key (debug / test) */
  snapshot(prefix = "") {
    return Object.fromEntries(this.listEntries(prefix).map(({ dbKey, value }) => [dbKey, value]));
  }

  /** Grouped by address: { "<address>": { code, storage: {...}, ... } } */
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

  /** Readable JSON string (maxStringLength: truncates long strings such as program code) */
  dump({ prefix = "", grouped = false, indent = 2, maxStringLength = 0 } = {}) {
    const data = grouped ? this.tree(prefix) : this.snapshot(prefix);
    const shorten = (_key, value) =>
      maxStringLength > 0 && typeof value === "string" && value.length > maxStringLength
        ? `${value.slice(0, maxStringLength)}… (${value.length} chars)`
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
//  Real DB (LMDB)
// ============================================================================

export class DB extends BaseDB {
  constructor(dbPath, { compression = true, mapSize = DEFAULT_MAP_SIZE } = {}) {   // reserves address space (real disk use = what is written) · server sets it via LMDB_MAP_SIZE
    super();
    this.basekey = crypto.createHash("sha256").update(`primarydbkey|${dbPath}`).digest("hex");
    this.queue = [];
    this.server = open({ path: path.resolve(dbPath), compression, mapSize });   // absolute path (/var/data) is used as is · relative path is resolved from the working directory
  }

  /** File size in use (highest page ever written · free pages inside are reused) vs mapSize → cannot write past mapSize */
  stats() {
    const { pageSize, lastPageNumber, mapSize } = this.server.getStats();
    const usedBytes = (lastPageNumber + 1) * pageSize;
    return { usedBytes, mapSize, usedPercent: Math.round((usedBytes / mapSize) * 10_000) / 100 };
  }

  /**
   * Back up the whole LMDB into a new folder while the server keeps running (mdb_env_copy: reads one snapshot, so every key is as of the latest commit)
   *   compact = true → skips free pages, smaller file but slower · target folder must be empty (prevents overwriting)
   */
  async backup(dir, { compact = false } = {}) {
    const target = path.resolve(dir);
    if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`Folder ${target} is not empty`);
    fs.mkdirSync(target, { recursive: true });
    await this.server.backup(target, compact);
    return target;
  }

  // ---------- used by the VM ----------

  readKeys(keys) {
    if (!Array.isArray(keys)) throw new Error("keys must be an array");
    return keys.map((key) => this.server.get(key)); // get is sync (lmdb's getMany is async)
  }

  /** Write everything in a single transaction (put / del) */
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

  // ---------- legacy ----------

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
//  In-memory DB (for tests / experiments — same interface as DB)
// ============================================================================

export class MemoryDB extends BaseDB {
  constructor(initial = {}) {
    super();
    this.data = new Map(Object.entries(initial));
  }

  readKeys(keys) {
    if (!Array.isArray(keys)) throw new Error("keys must be an array");
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
