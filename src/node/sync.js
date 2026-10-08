/**
 * ซิงก์ block จาก node ผู้ผลิตมารันเองแล้วเทียบ hash
 *   const stop = startSync(vm, { url: "https://node1.example.com", genesis });
 *
 * node ผู้อ่านไม่เชื่อ state ที่ส่งมา แต่รัน blockbody เองแล้วเทียบ blockHash
 * ถ้าไม่ตรง = ข้อมูลไม่ตรงกัน ให้หยุดทันที ไม่บันทึกอะไรต่อ
 */

/** รัน block ที่ดึงมา 1 อัน แล้วเทียบ hash */
export function applyBlock(vm, { header, body }) {
  const block = vm.createBlock({
    number: header.number,
    parentHash: header.parentHash,
    parentStateRoot: header.parentStateRoot,
    timestamp: header.timestamp,
    feeRecipient: header.feeRecipient,
    burnPercent: header.burnPercent,
    checkChain: false,
    maxTransactions: null,
    maxTransactionsPerSender: null,
    maxBlockGas: null,
  });
  for (const { method, request } of body) block[method](request);

  const local = block.header();
  if (local.hash !== header.hash) {
    throw new Error(`block ${header.number} ไม่ตรงกับผู้ผลิต (ของเรา ${local.hash} / ที่ส่งมา ${header.hash})`);
  }
  block.commit();
  return local;
}

/** ดึง block ที่ขาดแล้วรันให้ครบ → จำนวน block ที่เพิ่มเข้ามา */
export async function syncOnce(vm, fetchBlocks, { limit = 50 } = {}) {
  const from = (vm.latestBlockNumber() ?? 0) + 1;
  const blocks = await fetchBlocks(from, limit);
  for (const item of blocks) applyBlock(vm, item);
  return blocks.length;
}

/** ซิงก์ต่อเนื่อง — คืนฟังก์ชันสำหรับหยุด */
export function startSync(vm, { url, genesis, intervalMs = 3000, limit = 50, onError, onBlock } = {}) {
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
      const added = await syncOnce(vm, fetchBlocks, { limit });
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
      if (header && body) blocks.push({ header, body });
    }
    return blocks;
  });

  app.get("/genesis", async () => ({ hash: app.vm.genesisHash() }));
}
