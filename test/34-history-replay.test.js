import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN, COUNTER } from "./programs.js";

/*
 * history:<key>:<block> + blockundo:<block>
 *   - stateAt      a key's value at any block (single seek)
 *   - replayBlock  full receipts of old blocks without touching the real DB
 *   - rebuildFrom  recovers the system by re-running blocks from their bodies
 *   - sigtx        look up txs by the user-signed hash too
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const OPTIONS = {
  requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, recordHistory: true,
  gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 },
};

/** 5-block chain: deploy+init, then one token transfer per block */
function buildChain(vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS)) {
  vm.db.load({ "alice:native:received": "1000000n" });

  const first = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  first.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, nonce: 0 });
  first.init({ programUuid: "token" });
  first.commit();

  for (let i = 0; i < 4; i += 1) {
    const block = vm.createBlock({ timestamp: T + (i + 1) * 1000, feeRecipient: "miner" });
    block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 10 }, context: user("alice"), nonce: i + 1 });
    block.commit();
  }
  return vm;
}

const BALANCE = "token:storage:balances:alice";

// ---------------------------------------------------------------------------
//  recording history
// ---------------------------------------------------------------------------

test("history: stores the previous value of every key a block touches", () => {
  const vm = buildChain();
  const undo = vm.getBlockUndo(3);

  assert.ok(undo.includes(BALANCE));
  assert.ok(undo.includes("alice:nonce"));
  assert.equal(undo.some((key) => key.startsWith("block:")), false); // chain data itself need not be stored
  assert.deepEqual(vm.db.readKeys([`history:${BALANCE}:000000000003`])[0], { existed: true, before: "990n" });
  assert.deepEqual(vm.db.readKeys(["history:alice:nonce:000000000001"])[0], { existed: false }); // just created in block 1
});

test("history: recordHistory off → none of these keys", () => {
  const vm = buildChain(new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, recordHistory: false }));
  assert.equal(vm.getBlockUndo(1), null);
  assert.deepEqual(vm.db.listKeys("history:"), []);
});

// ---------------------------------------------------------------------------
//  stateAt
// ---------------------------------------------------------------------------

test("stateAt: a key's historical value at every block", () => {
  const vm = buildChain();
  assert.deepEqual([0, 1, 2, 3, 4, 5].map((n) => vm.stateAt(n, BALANCE)), [undefined, "1000n", "990n", "980n", "970n", "960n"]);
  assert.equal(vm.db.readKeys([BALANCE])[0], "960n");
});

test("stateAt: keys just created / deleted / never touched", () => {
  const vm = buildChain();
  assert.equal(vm.stateAt(0, "alice:nonce"), undefined);   // not present yet at block 0
  assert.equal(vm.stateAt(1, "alice:nonce"), 1);
  assert.equal(vm.stateAt(5, "alice:nonce"), 5);

  assert.equal(vm.stateAt(2, "untouched"), undefined);
  vm.db.load({ "offchain": 7 });
  assert.equal(vm.stateAt(2, "offchain"), 7);            // not in history → current value

  // deleted key: pending was deleted at init (block 1)
  assert.deepEqual(vm.stateAt(0, "pending:token"), undefined);
  assert.equal(vm.stateAt(1, "pending:token"), undefined);
});

test("stateAt: key prefixes do not collide", () => {
  const vm = buildChain();
  assert.equal(vm.stateAt(2, "alice"), undefined);           // not alice:nonce
  assert.equal(vm.stateAt(2, "alice:nonce"), 2);
});

test("stateAt: constant cost — the same number of DB reads no matter how far back", () => {
  const vm = buildChain();
  for (let i = 0; i < 30; i += 1) {   // extend the chain by 30 more blocks
    const block = vm.createBlock({ timestamp: T + 100_000 + i * 1000, feeRecipient: "miner" });
    block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 5 + i });
    block.commit();
  }

  const counted = { reads: 0 };
  const original = vm.db.readKeys.bind(vm.db);
  vm.db.readKeys = (keys) => { counted.reads += keys.length; return original(keys); };

  counted.reads = 0;
  vm.stateAt(34, BALANCE);
  const near = counted.reads;
  counted.reads = 0;
  vm.stateAt(1, BALANCE);
  const far = counted.reads;

  vm.db.readKeys = original;
  assert.equal(near, far, "near and far lookbacks must read the same amount");
  assert.ok(far <= 3, `${far} reads`);
});

test("snapshotAt: view a program's data at an old block", () => {
  const vm = buildChain();
  assert.deepEqual(vm.snapshotAt(2, "token:storage:"), {
    "token:storage:balances:alice": "990n",
    "token:storage:balances:bob": "10n",
    "token:storage:owner": "alice",
    "token:storage:totalSupply": "1000n",
  });
  assert.deepEqual(vm.snapshotAt(0, "token:storage:"), {});
});

// ---------------------------------------------------------------------------
//  replayBlock
// ---------------------------------------------------------------------------

test("replayBlock: returns the full receipts of an old block, and the real DB is unchanged", () => {
  const vm = buildChain();
  const before = vm.db.snapshot();
  const receipt = vm.replayBlock(2);

  assert.equal(receipt.number, 2);
  assert.equal(receipt.hash, vm.getBlock(2).hash);
  assert.equal(receipt.txCount, 1);
  assert.deepEqual(receipt.transactions[0].stateChanges, [
    { program: "token", key: ["balances", "alice"], after: "990n" },
    { program: "token", key: ["balances", "bob"], after: "10n" },
  ]);
  assert.deepEqual(receipt.transactions[0].trace[0].method, "transfer");
  assert.deepEqual(receipt.transactions[0].result, { from: "alice", to: "bob", amount: "10n" });
  assert.deepEqual(vm.db.snapshot(), before);
});

test("replayBlock: the first block with deploy + init can be replayed too", () => {
  const vm = buildChain();
  const receipt = vm.replayBlock(1);
  assert.deepEqual(receipt.transactions.map((tx) => tx.action), ["deploy", "init"]);
  assert.equal(receipt.transactions[0].input, null);
  assert.equal(receipt.hash, vm.getBlock(1).hash);
});

test("replayBlock: every block in the chain replays and every hash matches", () => {
  const vm = buildChain();
  for (let number = 1; number <= vm.latestBlockNumber(); number += 1) {
    assert.equal(vm.replayBlock(number).hash, vm.getBlock(number).hash, `block ${number}`);
  }
});

test("replayBlock: corrupted data → detected", () => {
  const vm = buildChain();
  vm.db.writeKeys([{ type: "put", dbKey: `history:${BALANCE}:000000000003`, value: { existed: true, before: 9999 } }]);
  assert.throws(() => vm.replayBlock(3), { code: "INTERNAL", message: /hash that does not match/ });
  assert.equal(vm.replayBlock(3, { verify: false }).number, 3); // turn off verification to see where it diverges
});

test("replayBlock: missing block → NOT_FOUND", () => {
  const vm = buildChain();
  assert.throws(() => vm.replayBlock(99), { code: "NOT_FOUND" });
});

// ---------------------------------------------------------------------------
//  rebuildFrom
// ---------------------------------------------------------------------------

test("rebuildFrom: rolls the whole system back to block 2 and the state matches exactly", () => {
  const vm = buildChain();
  // indexes have no history (rebuilt from blocks) → compare state only · indexes are checked in the next test
  // trie nodes have no history (only the latest is kept) → check via stateRoot instead
  const stateKeys = (snapshot) => Object.fromEntries(Object.entries(snapshot).filter(([key]) => VM.isStateKey(key)));
  const expected = stateKeys(vm.snapshotAt(2));
  const stateRoot = vm.getBlock(2).stateRoot;

  const result = vm.rebuildFrom(2);
  assert.deepEqual({ from: result.from, to: result.to, blocks: result.blocks }, { from: 5, to: 2, blocks: 2 });
  assert.equal(result.stateRoot, stateRoot);
  assert.equal(vm.stateRoot(), stateRoot);   // the trie is rolled back along with the state

  assert.equal(vm.latestBlockNumber(), 2);
  assert.equal(vm.db.readKeys([BALANCE])[0], "990n");
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], 2);
  assert.equal(vm.getBlock(3), null);
  assert.equal(vm.getBlockBody(3), null);
  assert.deepEqual(vm.db.listKeys("history:").filter((key) => key.endsWith("000000000004")), []);
  assert.deepEqual(stateKeys(vm.db.snapshot()), expected);
});

test("rebuildFrom: explorer indexes are rolled back too", () => {
  const vm = buildChain();
  const discarded = vm.getBlock(4).txHashes[0];
  const kept = vm.getBlock(2).txHashes[0];

  vm.rebuildFrom(2);
  assert.equal(vm.getTransaction(discarded), null);         // txs of discarded blocks are gone
  assert.equal(vm.getTransaction(kept).blockNumber, 2);
  assert.deepEqual(vm.listTransactionsOf("alice").map((tx) => tx.nonce), [1, 0]);
  assert.equal(vm.db.listKeys("blockhash:").length, 2);
});

test("rebuildFrom: can continue after rolling back, with correct parentHash links", () => {
  const vm = buildChain();
  vm.rebuildFrom(2);

  const block = vm.createBlock({ timestamp: T + 9000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "carol", amount: 5 }, context: user("alice"), nonce: 2 });
  block.commit();

  assert.equal(vm.latestBlockNumber(), 3);
  assert.equal(vm.getBlock(3).parentHash, vm.getBlock(2).hash);
  assert.equal(vm.getBlock(3).parentStateRoot, vm.getBlock(2).stateRoot);
  assert.equal(vm.db.readKeys(["token:storage:balances:carol"])[0], "5n");
});

test("rebuildFrom: rolling back to 0 = clears every block's effects, but off-chain data remains", () => {
  const vm = buildChain();
  vm.db.load({ "offchain": "still here" });
  vm.rebuildFrom(0);

  assert.equal(vm.latestBlockNumber(), null);
  assert.equal(vm.db.readKeys([BALANCE])[0], undefined);
  assert.equal(vm.db.readKeys(["token:code"])[0], undefined);
  assert.equal(vm.db.readKeys(["alice:nonce"])[0], undefined);
  assert.equal(vm.db.readKeys(["offchain"])[0], "still here");
  assert.equal(vm.nativeBalanceOf("alice").balance, 1_000_000n); // genesis is restored
});

test("rebuildFrom: re-running to the same point gives the same result every time", () => {
  const first = buildChain();
  first.rebuildFrom(3);
  const second = buildChain();
  second.rebuildFrom(3);
  assert.deepEqual(first.db.snapshot(), second.db.snapshot());

  first.rebuildFrom(3); // once more
  assert.deepEqual(first.db.snapshot(), second.db.snapshot());
});

test("rebuildFrom: invalid block number → NOT_FOUND", () => {
  const vm = buildChain();
  for (const target of [6, -1, 1.5]) assert.throws(() => vm.rebuildFrom(target), { code: "NOT_FOUND" });
});

// ---------------------------------------------------------------------------
//  looking up txs by the user-signed hash
// ---------------------------------------------------------------------------

test("sigtx: finds txs by both the system hash and the user-signed hash", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), OPTIONS);
  const key = sign.randomPrivateKey();
  const alice = sign.addressOf(key);
  vm.db.load({ [`${alice}:native:received`]: "1000000n" });

  const tx = { chainId: 1, action: "transfer", from: alice, to: "0xbob", method: "", input: {}, value: 100, nonce: 0, gasLimit: 0, gasPrice: 0 };
  const verified = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block[verified.method](verified.request);
  block.commit();

  const vmHash = vm.getBlock(1).txHashes[0];
  assert.notEqual(vmHash, verified.hash);                          // different values
  assert.equal(vm.db.readKeys([`sigtx:${verified.hash}`])[0], vmHash);
  assert.deepEqual(vm.getTransaction(verified.hash), vm.getTransaction(vmHash)); // both lookups work
  assert.equal(vm.getTransaction(verified.hash).digest, verified.hash);
  assert.equal(vm.listTransactionsOf(alice)[0].digest, verified.hash);
});

test("sigtx: unsigned tx → no such index, lookup by the system hash as usual", () => {
  const vm = buildChain();
  const hash = vm.getBlock(2).txHashes[0];
  assert.equal(vm.getTransaction(hash).digest, null);
  assert.deepEqual(vm.db.listKeys("sigtx:"), []);
});

test("replayBlock: no history for newer blocks → says plainly it cannot replay (not a hash mismatch)", () => {
  const vm = buildChain(new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, recordHistory: false }));
  assert.throws(() => vm.replayBlock(1), { code: "NOT_FOUND", message: /recordHistory/ });

  // history enabled later → old blocks without undo still cannot be replayed
  vm.recordHistory = true;
  const block = vm.createBlock({ timestamp: T + 100_000, feeRecipient: "miner" });
  block.call({ programUuid: "token", functionName: "transfer", input: { to: "bob", amount: 1 }, context: user("alice"), nonce: 5 });
  block.commit();
  assert.throws(() => vm.replayBlock(2), { code: "NOT_FOUND" });
  assert.equal(vm.replayBlock(vm.latestBlockNumber()).number, vm.latestBlockNumber()); // the latest block, with full undo, replays
});
