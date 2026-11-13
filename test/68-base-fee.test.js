import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, num } from "./helpers.js";

/*
 * EIP-1559: base fee per block (rises / falls with block fullness against gasTarget, at most 12.5% per block, never below minBaseFee)
 *   effective price = min(maxFeePerGas, baseFee + maxPriorityFeePerGas) · the base fee part is burned (burnPercent) · the tip goes to the block producer
 *   legacy gasPrice = maxFee = priority (works as before)
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const MINER = "0x00000000000000000000000000000000000000aa";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const MIN = 1000n;
const TRANSFER_GAS = 100 + 2 * (100 + 500);   // call + (read + write) × 2

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true,
    feeRecipient: MINER, gas: { price: MIN }, maxBlockGas: 10_000, ...options,   // target = 5,000
  });
  vm.db.load({ [`${ALICE}:native:received`]: "1000000000000n", [`${BOB}:native:received`]: "1000000000000n" });
  return vm;
}
const nonces = new Map();
const send = (from, fees = {}) => {
  const nonce = nonces.get(from) ?? 0;
  return { from, to: BOB, amount: 1, nonce, ...fees };
};
/** Close a block with the given txs (returns each result + header); sender nonces are filled in automatically */
function mine(vm, txs, number) {
  const block = vm.createBlock({ timestamp: T + number * 1000, feeRecipient: MINER });
  const results = txs.map((tx) => {
    const result = block.transfer(tx);
    if (result.accepted !== false) nonces.set(tx.from, tx.nonce + 1);
    return result;
  });
  const header = block.header();
  block.commit();
  return { block, results, header };
}

test("base fee: block over target → rises per the formula · empty block → falls, but not below the minimum", () => {
  nonces.clear();
  const vm = setup();
  assert.equal(vm.gasTarget, 5000);   // unset gasTarget = maxBlockGas / 2
  const first = mine(vm, Array.from({ length: 7 }, () => send(ALICE)).map((tx, i) => ({ ...tx, nonce: i })), 1);
  assert.equal(first.header.baseFeePerGas, `${MIN}n`);   // first block = minimum
  assert.equal(first.header.gasUsed, 7 * TRANSFER_GAS);   // 9,100 > 5,000

  const up = MIN + (MIN * BigInt(7 * TRANSFER_GAS - 5000)) / 5000n / 8n;
  assert.equal(vm.currentBaseFee(), up);
  assert.equal(up, 1102n);
  const second = mine(vm, [], 2);
  assert.equal(second.header.baseFeePerGas, "1102n");

  // empty block → down 1/8 (1102 - 137 = 965) but not below 1000
  assert.equal(vm.currentBaseFee(), MIN);
  assert.equal(mine(vm, [], 3).header.baseFeePerGas, `${MIN}n`);
});

test("base fee: nextBaseFee follows the EIP-1559 formula · rises by at least 1 · at target = unchanged · no target = always the minimum", () => {
  const base = { parentBaseFee: 1_000_000_000n, gasTarget: 15_000_000, denominator: 8, minimum: 1n };
  assert.equal(VM.nextBaseFee({ ...base, parentGasUsed: 30_000_000 }), 1_125_000_000n);   // 2× full = +12.5%
  assert.equal(VM.nextBaseFee({ ...base, parentGasUsed: 0 }), 875_000_000n);              // empty = -12.5%
  assert.equal(VM.nextBaseFee({ ...base, parentGasUsed: 15_000_000 }), 1_000_000_000n);
  assert.equal(VM.nextBaseFee({ ...base, parentBaseFee: 7n, parentGasUsed: 15_000_001 }), 8n);   // at least +1
  assert.equal(VM.nextBaseFee({ ...base, gasTarget: null, parentGasUsed: 30_000_000, minimum: 5n }), 5n);
  // configurable: target / denominator / minimum
  const vm = setup({ gasTarget: 1000, baseFeeChangeDenominator: 2, minBaseFee: 500n });
  assert.deepEqual([vm.gasTarget, vm.baseFeeChangeDenominator, vm.minBaseFee], [1000, 2, 500n]);
  assert.equal(vm.baseFeeAfter({ baseFeePerGas: "1000n", gasUsed: 2000 }), 1500n);   // 2× full ÷ 2 = +50%
  assert.throws(() => setup({ baseFeeChangeDenominator: 0 }), /baseFeeChangeDenominator/);
  // no maxBlockGas and no gasTarget → fixed base fee (old behavior)
  assert.equal(new VM.VirtualMachine(new MemoryDB(), { gas: { price: 7n } }).currentBaseFee(), 7n);
});

test("effective price = min(maxFee, baseFee + priority) · base fee burned · tip to the block producer · totals are preserved", () => {
  nonces.clear();
  const vm = setup();
  mine(vm, Array.from({ length: 7 }, (_, i) => ({ ...send(ALICE), nonce: i })), 1);   // push the base fee to 1102
  const burnedBefore = vm.nativeBalanceOf(VM.BURN_ADDRESS).balance;
  const { results, header } = mine(vm, [
    send(BOB, { maxFeePerGas: "2000", maxPriorityFeePerGas: "500" }),         // 1102 + 500 = 1602 < 2000
  ], 2);
  const [roomy] = results;
  assert.equal(header.baseFeePerGas, "1102n");
  assert.deepEqual([roomy.gasPrice, roomy.baseFee, roomy.feeType, roomy.maxFeePerGas, roomy.maxPriorityFeePerGas], ["1602n", "1102n", 2, "2000n", "500n"]);
  assert.equal(num(roomy.fee), TRANSFER_GAS * 1602);
  assert.equal(num(roomy.burnedFee), TRANSFER_GAS * 1102);
  assert.equal(num(roomy.producerFee), TRANSFER_GAS * 500);

  // maxFee below baseFee + priority → pays maxFee (tip = maxFee - baseFee)
  nonces.set(BOB, 1);
  const capped = mine(vm, [send(BOB, { maxFeePerGas: "1200", maxPriorityFeePerGas: "500" })], 3).results[0];
  const base3 = vm.getBlock(3).baseFeePerGas;
  assert.equal(capped.gasPrice, "1200n");
  assert.equal(num(capped.producerFee), TRANSFER_GAS * (1200 - num(base3)));
  assert.equal(num(capped.burnedFee), TRANSFER_GAS * num(base3));

  // the header totals burned / producer amounts · burned total accumulates at 0x000…000 · the producer gets the full tip
  assert.equal(header.burnedFee, roomy.burnedFee);
  assert.equal(header.producerFee, roomy.producerFee);
  assert.equal(vm.nativeBalanceOf(VM.BURN_ADDRESS).balance - burnedBefore, BigInt(num(roomy.burnedFee) + num(capped.burnedFee)));
  assert.equal(vm.nativeBalanceOf(MINER).balance, BigInt(num(roomy.producerFee) + num(capped.producerFee)));
});

test("burnPercent = share of the base fee that is burned (tips are not burned) · no feeRecipient = burn everything", () => {
  nonces.clear();
  const vm = setup({ burnPercent: 50, maxBlockGas: null });
  const [res] = mine(vm, [send(ALICE, { maxFeePerGas: "3000", maxPriorityFeePerGas: "1000" })], 1).results;
  assert.equal(res.gasPrice, "2000n");
  assert.equal(num(res.producerFee), TRANSFER_GAS * 1000 + (TRANSFER_GAS * 1000) / 2);
  assert.equal(num(res.burnedFee), (TRANSFER_GAS * 1000) / 2);

  const solo = new VM.VirtualMachine(new MemoryDB(), { chargeGas: true, requireNonce: true, gas: { price: MIN } });
  solo.db.load({ [`${ALICE}:native:received`]: "1000000000n" });
  const alone = solo.transfer({ from: ALICE, to: BOB, amount: 1, nonce: 0, maxFeePerGas: "5000", maxPriorityFeePerGas: "2000" }, { timestamp: T });
  assert.deepEqual([alone.producerFee, alone.burnedFee], ["0n", alone.fee]);
});

test("legacy gasPrice: = maxFee = priority · below base fee → not accepted into the block (no nonce used) · no price = pays the base fee", () => {
  nonces.clear();
  const vm = setup();
  mine(vm, Array.from({ length: 7 }, (_, i) => ({ ...send(ALICE), nonce: i })), 1);   // base fee 1102
  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: MINER });
  assert.equal(block.baseFee, 1102n);
  const legacy = block.transfer({ from: BOB, to: ALICE, amount: 1, nonce: 0, gasPrice: 1500 });
  assert.deepEqual([legacy.gasPrice, legacy.feeType, legacy.producerFee], ["1500n", undefined, `${TRANSFER_GAS * (1500 - 1102)}n`]);
  const low = block.transfer({ from: BOB, to: ALICE, amount: 1, nonce: 1, gasPrice: 1050 });
  assert.deepEqual([low.accepted, low.error.code], [false, "INVALID_REQUEST"]);
  assert.match(low.error.message, /gasPrice/);
  const plain = block.transfer({ from: BOB, to: ALICE, amount: 1, nonce: 1 });   // nonce 1 is still free (the rejected tx did not use it)
  assert.deepEqual([plain.status, plain.gasPrice, plain.producerFee], ["success", "1102n", "0n"]);
  const header = block.header();
  assert.equal(header.txCount, 2);

  // the receipt shows type / effective price / base fee / offered price
  const receipt = block.receipt().transactions;
  assert.deepEqual(receipt.map((r) => [r.type, r.effectiveGasPrice, r.baseFeePerGas, r.maxFeePerGas, r.maxPriorityFeePerGas]),
    [[0, "1500n", "1102n", "1500n", "1500n"], [0, "1102n", "1102n", null, null]]);
});

test("gas fee field checks: priority > maxFee / maxFee < baseFee / combined with gasPrice / negative values → INVALID_REQUEST", () => {
  nonces.clear();
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, feeRecipient: MINER });
  const bad = [
    [{ maxFeePerGas: "1500", maxPriorityFeePerGas: "1600" }, /maxPriorityFeePerGas must not exceed maxFeePerGas/],
    [{ maxFeePerGas: "999" }, /is below the block base fee/],
    [{ gasPrice: "2000", maxFeePerGas: "2000" }, /gasPrice cannot be combined with maxFeePerGas/],
    [{ maxPriorityFeePerGas: "-1" }, /maxPriorityFeePerGas must be a non-negative integer/],
  ];
  for (const [fees, message] of bad) {
    const res = block.transfer({ from: ALICE, to: BOB, amount: 1, nonce: 0, ...fees });
    assert.equal(res.accepted, false, JSON.stringify(fees));
    assert.match(res.error.message, message);
  }
  // priority only → maxFee = baseFee + priority
  const tipOnly = block.transfer({ from: ALICE, to: BOB, amount: 1, nonce: 0, maxPriorityFeePerGas: "7" });
  assert.deepEqual([tipOnly.status, tipOnly.gasPrice, tipOnly.maxFeePerGas], ["success", "1007n", "1007n"]);
});

test("tx hash: legacy has no new fields (same hash) · 1559 includes maxFee / priority", () => {
  const vm = setup();
  const legacy = { from: ALICE, to: BOB, amount: 1, nonce: 0, gasPrice: 5 };
  assert.deepEqual(Object.keys(vm.transactionPayload(legacy)).sort(), ["action", "amount", "chainId", "from", "gasLimit", "gasPrice", "nonce", "to"]);
  const typed = { from: ALICE, to: BOB, amount: 1, nonce: 0, maxFeePerGas: "9", maxPriorityFeePerGas: "1" };
  assert.deepEqual([vm.transactionPayload(typed).maxFeePerGas, vm.transactionPayload(typed).maxPriorityFeePerGas], ["9", "1"]);
  assert.notEqual(vm.hashTransaction(typed), vm.hashTransaction({ ...typed, maxPriorityFeePerGas: "2" }));
});

test("the base fee is in the block hash · replay / rebuild compute the base fee from the previous block and get the same hash", () => {
  nonces.clear();
  const vm = setup();
  mine(vm, Array.from({ length: 7 }, (_, i) => ({ ...send(ALICE), nonce: i })), 1);
  const second = mine(vm, [send(BOB, { maxFeePerGas: "3000", maxPriorityFeePerGas: "10" })], 2).header;
  assert.equal(second.baseFeePerGas, "1102n");

  const fields = {
    number: 2, parentHash: second.parentHash, parentStateRoot: second.parentStateRoot, timestamp: second.timestamp,
    feeRecipient: MINER, burnPercent: 100, txHashes: second.txHashes, writes: [], gasUsed: second.gasUsed,
    receiptsRoot: second.receiptsRoot, logsBloom: second.logsBloom,
  };
  assert.notEqual(vm.hashBlock({ ...fields, baseFeePerGas: "1102n" }).hash, vm.hashBlock({ ...fields, baseFeePerGas: "1000n" }).hash);
  assert.notEqual(vm.hashBlock({ ...fields, baseFeePerGas: "1102n" }).hash, vm.hashBlock({ ...fields, baseFeePerGas: "1102n", gasUsed: 1 }).hash);

  assert.equal(vm.replayBlock(2).hash, second.hash);
  assert.equal(vm.replayBlock(2).baseFeePerGas, "1102n");
  vm.rebuildFrom(2);
  assert.equal(vm.getBlock(2).hash, second.hash);
});

test("BaseFee() / GasPrice() in programs: the block's base fee and the tx's effective price · charged as env gas", () => {
  nonces.clear();
  const vm = setup();
  const code = `function program() {
  function fees() { return { base: BaseFee(), price: GasPrice() } }
  function one() { return BaseFee() }
  function none() { return 0n }
  return { fees, one, none }
}`;
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "fees", code, context: { sender: ALICE, origin: ALICE } }).writes);
  vm.commit(plain.init({ programUuid: "fees" }).writes);
  mine(vm, Array.from({ length: 7 }, (_, i) => ({ ...send(ALICE), nonce: i })), 1);
  const block = vm.createBlock({ timestamp: T + 2000, feeRecipient: MINER });
  const res = block.call({ programUuid: "fees", functionName: "fees", context: { sender: BOB, origin: BOB }, nonce: 0, maxFeePerGas: "5000", maxPriorityFeePerGas: "3" });
  assert.deepEqual(res.result, { base: "1102n", price: "1105n" });
  const one = block.call({ programUuid: "fees", functionName: "one", context: { sender: BOB, origin: BOB }, nonce: 1 });
  const none = block.call({ programUuid: "fees", functionName: "none", context: { sender: BOB, origin: BOB }, nonce: 2 });
  assert.equal(one.gasUsed - none.gasUsed, vm.gas.env + 1);   // + 1 node for the call (one has 1 call, none has 1 number literal)
  // a query (outside a block) sees the next block's base fee
  assert.equal(vm.query({ programUuid: "fees", functionName: "one" }).result, `${vm.currentBaseFee()}n`);
});
