import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { applyBlock } from "../src/node/sync.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * receiptsRoot + logsBloom in the block header (computed from every tx result in the block · part of the hash)
 *   replay / rebuild / sync must reproduce the same values · /evm uses the header values directly
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const TOKEN = "0x00000000000000000000000000000000000000f1";
const as = (who) => ({ sender: who, origin: who });
const options = { recordBlocks: true, recordTransactions: true, recordHistory: true };

function chain(vm = new VM.VirtualMachine(new MemoryDB(), options)) {
  const blocks = [];
  const mine = (fn, number) => {
    const block = vm.createBlock({ number, timestamp: T + number * 1000, feeRecipient: OWNER });
    fn(block);
    const header = block.header();
    blocks.push({ header, body: block.body(), rejected: block.rejectedTransactions() });
    block.commit();
    return { block, header };
  };
  mine((b) => {
    b.deploy({ programUuid: TOKEN, code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Coin", ticker: "C", decimals: "0n", supply: "1000n" } });
    b.init({ programUuid: TOKEN });
  }, 1);
  mine((b) => {
    b.call({ programUuid: TOKEN, functionName: "transfer", input: { to: BOB, amount: "5n" }, context: as(OWNER) });
    b.call({ programUuid: TOKEN, functionName: "transfer", input: { to: BOB, amount: "99999n" }, context: as(OWNER) });   // fails → no log
  }, 2);
  mine(() => {}, 3);
  return { vm, blocks };
}

test("header: receiptsRoot = hash of every compact receipt · logsBloom = bloom of every log (empty block = zero bloom)", () => {
  const { vm } = chain();
  const header = vm.getBlock(2);
  assert.match(header.receiptsRoot, /^0x[0-9a-f]{64}$/);
  assert.match(header.logsBloom, /^0x[0-9a-f]{512}$/);
  const entries = vm.replayBlock(2).transactions;
  assert.deepEqual(entries.map((tx) => tx.status), ["success", "throw"]);
  // compact receipt: result / gas / cumulative gas / effective price / fee / error / logs
  const logs = entries[0].events.map(VM.eventLog);
  assert.equal(header.logsBloom, VM.logsBloom(logs));
  assert.ok(VM.bloomContains(header.logsBloom, TOKEN));
  assert.ok(VM.bloomContains(header.logsBloom, VM.topicOf(BOB)));
  assert.equal(VM.bloomContains(header.logsBloom, VM.topicOf("0x00000000000000000000000000000000000000c3")), false);
  assert.equal(vm.getBlock(3).logsBloom, `0x${"0".repeat(512)}`);
  assert.notEqual(vm.getBlock(3).receiptsRoot, header.receiptsRoot);
});

test("header: receiptsRoot / logsBloom are in the block hash: changing either changes the hash", () => {
  const { vm } = chain();
  const h = vm.getBlock(2);
  const fields = {
    number: 2, parentHash: h.parentHash, parentStateRoot: h.parentStateRoot, timestamp: h.timestamp, feeRecipient: h.feeRecipient,
    burnPercent: h.burnPercent, txHashes: h.txHashes, writes: [], baseFeePerGas: h.baseFeePerGas, gasUsed: h.gasUsed,
    receiptsRoot: h.receiptsRoot, logsBloom: h.logsBloom,
  };
  const base = vm.hashBlock(fields).hash;
  assert.notEqual(vm.hashBlock({ ...fields, receiptsRoot: `0x${"1".repeat(64)}` }).hash, base);
  assert.notEqual(vm.hashBlock({ ...fields, logsBloom: `0x${"0".repeat(512)}` }).hash, base);
});

test("replay / rebuild: re-running a block gives the same receiptsRoot / logsBloom / hash", () => {
  const { vm } = chain();
  const before = vm.getBlock(2);
  const replay = vm.replayBlock(2);
  assert.deepEqual([replay.hash, replay.receiptsRoot, replay.logsBloom], [before.hash, before.receiptsRoot, before.logsBloom]);
  vm.rebuildFrom(3);
  assert.deepEqual([vm.getBlock(2).receiptsRoot, vm.getBlock(2).hash], [before.receiptsRoot, before.hash]);
});

test("sync: the syncer runs blocks itself and compares hashes (including receiptsRoot / logsBloom) · a producer faking receipts → stop", () => {
  const { blocks } = chain();
  const follower = new VM.VirtualMachine(new MemoryDB(), options);
  for (const item of blocks) applyBlock(follower, item);
  assert.equal(follower.getBlock(2).receiptsRoot, blocks[1].header.receiptsRoot);

  // a header claiming different logs (fake bloom + a self-computed new hash) → our hash does not match
  const other = new VM.VirtualMachine(new MemoryDB(), options);
  applyBlock(other, blocks[0]);
  const fake = { ...blocks[1].header, logsBloom: `0x${"f".repeat(512)}` };
  fake.hash = other.hashBlock({ ...fake, writes: [] }).hash;
  assert.throws(() => applyBlock(other, { ...blocks[1], header: fake }), /does not match the producer/);
});

test("/evm: logsBloom / receiptsRoot / baseFeePerGas of a block come from the header", () => {
  const { vm } = chain();
  const rpc = createEvmRpc({ vm });
  const reply = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x2", false] }).result;
  const header = vm.getBlock(2);
  assert.deepEqual([reply.logsBloom, reply.receiptsRoot, reply.baseFeePerGas], [header.logsBloom, header.receiptsRoot, "0x1"]);
  // header bloom = OR of every receipt bloom
  const receipts = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getBlockReceipts", params: ["0x2"] }).result;
  assert.equal(receipts[0].logsBloom, header.logsBloom);
  assert.equal(receipts[1].logs.length, 0);
});
