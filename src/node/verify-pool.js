/**
 * Verifies tx signatures in worker threads (phase 2.3)
 *
 *   const pool = new VerifyPool({ size: 2 });
 *   const verified = await pool.verify({ tx, signature });   // = verifyTransaction({ tx, signature }) without blocking the main thread
 *
 * recovering a secp256k1 signature takes ~2 ms per tx → on the main thread /sendtx tops out at ~400 tx/s and other RPCs must wait
 * results are byte-for-byte identical to verifyTransaction (returned via structured clone: JSON data + BigInt) · bad signature = rejects with the same message
 *
 * size 0 = verify on the main thread (the old way) · workers are created on first use and unref'd so they don't keep the process alive
 * a worker dies → its pending jobs reject and it is recreated on next use
 */
import { Worker, isMainThread, parentPort } from "node:worker_threads";
import os from "node:os";
import { verifyTransaction } from "../crypto/signature.js";

export const DEFAULT_VERIFY_WORKERS = Math.max(1, Math.min(4, (os.availableParallelism?.() ?? os.cpus().length) - 1));

export class VerifyPool {
  #size;
  #workers = [];   // { worker, pending: Map<id, { resolve, reject }> }
  #next = 0;
  #id = 0;

  constructor({ size = DEFAULT_VERIFY_WORKERS } = {}) {
    this.#size = Math.max(0, Math.floor(Number(size) || 0));
  }

  get size() { return this.#size; }

  verify({ tx, signature, sponsorSignature } = {}) {
    if (this.#size === 0) {
      try { return Promise.resolve(verifyTransaction({ tx, signature, sponsorSignature })); }
      catch (error) { return Promise.reject(error); }
    }
    const slot = this.#slot();
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      if (slot.pending.size === 1) slot.worker.ref();
      try { slot.worker.postMessage({ id, tx, signature, sponsorSignature }); }
      catch (error) { this.#settle(slot, id, { error: error.message }); }   // data can't cross threads (e.g. a function)
    });
  }

  /** close all workers (pending jobs reject) */
  async close() {
    const workers = this.#workers.splice(0);
    await Promise.all(workers.filter(Boolean).map((slot) => slot.worker.terminate()));
  }

  #slot() {
    const index = this.#next++ % this.#size;
    return this.#workers[index] ??= this.#spawn(index);
  }

  #spawn(index) {
    // execArgv: [] = don't inherit the main process's flags (e.g. --input-type / --test)
    const slot = { worker: new Worker(new URL(import.meta.url), { execArgv: [] }), pending: new Map() };
    slot.worker.unref();
    slot.worker.on("message", ({ id, ...result }) => this.#settle(slot, id, result));
    const fail = (error) => {
      if (this.#workers[index] === slot) this.#workers[index] = undefined;
      for (const { reject } of slot.pending.values()) reject(new Error(`verify worker stopped: ${error?.message ?? error}`));
      slot.pending.clear();
    };
    slot.worker.on("error", fail);
    slot.worker.on("exit", (code) => fail(`exit ${code}`));
    return slot;
  }

  #settle(slot, id, { verified, error }) {
    const job = slot.pending.get(id);
    if (!job) return;
    slot.pending.delete(id);
    if (slot.pending.size === 0) slot.worker.unref();
    if (error !== undefined) job.reject(new Error(error));
    else job.resolve(verified);
  }
}

if (!isMainThread && parentPort) {
  parentPort.on("message", ({ id, tx, signature, sponsorSignature }) => {
    try { parentPort.postMessage({ id, verified: verifyTransaction({ tx, signature, sponsorSignature }) }); }
    catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
}
