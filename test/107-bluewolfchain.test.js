import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VM, MemoryDB, user } from "./helpers.js";
import { resolveSettings } from "../src/node/genesis.js";
import { systemPrograms } from "../src/standards/system.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * ค่าตั้งต้นของ Bluewolfchain (BWSC)
 *   chainId 41234 · min gas price 10,000 gwei · block ทุก 2 วินาที · block 5M แก๊ส (gasTarget 2.5M)
 *   fork "bluewolf" (genesis.json เปิดตั้งแต่ block 0): ราคาต่อหน่วย 2.5 เท่าของภาระเครื่องจริง + ค่าพื้นฐาน 15,000 ต่อ tx
 */

const ALICE = "0x00000000000000000000000000000000000a11ce";
const BOB = "0x0000000000000000000000000000000000000b0b";

test("Bluewolfchain: ค่าตั้งต้นของเชน + genesis.json ของ repo", () => {
  const { settings, errors } = resolveSettings({}, {});
  assert.deepEqual(errors, []);
  assert.equal(settings.chainId, 41234);
  assert.equal(settings.minBaseFee, 10_000n * 10n ** 9n);   // 10,000 gwei
  assert.equal(settings.blockMs, 2000);
  assert.equal(settings.maxBlockGas, 5_000_000);

  const genesis = JSON.parse(fs.readFileSync(new URL("../genesis.json", import.meta.url), "utf8"));
  assert.equal(genesis.chainId, 41234);
  assert.deepEqual(genesis.forks, { bluewolf: 0 });
  const mainnet = JSON.parse(fs.readFileSync(new URL("../deploy/genesis.mainnet.example.json", import.meta.url), "utf8"));
  assert.equal(mainnet.chainId, 41234);
  assert.deepEqual(mainnet.forks, { bluewolf: 0 });
  assert.deepEqual([mainnet.config.blockMs, mainnet.config.maxBlockGas, mainnet.config.gasTarget, mainnet.config.minBaseFee],
    [2000, 5_000_000, 2_500_000, "10000000000000"]);
});

test("fork bluewolf: ราคาต่อหน่วย ×2.5 · ค่าพื้นฐาน 15,000 ต่อ tx · ไม่เปิด fork = ตารางเดิม (tx = 0)", () => {
  assert.equal(VM.DEFAULT_GAS.tx, 0);
  const vm = new VM.VirtualMachine(new MemoryDB(), { forks: { bluewolf: 0 }, maxBlockGas: 5_000_000 });
  const gas = vm.gasAt(1);
  assert.deepEqual([gas.call, gas.read, gas.write, gas.stateKey, gas.byte, gas.event, gas.topic, gas.code, gas.node, gas.builtin, gas.tx],
    [1750, 150, 125, 1125, 10, 1250, 940, 33, 3, 3, 15000]);
  assert.equal(gas.recover, VM.DEFAULT_GAS.recover);   // ค่าที่ไม่ได้วัดใช้ค่าเดิม
  assert.equal(vm.gasTarget, 2_500_000);
});

test("ค่าพื้นฐานต่อ tx: หักทุก tx ของ user · โอนเหรียญหลักใช้ราว 17,000 แก๊ส · query ไม่หัก", () => {
  const plain = new VM.VirtualMachine(new MemoryDB(), {});
  const forked = new VM.VirtualMachine(new MemoryDB(), { forks: { bluewolf: 0 } });
  for (const vm of [plain, forked]) vm.db.load({ [`${ALICE}:native:received`]: "1000n" });
  const base = plain.transfer({ from: ALICE, to: BOB, amount: 1 });
  const bluewolf = forked.transfer({ from: ALICE, to: BOB, amount: 1 });
  assert.equal(base.status, "success");
  assert.equal(bluewolf.status, "success");
  assert.equal(base.gasUsed, 1_300);
  assert.equal(bluewolf.gasUsed, 17_300);   // ตรงกับที่คำนวณไว้ (gas-fees.md ข้อ 13) · ต่ำกว่า 21,000 ที่กระเป๋าตั้งให้

  const short = forked.transfer({ from: ALICE, to: BOB, amount: 1, gasLimit: 10_000 });
  assert.equal(short.status, "throw");
  assert.equal(short.error.code, "OUT_OF_GAS");
});

test("ชื่อเชน / เหรียญ: Bluewolfchain (BWSC) · ห่อเหรียญเป็น WBWSC · query ไม่หักค่าพื้นฐานต่อ tx", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { forks: { bluewolf: 0 }, chainId: 41234 });
  const block = vm.createBlock({ timestamp: 1_700_000_000_000 });
  block.deploy({ programUuid: "0x00000000000000000000000000000000000c0de1", code: `function program() {
    function initialization() {}
    function ping() { writeDB("x", 1n) }
    return { ping }
  }`, context: user(ALICE) });
  block.init({ programUuid: "0x00000000000000000000000000000000000c0de1" });
  block.commit();
  const rpc = createEvmRpc({ vm });
  const query = vm.query({ programUuid: "0x00000000000000000000000000000000000c0de1", functionName: "ping", input: {}, context: user(ALICE) });
  assert.equal(query.status, "success");
  assert.ok(query.gasUsed < 15_000, `${query.gasUsed}`);   // eth_estimateGas บวก gas.tx ให้เอง (src/node/evm-rpc.js)
  const params = rpc.chainParams({ rpcUrl: "http://x/evm" });
  assert.equal(params.chainName, "Bluewolfchain");
  assert.deepEqual(params.nativeCurrency, { name: "Bluewolfchain", symbol: "BWSC", decimals: 18 });
  assert.equal(params.chainId, "0xa112");

  const wrapped = systemPrograms({ addressAt: (nonce) => `0x${String(nonce).padStart(40, "0")}` }).find((item) => item.key === "wcard");
  assert.deepEqual([wrapped.input.name, wrapped.input.ticker, wrapped.input.namespace], ["Wrapped BWSC", "WBWSC", "wbwsc"]);
});
