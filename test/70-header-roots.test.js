import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { applyBlock } from "../src/node/sync.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * receiptsRoot + logsBloom ใน header ของ block (คำนวณจากผลของทุก tx ใน block · อยู่ใน hash)
 *   replay / rebuild / sync รันใหม่แล้วต้องได้ค่าเดิม · /evm ใช้ค่าจาก header ตรง ๆ
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
    b.call({ programUuid: TOKEN, functionName: "transfer", input: { to: BOB, amount: "99999n" }, context: as(OWNER) });   // ล้ม → ไม่มี log
  }, 2);
  mine(() => {}, 3);
  return { vm, blocks };
}

test("header: receiptsRoot = hash ของ receipt ย่อทุกใบ · logsBloom = bloom ของ log ทุกใบ (block ว่าง = bloom ศูนย์)", () => {
  const { vm } = chain();
  const header = vm.getBlock(2);
  assert.match(header.receiptsRoot, /^0x[0-9a-f]{64}$/);
  assert.match(header.logsBloom, /^0x[0-9a-f]{512}$/);
  const entries = vm.replayBlock(2).transactions;
  assert.deepEqual(entries.map((tx) => tx.status), ["success", "throw"]);
  // receipt ย่อ: ผล / แก๊ส / แก๊สสะสม / ราคาจริง / ค่าแก๊ส / error / log
  const logs = entries[0].events.map(VM.eventLog);
  assert.equal(header.logsBloom, VM.logsBloom(logs));
  assert.ok(VM.bloomContains(header.logsBloom, TOKEN));
  assert.ok(VM.bloomContains(header.logsBloom, VM.topicOf(BOB)));
  assert.equal(VM.bloomContains(header.logsBloom, VM.topicOf("0x00000000000000000000000000000000000000c3")), false);
  assert.equal(vm.getBlock(3).logsBloom, `0x${"0".repeat(512)}`);
  assert.notEqual(vm.getBlock(3).receiptsRoot, header.receiptsRoot);
});

test("header: receiptsRoot / logsBloom อยู่ใน hash ของ block — แก้ค่าใดค่าหนึ่ง hash เปลี่ยน", () => {
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

test("replay / rebuild: รัน block เดิมใหม่ได้ receiptsRoot / logsBloom / hash เดิม", () => {
  const { vm } = chain();
  const before = vm.getBlock(2);
  const replay = vm.replayBlock(2);
  assert.deepEqual([replay.hash, replay.receiptsRoot, replay.logsBloom], [before.hash, before.receiptsRoot, before.logsBloom]);
  vm.rebuildFrom(3);
  assert.deepEqual([vm.getBlock(2).receiptsRoot, vm.getBlock(2).hash], [before.receiptsRoot, before.hash]);
});

test("sync: ผู้ซิงก์รันเองแล้วเทียบ hash (ที่รวม receiptsRoot / logsBloom) · ผู้ผลิตปลอม receipt → หยุด", () => {
  const { blocks } = chain();
  const follower = new VM.VirtualMachine(new MemoryDB(), options);
  for (const item of blocks) applyBlock(follower, item);
  assert.equal(follower.getBlock(2).receiptsRoot, blocks[1].header.receiptsRoot);

  // header ที่อ้างว่า log ต่างไป (bloom ปลอม + hash ใหม่ที่คำนวณเอง) → hash ของเราไม่ตรง
  const other = new VM.VirtualMachine(new MemoryDB(), options);
  applyBlock(other, blocks[0]);
  const fake = { ...blocks[1].header, logsBloom: `0x${"f".repeat(512)}` };
  fake.hash = other.hashBlock({ ...fake, writes: [] }).hash;
  assert.throws(() => applyBlock(other, { ...blocks[1], header: fake }), /ไม่ตรงกับผู้ผลิต/);
});

test("/evm: logsBloom / receiptsRoot / baseFeePerGas ของ block มาจาก header", () => {
  const { vm } = chain();
  const rpc = createEvmRpc({ vm });
  const reply = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["0x2", false] }).result;
  const header = vm.getBlock(2);
  assert.deepEqual([reply.logsBloom, reply.receiptsRoot, reply.baseFeePerGas], [header.logsBloom, header.receiptsRoot, "0x1"]);
  // bloom ของ header = OR ของ bloom ทุก receipt
  const receipts = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getBlockReceipts", params: ["0x2"] }).result;
  assert.equal(receipts[0].logsBloom, header.logsBloom);
  assert.equal(receipts[1].logs.length, 0);
});
