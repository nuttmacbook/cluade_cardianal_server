import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, resetVM, user, MemoryDB } from "./helpers.js";
import { COUNTER } from "./programs.js";

beforeEach(resetVM);


test("MemoryDB.readKeys: คืน array ตามลำดับ key, ไม่มี → undefined", () => {
  const db = new MemoryDB();
  db.writeKeys([{ type: "put", dbKey: "a", value: 1 }, { type: "put", dbKey: "b", value: { x: [1] } }]);
  assert.deepEqual(db.readKeys(["b", "missing", "a"]), [{ x: [1] }, undefined, 1]);
  assert.deepEqual(db.readKeys([]), []);
  assert.throws(() => db.readKeys("a"), /keys ต้องเป็น array/);
});

test("MemoryDB.writeKeys: put / del / เขียน key เดิมหลายครั้งใช้ค่าสุดท้าย", () => {
  const db = new MemoryDB();
  assert.equal(db.writeKeys([
    { type: "put", dbKey: "a", value: 1 },
    { type: "put", dbKey: "b", value: 2 },
    { type: "put", dbKey: "a", value: 3 },
    { type: "del", dbKey: "b" },
  ]), 4);
  assert.deepEqual(db.snapshot(), { a: 3 });
});

test("MemoryDB.writeKeys: มีรายการผิด → ไม่บันทึกอะไรเลย (atomic)", () => {
  const db = new MemoryDB();
  const bad = [
    [{ type: "put", dbKey: "a", value: 1 }, { type: "put", dbKey: "b" }],
    [{ type: "put", dbKey: "a", value: 1 }, { type: "update", dbKey: "b", value: 1 }],
    [{ type: "put", dbKey: 1, value: 1 }],
    [null],
  ];
  for (const writes of bad) assert.throws(() => db.writeKeys(writes), /write ไม่ถูกต้อง/);
  assert.throws(() => db.writeKeys("x"), /writes ต้องเป็น array/);
  assert.deepEqual(db.snapshot(), {});
});

test("MemoryDB: ค่าที่อ่าน / เขียนถูก copy", () => {
  const db = new MemoryDB();
  const value = { n: 1 };
  db.writeKeys([{ type: "put", dbKey: "a", value }]);
  value.n = 2;
  db.readKeys(["a"])[0].n = 3;
  assert.deepEqual(db.readKeys(["a"]), [{ n: 1 }]);
});

test("MemoryDB: สร้างพร้อมข้อมูลตั้งต้นได้ และแต่ละตัวแยกกัน", () => {
  const a = new MemoryDB({ k: "seed" });
  const b = new MemoryDB();
  assert.deepEqual(a.readKeys(["k"]), ["seed"]);
  assert.deepEqual(b.readKeys(["k"]), [undefined]);
});

test("VM: อ่านผ่าน db.readKeys และ commit ผ่าน db.writeKeys", () => {
  const reads = [];
  const commits = [];
  const inner = new MemoryDB();
  const db = {
    readKeys: (keys) => { reads.push(keys); return inner.readKeys(keys); },
    writeKeys: (writes) => { commits.push(writes); return inner.writeKeys(writes); },
  };
  const vm = new VM.VirtualMachine(db);

  const deployed = vm.deploy({ programUuid: "c", code: COUNTER, context: user("a"), initInput: { start: 2 } });
  assert.deepEqual(reads, [["pending:c"], ["c:code"]]);
  vm.commit(deployed.writes);
  vm.commit(vm.init({ programUuid: "c" }).writes);

  reads.length = 0;
  const res = vm.call({ programUuid: "c", functionName: "add", input: { amount: 3 }, context: user("a") });
  assert.equal(res.result, 5);
  assert.deepEqual(reads, [["c:code"], ["c:storage:count"]]);
  assert.equal(commits.length, 2);
});

test("VM: readKeys throw → INTERNAL", () => {
  const vm = new VM.VirtualMachine({ readKeys: () => { throw new Error("503"); }, writeKeys: () => {} });
  const res = vm.call({ programUuid: "p", functionName: "f", context: user("a") });
  assert.deepEqual(res.error, { code: "INTERNAL", message: "อ่านข้อมูลจาก DB ไม่สำเร็จ: 503" });
});

test("VM: commit ส่ง error ของ writeKeys ออกมาตรง ๆ ให้ผู้เรียกจัดการ", () => {
  const vm = new VM.VirtualMachine({ readKeys: (keys) => keys.map(() => undefined), writeKeys: () => { throw new Error("write failed"); } });
  assert.throws(() => vm.commit([{ type: "put", dbKey: "a", value: 1 }]), /write failed/);
});

test("VM: แต่ละ key ถูกอ่านจาก DB ครั้งเดียวต่อ request แม้โปรแกรมอ่านซ้ำหลายครั้ง", () => {
  const reads = [];
  const inner = new MemoryDB();
  const vm = new VM.VirtualMachine({ readKeys: (keys) => { reads.push(...keys); return inner.readKeys(keys); }, writeKeys: (w) => inner.writeKeys(w) });
  vm.commit(vm.deploy({ programUuid: "c", code: COUNTER, context: user("a"), initInput: { start: 0 } }).writes);
  vm.commit(vm.init({ programUuid: "c" }).writes);

  reads.length = 0;
  vm.call({ programUuid: "c", functionName: "addTwice", input: { amount: 1 }, context: user("a") }); // อ่าน count 2 ครั้ง + เขียน 2 ครั้ง
  assert.deepEqual(reads, ["c:code", "c:storage:count"]);
});

// ---------------------------------------------------------------------------
//  เครื่องมือ debug ของ MemoryDB
// ---------------------------------------------------------------------------

test("MemoryDB: snapshot / listKeys / size / has — ดูข้อมูลทั้งหมดและเลือกด้วย prefix", () => {
  const db = new MemoryDB();
  db.load({
    "token:code": "",
    "token:storage:balances:alice": 700,
    "token:storage:balances:bob": 300,
    "alice:native:received": 1000,
  });

  assert.equal(db.size, 4);
  assert.equal(db.has("token:code"), true);
  assert.equal(db.has("nope"), false);
  assert.deepEqual(db.listKeys(), ["alice:native:received", "token:code", "token:storage:balances:alice", "token:storage:balances:bob"]);
  assert.deepEqual(db.listKeys("token:storage:"), ["token:storage:balances:alice", "token:storage:balances:bob"]);
  assert.deepEqual(db.snapshot("alice"), { "alice:native:received": 1000 });
  assert.deepEqual(Object.keys(db.snapshot()), db.listKeys()); // เรียงตาม key เสมอ
});

test("MemoryDB: tree — จัดกลุ่มตาม address", () => {
  const db = new MemoryDB();
  db.load({
    "token:code": "code",
    "token:context": { sender: "alice", origin: "alice" },
    "token:this": "token",
    "token:storage:balances:alice": 700,
    "token:storage:totalSupply": 1000,
    "alice:native:received": 1000,
    "alice:nonce": 3,
    "alice:txn:0:0xabc": { status: "success" },
    "pending:shop": { code: "x" },
  });

  assert.deepEqual(db.tree(), {
    token: {
      code: "code",
      context: { sender: "alice", origin: "alice" },
      this: "token",
      storage: { "balances:alice": 700, totalSupply: 1000 },
    },
    alice: {
      native: { received: 1000 },
      nonce: 3,
      txn: { "0:0xabc": { status: "success" } },
    },
    pending: { shop: { code: "x" } },
  });
  assert.deepEqual(Object.keys(db.tree("token")), ["token"]);
});

test("MemoryDB: dump / toJSON / toString — ดูเป็น JSON ได้", () => {
  const db = new MemoryDB();
  db.load({ "alice:nonce": 1, "token:storage:x": { a: [1, 2] } });

  assert.deepEqual(JSON.parse(db.dump()), db.snapshot());
  assert.deepEqual(JSON.parse(db.dump({ grouped: true })), db.tree());
  assert.deepEqual(JSON.parse(db.dump({ prefix: "alice" })), { "alice:nonce": 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(db)), db.snapshot()); // toJSON
  assert.equal(String(db), db.dump());
  assert.equal(db.dump({ indent: 0 }).includes("\n"), false);
});

test("MemoryDB: dump ตัด string ยาว ๆ ได้ (เช่นโค้ดโปรแกรม)", () => {
  const db = new MemoryDB();
  db.load({ "token:code": "x".repeat(500), "token:storage:n": 1 });

  const short = JSON.parse(db.dump({ maxStringLength: 20 }));
  assert.equal(short["token:code"], `${"x".repeat(20)}… (500 ตัวอักษร)`);
  assert.equal(short["token:storage:n"], 1);
  assert.equal(JSON.parse(db.dump())["token:code"].length, 500); // ไม่ตัดถ้าไม่สั่ง
});

test("MemoryDB: load / clear และข้อมูลที่คืนมาเป็น copy", () => {
  const db = new MemoryDB();
  db.load({ "a:storage:x": { n: 1 } });
  db.snapshot()["a:storage:x"].n = 99;
  db.tree().a.storage.x.n = 99;
  assert.deepEqual(db.readKeys(["a:storage:x"]), [{ n: 1 }]);

  assert.equal(db.clear().size, 0);
  assert.deepEqual(db.snapshot(), {});
});

test("MemoryDB: ใช้ดูสถานะหลังรัน VM ได้", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 5 } }).writes);
  vm.commit(vm.init({ programUuid: "counter" }).writes);
  vm.commit(vm.call({ programUuid: "counter", functionName: "add", input: { amount: 2 }, context: user("alice") }).writes);

  assert.deepEqual(vm.db.tree().counter.storage, { count: 7 });
  assert.deepEqual(vm.db.listKeys("counter:"), [
    "counter:code", "counter:context",
    "counter:metadata:createdAt", "counter:metadata:creator", "counter:metadata:type",
    "counter:storage:count", "counter:this",
  ]);
  assert.equal(vm.db.has("pending:counter"), false);
});
