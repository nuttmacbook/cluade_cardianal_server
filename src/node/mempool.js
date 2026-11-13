/**
 * Server-side tx queue: bounded size, duplicate protection, drops stale txs and orders by gasPrice
 *
 *   const mempool = new Mempool(vm, { maxPerSender: 16, maxSize: 5000, ttlMs: 5 * 60_000 });
 *   mempool.add({ tx, signature });      // → { ok, hash, reason }
 *   mempool.take(block);                 // pick ready txs and put them into the block
 *   mempool.remove(hashes);              // remove txs already included in a block
 *   mempool.replacedBy(hash);            // a replaced tx → hash of the new tx (remembered for ttlMs · pass replacedLog = remembered persistently, bounded)
 *
 * Rejected txs (passed signature verification but were not executed) are remembered in order, then take() puts them into the next block
 * (block.recordRejected · at most maxRejectedPerBlock per block, the excess carries over to the next block) → explorer / GET /tx answer "rejected" from chain data
 *   stage: "sendtx" (rejected on admission: bad nonce / quota full / too frequent / simulate failed)
 *          "block"  (the VM refused it while sealing the block, e.g. TIMEOUT / block gas full)
 *          "expired" (stayed in the queue longer than ttlMs)
 *   txs with bad signatures / duplicates are not recorded (hash / sender untrustworthy, or it already has a real status)
 *
 * replacedLog (optional · see src/node/txlog.js): replaced txs → { hash, replacedBy, sender, nonce, at } recorded off-chain
 * (replacement is normal, not a rejection, so it doesn't go into blocks) · with a file = survives restarts
 *
 * Replacement (geth-style replace-by-fee): send the same nonce as a pending tx + both maxFeePerGas and maxPriorityFeePerGas
 * at least replaceBumpPercent % higher (legacy gasPrice = both values) · the new tx may be any action → cancel the old one by sending 0 to yourself
 *
 * EIP-1559: take(block) orders by the tip the producer actually gets = min(priority, maxFee - the block's baseFee)
 * txs with maxFee < the block's baseFee are not picked yet (they wait in the queue until the base fee drops, or expire after ttlMs)
 */
import { sortPendingTransactions, parseNative, effectiveTip } from "../core/virtualmachine.js";
import { verifyTransaction } from "../crypto/signature.js";

export const DEFAULT_MEMPOOL = {
  maxPerSender: 16,        // pending txs one address may have in the queue
  maxSize: 5000,           // total txs in the queue
  ttlMs: 5 * 60_000,       // lifetime of a tx not yet in a block
  rateWindowMs: 60_000,    // rate limit window
  rateLimit: 60,           // txs one address may send per window
  replaceBumpPercent: 10,  // a pending tx (same nonce) can be replaced when the new gasPrice ≥ old × (100 + this) / 100
  maxRejectedPerBlock: 1000,   // rejected txs that can go into one block (the excess waits for the next block)
  maxRejectedQueue: 100_000,   // max remembered while waiting for a block (excess = drop the oldest)
  recordRejected: true,        // false = don't remember rejected txs
  replacedLog: null,       // TxLog for replaced txs (omitted = in memory for ttlMs only)
};

const DUPLICATE = "tx already submitted";
/** a tx signed EIP-1559-style (has maxFeePerGas / maxPriorityFeePerGas) */
const isFeeMarket = (tx) => (tx?.maxFeePerGas ?? null) !== null || (tx?.maxPriorityFeePerGas ?? null) !== null;
export const EXPIRED_REASON = "stayed in the queue too long (not included in a block)";

export class Mempool {
  #vm;
  #options;
  #items = new Map();              // hash → { tx, signature, sender, method, request, receivedAt }
  #recent = new Map();             // sender → [timestamp, ...] for the rate limit
  #seen = new Map();               // hash → when it was seen (blocks resubmission even after inclusion)
  #byNonce = new Map();            // "sender:nonce" → hash of the pending tx (finds the tx to be replaced)
  #replaced = new Map();           // old hash → { replacedBy, at } kept for ttlMs so GET /tx/:hash can answer
  #rejections = new Map();         // hash → entry of a rejected tx waiting for the next block (in order of occurrence)
  #listeners = new Set();          // functions waiting for hashes of txs just admitted (/evm newPendingTransactions)

  constructor(vm, options = {}) {
    this.#vm = vm;
    this.#options = { ...DEFAULT_MEMPOOL, ...options };
  }

  get size() {
    return this.#items.size;
  }

  /** pending txs (summary for /pending) */
  list() {
    return [...this.#items.values()].map(({ hash, sender, tx, receivedAt }) =>
      ({ hash, sender, action: tx.action, to: typeof tx.to === "string" && tx.to ? tx.to.toLowerCase() : null, nonce: tx.nonce, gasPrice: tx.gasPrice ?? null,
        ...(isFeeMarket(tx) ? { maxFeePerGas: String(tx.maxFeePerGas ?? 0), maxPriorityFeePerGas: String(tx.maxPriorityFeePerGas ?? 0) } : {}), receivedAt }));
  }

  has(hash) {
    return this.#items.has(hash);
  }

  /** number of pending txs for this address */
  countOf(sender) {
    let count = 0;
    for (const item of this.#items.values()) if (item.sender === sender) count += 1;
    return count;
  }

  /** the next nonce this address should use (counting pending txs) */
  nextNonce(address) {
    const sender = String(address).toLowerCase();
    const { expectedNonce } = this.#vm.checkTransaction({ from: sender, nonce: -1 });
    return (expectedNonce ?? 0) + this.countOf(sender);
  }

  /**
   * Admit a tx into the queue: checks signature, rate limit, quota, nonce order
   *
   * simulate (if given) is called only after all the cheap checks pass
   * and failed simulations also count toward the rate limit → long-running txs can't be spammed
   *   simulate(verified) → { ok, ... }   the result is returned in simulation
   *
   * accepted nonce range [on-chain nonce, on-chain nonce + number pending]:
   *   = next              → appended to the queue
   *   = a pending tx of the same sender → replaces it (see #replace) · the result has replaced: hash of the old tx
   *
   * @returns {{ ok: boolean, hash?: string, sender?: string, reason?: string, expectedNonce?: number, replaced?: string, simulation?: object }}
   */
  add({ tx, signature, sponsorSignature }, { now = Date.now(), simulate, verified } = {}) {
    const result = this.#add({ tx, signature, sponsorSignature }, { now, simulate, verified });
    // bad signature = no trustworthy hash / sender · duplicate = this hash already has a real status (pending / in a block / replaced)
    if (!result.ok && result.hash && result.sender && result.reason !== DUPLICATE) {
      this.#reject(tx, { hash: result.hash, sender: result.sender, reason: result.reason, code: result.simulation?.errorCode, stage: "sendtx" });
    }
    if (result.ok) {
      for (const listener of this.#listeners) {
        try { listener(result.hash); } catch (error) { console.error(error); }   // a broken listener must not stop txs being accepted
      }
    }
    return result;
  }

  /** call listener(hash) whenever a tx is admitted (including replacements) · returns an unsubscribe function */
  onAdded(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #add({ tx, signature, sponsorSignature }, { now, simulate, verified }) {
    // verified = the result of verifyTransaction({ tx, signature }) already done by the caller (the server checks first → no need to recover the signature again)
    if (!verified) {
      try {
        verified = verifyTransaction({ tx, signature, sponsorSignature });
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    }
    const { sender, hash, method, request } = verified;
    // signature for another chain (chainId in the message doesn't match) = cross-chain replay → reject before touching state
    if (verified.chainId !== undefined && Number(verified.chainId) !== Number(this.#vm.chainId)) {
      return { ok: false, reason: `tx chainId (${verified.chainId}) does not match the chain (${this.#vm.chainId})` };
    }

    this.#pruneRecent(now);
    if (this.#isSeen(hash, now)) return { ok: false, hash, sender, reason: DUPLICATE };
    const inQueue = this.countOf(sender);
    const chainNonce = this.#vm.checkTransaction(request).expectedNonce ?? 0;
    const target = this.#vm.requireNonce && Number.isInteger(tx.nonce) && tx.nonce >= chainNonce && tx.nonce < chainNonce + inQueue
      ? this.#items.get(this.#byNonce.get(`${sender}:${tx.nonce}`))
      : undefined;
    if (target) return this.#replace(target, { tx, signature, verified, now, simulate });

    if (this.#items.size >= this.#options.maxSize) return { ok: false, hash, sender, reason: "queue is full" };
    if (!this.#allowRate(sender, now)) return { ok: false, hash, sender, reason: "sending too frequently" };
    if (inQueue >= this.#options.maxPerSender) return { ok: false, hash, sender, reason: "queue for this address is full" };

    const expectedNonce = chainNonce + inQueue;
    if (this.#vm.requireNonce && tx.nonce !== expectedNonce) {
      return { ok: false, hash, sender, reason: `nonce must be ${expectedNonce}`, expectedNonce };
    }

    this.#touchRecent(sender, now);
    let simulation;
    if (simulate) {
      simulation = simulate(verified);
      if (!simulation.ok) return { ok: false, hash, sender, reason: simulation.error ?? "simulation failed", simulation };
    }

    this.#insert({ tx, signature, hash, sender, method, request, receivedAt: now });
    return simulation ? { ok: true, hash, sender, simulation } : { ok: true, hash, sender };
  }

  /** a replaced tx → hash of the new tx (null if unknown or past ttlMs) */
  replacedBy(hash, { now = Date.now() } = {}) {
    const entry = this.#replaced.get(hash);
    if (entry && now - entry.at <= this.#options.ttlMs) return entry.replacedBy;
    return this.#options.replacedLog?.get(hash, { now })?.replacedBy ?? null;
  }

  /** number of rejected txs waiting to go into a block */
  get rejectedPending() {
    return this.#rejections.size;
  }

  /** time (ms) at which the longest-waiting rejected tx was rejected · none waiting = null */
  get oldestRejectionAt() {
    let oldest = null;
    for (const entry of this.#rejections.values()) if (oldest === null || entry.at < oldest) oldest = entry.at;
    return oldest;
  }

  /** rejected txs still waiting for a block (the same data that will be in the block) */
  pendingRejections() {
    return [...this.#rejections.values()].map((entry) => ({ ...entry }));
  }

  /** a rejected tx not yet put into a block (none → null) */
  pendingRejection(hash) {
    const entry = this.#rejections.get(String(hash ?? "").toLowerCase());
    return entry ? { ...entry } : null;
  }

  /** remember a rejected tx (the same hash rejected again = moved to the end, keeping the latest) */
  #reject(tx, { hash, sender, reason, code, stage }) {
    if (!this.#options.recordRejected) return;
    // the exact same tx (same hash) was already recorded as rejected in an earlier block and has never been included → don't record it again
    // 1 hash is always in exactly one block: the explorer and /evm (Blockscout) agree, and rapid resubmission doesn't create new blocks
    if (typeof this.#vm.getRejectedTransaction === "function" && this.#vm.getRejectedTransaction(hash)
      && !this.#vm.getTransaction?.(hash)) return;
    const text = String(reason ?? "");
    this.#rejections.delete(hash);
    this.#rejections.set(hash, {
      hash, sender,
      nonce: Number.isSafeInteger(tx?.nonce) ? tx.nonce : null,
      action: typeof tx?.action === "string" ? tx.action : "call",
      to: typeof tx?.to === "string" && tx.to ? tx.to.toLowerCase() : null,
      gasPrice: String(this.feesOf(tx).maxFee),   // EIP-1559 = maxFeePerGas
      reason: text.length > 500 ? text.slice(0, 500) : text,
      code: code ?? null,
      stage,
      at: Date.now(),   // time of rejection (off-chain) → the server uses it to hold rejected txs before sealing a block
    });
    while (this.#rejections.size > this.#options.maxRejectedQueue) this.#rejections.delete(this.#rejections.keys().next().value);
  }

  /** the price a tx offers → { maxFee, priority } (BigInt) · legacy gasPrice = both values (omitted = the VM's default price) */
  feesOf(tx) {
    if (isFeeMarket(tx)) return { maxFee: parseNative(tx.maxFeePerGas ?? 0) ?? 0n, priority: parseNative(tx.maxPriorityFeePerGas ?? 0) ?? 0n };
    const price = this.#priceOf(tx?.gasPrice);
    return { maxFee: price, priority: price };
  }

  /** the minimum a replacement must offer: both maxFee and priority up by at least replaceBumpPercent % (rounded up) */
  minimumReplacementFees(oldTx) {
    const { maxFee, priority } = this.feesOf(oldTx);
    return { maxFee: this.minimumReplacementPrice(maxFee), priority: this.minimumReplacementPrice(priority) };
  }

  /** the minimum gasPrice a replacement must offer (BigInt) */
  minimumReplacementPrice(oldGasPrice) {
    const old = this.#priceOf(oldGasPrice);
    const bump = BigInt(this.#options.replaceBumpPercent);
    return (old * (100n + bump) + 99n) / 100n;   // round up → +10% of 1 wei must be 2, not 1
  }

  /**
   * Replace a pending tx (same nonce): doesn't use extra maxPerSender / maxSize quota, but counts toward the rate limit
   * simulate fails → the old tx stays
   */
  #replace(target, { tx, signature, verified, now, simulate }) {
    const { sender, hash, method, request } = verified;
    if (!this.#allowRate(sender, now)) return { ok: false, hash, sender, reason: "sending too frequently" };

    const minimum = this.minimumReplacementFees(target.tx);
    const offered = this.feesOf(tx);
    if (offered.maxFee < minimum.maxFee || offered.priority < minimum.priority) {
      const legacy = !isFeeMarket(target.tx) && !isFeeMarket(tx);
      return { ok: false, hash, sender, replaces: target.hash,
        reason: legacy ? `gas price too low to replace (must be at least ${minimum.maxFee})`
          : `gas price too low to replace (needs maxFeePerGas ≥ ${minimum.maxFee} and maxPriorityFeePerGas ≥ ${minimum.priority})`,
        minimumGasPrice: `${minimum.maxFee}`, minimumMaxFeePerGas: `${minimum.maxFee}`, minimumMaxPriorityFeePerGas: `${minimum.priority}` };
    }

    this.#touchRecent(sender, now);
    let simulation;
    if (simulate) {
      simulation = simulate(verified);
      if (!simulation.ok) return { ok: false, hash, sender, reason: simulation.error ?? "simulation failed", simulation };
    }

    this.#delete(target.hash);
    this.#replaced.set(target.hash, { replacedBy: hash, at: now });
    try {
      this.#options.replacedLog?.record({ hash: target.hash, replacedBy: hash, sender, nonce: tx.nonce, action: target.tx.action ?? "call" }, { now });
    } catch (error) { console.error("failed to record the replaced tx:", error.message); }
    this.#insert({ tx, signature, hash, sender, method, request, receivedAt: now });
    const result = { ok: true, hash, sender, replaced: target.hash };
    return simulation ? { ...result, simulation } : result;
  }

  /** unspecified gasPrice = the VM's default price · read the same way as the VM (BigInt wei) */
  #priceOf(gasPrice) {
    return parseNative(gasPrice ?? this.#vm.gas.price) ?? 0n;
  }

  #insert(item) {
    this.#rejections.delete(item.hash);   // rejected before and now resubmitted successfully → no need to record the rejection
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

  /** put ready txs into the block in price order → returns the hashes included */
  take(block, { limit = Infinity, now = block.timestamp ?? Date.now() } = {}) {
    this.prune({ now });   // expired txs → rejected (expired) and recorded in this block
    const included = [];
    // txs from the same address are always picked in nonce order (replacements keep the same nonce → order is preserved)
    const baseFee = block.baseFee ?? 0n;
    for (const item of sortPendingTransactions([...this.#items.values()], { defaultGasPrice: this.#vm.gas.price, baseFee })) {
      if (included.length >= limit) break;
      if (effectiveTip(item.request, baseFee, { defaultGasPrice: this.#vm.gas.price }) === null) continue;   // maxFee < baseFee → wait for a cheaper block
      if (!block.checkTransaction(item.request).ok) continue;   // nonce not yet due, or the block quota is full
      const gasLeft = block.capacity?.(item.sender)?.gas ?? Infinity;
      const result = block[item.method](item.request);
      // not enough gas left in this block, but an empty block could take it → wait for the next block (not rejected · the sender's next nonce waits too)
      if (result?.accepted === false && result.error?.code === "LIMIT_EXCEEDED" && gasLeft < this.#vm.maxBlockGas) continue;
      // the VM refused it for the block (TIMEOUT / larger than an empty block etc.) → it leaves the queue, so record it for /tx to answer
      included.push(item.hash);
      if (result?.accepted === false) {
        this.remove([item.hash]);
        this.#reject(item.tx, { hash: item.hash, sender: item.sender, reason: result.error?.message ?? "not accepted into a block",
          code: result.error?.code, stage: "block" });
      }
    }
    this.remove(included);
    this.#drainRejections(block);
    return included;
  }

  /** put rejected txs into the block in order of occurrence, at most maxRejectedPerBlock (the rest wait for the next block) */
  #drainRejections(block) {
    if (typeof block.recordRejected !== "function") return;
    let count = 0;
    for (const [hash, entry] of this.#rejections) {
      if (count >= this.#options.maxRejectedPerBlock) break;
      this.#rejections.delete(hash);
      try { block.recordRejected(entry); count += 1; } catch (error) { console.error("failed to record the rejected tx:", error.message); }
    }
  }

  remove(hashes) {
    for (const hash of hashes) this.#delete(hash);
  }

  /** drop txs older than ttl and clear expired history */
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

  /** seen this hash within ttl × 2 (time is checked on read → no need to wait for prune) */
  #isSeen(hash, now) {
    const time = this.#seen.get(hash);
    return time !== undefined && now - time <= this.#options.ttlMs * 2;
  }

  /** record the sender's send time and move it to the end of the Map → #recent is ordered by latest send (front = quietest longest) */
  #touchRecent(sender, now) {
    const times = [...(this.#recent.get(sender) ?? []), now];
    this.#recent.delete(sender);
    this.#recent.set(sender, times);
  }

  /**
   * light cleanup on each admitted tx: walk from the oldest entries and stop at the first unexpired one
   * (a Map keeps insertion order ≈ time order) → doesn't walk all of #seen (hundreds of thousands at full load) on every tx
   * the full cleanup is done in prune() when sealing a block
   */
  #pruneRecent(now) {
    for (const [hash, item] of this.#items) {
      if (now - item.receivedAt <= this.#options.ttlMs) break;
      this.#delete(hash);
      this.#reject(item.tx, { hash, sender: item.sender, reason: EXPIRED_REASON, stage: "expired" });
    }
    for (const [sender, times] of this.#recent) {
      if (times.length && now - times[times.length - 1] < this.#options.rateWindowMs) break;
      this.#recent.delete(sender);
    }
    for (const [hash, time] of this.#seen) {
      if (now - time <= this.#options.ttlMs * 2) break;
      this.#seen.delete(hash);
    }
    for (const [hash, { at }] of this.#replaced) {
      if (now - at <= this.#options.ttlMs) break;
      this.#replaced.delete(hash);
    }
  }

  #allowRate(sender, now) {
    const times = (this.#recent.get(sender) ?? []).filter((time) => now - time < this.#options.rateWindowMs);
    this.#recent.set(sender, times);
    return times.length < this.#options.rateLimit;
  }
}
