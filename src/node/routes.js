/**
 * ตัวอย่าง routes ครบชุดสำหรับ Fastify (ยกไปใช้ได้เลย)
 *   app.vm      VirtualMachine
 *   app.mempool Mempool
 *
 * ปิด block อัตโนมัติด้วย setInterval ดูที่ startMiner() ท้ายไฟล์
 */
import { verifyTransaction } from "../crypto/signature.js";
import { simulate } from "./simulate.js";
import { reviewProgram } from "../core/autoreview.js";

const MINER = process.env.MINER ?? "0x1111111111111111111111111111111111111111";
const MAX_LIST = 100;

export default async function routes(app) {
  const { vm, mempool } = app;
  const number = (value) => (Number.isInteger(Number(value)) ? Number(value) : null);
  const limitOf = (query) => Math.min(Number(query.limit) || 20, MAX_LIST);

  // ---------- ส่ง tx ----------

  app.post("/sendtx", async (request, reply) => {
    const { tx, signature } = request.body ?? {};

    let verified;
    try {
      verified = verifyTransaction({ tx, signature });       // 1) ลายเซ็น
    } catch (error) {
      return reply.status(400).send({ queued: false, error: error.message });
    }

    if (tx.action === "deploy") {                            // 2) ตรวจโค้ดก่อนเปลืองอะไรทั้งนั้น
      const reviewed = reviewProgram(tx.code);
      if (!reviewed.ok) return reply.status(400).send({ queued: false, error: "โค้ดไม่ผ่านการตรวจ", issues: reviewed.issues });
    }

    const simulation = simulate(vm, verified);               // 3) ลองรันดูก่อน
    if (!simulation.ok) {
      return reply.status(400).send({ queued: false, hash: verified.hash, simulation });   // ล้ม → ไม่เข้าคิว
    }

    const queued = mempool.add({ tx, signature });           // 4) ผ่านแล้วค่อยเข้าคิว
    if (!queued.ok) return reply.status(400).send({ queued: false, ...queued });
    return { queued: true, hash: queued.hash, sender: queued.sender, simulation };
  });

  app.post("/query", async (request, reply) => {
    const { programUuid, functionName, input, context } = request.body ?? {};
    const result = vm.query({ programUuid, functionName, input, context });   // ไม่กิน nonce ไม่เสียค่าแก๊ส
    return result.status === "success" ? result : reply.status(400).send(result);
  });

  app.get("/events", async (request) => vm.listEvents({
    program: request.query.program,
    name: request.query.name,
    limit: limitOf(request.query),
  }));

  app.get("/pending", async (request) => {
    mempool.prune();
    return { size: mempool.size, transactions: mempool.list().slice(0, limitOf(request.query)) };
  });

  app.get("/nonce/:address", async (request) => ({
    address: request.params.address.toLowerCase(),
    nonce: mempool.nextNonce(request.params.address),          // นับใบที่รออยู่ในคิวด้วย
    onChain: vm.checkTransaction({ from: request.params.address, nonce: -1 }).expectedNonce,
  }));

  // ---------- block ----------

  app.get("/block/latest", async () => vm.getBlock(vm.latestBlockNumber()) ?? { error: "ยังไม่มี block" });

  app.get("/block/:number", async (request, reply) => {
    const target = number(request.params.number);
    const header = target === null ? null : vm.getBlock(target);
    if (!header) return reply.status(404).send({ error: "ไม่พบ block" });
    if (request.query.full !== "1") return header;

    try {
      return vm.replayBlock(target);        // receipt เต็ม: trace / stateChanges / events
    } catch (error) {
      return reply.status(409).send({ error: error.message, header });
    }
  });

  app.get("/blocks", async (request) => vm.listBlocks({ limit: limitOf(request.query), reverse: true }));

  // ---------- tx ----------

  app.get("/tx/:hash", async (request, reply) => {
    const found = vm.getTransaction(request.params.hash);       // ค้นได้ทั้ง vmHash และ digest ที่ผู้ใช้เซ็น
    if (found) return { status: "confirmed", ...found };
    if (mempool.has(request.params.hash)) return { status: "pending", hash: request.params.hash };
    return reply.status(404).send({ error: "ไม่พบ tx" });
  });

  app.get("/tx/:hash/receipt", async (request, reply) => {
    const found = vm.getTransaction(request.params.hash);
    if (!found) return reply.status(404).send({ error: "ไม่พบ tx" });
    try {
      const receipt = vm.replayBlock(found.blockNumber);
      return receipt.transactions[found.index];
    } catch (error) {
      return reply.status(409).send({ error: error.message, tx: found });
    }
  });

  // ---------- address / program ----------

  app.get("/address/:address", async (request) => {
    const address = request.params.address.toLowerCase();
    return {
      address,
      native: vm.nativeBalanceOf(address),
      nonce: vm.checkTransaction({ from: address, nonce: -1 }).expectedNonce,
      metadata: vm.getMetadata(address),
      isProgram: vm.read(`${address}:this`) !== undefined,
      transactions: vm.listTransactionsOf(address, { limit: limitOf(request.query) }),
    };
  });

  app.get("/program/:address", async (request, reply) => {
    const address = request.params.address.toLowerCase();
    const code = vm.read(`${address}:code`);
    if (!code) return reply.status(404).send({ error: "ไม่พบโปรแกรม (อาจยังไม่ได้ init)" });
    return {
      address, code,
      context: vm.read(`${address}:context`),
      metadata: vm.getMetadata(address),
      native: vm.nativeBalanceOf(address),
      storage: vm.listProgramStorage(address, { limit: limitOf(request.query) }),
    };
  });

  app.get("/name/:namespace", async (request, reply) => {
    const address = vm.resolveNamespace(request.params.namespace);
    return address ? { namespace: request.params.namespace.toLowerCase(), address } : reply.status(404).send({ error: "ไม่พบชื่อนี้" });
  });

  // ---------- state ย้อนหลัง ----------

  app.get("/state/:address", async (request) => {
    const at = number(request.query.block);
    const prefix = `${request.params.address.toLowerCase()}:storage:`;
    return at === null ? vm.listProgramStorage(request.params.address) : vm.snapshotAt(at, prefix);
  });
}

/** ปิด block อัตโนมัติ */
export function startMiner(app, { intervalMs = 3000, feeRecipient = MINER, maxPerBlock = 500 } = {}) {
  let mining = false;
  const timer = setInterval(() => {
    if (mining) return;                       // กัน block ซ้อน
    mining = true;
    try {
      app.mempool.prune();
      if (app.mempool.size === 0) return;     // ไม่มีอะไรก็ไม่ต้องปิด block เปล่า
      const block = app.vm.createBlock({ timestamp: Date.now(), feeRecipient });
      app.mempool.take(block, { limit: maxPerBlock });
      block.commit();
      app.log?.info?.(`block ${block.number} ปิดแล้ว (${block.results().length} tx)`);
    } catch (error) {
      app.log?.error?.(error);
    } finally {
      mining = false;
    }
  }, intervalMs);

  timer.unref?.();
  return () => clearInterval(timer);
}
