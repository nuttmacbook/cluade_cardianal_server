import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, num } from "./helpers.js";
import { TOKEN, COUNTER } from "./programs.js";

/* block hash / txRoot / stateRoot and the block data written to the DB */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, recordTransactions: true, recordBlocks: true, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  // fixed time: stateRoot = trie root over the whole state (including deploy data) → two setups must give byte-identical state
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }, { timestamp: T - 2 }).writes);
  vm.commit(plain.init({ programUuid: "token" }, { timestamp: T - 1 }).writes);
  vm.commit([{ type: "put", dbKey: "alice:native:received", value: "1000000n" }]);
  return vm;
}

const callTx = (nonce, amount = 10) => ({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount }, context: user("alice"), nonce });

function buildBlock(vm, { number = 1, parentHash = null, txs = [callTx(0), callTx(1)] } = {}) {
  const block = vm.createBlock({ timestamp: T, number, parentHash, feeRecipient: "miner" });
  for (const tx of txs) block.call(tx);
  return block;
}

// ---------------------------------------------------------------------------
//  hash
// ---------------------------------------------------------------------------

test("hash: a block has hash / parentHash / txRoot / stateRoot", () => {
  const vm = setup();
  const block = buildBlock(vm, { parentHash: "0xparent" });
  const { hash, parentHash, txRoot, stateRoot } = block.hashes();

  for (const value of [hash, txRoot, stateRoot]) assert.match(value, /^0x[0-9a-f]{64}$/);
  assert.equal(parentHash, "0xparent");
  assert.equal(new Set([hash, txRoot, stateRoot]).size, 3);
  assert.deepEqual(block.receipt().hash, hash);
});

test("hash: txRoot comes from every tx hash in order", () => {
  const vm = setup();
  const block = buildBlock(vm);
  assert.deepEqual(block.txHashes(), block.receipt().transactions.map((tx) => tx.hash));
  assert.equal(block.hashes().txRoot, vm.hashData(block.txHashes()));
});

test("hash: identical every time for identical data", () => {
  const first = buildBlock(setup(), { parentHash: "0xp" }).hashes();
  const second = buildBlock(setup(), { parentHash: "0xp" }).hashes();
  assert.deepEqual(first, second);
});

test("hash: any change gives a new block hash", () => {
  const base = buildBlock(setup(), { parentHash: "0xp" }).hashes().hash;
  const variants = [
    buildBlock(setup(), { parentHash: "0xp", number: 2 }),                      // block number
    buildBlock(setup(), { parentHash: "0xother" }),                             // parent
    buildBlock(setup(), { parentHash: "0xp", txs: [callTx(0), callTx(1, 11)] }), // tx content
    buildBlock(setup(), { parentHash: "0xp", txs: [callTx(0)] }),                // tx count
  ];
  const hashes = variants.map((block) => block.hashes().hash);
  assert.equal(new Set([base, ...hashes]).size, hashes.length + 1);

  const other = setup();
  const timeChanged = other.createBlock({ timestamp: T + 1, number: 1, parentHash: "0xp", feeRecipient: "miner" });
  timeChanged.call(callTx(0));
  timeChanged.call(callTx(1));
  assert.notEqual(timeChanged.hashes().hash, base); // time changed
});

test("hash: same txs but different state → different stateRoot", () => {
  const rich = setup();
  const poor = setup();
  poor.db.load({ "token:storage:balances:alice": 5 }); // the 2nd tx will fail for lack of funds

  const a = buildBlock(rich, { txs: [callTx(0), callTx(1, 10)] });
  const b = buildBlock(poor, { txs: [callTx(0), callTx(1, 10)] });
  assert.deepEqual(a.txHashes(), b.txHashes());          // tx hashes are equal
  assert.notEqual(a.hashes().stateRoot, b.hashes().stateRoot);
  assert.notEqual(a.hashes().hash, b.hashes().hash);
});

test("hash: linked into a chain by parentHash", () => {
  const vm = setup();
  const first = buildBlock(vm, { number: 1, txs: [callTx(0)] });
  first.commit();

  const second = vm.createBlock({ timestamp: T + 1000, number: 2, parentHash: first.hashes().hash, feeRecipient: "miner" });
  second.call(callTx(1));
  assert.equal(second.parentHash, first.hashes().hash);
  assert.equal(second.receipt().parentHash, first.hashes().hash);
});

// ---------------------------------------------------------------------------
//  header + writes
// ---------------------------------------------------------------------------

test("header: block summary", () => {
  const vm = setup();
  const block = buildBlock(vm, { number: 5, parentHash: "0xp", txs: [callTx(0), callTx(1, 99999)] });
  const header = block.header();

  assert.deepEqual(
    { ...header, hash: null, txRoot: null, stateRoot: null, writesRoot: null, txHashes: header.txHashes.length },
    {
      number: 5, hash: null, parentHash: "0xp", parentStateRoot: null, timestamp: T, feeRecipient: "miner", burnPercent: 100,
      txCount: 2, successCount: 1, failedCount: 1,
      gasUsed: block.results().reduce((sum, r) => sum + r.gasUsed, 0),
      fee: `${block.results().reduce((sum, r) => sum + num(r.fee), 0)}n`,
      txRoot: null, stateRoot: null, writesRoot: null, txHashes: 2,
      // EIP-1559 + receipt (no maxBlockGas → base fee fixed at the minimum · no events → empty bloom)
      baseFeePerGas: "1n", gasTarget: null, burnedFee: "0n", producerFee: "0n",
      receiptsRoot: block.receiptRoots().receiptsRoot, logsBloom: `0x${"0".repeat(512)}`,
    },
  );
});

test("writes: include block:<number> / blockhash:<hash> / latestblock / tx:<hash>", () => {
  const vm = setup();
  const block = buildBlock(vm, { number: 42, parentHash: "0xp" });
  const header = block.header();
  const blockWrites = block.blockWrites();

  assert.deepEqual(blockWrites.slice(0, 4).map((w) => w.dbKey), [
    "block:000000000042", "blockbody:000000000042", `blockhash:${header.hash}`, "latestblock",
  ]);
  assert.deepEqual(blockWrites[0].value, header);
  assert.deepEqual(blockWrites[1].value.map((entry) => entry.action), ["call", "call"]); // raw txs
  assert.equal(blockWrites[2].value, 42);
  assert.equal(blockWrites[3].value, 42);

  assert.deepEqual(blockWrites.slice(4).filter((w) => w.dbKey.startsWith("tx:")).map((w) => w.dbKey), header.txHashes.map((hash) => `tx:${hash}`));
  const { gasUsed, gasPrice, tip, ...entry } = blockWrites[4].value;
  assert.deepEqual(entry, {
    hash: header.txHashes[0], digest: null, blockNumber: 42, index: 0, action: "call", status: "success", from: "alice", nonce: 0,
  });
  assert.deepEqual([gasUsed, gasPrice, tip], [block.results()[0].gasUsed, "1n", "0n"]);   // tx gas figures (eth_feeHistory reads them from here)

  // writes() = tx writes + block data
  assert.deepEqual(block.writes(), [...block.stateWrites(), ...blockWrites]);
});

test("writes: after commit, data can be looked up in the DB every way", () => {
  const vm = setup();
  const block = buildBlock(vm, { number: 7, parentHash: "0xp", txs: [callTx(0), callTx(1, 99999)] });
  const header = block.header();
  block.commit();

  assert.deepEqual(vm.db.readKeys(["block:000000000007"])[0], header);
  assert.equal(vm.db.readKeys([`blockhash:${header.hash}`])[0], 7);
  assert.equal(vm.db.readKeys(["latestblock"])[0], 7);

  // look up a tx by hash → find its block and index, then read the address's full record
  const [okHash, failedHash] = header.txHashes;
  const found = vm.db.readKeys([`tx:${okHash}`])[0];
  const { gasUsed: _gas, gasPrice: _price, tip: _tip, ...found2 } = found;
  assert.deepEqual(found2, { hash: okHash, digest: null, blockNumber: 7, index: 0, action: "call", status: "success", from: "alice", nonce: 0 });
  assert.equal(vm.db.readKeys([`tx:${failedHash}`])[0].status, "throw");
  assert.equal(vm.db.readKeys([`alice:txn:${found.nonce}:${found.hash}`])[0].gasUsed > 0, true);
});

test("writes: consecutive blocks — latestblock updates and keys sort by block number", () => {
  const vm = setup();
  let parentHash = null;
  for (let number = 1; number <= 3; number += 1) {
    const block = vm.createBlock({ timestamp: T + number, number, parentHash, feeRecipient: "miner" });
    block.call(callTx(number - 1));
    parentHash = block.header().hash;
    block.commit();
  }

  assert.deepEqual(vm.db.listKeys("block:"), ["block:000000000001", "block:000000000002", "block:000000000003"]);
  assert.equal(vm.db.readKeys(["latestblock"])[0], 3);
  assert.equal(vm.db.readKeys(["block:000000000003"])[0].parentHash, vm.db.readKeys(["block:000000000002"])[0].hash);
});

test("writes: recordBlocks off → no block data in writes", () => {
  const off = setup({ recordBlocks: false });
  assert.deepEqual(buildBlock(off, { number: 1 }).blockWrites(), []);

  const noNumber = off.createBlock({ timestamp: T });
  noNumber.call(callTx(0));
  assert.deepEqual(noNumber.blockWrites(), []);
  assert.deepEqual(noNumber.writes(), noNumber.stateWrites());
  assert.equal(noNumber.header().number, null); // the hash can still be computed
});

test("chain: no number / parentHash → the VM continues from the latest block", () => {
  const vm = setup();
  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.call(callTx(0));
  assert.deepEqual([first.number, first.parentHash, first.parentStateRoot], [1, null, null]);
  first.commit();

  const second = vm.createBlock({ timestamp: T + 1, feeRecipient: "miner" });
  second.call(callTx(1));
  assert.equal(second.number, 2);
  assert.equal(second.parentHash, first.header().hash);
  assert.equal(second.parentStateRoot, first.header().stateRoot);
});

test("chain: a block number cannot be committed twice", () => {
  const vm = setup();
  buildBlock(vm, { number: 1, txs: [callTx(0)] }).commit();

  assert.throws(() => vm.createBlock({ timestamp: T + 1, number: 1 }), { code: "INVALID_REQUEST", message: /block 1 is already recorded/ });

  // created first, but someone else commits the same number first → commit fails
  const pending = vm.createBlock({ timestamp: T + 2, number: 2, feeRecipient: "miner" });
  const other = vm.createBlock({ timestamp: T + 3, number: 2, feeRecipient: "miner" });
  other.call(callTx(1));
  other.commit();
  assert.throws(() => pending.commit(), { code: "INVALID_REQUEST", message: /block 2 is already recorded/ });
});

test("chain: timestamp must always move forward", () => {
  const vm = setup();
  buildBlock(vm, { number: 1, txs: [callTx(0)] }).commit();
  const previous = vm.getBlock(1).timestamp;

  for (const timestamp of [previous, previous - 1000]) {
    assert.throws(() => vm.createBlock({ timestamp, number: 2 }), { code: "INVALID_REQUEST", message: /block timestamp must be greater than/ });
  }
  assert.equal(vm.createBlock({ timestamp: previous + 1, number: 2 }).number, 2);
});

test("chain: checks can be skipped with checkChain: false (for replay or tests)", () => {
  const vm = setup();
  buildBlock(vm, { number: 1, txs: [callTx(0)] }).commit();
  const block = vm.createBlock({ timestamp: T - 5000, number: 1, checkChain: false });
  assert.equal(block.number, 1);
});


test("writes: init / reject also have a tx hash in the block (but no <addr>:txn)", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, number: 9, feeRecipient: "miner" });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 0 });
  block.init({ programUuid: "counter" });

  const header = block.header();
  assert.equal(header.txCount, 2);
  assert.equal(new Set(header.txHashes).size, 2);
  block.commit();

  const initEntry = vm.db.readKeys([`tx:${header.txHashes[1]}`])[0];
  const { gasUsed: _g, gasPrice: _p, tip: _t, ...initOnly } = initEntry;
  assert.deepEqual(initOnly, { hash: header.txHashes[1], digest: null, blockNumber: 9, index: 1, action: "init", status: "success", from: null, nonce: null });
  assert.deepEqual(vm.db.listKeys("alice:txn:").length, 1); // deploy only
});

test("decodeDbKey: parses block keys", () => {
  assert.deepEqual(VM.decodeDbKey("block:000000000042"), { kind: "block", number: 42 });
  assert.deepEqual(VM.decodeDbKey("blockhash:0xabc"), { kind: "blockhash", hash: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("tx:0xabc"), { kind: "tx", hash: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("latestblock"), { kind: "latestblock" });
});

test("receipt: includes the block hash and every tx hash", () => {
  const vm = setup();
  const block = buildBlock(vm, { number: 3, parentHash: "0xp" });
  const receipt = block.receipt();

  assert.equal(receipt.number, 3);
  assert.equal(receipt.hash, block.header().hash);
  assert.equal(receipt.parentHash, "0xp");
  assert.equal(receipt.txRoot, block.header().txRoot);
  assert.equal(receipt.stateRoot, block.header().stateRoot);
  assert.deepEqual(receipt.transactions.map((tx) => tx.hash), block.header().txHashes);
});

// ---------------------------------------------------------------------------
//  cumulative stateRoot
// ---------------------------------------------------------------------------

test("stateRoot: builds on the previous block (reads parentStateRoot from the DB itself)", () => {
  const vm = setup();
  const first = buildBlock(vm, { number: 1, txs: [callTx(0)] });
  assert.equal(first.parentStateRoot, null);
  first.commit();

  const second = vm.createBlock({ timestamp: T + 1, number: 2, parentHash: first.header().hash, feeRecipient: "miner" });
  second.call(callTx(1));
  assert.equal(second.parentStateRoot, first.header().stateRoot);
  assert.equal(second.header().parentStateRoot, first.header().stateRoot);
});

test("stateRoot = trie root over the whole post-block state: the same writes on different state → different · a given parentStateRoot has no effect", () => {
  const vm = setup();
  const block = (parentStateRoot) => {
    const target = vm.createBlock({ timestamp: T, number: 9, parentStateRoot, feeRecipient: "miner" });
    target.call(callTx(0));
    return target;
  };
  assert.equal(block(null).header().stateRoot, block("0xotherchain").header().stateRoot);

  const other = setup();
  other.commit([{ type: "put", dbKey: "carol:native:received", value: "1n" }]);   // pre-block state differs by 1 key
  const a = block(null);
  const b = other.createBlock({ timestamp: T, number: 9, feeRecipient: "miner" });
  b.call(callTx(0));
  assert.equal(a.header().writesRoot, b.header().writesRoot);
  assert.notEqual(a.header().stateRoot, b.header().stateRoot);

  // after commit: the trie root in the DB = the header's stateRoot = rebuilding the trie from the whole state gives the same value
  const header = a.header();
  a.commit();
  assert.equal(vm.stateRoot(), header.stateRoot);
  assert.equal(vm.rebuildTrie().root, header.stateRoot);
  assert.equal(vm.hashHeader(vm.getBlock(9)), header.hash);   // the hash can be recomputed from the header fields
});

test("stateRoot: editing state in the DB directly (bypassing commit) → a rebuilt trie's root does not match the header · editing a trie node → getProof detects it (update does not check: it is the node's own storage)", () => {
  const vm = setup();
  let parentHash = null;
  for (let number = 1; number <= 3; number += 1) {
    const block = vm.createBlock({ timestamp: T + number, number, parentHash, feeRecipient: "miner" });
    block.call(callTx(number - 1));
    parentHash = block.header().hash;
    block.commit();
  }
  const { stateRoot } = vm.getBlock(3);
  assert.equal(vm.stateRoot(), stateRoot);

  const tampered = new VM.VirtualMachine(new MemoryDB(vm.db.snapshot()), { recordBlocks: true });
  tampered.db.writeKeys([{ type: "put", dbKey: "token:storage:balances:bob", value: "999n" }]);
  assert.notEqual(tampered.rebuildTrie().root, stateRoot);

  const broken = new VM.VirtualMachine(new MemoryDB(vm.db.snapshot()), { recordBlocks: true });
  const nodes = broken.listKeys("trie:", { limit: 1000 }).filter((key) => key !== "trie:");   // every node except the root
  assert.ok(nodes.length > 0);
  broken.db.writeKeys(nodes.map((dbKey) => { const value = broken.read(dbKey); value[5] ^= 1; return { type: "put", dbKey, value }; }));
  assert.throws(() => broken.getProof(["token:storage:balances:bob"]), /does not match the hash/);
});
