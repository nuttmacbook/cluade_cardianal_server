import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM, MemoryDB } from "./helpers.js";
import { DB, DEFAULT_MAP_SIZE, parseSize } from "../src/storage/db.js";

/*
 * a long chain (tens of millions of blocks) must not slow normal requests in proportion to its length
 *   - historyfrom: replayBlock / snapshotAt check once that history is complete (no scan of every block's blockundo)
 *   - pageSnapshotAt: finds keys from history by jumping one key at a time + paging (does not read blockundo)
 *   - rebuildFrom: works in batches, never holding the whole chain in memory · writes over existing blocks (overwrite)
 *   - LMDB: mapSize default 1 TB · LMDB_MAP_SIZE · stats() for /health
 */

const T = Date.parse("2026-02-01T00:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const OPTIONS = {
  requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true,
  gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 },
};
// set = write · drop = delete (a deleted key must still show in snapshots of blocks before the delete) · nested key map("a", x, y)
const STORE = `function program() {
  function set(params) { writeDB(map("k", params.input.k), params.input.v) }
  function drop(params) { deleteDB(map("k", params.input.k)) }
  function nested(params) { writeDB(map("k", params.input.k, params.input.sub), params.input.v) }
  return { set, drop, nested }
}`;

/** Count how many times each kind of key is read from the DB */
function countingDB() {
  const db = new MemoryDB();
  const counts = new Map();
  const readKeys = db.readKeys.bind(db);
  db.readKeys = (keys) => {
    for (const key of keys) { const head = key.split(":")[0]; counts.set(head, (counts.get(head) ?? 0) + 1); }
    return readKeys(keys);
  };
  return { db, counts };
}

/** Chain of n blocks: block 1 deploys · each block writes / deletes keys by formula (including keys deleted later and nested keys) */
function buildChain(blocks = 12, vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS)) {
  vm.db.load({ "alice:native:received": "1000000n" });
  let nonce = 0;
  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.deploy({ programUuid: "store", code: STORE, context: user("alice"), nonce: nonce++ });
  first.init({ programUuid: "store" });
  first.commit();
  for (let n = 2; n <= blocks; n += 1) {
    const block = vm.createBlock({ timestamp: T + n * 1000, feeRecipient: "miner" });
    const call = (functionName, input) => assert.equal(block.call({ programUuid: "store", functionName, input, context: user("alice"), nonce: nonce++ }).status, "success");
    call("set", { k: `a${n % 5}`, v: `${n}n` });
    call("set", { k: `b${n}`, v: `${n}n` });
    if (n % 3 === 0) call("drop", { k: `b${n - 1}` });                  // deleted later
    if (n % 4 === 0) call("nested", { k: `a${n % 5}`, sub: "x", v: `${n}n` });
    block.commit();
  }
  return vm;
}

/** The old snapshot: scans every block's blockundo (used as the reference answer) */
function bruteSnapshot(vm, number, prefix) {
  const keys = new Set(vm.listKeys(prefix));
  for (let n = vm.latestBlockNumber(); n > number; n -= 1) for (const key of vm.getBlockUndo(n) ?? []) if (key.startsWith(prefix)) keys.add(key);
  const out = {};
  for (const key of [...keys].sort()) { const value = vm.stateAt(number, key); if (value !== undefined && !VM.isIndexKey(key)) out[key] = value; }
  return out;
}

// ---------------------------------------------------------------------------
//  historyfrom
// ---------------------------------------------------------------------------

test("historyfrom: new chain = 1 · a block without history → restart from the next block", () => {
  const vm = buildChain(4);
  assert.equal(vm.read(VM.HISTORY_FROM_KEY), 1);
  assert.equal(vm.historyFrom(), 1);

  const gap = vm.createBlock({ timestamp: T + 10_000, feeRecipient: "miner", recordHistory: false });
  gap.commit();
  assert.equal(vm.historyFrom(), 6);
  const next = vm.createBlock({ timestamp: T + 11_000, feeRecipient: "miner" });
  next.commit();
  assert.equal(vm.historyFrom(), 6);   // later blocks with history do not move the value back

  assert.throws(() => vm.replayBlock(5), /ไม่มีข้อมูลย้อนหลัง/);
  assert.equal(vm.replayBlock(6).hash, vm.getBlock(6).hash);
  assert.throws(() => vm.snapshotAt(4, "store:storage:"), /ไม่มีข้อมูลย้อนหลัง/);
  assert.doesNotThrow(() => vm.snapshotAt(5, "store:storage:"));   // as of closing block 5 = uses history from block 6 onward
});

test("historyfrom: an old chain without this value → computed from blockundo, then saved by the next block", () => {
  const vm = buildChain(5);
  vm.commit([{ type: "del", dbKey: VM.HISTORY_FROM_KEY }]);
  assert.equal(vm.historyFrom(), 1);
  const block = vm.createBlock({ timestamp: T + 20_000, feeRecipient: "miner" });
  block.commit();
  assert.equal(vm.read(VM.HISTORY_FROM_KEY), 1);
});

test("replayBlock: never reads blockundo (one check against historyfrom) however long the chain is", () => {
  const { db, counts } = countingDB();
  const vm = buildChain(30, new VM.VirtualMachine(db, OPTIONS));
  counts.clear();
  assert.equal(vm.replayBlock(2).hash, vm.getBlock(2).hash);
  assert.equal(counts.get("blockundo") ?? 0, 0);
  assert.equal(counts.get("historyfrom"), 1);
});

// ---------------------------------------------------------------------------
//  snapshotAt / pageSnapshotAt
// ---------------------------------------------------------------------------

test("pageSnapshotAt: gives the same result as scanning every blockundo (including later-deleted keys and nested keys)", () => {
  const vm = buildChain(12);
  for (let n = 1; n <= 12; n += 1) {
    for (const prefix of ["store:storage:", "store:storage:k:a1", ""]) {
      assert.deepEqual(vm.snapshotAt(n, prefix), bruteSnapshot(vm, n, prefix), `block ${n} prefix ${prefix}`);
    }
  }
  // a key deleted later still shows at blocks before the delete
  assert.equal(vm.snapshotAt(4, "store:storage:")["store:storage:k:b4"], "4n");
  assert.equal(vm.snapshotAt(5, "store:storage:")["store:storage:k:b5"], "5n");
  assert.equal(vm.snapshotAt(6, "store:storage:")["store:storage:k:b5"], undefined);   // deleted in block 6
});

test("pageSnapshotAt: pages join up completely with no repeats · does not read blockundo", () => {
  const { db, counts } = countingDB();
  const vm = buildChain(12, new VM.VirtualMachine(db, OPTIONS));
  const full = Object.entries(vm.snapshotAt(7, "store:storage:"));
  for (const limit of [1, 2, 3, 5, 100]) {
    counts.clear();
    const items = [];
    let after;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = vm.pageSnapshotAt(7, "store:storage:", { limit, after });
      assert.ok(page.items.length <= limit);
      items.push(...page.items);
      if (page.next === null) break;
      after = page.next;
    }
    assert.deepEqual(items, full, `limit ${limit}`);
    assert.equal(counts.get("blockundo") ?? 0, 0);
  }
});

test("pageSnapshotAt: block past the latest / negative → block not found", () => {
  const vm = buildChain(3);
  assert.throws(() => vm.snapshotAt(4), /ไม่พบ block/);
  assert.throws(() => vm.snapshotAt(-1), /ไม่พบ block/);
  assert.deepEqual(vm.snapshotAt(3, "store:storage:"), Object.fromEntries(vm.listProgramStorage("store").map(({ key, value }) => [`store:storage:${key.join(":")}`, value])));
});

// ---------------------------------------------------------------------------
//  rebuildFrom in batches
// ---------------------------------------------------------------------------

/** Everything in the DB except what may differ by write order (nothing) */
const everything = (vm) => vm.db.snapshot();

test("rebuildFrom in batches: the DB after rebuild = the DB of a chain built straight to target (every key, including history / blockundo / indexes)", () => {
  for (const batch of [1, 3, 10_000]) {
    for (const target of [0, 1, 5, 11]) {
      const vm = buildChain(12);
      const result = vm.rebuildFrom(target, { batch });
      assert.deepEqual({ from: result.from, to: result.to, blocks: result.blocks }, { from: 12, to: target, blocks: target });
      const expected = target === 0 ? null : buildChain(target);
      if (target === 0) {
        assert.equal(vm.latestBlockNumber(), null);
        assert.deepEqual(vm.db.listKeys("history:"), []);
        assert.deepEqual(vm.db.listKeys("block"), []);
        assert.equal(vm.read("store:code"), undefined);
      } else {
        assert.deepEqual(everything(vm), everything(expected), `batch ${batch} target ${target}`);
      }
    }
  }
});

test("rebuildFrom: after rebuild the chain continues · replay / snapshot work for every block", () => {
  const vm = buildChain(10);
  vm.rebuildFrom(6, { batch: 4 });
  assert.equal(vm.historyFrom(), 1);
  const block = vm.createBlock({ timestamp: T + 50_000, feeRecipient: "miner" });
  block.call({ programUuid: "store", functionName: "set", input: { k: "z", v: "1n" }, context: user("alice"), nonce: vm.read("alice:nonce") });
  block.commit();
  assert.equal(vm.latestBlockNumber(), 7);
  for (let n = 1; n <= 7; n += 1) assert.equal(vm.replayBlock(n).hash, vm.getBlock(n).hash);
  assert.deepEqual(vm.snapshotAt(3, "store:storage:"), bruteSnapshot(vm, 3, "store:storage:"));
});

test("rebuildFrom: history incomplete from block 1 → rejected before touching the DB", () => {
  const vm = buildChain(3);
  const gap = vm.createBlock({ timestamp: T + 10_000, feeRecipient: "miner", recordHistory: false });
  gap.commit();
  const before = everything(vm);
  assert.throws(() => vm.rebuildFrom(1), /ไม่มีข้อมูลย้อนหลัง/);
  assert.deepEqual(everything(vm), before);
});

// ---------------------------------------------------------------------------
//  LMDB
// ---------------------------------------------------------------------------

test("LMDB: mapSize default 1 TB · parseSize · stats() reports usage against mapSize", () => {
  assert.equal(DEFAULT_MAP_SIZE, 1024 ** 4);
  assert.equal(parseSize("1T"), 1024 ** 4);
  assert.equal(parseSize("500g"), 500 * 1024 ** 3);
  assert.equal(parseSize("64MB"), 64 * 1024 ** 2);
  assert.equal(parseSize("4096"), 4096);
  assert.throws(() => parseSize("lots"), /ขนาดไม่ถูกต้อง/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-scale-"));
  try {
    const db = new DB(path.join(dir, "data"), { mapSize: parseSize("64M") });
    db.writeKeys([{ type: "put", dbKey: "a", value: "x".repeat(10_000) }]);
    const stats = db.stats();
    assert.equal(stats.mapSize, 64 * 1024 ** 2);
    assert.ok(stats.usedBytes > 10_000 && stats.usedBytes < stats.mapSize);
    assert.equal(stats.usedPercent, Math.round((stats.usedBytes / stats.mapSize) * 10_000) / 100);
    db.server.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
//  server: /health · /state/:id?block=&limit=&cursor=
// ---------------------------------------------------------------------------

test("server: /health reports historyFrom + DB space · /state at an old block is paged", async () => {
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  const { server, vm, miner } = await import("../server.js");
  clearInterval(miner);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const get = (p) => fetch(url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const health = await get("/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.db, null);   // no DATA = MemoryDB

    // a small chain on the server's vm: program "store" writes a key per block
    vm.db.load({ "alice:native:received": "1000000000000000000000n" });
    let nonce = 0;
    const deploy = vm.createBlock({ timestamp: Date.now() - 10_000, feeRecipient: "miner" });
    const deployed = deploy.deploy({ code: STORE, context: user("alice"), nonce: nonce++ });
    deploy.init({ programUuid: deployed.result.programUuid });
    deploy.commit();
    const id = deployed.result.programUuid;
    for (let i = 0; i < 4; i += 1) {
      const block = vm.createBlock({ timestamp: Date.now() - 9_000 + i * 1000, feeRecipient: "miner" });
      block.call({ programUuid: id, functionName: "set", input: { k: `k${i}`, v: `${i}n` }, context: user("alice"), nonce: nonce++ });
      block.commit();
    }
    assert.equal((await get("/health")).body.historyFrom, 1);

    const all = (await get(`/state/${id}?block=4`)).body;
    assert.deepEqual(Object.keys(all).length, 3);
    const first = (await get(`/state/${id}?block=4&limit=2`)).body;
    assert.equal(Object.keys(first.items).length, 2);
    const second = (await get(`/state/${id}?block=4&limit=2&cursor=${encodeURIComponent(first.next)}`)).body;
    assert.equal(second.next, null);
    assert.deepEqual({ ...first.items, ...second.items }, all);
    assert.equal((await get(`/state/${id}?block=99&limit=2`)).status, 409);
  } finally {
    server.close();
  }
});
