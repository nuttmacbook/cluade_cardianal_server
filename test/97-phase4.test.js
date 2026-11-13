import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM, MemoryDB } from "./helpers.js";
import { applyBlock, syncOnce } from "../src/node/sync.js";
import { writeSnapshot, loadSnapshot, readSnapshotFile, snapshotLines } from "../src/node/snapshot.js";
import { verifyProof, EMPTY_ROOT } from "../src/core/trie.js";
import { signTypedDataDigest } from "../src/crypto/program-signature.js";
import { addressOf, randomPrivateKey } from "../src/crypto/signature.js";
import { TOKEN, COUNTER } from "./programs.js";

/*
 * Phase 4: stateRoot = Merkle trie (getProof) · history pruning (historyKeep) · state snapshots (src/node/snapshot.js)
 */

const T = Date.parse("2025-05-01T00:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const GENESIS = { chainId: 1, balances: { alice: 1_000_000 } };
const PRODUCER_KEY = randomPrivateKey();
const PRODUCER = addressOf(PRODUCER_KEY);
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true,
  producer: { address: PRODUCER, sign: (hash) => signTypedDataDigest(hash, PRODUCER_KEY) } };
const READER = { ...OPTIONS, producer: null };
const BALANCE = (who) => `token:storage:balances:${who}`;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "phase4-"));

/** block 1 = deploy + init token · later blocks = transfer to user<i> · some blocks delete keys (approve 0 → overwritten by a new value) */
function produce(vm, from, to) {
  for (let number = from; number <= to; number += 1) {
    const block = vm.createBlock({ timestamp: T + number * 1000, feeRecipient: "miner" });
    if (number === 1) {
      block.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 });
      block.init({ programUuid: "token" });
    } else {
      block.call({ programUuid: "token", functionName: "transfer", input: { to: `user${number}`, amount: 10 }, context: user("alice"), nonce: number - 1 });
    }
    block.commit();
  }
  return vm;
}

function chain(blocks, options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, ...options });
  vm.applyGenesis(GENESIS);
  return produce(vm, 1, blocks);
}

function reader(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...READER, ...options });
  vm.applyGenesis(GENESIS);
  return vm;
}

const stateOf = (vm) => Object.fromEntries(Object.entries(vm.db.snapshot()).filter(([key]) => VM.isStateKey(key)));
const feed = (source) => async (from, limit) => {
  const blocks = [];
  for (let n = from; n <= Math.min(source.latestBlockNumber(), from + limit - 1); n += 1) {
    blocks.push({ header: source.getBlock(n), body: source.getBlockBody(n), rejected: source.getBlockRejected(n) });
  }
  return blocks;
};

// ---------------------------------------------------------------------------
//  4.3 Merkle trie · getProof
// ---------------------------------------------------------------------------

test("getProof: values in the latest state prove against the latest header's stateRoot · missing keys can be proven absent", () => {
  const vm = chain(4);
  const header = vm.getBlock(4);
  const keys = [BALANCE("alice"), BALANCE("user3"), "alice:nonce", "alice:native:received", BALANCE("nobody")];
  const result = vm.getProof(keys);
  assert.deepEqual([result.blockNumber, result.blockHash, result.stateRoot], [4, header.hash, header.stateRoot]);
  for (const { dbKey, value, proof } of result.proofs) {
    assert.deepEqual(value, vm.read(dbKey));
    assert.deepEqual(verifyProof(header.stateRoot, dbKey, proof), value === undefined ? { exists: false } : { exists: true, value });
  }
  // an old proof does not work with a new root (value changed → nodes on the path changed)
  const old = result.proofs[0];
  produce(vm, 5, 5);
  assert.throws(() => verifyProof(vm.getBlock(5).stateRoot, old.dbKey, old.proof), /incomplete proof/);
  assert.throws(() => vm.getProof("x"), /key/);
});

test("tries match node for node: after syncing, the reader has the producer's stateRoot / trie nodes · migrating a DB without a trie gives the same root", async () => {
  const source = chain(5);
  const target = reader();
  await syncOnce(target, feed(source));
  assert.equal(target.stateRoot(), source.getBlock(5).stateRoot);
  const trieOf = (vm) => vm.db.snapshot("trie:");
  assert.deepEqual(trieOf(target), trieOf(source));

  // an old DB (before phase 4.3) has no trie: the VM builds it on first use
  const legacy = new MemoryDB(Object.fromEntries(Object.entries(source.db.snapshot()).filter(([key]) => !key.startsWith("trie:"))));
  assert.equal(new VM.VirtualMachine(legacy).stateRoot(), source.getBlock(5).stateRoot);
  assert.equal(new VM.VirtualMachine(new MemoryDB()).stateRoot(), EMPTY_ROOT);
});

// ---------------------------------------------------------------------------
//  4.2 pruning
// ---------------------------------------------------------------------------

test("pruning: historyKeep = 3 → only the last 3 blocks of history remain · lookback / replay only within that range · headers / bodies stay complete, syncing still works", async () => {
  const vm = chain(8, { historyKeep: 3 });
  assert.equal(vm.historyFrom(), 6);
  assert.deepEqual(vm.listKeys("blockundo:").map((key) => Number(key.split(":")[1])), [6, 7, 8]);
  assert.ok(vm.listKeys("history:").every((key) => Number(key.split(":").at(-1)) >= 6));

  assert.equal(vm.stateAt(5, BALANCE("alice")), "960n");                    // state at block 5 = before block 6 → still reachable
  assert.throws(() => vm.stateAt(4, BALANCE("alice")) && vm.snapshotAt(4), { code: "NOT_FOUND" });
  assert.throws(() => vm.snapshotAt(4), { code: "NOT_FOUND" });
  assert.equal(vm.replayBlock(6).hash, vm.getBlock(6).hash);
  assert.throws(() => vm.replayBlock(5), { code: "NOT_FOUND" });
  assert.throws(() => vm.rebuildFrom(7), { code: "NOT_FOUND" });           // rebuild needs history from block 1

  // a pruned node can still serve as a sync source (bodies complete), with results matching an archive node
  const archive = chain(8);
  const synced = reader();
  await syncOnce(synced, feed(vm));
  assert.equal(synced.stateRoot(), archive.stateRoot());
  assert.deepEqual(stateOf(synced), stateOf(archive));
  assert.equal(vm.getBlock(8).hash, archive.getBlock(8).hash);              // pruning is not in the hash (each machine may set it differently)
});

test("pruning: enabled on an already long chain → deletes gradually, at most maxKeys per run", () => {
  const vm = chain(10);
  assert.equal(vm.historyFrom(), 1);
  const first = vm.pruneHistory({ keep: 2, maxKeys: 4 });
  assert.equal(first.from, 1);
  assert.ok(first.to > 1 && first.to < 9);
  let last = first;
  while (last.to < 9) last = vm.pruneHistory({ keep: 2, maxKeys: 4 });
  assert.equal(vm.historyFrom(), 9);
  assert.deepEqual(vm.pruneHistory({ keep: 2 }), { from: 9, to: 9, keys: 0 });
  assert.throws(() => new VM.VirtualMachine(new MemoryDB(), { historyKeep: 0 }), /historyKeep/);
});

// ---------------------------------------------------------------------------
//  4.1 snapshot
// ---------------------------------------------------------------------------

test("snapshot: load state at block N, then keep syncing → state / trie match the producer for every key", async () => {
  const dir = tmp();
  try {
    const source = chain(6);
    const file = path.join(dir, "snap.ndjson.gz");
    const written = await writeSnapshot(source, file);
    assert.deepEqual([written.number, written.hash, written.stateRoot], [6, source.getBlock(6).hash, source.getBlock(6).stateRoot]);

    const target = reader();
    const loaded = await loadSnapshot(target, readSnapshotFile(file), { producers: [PRODUCER] });
    assert.equal(loaded.number, 6);
    assert.equal(target.latestBlockNumber(), 6);
    assert.equal(target.historyFrom(), 7);
    assert.equal(target.stateRoot(), source.getBlock(6).stateRoot);
    assert.deepEqual(stateOf(target), stateOf(source));
    assert.equal(target.getBlockBody(6), null);                               // no bodies before the snapshot
    assert.throws(() => target.replayBlock(6), { code: "NOT_FOUND" });

    produce(source, 7, 9);
    assert.equal(await syncOnce(target, feed(source)), 3);
    assert.equal(target.stateRoot(), source.getBlock(9).stateRoot);
    assert.deepEqual(stateOf(target), stateOf(source));
    assert.equal(target.replayBlock(8).hash, source.getBlock(8).hash);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("snapshot: export does not stop the chain: new blocks (including key deletes) during export do not affect the state at block N", async () => {
  const source = chain(4);
  const five = source.createBlock({ timestamp: T + 5000, feeRecipient: "miner" });
  five.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: "7n" }, nonce: 4 });
  five.init({ programUuid: "counter" });
  five.commit();
  const root5 = source.getBlock(5).stateRoot;
  assert.equal(source.read("counter:storage:count"), "7n");
  const lines = [];
  let moved = false;
  for await (const chunk of snapshotLines(source, { batch: 3 })) {
    lines.push(...chunk.split("\n").filter(Boolean));
    if (!moved && lines.length > 8) {            // past 5 headers, in the middle of the state list (before "counter:" / "token:")
      moved = true;
      const block = source.createBlock({ timestamp: T + 6000, feeRecipient: "miner" });
      block.call({ programUuid: "token", functionName: "transfer", input: { to: "late", amount: 1 }, context: user("alice"), nonce: 5 });
      block.call({ programUuid: "counter", functionName: "reset", context: user("alice"), nonce: 6 });
      block.commit();
      assert.equal(source.read("counter:storage:count"), undefined);
    }
  }
  assert.ok(moved);
  const target = reader();
  const loaded = await loadSnapshot(target, lines);
  assert.equal(loaded.number, 5);
  assert.equal(target.stateRoot(), root5);
  assert.equal(target.read("counter:storage:count"), "7n");
  assert.equal(target.read(BALANCE("late")), undefined);
});

test("snapshot: tampered / incomplete data / wrong producer / wrong chain = rejected, leaving no partial state", async () => {
  const source = chain(3);
  const lines = [];
  for await (const chunk of snapshotLines(source)) lines.push(...chunk.split("\n").filter(Boolean));
  const target = reader();
  const empty = () => { assert.equal(target.latestBlockNumber(), null); assert.deepEqual(Object.keys(stateOf(target)), []); };

  const tampered = lines.map((text) => (text.startsWith(`["${BALANCE("alice")}"`) ? JSON.stringify([BALANCE("alice"), "999999n"]) : text));
  await assert.rejects(loadSnapshot(target, tampered), /does not match the stateRoot/);
  empty();
  await assert.rejects(loadSnapshot(target, lines.slice(0, -1)), /incomplete/);
  await assert.rejects(loadSnapshot(target, lines.filter((text) => !text.startsWith(`["${BALANCE("user2")}"`))), /does not match the stateRoot/);
  await assert.rejects(loadSnapshot(target, lines, { producers: ["0x0000000000000000000000000000000000000001"] }), /who is not in the producer list/);
  const forged = lines.map((text, index) => (index === 3 ? JSON.stringify({ header: { ...JSON.parse(text).header, stateRoot: `0x${"1".repeat(64)}` } }) : text));
  await assert.rejects(loadSnapshot(target, forged), /hash of header/);
  await assert.rejects(loadSnapshot(target, [JSON.stringify({ ...JSON.parse(lines[0]), chainId: 2 }), ...lines.slice(1)]), /chainId/);
  await assert.rejects(loadSnapshot(target, [lines[0], ...lines.slice(1, 3), `["block:000000000001", {}]`, ...lines.slice(3)]), /non-state key/);
  empty();

  await loadSnapshot(target, lines, { producers: [PRODUCER] });
  assert.equal(target.stateRoot(), source.stateRoot());
  await assert.rejects(loadSnapshot(target, lines), /no blocks/);
});

test("snapshot: headers for the last 256 blocks (BlockHash) · no blocks = cannot snapshot", async () => {
  const vm = reader({ producer: null });
  await assert.rejects(writeSnapshot(vm, path.join(os.tmpdir(), "never.ndjson")), /no blocks/);
  for (let number = 1; number <= 260; number += 1) {
    const block = vm.createBlock({ timestamp: T + number, feeRecipient: "miner" });
    block.commit();
  }
  const lines = [];
  for await (const chunk of snapshotLines(vm)) lines.push(...chunk.split("\n").filter(Boolean));
  const headers = lines.map((text) => JSON.parse(text)).filter((item) => item.header).map((item) => item.header.number);
  assert.deepEqual([headers.length, headers[0], headers.at(-1)], [256, 5, 260]);
  const target = reader({ producer: null });
  await loadSnapshot(target, lines);
  assert.equal(target.getBlock(5).hash, vm.getBlock(5).hash);
  assert.equal(target.getBlock(4), null);
  const next = target.createBlock({ timestamp: T + 261, feeRecipient: "miner" });
  const same = vm.createBlock({ timestamp: T + 261, feeRecipient: "miner" });
  assert.equal(next.header().hash, same.header().hash);                       // base fee / parentHash continue from header N
  applyBlock(target, { header: same.header(), body: [] });
});
