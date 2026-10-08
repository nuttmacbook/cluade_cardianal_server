/**
 * ประเมินผล tx ก่อนรับเข้าคิว — ไม่ commit อะไรเลย
 *
 *   const verified = verifyTransaction({ tx, signature });
 *   const result = simulate(vm, verified);
 *   if (!result.ok) return reply.status(400).send(result);
 *
 * หมายเหตุ: รันบน state ปัจจุบันของ DB ไม่ได้นับผลของ tx ที่ยังรออยู่ในคิว
 * จึงเป็น "การประเมิน" ไม่ใช่การรับประกัน
 */

const MINER = "0x1111111111111111111111111111111111111111";

/**
 * @param {import("../core/virtualmachine.js").VirtualMachine} vm
 * @param {{ method: string, request: object }} item ผลจาก verifyTransaction
 */
export function simulate(vm, item, { feeRecipient = MINER, timestamp = Date.now() } = {}) {
  const preview = vm.createBlock({
    timestamp,
    feeRecipient,
    number: null,          // ไม่จองเลข block
    checkChain: false,     // ไม่ตรวจสายของ block
    recordBlocks: false,
    recordHistory: false,
  });

  // nonce ถูกตรวจที่ /sendtx แล้ว (นับใบที่รออยู่ในคิวด้วย)
  // ตรงนี้จำลองด้วย nonce ปัจจุบันของ DB เพื่อให้ใบที่ 2, 3 ของคนเดิมรันได้
  const { expectedNonce } = vm.checkTransaction(item.request);
  const request = expectedNonce === null ? item.request : { ...item.request, nonce: expectedNonce };

  const result = preview[item.method](request);   // ไม่ commit → DB ไม่เปลี่ยน

  return {
    ok: result.status === "success",
    accepted: result.accepted,
    status: result.status,
    result: result.result ?? null,
    error: result.error?.message ?? null,
    errorCode: result.error?.code ?? null,
    debug: result.debug ?? null,        // ข้อความจริงจาก V8 ไว้ให้ผู้เขียนโปรแกรมแก้
    gasUsed: result.gasUsed,
    fee: result.fee,
    events: (result.events ?? []).map(({ name, data }) => ({ name, data })),
    trace: (result.calls ?? []).map((call) => `${call.depth} ${call.programUuid}.${call.functionName} ${call.status}`),
    note: "ประเมินบน state ปัจจุบัน ผลจริงขึ้นกับลำดับใน block",
  };
}
