import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, COUNTER, DICE } from "./programs.js";

/* 1) address ของโปรแกรมที่คำนวณจาก deployer + nonce
   2) Math.random() ที่รันซ้ำได้ผลเดิม
   3) การไล่ดูข้อมูลสำหรับ explorer ด้วย listKeys */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

const setup = (options = {}) => new VM.VirtualMachine(new MemoryDB(), {
  requireNonce: true, recordTransactions: true, recordBlocks: true, ...options,
});

const save = (vm, res) => {
  assert.equal(res.status, "success", JSON.stringify(res.error));
  vm.commit(res.writes);
  return res;
};

// ---------------------------------------------------------------------------
//  address ของโปรแกรม
// ---------------------------------------------------------------------------

test("address: ไม่ส่ง programUuid → VM คำนวณจาก deployer + nonce", () => {
  const vm = setup();
  const res = save(vm, vm.deploy({ code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 0 }));
  const address = res.result.programUuid;

  assert.match(address, /^0x[0-9a-f]{40}$/);
  assert.equal(address, vm.programAddressFor("alice", 0));
  save(vm, vm.init({ programUuid: address }));
  assert.equal(vm.call({ programUuid: address, functionName: "get", context: user("bob"), nonce: 0 }).result, 1);
});

test("address: nonce ต่างกัน / deployer ต่างกัน / chainId ต่างกัน → address ต่างกัน", () => {
  const vm = setup();
  const a = vm.programAddressFor("alice", 0);
  const other = setup({ chainId: 99 });
  assert.equal(new Set([a, vm.programAddressFor("alice", 1), vm.programAddressFor("bob", 0), other.programAddressFor("alice", 0)]).size, 4);
});

test("address: deploy สองครั้งติดกันได้คนละ address", () => {
  const vm = setup();
  const first = save(vm, vm.deploy({ code: COUNTER, context: user("alice"), nonce: 0 })).result.programUuid;
  const second = save(vm, vm.deploy({ code: COUNTER, context: user("alice"), nonce: 1 })).result.programUuid;
  assert.notEqual(first, second);
  assert.deepEqual([first, second], [vm.programAddressFor("alice", 0), vm.programAddressFor("alice", 1)]);
});

test("address: เปิด deriveProgramAddress → ตั้ง address เองไม่ได้อีก", () => {
  const vm = setup({ deriveProgramAddress: true });
  const res = save(vm, vm.deploy({ programUuid: "alice", code: COUNTER, context: user("alice"), nonce: 0 }));
  assert.notEqual(res.result.programUuid, "alice");          // ค่าที่ส่งมาถูกมองข้าม
  assert.equal(res.result.programUuid, vm.programAddressFor("alice", 0));
});

test("address: ปิดไว้ (ค่าเริ่มต้น) → ยังตั้งเองได้เหมือนเดิม", () => {
  const vm = setup();
  assert.equal(save(vm, vm.deploy({ programUuid: "myToken", code: TOKEN, context: user("alice"), initInput: { supply: 1 }, nonce: 0 })).result.programUuid, "mytoken");
});

// ---------------------------------------------------------------------------
//  Math.random
// ---------------------------------------------------------------------------

function diceVm() {
  const vm = setup({ requireNonce: false, recordBlocks: false });
  save(vm, vm.deploy({ programUuid: "dice", code: DICE, context: user("alice") }));
  save(vm, vm.init({ programUuid: "dice" }));
  save(vm, vm.deploy({ programUuid: "dice2", code: DICE, context: user("alice") }));
  save(vm, vm.init({ programUuid: "dice2" }));
  return vm;
}

const roll = (vm, fn = "rollMany", input = { times: 3 }) =>
  vm.call({ programUuid: "dice", functionName: fn, input, context: user("alice") }, { timestamp: T });

test("random: tx เดียวกันให้ผลเดิมทุกครั้ง แม้คนละ VM", () => {
  const first = roll(diceVm()).result;
  const second = roll(diceVm()).result;
  assert.deepEqual(first, second);
  assert.equal(first.length, 3);
  assert.ok(first.every((value) => value >= 0 && value < 1));
  assert.equal(new Set(first).size, 3); // ค่าที่ได้ในแต่ละครั้งไม่ซ้ำกัน
});

test("random: tx ที่ต่างกันได้ค่าต่างกัน", () => {
  const vm = diceVm();
  const a = roll(vm).result;
  const b = vm.call({ programUuid: "dice", functionName: "rollMany", input: { times: 3 }, context: user("bob") }, { timestamp: T }).result;
  const c = vm.call({ programUuid: "dice", functionName: "rollMany", input: { times: 3 }, context: user("alice") }, { timestamp: T + 1 }).result;
  assert.notDeepEqual(a, b); // คนละ sender
  assert.notDeepEqual(a, c); // tx เดียวกันแต่คนละ block (เวลาต่างกัน)
});

test("random: โปรแกรมที่เรียกซ้อนใช้ลำดับเดียวกันต่อกัน ไม่ซ้ำค่า", () => {
  const vm = diceVm();
  const res = vm.call({ programUuid: "dice", functionName: "rollNested", input: { target: "dice2" }, context: user("alice") }, { timestamp: T });
  const [first, nested, last] = res.result;
  const values = [first, ...nested, last];
  assert.equal(values.length, 4);
  assert.equal(new Set(values).size, 4);
});

test("random: Math อย่างอื่นยังใช้ได้ปกติ", () => {
  const vm = diceVm();
  const res = vm.call({ programUuid: "dice", functionName: "mathStillWorks", context: user("alice") }, { timestamp: T });
  assert.deepEqual(res.result, [2, 5, true, "number"]);
});

test("random: กระจายตัวพอใช้ (100 ค่า ไม่ซ้ำและกระจายทั้งช่วง)", () => {
  const vm = diceVm();
  const values = vm.call({ programUuid: "dice", functionName: "rollMany", input: { times: 100 }, context: user("alice") }, { timestamp: T }).result;
  assert.equal(new Set(values).size, 100);
  assert.ok(values.some((value) => value < 0.2) && values.some((value) => value > 0.8));
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.ok(average > 0.35 && average < 0.65, `average ${average}`);
});

test("random: Math.random ของระบบไม่ถูกแตะ", () => {
  const before = Math.random();
  diceVm();
  assert.notEqual(Math.random(), before);
});

// ---------------------------------------------------------------------------
//  explorer
// ---------------------------------------------------------------------------

function chainVm() {
  const vm = setup();
  save(vm, vm.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 }));
  save(vm, vm.init({ programUuid: "token" }));

  let parentHash = null;
  for (let number = 1; number <= 3; number += 1) {
    const block = vm.createBlock({ timestamp: T + number, number, parentHash, feeRecipient: "miner" });
    block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: number }, context: user("alice"), nonce: number });
    parentHash = block.header().hash;
    block.commit();
  }
  return vm;
}

test("explorer: latestBlockNumber / getBlock / getBlockByHash / listBlocks", () => {
  const vm = chainVm();
  assert.equal(vm.latestBlockNumber(), 3);

  const block = vm.getBlock(2);
  assert.equal(block.number, 2);
  assert.deepEqual(vm.getBlockByHash(block.hash), block);
  assert.equal(vm.getBlock(99), null);
  assert.equal(vm.getBlockByHash("0xไม่มี"), null);

  assert.deepEqual(vm.listBlocks({ limit: 2 }).map((b) => b.number), [3, 2]);          // ใหม่ไปเก่า
  assert.deepEqual(vm.listBlocks({ reverse: false }).map((b) => b.number), [1, 2, 3]);
});

test("explorer: getTransaction จาก hash → รู้ block, index และ record ของผู้ส่ง", () => {
  const vm = chainVm();
  const hash = vm.getBlock(2).txHashes[0];
  const found = vm.getTransaction(hash);

  assert.equal(found.blockNumber, 2);
  assert.equal(found.index, 0);
  assert.equal(found.from, "alice");
  assert.equal(found.record.status, "success");
  assert.equal(found.record.hash, hash);
  assert.equal(vm.getTransaction("0xไม่มี"), null);
});

test("explorer: listTransactionsOf — ไล่ tx ของ address", () => {
  const vm = chainVm();
  const all = vm.listTransactionsOf("alice");
  assert.deepEqual(all.map((tx) => tx.nonce), [3, 2, 1, 0]);               // ใหม่ไปเก่า
  assert.deepEqual(vm.listTransactionsOf("alice", { limit: 2 }).map((tx) => tx.nonce), [3, 2]);
  assert.deepEqual(vm.listTransactionsOf("alice", { reverse: false, limit: 2 }).map((tx) => tx.action), ["deploy", "call"]);
  assert.deepEqual(vm.listTransactionsOf("bob"), []);
});

test("explorer: listProgramStorage — ดู storage ทั้งหมดของโปรแกรม", () => {
  const vm = chainVm();
  assert.deepEqual(vm.listProgramStorage("token"), [
    { key: ["balances", "alice"], value: 994 },
    { key: ["balances", "bob"], value: 6 },
    { key: ["owner"], value: "alice" },
    { key: ["totalSupply"], value: 1000 },
  ]);
});

test("explorer: listKeys / listEntries และแบ่งหน้าได้", () => {
  const vm = chainVm();
  assert.deepEqual(vm.listKeys("block:"), ["block:000000000001", "block:000000000002", "block:000000000003"]);

  const page1 = vm.listKeys("block:", { limit: 2 });
  const page2 = vm.listKeys("block:", { limit: 2, start: "block:000000000003" });
  assert.deepEqual([page1, page2], [["block:000000000001", "block:000000000002"], ["block:000000000003"]]);
  assert.deepEqual(vm.listEntries("latestblock"), [{ dbKey: "latestblock", value: 3 }]);
});

test("explorer: DB ที่ไม่มี listKeys → INTERNAL", () => {
  const vm = new VM.VirtualMachine({ readKeys: (keys) => keys.map(() => undefined), writeKeys: () => 0 });
  assert.throws(() => vm.listKeys("block:"), { code: "INTERNAL", message: /listKeys/ });
});
