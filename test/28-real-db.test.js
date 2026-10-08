import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM } from "./helpers.js";
import { DB } from "../src/storage/db.js";
import { TOKEN } from "./programs.js";

/* DB จริง (LMDB) ใช้กับ VM ได้เหมือน MemoryDB ทุกอย่าง */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-db-"));
const db = new DB(path.join(dir, "data"));
const vm = new VM.VirtualMachine(db, { requireNonce: true, recordTransactions: true, recordBlocks: true });
const user = (name) => ({ sender: name, origin: name });
const T = Date.parse("2024-06-01T10:00:00Z");

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DB: deploy → init → block → commit แล้วอ่านกลับได้", () => {
  vm.commit(vm.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 }).writes);
  vm.commit(vm.init({ programUuid: "token" }).writes);

  const block = vm.createBlock({ timestamp: T, number: 1, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 30 }, context: user("alice"), nonce: 1 });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 2 });
  const header = block.header();
  block.commit();

  assert.equal(db.readKeys(["token:storage:balances:bob"])[0], 30);
  assert.deepEqual(db.readKeys(["token:context"])[0], user("alice"));
  assert.equal(vm.latestBlockNumber(), 1);
  assert.deepEqual(vm.getBlock(1), header);
  assert.equal(vm.getBlockByHash(header.hash).number, 1);
});

test("DB: listKeys / explorer ทำงานเหมือน MemoryDB", () => {
  assert.deepEqual(vm.listProgramStorage("token").map((entry) => entry.key.join("/")), ["balances/alice", "balances/bob", "owner", "totalSupply"]);
  assert.deepEqual(vm.listTransactionsOf("alice").map((tx) => tx.nonce), [2, 1, 0]);
  assert.deepEqual(vm.listTransactionsOf("alice", { limit: 1 }).map((tx) => tx.nonce), [2]);
  assert.deepEqual(db.listKeys("block:"), ["block:000000000001"]);
  assert.equal(vm.getTransaction(vm.getBlock(1).txHashes[1]).status, "throw");
});

test("DB: writeKeys เป็น atomic — รายการผิดแม้อันเดียวก็ไม่บันทึกอะไรเลย", () => {
  const before = db.readKeys(["token:storage:balances:bob"])[0];
  assert.throws(() => db.writeKeys([
    { type: "put", dbKey: "token:storage:balances:bob", value: 999 },
    { type: "put", dbKey: "เสีย" },
  ]), /write ไม่ถูกต้อง/);
  assert.equal(db.readKeys(["token:storage:balances:bob"])[0], before);
});

test("DB: del ลบข้อมูลจริง และ snapshot / tree ใช้ดูได้", () => {
  db.writeKeys([{ type: "put", dbKey: "tmp:x", value: 1 }]);
  assert.equal(db.has("tmp:x"), true);
  db.writeKeys([{ type: "del", dbKey: "tmp:x" }]);
  assert.equal(db.has("tmp:x"), false);

  assert.deepEqual(db.tree("token:").token.storage["balances:bob"], 30);
  assert.ok(db.dump({ prefix: "token:storage:" }).includes("balances:alice"));
  assert.ok(db.size > 5);
});

test("DB: ข้อมูลยังอยู่หลังเปิดใหม่ (เขียนลงดิสก์จริง)", () => {
  const reopened = new DB(path.join(dir, "data"));
  assert.equal(reopened.readKeys(["token:storage:balances:bob"])[0], 30);
  assert.equal(reopened.readKeys(["latestblock"])[0], 1);
  reopened.close();
});
