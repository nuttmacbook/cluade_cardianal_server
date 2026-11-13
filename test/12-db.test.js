import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, resetVM, user, MemoryDB } from "./helpers.js";
import { COUNTER } from "./programs.js";

beforeEach(resetVM);


test("MemoryDB.readKeys: returns an array in key order, missing → undefined", () => {
  const db = new MemoryDB();
  db.writeKeys([{ type: "put", dbKey: "a", value: 1 }, { type: "put", dbKey: "b", value: { x: [1] } }]);
  assert.deepEqual(db.readKeys(["b", "missing", "a"]), [{ x: [1] }, undefined, 1]);
  assert.deepEqual(db.readKeys([]), []);
  assert.throws(() => db.readKeys("a"), /keys must be an array/);
});

test("MemoryDB.writeKeys: put / del / writing the same key repeatedly keeps the last value", () => {
  const db = new MemoryDB();
  assert.equal(db.writeKeys([
    { type: "put", dbKey: "a", value: 1 },
    { type: "put", dbKey: "b", value: 2 },
    { type: "put", dbKey: "a", value: 3 },
    { type: "del", dbKey: "b" },
  ]), 4);
  assert.deepEqual(db.snapshot(), { a: 3 });
});

test("MemoryDB.writeKeys: a bad entry → nothing is saved (atomic)", () => {
  const db = new MemoryDB();
  const bad = [
    [{ type: "put", dbKey: "a", value: 1 }, { type: "put", dbKey: "b" }],
    [{ type: "put", dbKey: "a", value: 1 }, { type: "update", dbKey: "b", value: 1 }],
    [{ type: "put", dbKey: 1, value: 1 }],
    [null],
  ];
  for (const writes of bad) assert.throws(() => db.writeKeys(writes), /Invalid write/);
  assert.throws(() => db.writeKeys("x"), /writes must be an array/);
  assert.deepEqual(db.snapshot(), {});
});

test("MemoryDB: read / written values are copied", () => {
  const db = new MemoryDB();
  const value = { n: 1 };
  db.writeKeys([{ type: "put", dbKey: "a", value }]);
  value.n = 2;
  db.readKeys(["a"])[0].n = 3;
  assert.deepEqual(db.readKeys(["a"]), [{ n: 1 }]);
});

test("MemoryDB: can be created with initial data, and instances are separate", () => {
  const a = new MemoryDB({ k: "seed" });
  const b = new MemoryDB();
  assert.deepEqual(a.readKeys(["k"]), ["seed"]);
  assert.deepEqual(b.readKeys(["k"]), [undefined]);
});

test("VM: reads via db.readKeys and commits via db.writeKeys", () => {
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
  assert.equal(res.result, "5n");
  assert.deepEqual(reads, [["c:code"], ["c:storage:count"]]);
  assert.equal(commits.length, 2);
});

test("VM: readKeys throw → INTERNAL", () => {
  const vm = new VM.VirtualMachine({ readKeys: () => { throw new Error("503"); }, writeKeys: () => {} });
  const res = vm.call({ programUuid: "p", functionName: "f", context: user("a") });
  assert.deepEqual(res.error, { code: "INTERNAL", message: "อ่านข้อมูลจาก DB ไม่สำเร็จ: 503" });
});

test("VM: commit passes writeKeys errors straight through to the caller", () => {
  const vm = new VM.VirtualMachine({ readKeys: (keys) => keys.map(() => undefined), writeKeys: () => { throw new Error("write failed"); } });
  assert.throws(() => vm.commit([{ type: "put", dbKey: "a", value: 1 }]), /write failed/);
});

test("VM: each key is read from the DB once per request, even if the program reads it repeatedly", () => {
  const reads = [];
  const inner = new MemoryDB();
  const vm = new VM.VirtualMachine({ readKeys: (keys) => { reads.push(...keys); return inner.readKeys(keys); }, writeKeys: (w) => inner.writeKeys(w) });
  vm.commit(vm.deploy({ programUuid: "c", code: COUNTER, context: user("a"), initInput: { start: 0 } }).writes);
  vm.commit(vm.init({ programUuid: "c" }).writes);

  reads.length = 0;
  vm.call({ programUuid: "c", functionName: "addTwice", input: { amount: 1 }, context: user("a") }); // reads count twice + writes twice
  assert.deepEqual(reads, ["c:code", "c:storage:count"]);
});

// ---------------------------------------------------------------------------
//  MemoryDB debug tools
// ---------------------------------------------------------------------------

test("MemoryDB: snapshot / listKeys / size / has — view all data and filter by prefix", () => {
  const db = new MemoryDB();
  db.load({
    "token:code": "",
    "token:storage:balances:alice": 700,
    "token:storage:balances:bob": 300,
    "alice:native:received": "1000n",
  });

  assert.equal(db.size, 4);
  assert.equal(db.has("token:code"), true);
  assert.equal(db.has("nope"), false);
  assert.deepEqual(db.listKeys(), ["alice:native:received", "token:code", "token:storage:balances:alice", "token:storage:balances:bob"]);
  assert.deepEqual(db.listKeys("token:storage:"), ["token:storage:balances:alice", "token:storage:balances:bob"]);
  assert.deepEqual(db.snapshot("alice"), { "alice:native:received": "1000n" });
  assert.deepEqual(Object.keys(db.snapshot()), db.listKeys()); // always sorted by key
});

test("MemoryDB: tree — grouped by address", () => {
  const db = new MemoryDB();
  db.load({
    "token:code": "code",
    "token:context": { sender: "alice", origin: "alice" },
    "token:this": "token",
    "token:storage:balances:alice": 700,
    "token:storage:totalSupply": 1000,
    "alice:native:received": "1000n",
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
      native: { received: "1000n" },
      nonce: 3,
      txn: { "0:0xabc": { status: "success" } },
    },
    pending: { shop: { code: "x" } },
  });
  assert.deepEqual(Object.keys(db.tree("token")), ["token"]);
});

test("MemoryDB: dump / toJSON / toString — viewable as JSON", () => {
  const db = new MemoryDB();
  db.load({ "alice:nonce": 1, "token:storage:x": { a: [1, 2] } });

  assert.deepEqual(JSON.parse(db.dump()), db.snapshot());
  assert.deepEqual(JSON.parse(db.dump({ grouped: true })), db.tree());
  assert.deepEqual(JSON.parse(db.dump({ prefix: "alice" })), { "alice:nonce": 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(db)), db.snapshot()); // toJSON
  assert.equal(String(db), db.dump());
  assert.equal(db.dump({ indent: 0 }).includes("\n"), false);
});

test("MemoryDB: dump can truncate long strings (e.g. program code)", () => {
  const db = new MemoryDB();
  db.load({ "token:code": "x".repeat(500), "token:storage:n": 1 });

  const short = JSON.parse(db.dump({ maxStringLength: 20 }));
  assert.equal(short["token:code"], `${"x".repeat(20)}… (500 chars)`);
  assert.equal(short["token:storage:n"], 1);
  assert.equal(JSON.parse(db.dump())["token:code"].length, 500); // not truncated unless asked
});

test("MemoryDB: load / clear, and returned data is a copy", () => {
  const db = new MemoryDB();
  db.load({ "a:storage:x": { n: 1 } });
  db.snapshot()["a:storage:x"].n = 99;
  db.tree().a.storage.x.n = 99;
  assert.deepEqual(db.readKeys(["a:storage:x"]), [{ n: 1 }]);

  assert.equal(db.clear().size, 0);
  assert.deepEqual(db.snapshot(), {});
});

test("MemoryDB: can inspect state after running the VM", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  vm.commit(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 5 } }).writes);
  vm.commit(vm.init({ programUuid: "counter" }).writes);
  vm.commit(vm.call({ programUuid: "counter", functionName: "add", input: { amount: 2 }, context: user("alice") }).writes);

  assert.deepEqual(vm.db.tree().counter.storage, { count: "7n" });
  assert.deepEqual(vm.db.listKeys("counter:"), [
    "counter:code", "counter:context",
    "counter:metadata:createdAt", "counter:metadata:creator", "counter:metadata:type",
    "counter:storage:count", "counter:this",
  ]);
  assert.equal(vm.db.has("pending:counter"), false);
});
