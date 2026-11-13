/**
 * Off-chain log of the status of txs that "didn't make it into a block" (not in blocks · not in hash / stateRoot · chain format unchanged)
 *   - rejected: rejected after signature verification (bad nonce / quota full / too frequent / simulate failed / TIMEOUT while sealing a block / expired in the queue)
 *   - replaced: replaced by a tx with the same nonce and a higher gas price
 *
 *   const log = new TxLog({ file: "data/rejected-tx.jsonl", maxEntries: 100_000, maxAgeMs: 30 * 86_400_000 });
 *   log.record({ hash, sender, nonce, action, reason, stage });   // same hash again = replaces the old value (latest wins)
 *   log.get(hash);                                              // → entry | null
 *   log.list({ address, limit, cursor });                       // newest to oldest → { items, next }
 *
 * Stored on disk as JSON lines (1 line = 1 entry appended to the file) · no file = in memory only
 * Always bounded: at most maxEntries entries and nothing older than maxAgeMs (oldest dropped first)
 * The file is rewritten (compacted) when the line count exceeds twice what is kept → the file doesn't grow without bound
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_TX_LOG = {
  maxEntries: 100_000,
  maxAgeMs: 30 * 24 * 60 * 60_000,   // 30 days
  maxScan: 10_000,                   // list() scans at most this many per call (skipping replaced entries) → bounded cost per request
  maxText: 500,                      // truncate long strings (e.g. reason) to keep the file small
};
export const MAX_LIST_LIMIT = 100;

const lower = (value) => (typeof value === "string" ? value.toLowerCase() : value ?? null);

/** seq in ascending order + a head pointer (drops old entries without shifting the whole array) */
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
  /** last position with seq < cursor (none = -1) · no cursor = the very last */
  lastBefore(cursor) {
    let lo = this.head, hi = this.items.length;   // find the first one >= cursor
    if (cursor === undefined) return hi - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.items[mid] < cursor) lo = mid + 1; else hi = mid; }
    return lo - 1;
  }
}

export class TxLog {
  #file;
  #options;
  #entries = new Map();   // seq → entry
  #byHash = new Map();    // hash → latest seq
  #order = new SeqList();
  #bySender = new Map();  // sender → SeqList
  #nextSeq = 1;
  #lines = 0;             // lines in the file (including replaced / expired lines)

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

  /** record (same hash = replaces the old one) · returns the stored entry */
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

  /** the entry for this hash (none / expired → null) */
  get(hash, { now = Date.now() } = {}) {
    const seq = this.#byHash.get(lower(hash));
    const entry = seq === undefined ? undefined : this.#entries.get(seq);
    if (!entry || now - entry.at > this.#options.maxAgeMs) return null;
    return { ...entry };
  }

  /**
   * newest to oldest · address = only this sender's · cursor = the previous page's next value
   * scans at most maxScan positions per call (fewer than limit but more remain → next points to where it stopped)
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

  // ---------- internals ----------

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
    if (old !== undefined) this.#entries.delete(old);   // the old seq stays in SeqList → skipped during list / prune
    this.#entries.set(entry.seq, entry);
    this.#byHash.set(entry.hash, entry.seq);
    this.#order.push(entry.seq);
    if (entry.sender) {
      if (!this.#bySender.has(entry.sender)) this.#bySender.set(entry.sender, new SeqList());
      this.#bySender.get(entry.sender).push(entry.seq);
    }
    this.#nextSeq = Math.max(this.#nextSeq, entry.seq + 1);
  }

  /** drop from the head (oldest) until within maxEntries and nothing is older than maxAgeMs */
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
      try { entry = JSON.parse(line); } catch { continue; }   // corrupt line (e.g. power loss mid-write) → skip
      if (typeof entry?.hash !== "string" || !Number.isSafeInteger(entry.seq) || entry.seq < this.#nextSeq) continue;
      this.#insert(this.#clean(entry));
    }
    this.#lines = lines.length;
    this.#prune(Date.now());
    if (this.#lines > Math.max(1000, this.#entries.size * 2)) this.#compact();
  }

  /** rewrite the file from the entries still kept (write a temp file then rename → the file is never empty) */
  #compact() {
    const live = [...this.#entries.values()].sort((a, b) => a.seq - b.seq);
    const temp = `${this.#file}.tmp`;
    fs.writeFileSync(temp, live.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    fs.renameSync(temp, this.#file);
    this.#lines = live.length;
  }
}
