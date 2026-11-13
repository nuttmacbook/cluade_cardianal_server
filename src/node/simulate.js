/**
 * Estimates a tx's outcome before it enters the queue — commits nothing
 *
 *   const verified = verifyTransaction({ tx, signature });
 *   const result = simulate(vm, verified);
 *   if (!result.ok) return reply.status(400).send(result);
 *
 * Note: runs on the DB's current state and doesn't account for txs still waiting in the queue
 * so it is an "estimate", not a guarantee
 */

const MINER = "0x1111111111111111111111111111111111111111";

/**
 * @param {import("../core/virtualmachine.js").VirtualMachine} vm
 * @param {{ method: string, request: object }} item the result of verifyTransaction
 */
export function simulate(vm, item, { feeRecipient = MINER, timestamp = Date.now() } = {}) {
  // always simulate as the next block: BlockNumber() / BlockHash() in programs get the same values as when actually included
  // (previously number: null → BlockNumber() was null during simulate → programs computing with the block number were rejected at /sendtx even though they ran fine in a block)
  // and approving a timelocked upgrade needs the block number (scheduled for activation at block + N)
  const preview = vm.createBlock({
    timestamp,
    feeRecipient,
    number: (vm.latestBlockNumber() ?? 0) + 1,   // doesn't reserve a real number (recordBlocks: false · no commit)
    checkChain: false,     // don't check the block chain linkage
    recordBlocks: false,
    recordHistory: false,
  });

  // the nonce was already checked at /sendtx (counting txs waiting in the queue)
  // here we simulate with the DB's current nonce so the sender's 2nd, 3rd tx can run
  const { expectedNonce } = vm.checkTransaction(item.request);
  const request = expectedNonce === null ? item.request : { ...item.request, nonce: expectedNonce };

  const result = preview[item.method](request);   // no commit → DB unchanged

  return {
    ok: result.status === "success",
    accepted: result.accepted,
    status: result.status,
    result: result.result ?? null,
    error: result.error?.message ?? null,
    errorCode: result.error?.code ?? null,
    debug: result.debug ?? null,        // the raw V8 message, for program authors to debug
    gasUsed: result.gasUsed,
    fee: result.fee,
    events: (result.events ?? []).map(({ name, data }) => ({ name, data })),
    trace: (result.calls ?? []).map((call) => `${call.depth} ${call.programUuid}.${call.functionName} ${call.status}`),
    note: "estimated on current state; the real result depends on the order within the block",
  };
}
