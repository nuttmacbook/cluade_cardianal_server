import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, COUNTER } from "./programs.js";

/* block hash / txRoot / stateRoot และข้อมูล block ที่เขียนลง DB */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
let endpointCounter = 0;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, recordTransactions: true, recordBlocks: true, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: user("alice"), initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  vm.db.load({ "alice:native:received": 1_000_000 });
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

test("hash: block มี hash / parentHash / txRoot / stateRoot", () => {
  const vm = setup();
  const block = buildBlock(vm, { parentHash: "0xparent" });
  const { hash, parentHash, txRoot, stateRoot } = block.hashes();

  for (const value of [hash, txRoot, stateRoot]) assert.match(value, /^0x[0-9a-f]{64}$/);
  assert.equal(parentHash, "0xparent");
  assert.equal(new Set([hash, txRoot, stateRoot]).size, 3);
  assert.deepEqual(block.receipt().hash, hash);
});

test("hash: txRoot มาจาก hash ของทุก tx เรียงตามลำดับ", () => {
  const vm = setup();
  const block = buildBlock(vm);
  assert.deepEqual(block.txHashes(), block.receipt().transactions.map((tx) => tx.hash));
  assert.equal(block.hashes().txRoot, vm.hashData(block.txHashes()));
});

test("hash: เหมือนเดิมทุกครั้งเมื่อข้อมูลเหมือนกัน", () => {
  const first = buildBlock(setup(), { parentHash: "0xp" }).hashes();
  const second = buildBlock(setup(), { parentHash: "0xp" }).hashes();
  assert.deepEqual(first, second);
});

test("hash: เปลี่ยนอะไรก็ได้ block hash ใหม่", () => {
  const base = buildBlock(setup(), { parentHash: "0xp" }).hashes().hash;
  const variants = [
    buildBlock(setup(), { parentHash: "0xp", number: 2 }),                      // เลข block
    buildBlock(setup(), { parentHash: "0xother" }),                             // parent
    buildBlock(setup(), { parentHash: "0xp", txs: [callTx(0), callTx(1, 11)] }), // เนื้อหา tx
    buildBlock(setup(), { parentHash: "0xp", txs: [callTx(0)] }),                // จำนวน tx
  ];
  const hashes = variants.map((block) => block.hashes().hash);
  assert.equal(new Set([base, ...hashes]).size, hashes.length + 1);

  const other = setup();
  const timeChanged = other.createBlock({ timestamp: T + 1, number: 1, parentHash: "0xp", feeRecipient: "miner" });
  timeChanged.call(callTx(0));
  timeChanged.call(callTx(1));
  assert.notEqual(timeChanged.hashes().hash, base); // เวลาเปลี่ยน
});

test("hash: tx ชุดเดียวกันแต่ state ต่างกัน → stateRoot ต่างกัน", () => {
  const rich = setup();
  const poor = setup();
  poor.db.load({ "token:storage:balances:alice": 5 }); // tx ที่ 2 จะล้มเพราะเงินไม่พอ

  const a = buildBlock(rich, { txs: [callTx(0), callTx(1, 10)] });
  const b = buildBlock(poor, { txs: [callTx(0), callTx(1, 10)] });
  assert.deepEqual(a.txHashes(), b.txHashes());          // hash ของ tx เท่ากัน
  assert.notEqual(a.hashes().stateRoot, b.hashes().stateRoot);
  assert.notEqual(a.hashes().hash, b.hashes().hash);
});

test("hash: ต่อกันเป็นสายด้วย parentHash", () => {
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

test("header: สรุปข้อมูลของ block", () => {
  const vm = setup();
  const block = buildBlock(vm, { number: 5, parentHash: "0xp", txs: [callTx(0), callTx(1, 99999)] });
  const header = block.header();

  assert.deepEqual(
    { ...header, hash: null, txRoot: null, stateRoot: null, txHashes: header.txHashes.length },
    {
      number: 5, hash: null, parentHash: "0xp", parentStateRoot: null, timestamp: T, feeRecipient: "miner", burnPercent: 100,
      txCount: 2, successCount: 1, failedCount: 1,
      gasUsed: block.results().reduce((sum, r) => sum + r.gasUsed, 0),
      fee: block.results().reduce((sum, r) => sum + r.fee, 0),
      txRoot: null, stateRoot: null, txHashes: 2,
    },
  );
});

test("writes: มี block:<number> / blockhash:<hash> / latestblock / tx:<hash>", () => {
  const vm = setup();
  const block = buildBlock(vm, { number: 42, parentHash: "0xp" });
  const header = block.header();
  const blockWrites = block.blockWrites();

  assert.deepEqual(blockWrites.slice(0, 4).map((w) => w.dbKey), [
    "block:000000000042", "blockbody:000000000042", `blockhash:${header.hash}`, "latestblock",
  ]);
  assert.deepEqual(blockWrites[0].value, header);
  assert.deepEqual(blockWrites[1].value.map((entry) => entry.action), ["call", "call"]); // tx ดิบ
  assert.equal(blockWrites[2].value, 42);
  assert.equal(blockWrites[3].value, 42);

  assert.deepEqual(blockWrites.slice(4).filter((w) => w.dbKey.startsWith("tx:")).map((w) => w.dbKey), header.txHashes.map((hash) => `tx:${hash}`));
  assert.deepEqual(blockWrites[4].value, {
    hash: header.txHashes[0], digest: null, blockNumber: 42, index: 0, action: "call", status: "success", from: "alice", nonce: 0,
  });

  // writes() = writes ของ tx + ข้อมูล block
  assert.deepEqual(block.writes(), [...block.stateWrites(), ...blockWrites]);
});

test("writes: commit แล้วค้นข้อมูลจาก DB ได้ทุกทาง", () => {
  const vm = setup();
  const block = buildBlock(vm, { number: 7, parentHash: "0xp", txs: [callTx(0), callTx(1, 99999)] });
  const header = block.header();
  block.commit();

  assert.deepEqual(vm.db.readKeys(["block:000000000007"])[0], header);
  assert.equal(vm.db.readKeys([`blockhash:${header.hash}`])[0], 7);
  assert.equal(vm.db.readKeys(["latestblock"])[0], 7);

  // ค้น tx จาก hash → รู้ว่าอยู่ block ไหน index ไหน แล้วไปอ่าน record เต็มของ address ต่อ
  const [okHash, failedHash] = header.txHashes;
  const found = vm.db.readKeys([`tx:${okHash}`])[0];
  assert.deepEqual(found, { hash: okHash, digest: null, blockNumber: 7, index: 0, action: "call", status: "success", from: "alice", nonce: 0 });
  assert.equal(vm.db.readKeys([`tx:${failedHash}`])[0].status, "throw");
  assert.equal(vm.db.readKeys([`alice:txn:${found.nonce}:${found.hash}`])[0].gasUsed > 0, true);
});

test("writes: หลาย block ต่อกัน — latestblock อัปเดต และ key เรียงตามเลข block", () => {
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

test("writes: ปิด recordBlocks → ไม่มีข้อมูล block ใน writes", () => {
  const off = setup({ recordBlocks: false });
  assert.deepEqual(buildBlock(off, { number: 1 }).blockWrites(), []);

  const noNumber = off.createBlock({ timestamp: T });
  noNumber.call(callTx(0));
  assert.deepEqual(noNumber.blockWrites(), []);
  assert.deepEqual(noNumber.writes(), noNumber.stateWrites());
  assert.equal(noNumber.header().number, null); // ยังคำนวณ hash ได้
});

test("chain: ไม่ส่ง number / parentHash → VM ต่อจาก block ล่าสุดให้เอง", () => {
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

test("chain: commit เลข block ซ้ำไม่ได้", () => {
  const vm = setup();
  buildBlock(vm, { number: 1, txs: [callTx(0)] }).commit();

  assert.throws(() => vm.createBlock({ timestamp: T + 1, number: 1 }), { code: "INVALID_REQUEST", message: /block 1 ถูกบันทึกไปแล้ว/ });

  // สร้างไว้ก่อนแล้วมีคนอื่น commit เลขเดียวกันก่อน → commit ไม่ผ่าน
  const pending = vm.createBlock({ timestamp: T + 2, number: 2, feeRecipient: "miner" });
  const other = vm.createBlock({ timestamp: T + 3, number: 2, feeRecipient: "miner" });
  other.call(callTx(1));
  other.commit();
  assert.throws(() => pending.commit(), { code: "INVALID_REQUEST", message: /block 2 ถูกบันทึกไปแล้ว/ });
});

test("chain: timestamp ต้องเดินหน้าเสมอ", () => {
  const vm = setup();
  buildBlock(vm, { number: 1, txs: [callTx(0)] }).commit();
  const previous = vm.getBlock(1).timestamp;

  for (const timestamp of [previous, previous - 1000]) {
    assert.throws(() => vm.createBlock({ timestamp, number: 2 }), { code: "INVALID_REQUEST", message: /timestamp ของ block ต้องมากกว่า/ });
  }
  assert.equal(vm.createBlock({ timestamp: previous + 1, number: 2 }).number, 2);
});

test("chain: ข้ามการตรวจได้ด้วย checkChain: false (ใช้ตอน replay หรือทดสอบ)", () => {
  const vm = setup();
  buildBlock(vm, { number: 1, txs: [callTx(0)] }).commit();
  const block = vm.createBlock({ timestamp: T - 5000, number: 1, checkChain: false });
  assert.equal(block.number, 1);
});


test("writes: init / reject ก็มี tx hash ใน block (แต่ไม่มี <addr>:txn)", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T, number: 9, feeRecipient: "miner" });
  block.deploy({ programUuid: "counter", code: COUNTER, context: user("alice"), initInput: { start: 1 }, nonce: 0 });
  block.init({ programUuid: "counter" });

  const header = block.header();
  assert.equal(header.txCount, 2);
  assert.equal(new Set(header.txHashes).size, 2);
  block.commit();

  const initEntry = vm.db.readKeys([`tx:${header.txHashes[1]}`])[0];
  assert.deepEqual(initEntry, { hash: header.txHashes[1], digest: null, blockNumber: 9, index: 1, action: "init", status: "success", from: null, nonce: null });
  assert.deepEqual(vm.db.listKeys("alice:txn:").length, 1); // เฉพาะ deploy
});

test("decodeDbKey: อ่าน key ของ block ออก", () => {
  assert.deepEqual(VM.decodeDbKey("block:000000000042"), { kind: "block", number: 42 });
  assert.deepEqual(VM.decodeDbKey("blockhash:0xabc"), { kind: "blockhash", hash: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("tx:0xabc"), { kind: "tx", hash: "0xabc" });
  assert.deepEqual(VM.decodeDbKey("latestblock"), { kind: "latestblock" });
});

test("receipt: มี hash ของ block และของทุก tx ครบ", () => {
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
//  stateRoot แบบสะสม
// ---------------------------------------------------------------------------

test("stateRoot: สะสมจาก block ก่อนหน้า (อ่าน parentStateRoot จาก DB ให้เอง)", () => {
  const vm = setup();
  const first = buildBlock(vm, { number: 1, txs: [callTx(0)] });
  assert.equal(first.parentStateRoot, null);
  first.commit();

  const second = vm.createBlock({ timestamp: T + 1, number: 2, parentHash: first.header().hash, feeRecipient: "miner" });
  second.call(callTx(1));
  assert.equal(second.parentStateRoot, first.header().stateRoot);
  assert.equal(second.header().parentStateRoot, first.header().stateRoot);
});

test("stateRoot: block ที่มี writes เหมือนกัน แต่ต่อจากสายคนละสาย → stateRoot ต่างกัน", () => {
  const vm = setup();
  const block = (parentStateRoot) => {
    const target = vm.createBlock({ timestamp: T, number: 9, parentStateRoot, feeRecipient: "miner" });
    target.call(callTx(0));
    return target.header().stateRoot;
  };
  assert.notEqual(block(null), block("0xสายอื่น"));
  assert.equal(block("0xเดียวกัน"), block("0xเดียวกัน"));
});

test("stateRoot: แก้ข้อมูลของ block เก่าย้อนหลัง → block ถัดไปคำนวณได้ root ใหม่ ไม่ตรงกับที่บันทึกไว้", () => {
  const vm = setup();
  let parentHash = null;
  const headers = [];
  for (let number = 1; number <= 3; number += 1) {
    const block = vm.createBlock({ timestamp: T + number, number, parentHash, feeRecipient: "miner" });
    block.call(callTx(number - 1));
    const header = block.header();
    headers.push(header);
    parentHash = header.hash;
    block.commit();
  }

  // มีคนแก้ stateRoot ของ block 1 ใน DB ตรง ๆ
  const tampered = { ...headers[0], stateRoot: "0xแก้มือ" };
  vm.db.writeKeys([{ type: "put", dbKey: "block:000000000001", value: tampered }]);

  // คำนวณ block 2 ใหม่จากสายที่ถูกแก้ → ได้ stateRoot คนละค่ากับที่บันทึกไว้
  const recomputed = vm.hashBlock({
    number: 2, parentHash: headers[0].hash, parentStateRoot: tampered.stateRoot,
    timestamp: headers[1].timestamp, feeRecipient: "miner", burnPercent: 100,
    txHashes: headers[1].txHashes, writes: [],
  });
  assert.notEqual(recomputed.stateRoot, headers[1].stateRoot);
});
