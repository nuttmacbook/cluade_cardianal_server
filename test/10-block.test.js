import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, mockData, resetVM, user, ok, activate, trace, stored } from "./helpers.js";
import { TOKEN, SHOP, COUNTER, PROBE, FAULTY } from "./programs.js";

beforeEach(() => {
  resetVM();
  activate("token", TOKEN, { initInput: { supply: 1000 } });
  ok(vm.call({ programUuid: "token", functionName: "transfer", input: { to: "alice", amount: 100 }, context: user("owner") }));
});

const transfer = (from, to, amount) => ({ programUuid: "token", functionName: "transfer", input: { to, amount }, context: user(from) });

/** บันทึก writes ของ block ลง DB ผ่าน db.writeKeys */
const commit = (block) => block.commit();

test("block: tx2 เห็นผลของ tx1 โดยยังไม่ลง DB", () => {
  const block = vm.createBlock();
  const tx1 = block.call(transfer("alice", "bob", 30));
  const tx2 = block.call(transfer("alice", "jane", 50));

  assert.equal(tx1.status, "success");
  assert.equal(tx2.status, "success");
  assert.deepEqual(tx2.loadValues[0], { dbKey: "token:storage:balances:alice", loadValue: 70 }); // ค่าหลัง tx1
  assert.equal(stored("token", "balances", "alice"), 100); // DB ยังไม่เปลี่ยน

  commit(block);
  assert.equal(stored("token", "balances", "alice"), 20);
  assert.equal(stored("token", "balances", "bob"), 30);
  assert.equal(stored("token", "balances", "jane"), 50);
});

test("block: writes รวมเหลือ 1 รายการต่อ key (ค่าสุดท้าย) ตามลำดับที่ key ถูกเขียนครั้งแรก", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("alice", "jane", 50));
  block.call(transfer("bob", "alice", 10));

  assert.deepEqual(block.writes(), [
    { type: "put", dbKey: "token:storage:balances:alice", value: 30 },
    { type: "put", dbKey: "token:storage:balances:bob", value: 20 },
    { type: "put", dbKey: "token:storage:balances:jane", value: 50 },
  ]);
});

test("block: tx ที่ throw ไม่มีผลกับ block และ tx ถัดไปยังทำงานได้", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 60));
  const failed = block.call(transfer("alice", "jane", 60)); // เหลือ 40 ไม่พอ
  const after = block.call(transfer("alice", "jane", 40));

  assert.equal(failed.status, "throw");
  assert.equal(failed.error.message, "ยอดไม่พอ");
  assert.equal(after.status, "success");
  assert.deepEqual(block.results().map((r) => r.status), ["success", "throw", "success"]);

  commit(block);
  assert.equal(stored("token", "balances", "alice"), 0);
  assert.equal(stored("token", "balances", "jane"), 40);
});

test("block: ไม่มี tx ที่ success → writes ว่าง", () => {
  const block = vm.createBlock();
  block.call(transfer("nobody", "bob", 1));
  assert.deepEqual(block.writes(), []);
});

test("block: deploy → init → call ใน block เดียว", () => {
  const block = vm.createBlock();
  assert.equal(block.deploy({ programUuid: "counter", code: COUNTER, context: user("a"), initInput: { start: 5 } }).status, "success");
  assert.equal(block.init({ programUuid: "counter" }).status, "success");
  const res = block.call({ programUuid: "counter", functionName: "add", input: { amount: 1 }, context: user("a") });
  assert.equal(res.result, 6);
  assert.equal(mockData.has("counter:code"), false);

  const writes = block.writes();
  assert.deepEqual(writes.map((w) => `${w.type} ${w.dbKey}`), [
    "del pending:counter",
    "put counter:storage:count",
    "put counter:code",
    "put counter:context",
    "put counter:this",
"put counter:metadata:type",
"put counter:metadata:creator",
"put counter:metadata:createdAt",
  ]);
  commit(block);
  assert.equal(mockData.has("pending:counter"), false);
  assert.equal(stored("counter", "count"), 6);
});

test("block: deploy id ซ้ำใน block เดียวกันไม่ได้ / reject แล้ว init ไม่ได้", () => {
  const block = vm.createBlock();
  block.deploy({ programUuid: "p", code: COUNTER, context: user("a") });
  assert.equal(block.deploy({ programUuid: "p", code: COUNTER, context: user("a") }).error.code, "INVALID_REQUEST");
  block.reject({ programUuid: "p" });
  assert.equal(block.init({ programUuid: "p" }).error.code, "NOT_FOUND");
  assert.deepEqual(block.writes(), [{ type: "del", dbKey: "pending:p" }]);
});

test("block: delete ใน tx หนึ่ง แล้ว tx ถัดไปอ่านได้ undefined และเขียนใหม่ได้", () => {
  activate("counter", COUNTER, { initInput: { start: 3 } });
  const block = vm.createBlock();
  block.call({ programUuid: "counter", functionName: "reset", context: user("a") });
  const get = block.call({ programUuid: "counter", functionName: "get", context: user("a") });
  assert.equal(get.result, 0);
  assert.deepEqual(block.writes(), [{ type: "del", dbKey: "counter:storage:count" }]);

  block.call({ programUuid: "counter", functionName: "add", input: { amount: 2 }, context: user("a") });
  assert.deepEqual(block.writes(), [{ type: "put", dbKey: "counter:storage:count", value: 2 }]);
});

test("block: ข้ามโปรแกรมหลาย tx (approve แล้วซื้อ)", () => {
  activate("shop", SHOP, { initInput: { shopId: "shop", token: "token", price: 30 } });
  const block = vm.createBlock();
  block.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 100 }, context: user("alice") });
  const buys = [1, 2, 3, 4].map(() => block.call({ programUuid: "shop", functionName: "buy", context: user("alice") }));

  assert.deepEqual(buys.map((r) => r.status), ["success", "success", "success", "throw"]);
  assert.deepEqual(trace(buys[3]), ["0:shop.buy:throw:PROGRAM_ERROR", "1:token.transferFrom:throw:PROGRAM_ERROR"]);

  commit(block);
  assert.equal(stored("token", "balances", "alice"), 10);
  assert.equal(stored("token", "balances", "shop"), 90);
  assert.equal(stored("shop", "sales"), 3);
});

test("block: timeout ของ tx หนึ่งไม่กระทบ tx อื่น (แต่ละ tx มีเวลาของตัวเอง)", () => {
  activate("faulty", FAULTY);
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  const spin = block.call({ programUuid: "faulty", functionName: "spin", context: user("a") });
  block.call(transfer("alice", "bob", 10));
  assert.equal(spin.error.code, "TIMEOUT");
  assert.deepEqual(block.writes().find((w) => w.dbKey === "token:storage:balances:bob"), { type: "put", dbKey: "token:storage:balances:bob", value: 20 });
});

test("block: ค่าที่ได้จาก writes() / results() เป็น copy — แก้แล้วไม่กระทบ block", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  block.writes()[0].value = 999;
  block.results().pop();
  assert.equal(block.writes()[0].value, 90);
  assert.equal(block.results().length, 1);
});

test("block: DB พังระหว่าง block → tx นั้น INTERNAL, tx ก่อนหน้ายังอยู่ใน block", () => {
  let down = false;
  const block = vm.createBlock({ read: (dbKey) => { if (down) throw new Error("db down"); return mockData.get(dbKey); } });
  block.call(transfer("alice", "bob", 10));
  down = true;
  const failed = block.call(transfer("alice", "jane", 10));
  assert.equal(failed.error.code, "INTERNAL");
  assert.equal(block.writes().length, 2);
});

test("block: โปรแกรมที่อยู่ใน block อื่นแยกกัน (block ไม่แชร์สถานะ)", () => {
  const a = vm.createBlock();
  const b = vm.createBlock();
  a.call(transfer("alice", "bob", 100));
  const res = b.call(transfer("alice", "jane", 100));
  assert.equal(res.status, "success"); // b ยังเห็นยอด alice = 100 จาก DB
});

test("block: ผลลัพธ์เหมือนเดิมทุกครั้ง", () => {
  activate("probe", PROBE);
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const block = vm.createBlock({ timestamp: 1_700_000_000_000 });
    block.call(transfer("alice", "bob", 30));
    block.call(transfer("alice", "jane", 80));
    block.call({ programUuid: "probe", functionName: "relayCatch", input: { target: "token", fn: "transfer", args: { to: "x", amount: 1 } }, context: user("alice") });
    block.call(transfer("bob", "jane", 30));
    runs.push(JSON.stringify({ results: block.results(), writes: block.writes() }));
  }
  assert.equal(new Set(runs).size, 1);
});

test("block.commit: บันทึกทีเดียวแล้วปิด block — ใช้ต่อหรือ commit ซ้ำไม่ได้", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  assert.equal(block.committed, false);
  assert.equal(block.commit(), 2);
  assert.equal(block.committed, true);
  assert.equal(stored("token", "balances", "bob"), 10);

  assert.throws(() => block.commit(), { code: "INVALID_REQUEST", message: "block นี้ commit ไปแล้ว" });
  assert.throws(() => block.call(transfer("alice", "bob", 1)), { code: "INVALID_REQUEST" });
});

test("block.commit: writeKeys ล้ม → block ยังไม่ถูกปิด ลอง commit ใหม่ได้", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  const original = vm.db.writeKeys;
  vm.db.writeKeys = () => { throw new Error("network error"); };
  try {
    assert.throws(() => block.commit(), /network error/);
  } finally {
    vm.db.writeKeys = original;
  }
  assert.equal(block.committed, false);
  block.commit();
  assert.equal(stored("token", "balances", "bob"), 10);
});

// ---------------------------------------------------------------------------
//  ข้อมูล storage ระดับ block
// ---------------------------------------------------------------------------

test("block: loadValues / afterValues ของทั้ง block (ค่าก่อน block → ค่าหลังทั้ง block)", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("alice", "jane", 50));

  assert.deepEqual(block.loadValues(), [
    { dbKey: "token:storage:balances:alice", loadValue: 100 },
    { dbKey: "token:storage:balances:bob", loadValue: undefined },
    { dbKey: "token:storage:balances:jane", loadValue: undefined },
  ]);
  assert.deepEqual(block.afterValues(), [
    { dbKey: "token:storage:balances:alice", afterValue: 20, changed: true },
    { dbKey: "token:storage:balances:bob", afterValue: 30, changed: true },
    { dbKey: "token:storage:balances:jane", afterValue: 50, changed: true },
  ]);
});

test("block: ค่าที่เปลี่ยนไปแล้วเปลี่ยนกลับเท่าเดิมภายใน block → changed false", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("bob", "alice", 30));

  assert.deepEqual(block.afterValues(), [
    { dbKey: "token:storage:balances:alice", afterValue: 100, changed: false },
    { dbKey: "token:storage:balances:bob", afterValue: 0, changed: true }, // เดิมไม่มี key → 0
  ]);
  assert.equal(block.writes().length, 2);
});

test("block: key ที่ถูกอ่านหลัง tx ก่อนหน้าเขียนไปแล้ว → loadValue ยังเป็นค่าใน DB ก่อน block", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("x") });

  const results = block.results();
  assert.equal(results[1].result, 70);
  assert.deepEqual(results[1].loadValues, [{ dbKey: "token:storage:balances:alice", loadValue: 70 }]); // ระดับ call: ก่อน call นี้
  assert.deepEqual(block.loadValues()[0], { dbKey: "token:storage:balances:alice", loadValue: 100 });  // ระดับ block: ก่อน block
});

test("block: tx ที่ throw ไม่ถูกนับใน loadValues / afterValues ของ block", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 30));
  block.call(transfer("carol", "dave", 1)); // carol ไม่มียอด → throw

  const keys = (list) => list.map((v) => v.dbKey);
  assert.deepEqual(keys(block.loadValues()), ["token:storage:balances:alice", "token:storage:balances:bob"]);
  assert.deepEqual(keys(block.afterValues()), ["token:storage:balances:alice", "token:storage:balances:bob"]);
});

test("block: อ่านอย่างเดียว → changed false และไม่มี writes", () => {
  const block = vm.createBlock();
  block.call({ programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("x") });
  assert.deepEqual(block.afterValues(), [{ dbKey: "token:storage:balances:alice", afterValue: 100, changed: false }]);
  assert.deepEqual(block.writes(), []);
});

test("block: key ที่ถูกลบในทั้ง block → afterValue undefined", () => {
  activate("counter", COUNTER, { initInput: { start: 3 } });
  const block = vm.createBlock();
  block.call({ programUuid: "counter", functionName: "add", input: { amount: 1 }, context: user("a") });
  block.call({ programUuid: "counter", functionName: "reset", context: user("a") });
  assert.deepEqual(block.afterValues(), [{ dbKey: "counter:storage:count", afterValue: undefined, changed: true }]);
  assert.deepEqual(block.loadValues(), [{ dbKey: "counter:storage:count", loadValue: 3 }]);
});

test("block: summary() รวม results / loadValues / afterValues / writes", () => {
  const block = vm.createBlock();
  block.call(transfer("alice", "bob", 10));
  const summary = block.summary();
  assert.deepEqual(Object.keys(summary), ["timestamp", "results", "loadValues", "afterValues", "writes"]);
  assert.deepEqual(summary.writes, block.writes());
});

test("block: แต่ละ key ถูกอ่านจาก DB ครั้งเดียวต่อ block (ทุก tx เห็นข้อมูลชุดเดียวกัน)", () => {
  const reads = [];
  const block = vm.createBlock({ read: (dbKey) => { reads.push(dbKey); return mockData.get(dbKey); } });
  const balanceOf = { programUuid: "token", functionName: "balanceOf", input: { account: "alice" }, context: user("x") };
  block.call(balanceOf);
  block.call(balanceOf);
  block.call(transfer("alice", "bob", 1));
  block.call(balanceOf);
  assert.deepEqual(reads, ["token:code", "token:storage:balances:alice", "token:storage:balances:bob"]);
});
