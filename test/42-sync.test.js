import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { applyBlock, syncOnce } from "../src/node/sync.js";
import { TOKEN } from "./programs.js";

/* node ผู้อ่าน: ดึง block มารันเอง แล้วเทียบ hash */

const T = Date.parse("2025-01-01T00:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GENESIS = { chainId: 1, balances: { alice: 1_000_000 } };
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true };

function producer() {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  vm.applyGenesis(GENESIS);
  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 });
  first.init({ programUuid: "token" });
  first.commit();
  for (let i = 0; i < 3; i += 1) {
    const block = vm.createBlock({ timestamp: T + (i + 1) * 3000, feeRecipient: "miner" });
    block.call({ programUuid: "token", functionName: "transfer", input: { to: `user${i}`, amount: 10 }, context: user("alice"), nonce: i + 1 });
    block.commit();
  }
  return vm;
}

const feed = (source) => async (from, limit) => {
  const blocks = [];
  for (let n = from; n <= Math.min(source.latestBlockNumber(), from + limit - 1); n += 1) {
    blocks.push({ header: source.getBlock(n), body: source.getBlockBody(n) });
  }
  return blocks;
};

const reader = () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  vm.applyGenesis(GENESIS);
  return vm;
};

test("sync: ดึง block มารันแล้วได้ state เหมือนผู้ผลิตทุกตัวอักษร", async () => {
  const source = producer();
  const target = reader();
  assert.equal(await syncOnce(target, feed(source)), 4);

  assert.equal(target.latestBlockNumber(), source.latestBlockNumber());
  assert.deepEqual(target.db.snapshot(), source.db.snapshot());
});

test("sync: ซิงก์ต่อจากที่ค้างไว้", async () => {
  const source = producer();
  const target = reader();
  await syncOnce(target, async (from, limit) => (await feed(source)(from, limit)).slice(0, 2));
  assert.equal(target.latestBlockNumber(), 2);

  await syncOnce(target, feed(source));
  assert.deepEqual(target.db.snapshot(), source.db.snapshot());
});

test("sync: block ที่ถูกแก้ → หยุดทันที ไม่บันทึก", () => {
  const source = producer();
  const target = reader();
  const item = { header: { ...source.getBlock(1) }, body: source.getBlockBody(1) };
  item.body[0].request.initInput = { supply: 999 };       // แก้ tx ระหว่างทาง

  assert.throws(() => applyBlock(target, item), /ไม่ตรงกับผู้ผลิต/);
  assert.equal(target.latestBlockNumber(), null);
});

test("genesis: ต่างกัน → ปฏิเสธตั้งแต่ยังไม่ซิงก์", () => {
  const vm = reader();
  assert.equal(vm.genesisHash(), vm.hashData(GENESIS));
  assert.deepEqual(vm.applyGenesis(GENESIS), { hash: vm.genesisHash(), applied: false });   // ซ้ำได้ ไม่เปลี่ยนอะไร
  assert.throws(() => vm.applyGenesis({ chainId: 1, balances: { alice: 999 } }), { code: "INTERNAL", message: /genesis ไม่ตรงกัน/ });
  assert.equal(vm.nativeBalanceOf("alice").balance, 1_000_000);
});

test("timeout: tx ที่หมดเวลาไม่เข้า block (ผลจึงไม่ขึ้นกับความเร็วเครื่อง)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, timeoutMs: 50 });
  vm.applyGenesis(GENESIS);
  const code = "function program() {\n  function spin() { while (true) {} }\n  return { spin }\n}";
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "spin", code, context: user("alice"), nonce: 0 });
  block.init({ programUuid: "spin" });
  const timedOut = block.call({ programUuid: "spin", functionName: "spin", context: user("alice"), nonce: 1 });
  block.commit();

  assert.equal(timedOut.error.code, "TIMEOUT");
  assert.equal(timedOut.accepted, false);        // ไม่เข้า block
  assert.deepEqual(timedOut.writes, []);         // ไม่กิน nonce ไม่เสียค่าแก๊ส
  assert.equal(vm.getBlock(1).txCount, 2);       // มีแต่ deploy กับ init
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 1);
});

test("error จาก V8 ถูกแทนด้วยข้อความคงที่ (ผลเหมือนกันทุกเวอร์ชัน Node)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  const code = `function program() {
  function typeError() { return null.x }
  function ownError() { throw new Error("ข้อความของโปรแกรม") }
  return { typeError, ownError }
}`;
  vm.commit(vm.deploy({ programUuid: "p", code, context: user("alice") }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "p" }, { timestamp: T }).writes);

  const call = (fn) => vm.call({ programUuid: "p", functionName: fn, context: user("alice") }, { timestamp: T });
  assert.equal(call("typeError").error.message, "โปรแกรมทำงานผิดพลาด (TypeError)");
  assert.equal(call("ownError").error.message, "ข้อความของโปรแกรม");   // ของโปรแกรมเองยังเหมือนเดิม
});
