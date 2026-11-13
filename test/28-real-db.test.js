import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM } from "./helpers.js";
import { DB } from "../src/storage/db.js";
import { TOKEN } from "./programs.js";

/* the real DB (LMDB) works with the VM exactly like MemoryDB */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vm-db-"));
const db = new DB(path.join(dir, "data"));
const vm = new VM.VirtualMachine(db, { requireNonce: true, recordTransactions: true, recordBlocks: true });
const user = (name) => ({ sender: name, origin: name });
const T = Date.parse("2024-06-01T10:00:00Z");

after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("DB: deploy → init → block → commit, then read back", () => {
  vm.commit(vm.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 }).writes);
  vm.commit(vm.init({ programUuid: "token" }).writes);

  const block = vm.createBlock({ timestamp: T, number: 1, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 30 }, context: user("alice"), nonce: 1 });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 2 });
  const header = block.header();
  block.commit();

  assert.equal(db.readKeys(["token:storage:balances:bob"])[0], "30n");
  assert.deepEqual(db.readKeys(["token:context"])[0], user("alice"));
  assert.equal(vm.latestBlockNumber(), 1);
  assert.deepEqual(vm.getBlock(1), header);
  assert.equal(vm.getBlockByHash(header.hash).number, 1);
});

test("DB: listKeys / explorer work like MemoryDB", () => {
  assert.deepEqual(vm.listProgramStorage("token").map((entry) => entry.key.join("/")), ["balances/alice", "balances/bob", "owner", "totalSupply"]);
  assert.deepEqual(vm.listTransactionsOf("alice").map((tx) => tx.nonce), [2, 1, 0]);
  assert.deepEqual(vm.listTransactionsOf("alice", { limit: 1 }).map((tx) => tx.nonce), [2]);
  assert.deepEqual(db.listKeys("block:"), ["block:000000000001"]);
  assert.equal(vm.getTransaction(vm.getBlock(1).txHashes[1]).status, "throw");
});

test("DB: writeKeys is atomic — a single bad entry means nothing is saved", () => {
  const before = db.readKeys(["token:storage:balances:bob"])[0];
  assert.throws(() => db.writeKeys([
    { type: "put", dbKey: "token:storage:balances:bob", value: 999 },
    { type: "put", dbKey: "bad" },
  ]), /Invalid write/);
  assert.equal(db.readKeys(["token:storage:balances:bob"])[0], before);
});

test("DB: del really deletes data, and snapshot / tree can be used to inspect it", () => {
  db.writeKeys([{ type: "put", dbKey: "tmp:x", value: 1 }]);
  assert.equal(db.has("tmp:x"), true);
  db.writeKeys([{ type: "del", dbKey: "tmp:x" }]);
  assert.equal(db.has("tmp:x"), false);

  assert.deepEqual(db.tree("token:").token.storage["balances:bob"], "30n");
  assert.ok(db.dump({ prefix: "token:storage:" }).includes("balances:alice"));
  assert.ok(db.size > 5);
});

test("DB: data survives reopening (really written to disk)", () => {
  const reopened = new DB(path.join(dir, "data"));
  assert.equal(reopened.readKeys(["token:storage:balances:bob"])[0], "30n");
  assert.equal(reopened.readKeys(["latestblock"])[0], 1);
  reopened.close();
});

test("DB: an absolute path is used as given, not turned into a path under the working directory", () => {
  const target = path.join(dir, "absolute");
  const other = new DB(target);
  other.writeKeys([{ type: "put", dbKey: "k", value: "v" }]);
  other.close();
  assert.ok(fs.existsSync(target), "the DB file must be at the given path");
  assert.equal(fs.existsSync(path.join(process.cwd(), target)), false, "must not be created under the working directory");
  const reopened = new DB(target);
  assert.equal(reopened.readKeys(["k"])[0], "v");
  assert.equal(reopened.basekey, new DB(target).basekey);   // basekey is still derived from the given path
  reopened.close();
});
