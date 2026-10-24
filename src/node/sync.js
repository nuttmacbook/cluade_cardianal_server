/**
 * ซิงก์ block จาก node ผู้ผลิตมารันเองแล้วเทียบ hash
 *   const stop = startSync(vm, { url: "https://node1.example.com", genesis, producers: genesis.config.producers });
 *
 * node ผู้อ่านไม่เชื่อ state ที่ส่งมา แต่รัน blockbody เองแล้วเทียบ blockHash
 * ถ้าไม่ตรง = ข้อมูลไม่ตรงกัน ให้หยุดทันที ไม่บันทึกอะไรต่อ
 *
 * ผู้ผลิต (header.producer อยู่ใน hash · header.producerSignature = ลายเซ็นบน hash):
 *   มีลายเซ็น → ต้องกู้ได้ address ของ producer เสมอ
 *   ส่ง producers (รายชื่อใน genesis) → ทุก block ต้องมีผู้ผลิตที่อยู่ในรายชื่อ และลายเซ็นถูก (block ไม่มีผู้ผลิต = ปฏิเสธ)
 * tx ใน block รันด้วย vm.replayTimeoutMs (ผู้ผลิตกรอง TIMEOUT ไปแล้ว → เครื่องที่ช้ากว่าไม่ได้ผลต่าง)
 */
import { recoverTypedDataDigest } from "../crypto/program-signature.js";

const lower = (value) => String(value ?? "").toLowerCase();

/** ตรวจผู้ผลิตของ header → throw ถ้าใช้ไม่ได้ */
export function verifyProducer(header, producers = null) {
  const allowed = producers ? producers.map(lower) : null;
  if (!header.producer) {
    if (allowed) throw new Error(`block ${header.number} ไม่มีผู้ผลิต (genesis กำหนดผู้ผลิตไว้)`);
    return null;
  }
  const producer = lower(header.producer);
  if (allowed && !allowed.includes(producer)) throw new Error(`block ${header.number} ผลิตโดย ${producer} ซึ่งไม่อยู่ในรายชื่อผู้ผลิต`);
  const signer = header.producerSignature ? recoverTypedDataDigest(header.hash, header.producerSignature) : null;
  if (signer !== producer) throw new Error(`block ${header.number} ลายเซ็นผู้ผลิตไม่ถูกต้อง`);
  return producer;
}

/** รัน block ที่ดึงมา 1 อัน แล้วเทียบ hash */
export function applyBlock(vm, { header, body, rejected = [] }, { producers = null } = {}) {
  verifyProducer(header, producers);
  const block = vm.createBlock({
    number: header.number,
    parentHash: header.parentHash,
    parentStateRoot: header.parentStateRoot,
    timestamp: header.timestamp,
    feeRecipient: header.feeRecipient,
    burnPercent: header.burnPercent,
    producer: header.producer ?? null,
    producerSignature: header.producerSignature ?? null,
    timeoutMs: vm.replayTimeoutMs,
    checkChain: false,
    maxTransactions: null,
    maxTransactionsPerSender: null,
    maxBlockGas: null,
  });
  for (const { method, request } of body) block[method](request);
  for (const entry of rejected ?? []) block.recordRejected(entry);   // tx ที่ถูกปฏิเสธ: อยู่ใน hash ของ block (rejectedRoot)

  const local = block.header();
  if (local.hash !== header.hash) {
    throw new Error(`block ${header.number} ไม่ตรงกับผู้ผลิต (ของเรา ${local.hash} / ที่ส่งมา ${header.hash})`);
  }
  block.commit();
  return local;
}

/** ดึง block ที่ขาดแล้วรันให้ครบ → จำนวน block ที่เพิ่มเข้ามา */
export async function syncOnce(vm, fetchBlocks, { limit = 50, producers = null } = {}) {
  const from = (vm.latestBlockNumber() ?? 0) + 1;
  const blocks = await fetchBlocks(from, limit);
  for (const item of blocks) applyBlock(vm, item, { producers });
  return blocks.length;
}

/** ซิงก์ต่อเนื่อง — คืนฟังก์ชันสำหรับหยุด */
export function startSync(vm, { url, genesis, producers = genesis?.config?.producers ?? null, intervalMs = 3000, limit = 50, onError, onBlock } = {}) {
  if (genesis) vm.applyGenesis(genesis);           // หยุดทันทีถ้า genesis ไม่ตรง

  const fetchBlocks = async (from, count) => {
    const response = await fetch(`${url}/sync?from=${from}&limit=${count}`);
    if (!response.ok) throw new Error(`sync ล้มเหลว: ${response.status}`);
    return response.json();
  };

  let running = false;
  let stopped = false;
  const timer = setInterval(async () => {
    if (running || stopped) return;
    running = true;
    try {
      const added = await syncOnce(vm, fetchBlocks, { limit, producers });
      if (added) onBlock?.(vm.latestBlockNumber());
    } catch (error) {
      stopped = true;                               // ข้อมูลไม่ตรงกัน = หยุด ไม่เดินต่อ
      clearInterval(timer);
      onError?.(error);
    } finally {
      running = false;
    }
  }, intervalMs);

  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}

/** ฝั่งผู้ผลิต: ส่ง block ให้ node อื่น (ใช้กับ fastify) */
export function syncRoute(app) {
  app.get("/sync", async (request) => {
    const from = Math.max(1, Number(request.query.from) || 1);
    const limit = Math.min(Number(request.query.limit) || 50, 200);
    const latest = app.vm.latestBlockNumber() ?? 0;

    const blocks = [];
    for (let number = from; number <= Math.min(latest, from + limit - 1); number += 1) {
      const header = app.vm.getBlock(number);
      const body = app.vm.getBlockBody(number);
      if (header && body) blocks.push({ header, body, rejected: app.vm.getBlockRejected(number) });
    }
    return blocks;
  });

  app.get("/genesis", async () => ({ hash: app.vm.genesisHash() }));
}
