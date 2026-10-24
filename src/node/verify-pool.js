/**
 * ตรวจลายเซ็นของ tx ใน worker thread (ระยะ 2.3)
 *
 *   const pool = new VerifyPool({ size: 2 });
 *   const verified = await pool.verify({ tx, signature });   // = verifyTransaction({ tx, signature }) แต่ไม่บล็อก thread หลัก
 *
 * recover ลายเซ็น secp256k1 ใช้ ~2 ms ต่อ tx → ถ้าทำบน thread หลัก /sendtx รับได้ไม่เกิน ~400 tx/วิ และ RPC อื่นต้องรอ
 * ผลเหมือน verifyTransaction ทุกไบต์ (ส่งกลับด้วย structured clone: ข้อมูล JSON + BigInt) · ลายเซ็นผิด = reject ด้วยข้อความเดิม
 *
 * size 0 = ตรวจบน thread หลัก (แบบเดิม) · worker สร้างเมื่อใช้ครั้งแรก และ unref ไว้ ไม่กันโปรเซสจบ
 * worker ตาย → งานที่ค้างของตัวนั้น reject แล้วสร้างใหม่ตอนใช้ครั้งต่อไป
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

  verify({ tx, signature } = {}) {
    if (this.#size === 0) {
      try { return Promise.resolve(verifyTransaction({ tx, signature })); }
      catch (error) { return Promise.reject(error); }
    }
    const slot = this.#slot();
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      if (slot.pending.size === 1) slot.worker.ref();
      try { slot.worker.postMessage({ id, tx, signature }); }
      catch (error) { this.#settle(slot, id, { error: error.message }); }   // ส่งข้อมูลข้าม thread ไม่ได้ (เช่น function)
    });
  }

  /** ปิด worker ทั้งหมด (งานที่ค้าง reject) */
  async close() {
    const workers = this.#workers.splice(0);
    await Promise.all(workers.filter(Boolean).map((slot) => slot.worker.terminate()));
  }

  #slot() {
    const index = this.#next++ % this.#size;
    return this.#workers[index] ??= this.#spawn(index);
  }

  #spawn(index) {
    // execArgv: [] = ไม่รับ flag ของโปรเซสหลัก (เช่น --input-type / --test)
    const slot = { worker: new Worker(new URL(import.meta.url), { execArgv: [] }), pending: new Map() };
    slot.worker.unref();
    slot.worker.on("message", ({ id, ...result }) => this.#settle(slot, id, result));
    const fail = (error) => {
      if (this.#workers[index] === slot) this.#workers[index] = undefined;
      for (const { reject } of slot.pending.values()) reject(new Error(`verify worker หยุดทำงาน: ${error?.message ?? error}`));
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
  parentPort.on("message", ({ id, tx, signature }) => {
    try { parentPort.postMessage({ id, verified: verifyTransaction({ tx, signature }) }); }
    catch (error) { parentPort.postMessage({ id, error: error.message }); }
  });
}
