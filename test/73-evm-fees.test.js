import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { createEvmRpc, EVM_ERROR } from "../src/node/evm-rpc.js";

/*
 * /evm กับค่าแก๊สแบบ EIP-1559
 *   block มี baseFeePerGas · tx แบบ 1559 เป็น type 0x2 (maxFeePerGas / maxPriorityFeePerGas) · receipt มี effectiveGasPrice
 *   eth_gasPrice = base fee ของ block ถัดไป + tip ที่แนะนำ · eth_maxPriorityFeePerGas = tip ที่แนะนำ (มัธยฐาน) · eth_feeHistory แบบ geth
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const MINER = "0x00000000000000000000000000000000000000aa";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const MIN = 1000n;
const TRANSFER_GAS = 1300;
const hex = (value) => `0x${BigInt(value).toString(16)}`;

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true,
    feeRecipient: MINER, gas: { price: MIN }, maxBlockGas: 10_000,   // target 5,000
  });
  vm.db.load({ [`${ALICE}:native:received`]: "1000000000000n", [`${BOB}:native:received`]: "1000000000000n" });
  let nonce = 0;
  const mine = (number, fees) => {
    const block = vm.createBlock({ timestamp: T + number * 1000, feeRecipient: MINER });
    const results = fees.map((fee) => block.transfer({ from: ALICE, to: BOB, amount: 1, nonce: nonce++, ...fee }));
    block.commit();
    return vm.getBlock(number).txHashes.map((hash, i) => ({ ...results[i], hash }));
  };
  // block 1: 7 ใบ (9,100 แก๊ส > เป้า) → base fee ขึ้นเป็น 1102
  const first = mine(1, [
    { maxFeePerGas: "5000", maxPriorityFeePerGas: "10" },
    { maxFeePerGas: "5000", maxPriorityFeePerGas: "20" },
    { gasPrice: "1030" },
    { maxFeePerGas: "1005", maxPriorityFeePerGas: "50" },   // tip จริง = 5
    {}, {}, {},                                               // ไม่ระบุ = จ่าย base fee (tip 0)
  ]);
  const second = mine(2, [{ maxFeePerGas: "3000", maxPriorityFeePerGas: "40" }]);
  mine(3, []);
  return { vm, rpc: createEvmRpc({ vm }), first, second };
}
const call = (rpc, method, params = []) => rpc.handle({ jsonrpc: "2.0", id: 1, method, params });

test("/evm block: baseFeePerGas ตาม header · gasUsed / gasLimit", () => {
  const { vm, rpc } = chain();
  const one = call(rpc, "eth_getBlockByNumber", ["0x1", false]).result;
  const two = call(rpc, "eth_getBlockByNumber", ["0x2", false]).result;
  assert.equal(one.baseFeePerGas, hex(MIN));
  assert.equal(two.baseFeePerGas, hex(1102));
  assert.equal(two.baseFeePerGas, hex(vm.getBlock(2).baseFeePerGas.replace(/n$/, "")));
  assert.equal(one.gasUsed, hex(7 * TRANSFER_GAS));
});

test("/evm tx + receipt: แบบ 1559 = type 0x2 มี maxFee / priority · gasPrice = effectiveGasPrice · แบบเดิม = type 0x0", () => {
  const { rpc, first } = chain();
  const tx = (hash) => call(rpc, "eth_getTransactionByHash", [hash]).result;
  const receipt = (hash) => call(rpc, "eth_getTransactionReceipt", [hash]).result;
  const typed = tx(first[0].hash);
  assert.deepEqual([typed.type, typed.maxFeePerGas, typed.maxPriorityFeePerGas, typed.gasPrice], ["0x2", hex(5000), hex(10), hex(1010)]);
  assert.deepEqual(typed.accessList, []);
  assert.deepEqual([receipt(first[0].hash).type, receipt(first[0].hash).effectiveGasPrice], ["0x2", hex(1010)]);
  // maxFee จำกัดราคา: min(1005, 1000 + 50) = 1005
  assert.equal(receipt(first[3].hash).effectiveGasPrice, hex(1005));
  const legacy = tx(first[2].hash);
  assert.deepEqual([legacy.type, legacy.gasPrice, legacy.maxFeePerGas], ["0x0", hex(1030), undefined]);
  assert.equal(receipt(first[2].hash).effectiveGasPrice, hex(1030));
  assert.equal(receipt(first[4].hash).effectiveGasPrice, hex(MIN));
});

test("eth_maxPriorityFeePerGas = มัธยฐานของ tip ล่าสุด · eth_gasPrice = base fee ถัดไป + tip นั้น", () => {
  const { vm, rpc } = chain();
  // tip: [10, 20, 30, 5, 0, 0, 0] + [40] → เรียง [0,0,0,5,10,20,30,40] → มัธยฐาน (ตำแหน่ง 4) = 10
  assert.equal(call(rpc, "eth_maxPriorityFeePerGas").result, hex(10));
  assert.equal(vm.currentBaseFee(), 1000n);   // block 2 เบา → 1001 · block 3 ว่าง → ขั้นต่ำ
  assert.equal(call(rpc, "eth_gasPrice").result, hex(1000 + 10));
  // เชนเปล่า: tip 0 · gasPrice = ขั้นต่ำ
  const empty = createEvmRpc({ vm: new VM.VirtualMachine(new MemoryDB(), { gas: { price: 7n } }) });
  assert.equal(call(empty, "eth_maxPriorityFeePerGas").result, "0x0");
  assert.equal(call(empty, "eth_gasPrice").result, "0x7");
});

test("eth_feeHistory: baseFeePerGas (+1 ช่องของ block ถัดไป) · gasUsedRatio · reward ตาม percentile ถ่วงแก๊ส", () => {
  const { rpc } = chain();
  const history = call(rpc, "eth_feeHistory", ["0x3", "latest", [0, 50, 100]]).result;
  assert.equal(history.oldestBlock, "0x1");
  assert.deepEqual(history.baseFeePerGas, [hex(1000), hex(1102), hex(1001), hex(1000)]);
  assert.deepEqual(history.gasUsedRatio, [(7 * TRANSFER_GAS) / 10_000, TRANSFER_GAS / 10_000, 0]);
  assert.deepEqual(history.reward, [[hex(0), hex(5), hex(30)], [hex(40), hex(40), hex(40)], ["0x0", "0x0", "0x0"]]);
  // ไม่ขอ reward → ไม่มี field · ขอมากกว่าที่มี → เริ่มที่ block 0
  const plain = call(rpc, "eth_feeHistory", ["0x10", "0x2"]).result;
  assert.equal(plain.reward, undefined);
  assert.equal(plain.oldestBlock, "0x0");
  assert.deepEqual(plain.baseFeePerGas.slice(-2), [hex(1102), hex(1001)]);   // ช่องท้าย = base fee ของ block 3
  assert.equal(call(rpc, "eth_feeHistory", ["0x1", "latest", [50, 10]]).error.code, EVM_ERROR.PARAMS);
  assert.equal(call(rpc, "eth_feeHistory", ["0x1", "0x99"]).error.code, EVM_ERROR.SERVER);
});
