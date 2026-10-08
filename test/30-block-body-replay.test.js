import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, COUNTER } from "./programs.js";

/*
 * blockbody:<number> เก็บ tx ดิบของทุกใบใน block
 * → node อีกเครื่องดึง block ไป replay แล้วได้ state เดียวกันทุกตัวอักษร (รวมโค้ดของโปรแกรมที่ deploy)
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, deriveProgramAddress: true, gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 } };

const newVm = () => new VM.VirtualMachine(new MemoryDB(), OPTIONS);

/** สร้างสาย block: block 1 deploy+init, block 2 โอนเงิน */
function buildChain(vm) {
  vm.db.load({ "alice:native:received": 1_000_000 });

  const first = vm.createBlock({ timestamp: T, number: 1, parentHash: null, feeRecipient: "miner", burnPercent: 50 });
  first.deploy({ code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, metadata: { namespace: "coin" }, nonce: 0 });
  const token = first.results()[0].result.programUuid;
  first.init({ programUuid: token });
  first.setMetadata({ metadata: { namespace: "alice" }, context: user("alice"), nonce: 1 });
  first.commit();

  const second = vm.createBlock({ timestamp: T + 5000, number: 2, parentHash: vm.getBlock(1).hash, feeRecipient: "miner", burnPercent: 50 });
  second.call({ programUuid: token, functionName: "transfer", input: { to: "bob", amount: 300 }, context: user("alice"), nonce: 2 });
  second.call({ programUuid: token, functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 3 }); // ล้ม
  second.transfer({ from: "alice", to: "carol", amount: 250, nonce: 4 });
  second.commit();

  return token;
}

/** node อีกเครื่อง: รัน block ที่ดึงมาใหม่ทั้งหมด */
function replay(source, target) {
  for (let number = 1; number <= source.latestBlockNumber(); number += 1) {
    const header = source.getBlock(number);
    const body = source.getBlockBody(number);

    const block = target.createBlock({
      number: header.number,
      parentHash: header.parentHash,
      timestamp: header.timestamp,
      feeRecipient: header.feeRecipient,
      burnPercent: header.burnPercent,
    });
    for (const { method, request } of body) block[method](request);

    assert.equal(block.header().hash, header.hash, `block ${number} hash ไม่ตรง`);
    block.commit();
  }
}

test("body: ถูกเก็บลง blockbody:<number> พร้อมโค้ดของโปรแกรม", () => {
  const vm = newVm();
  buildChain(vm);

  const body = vm.getBlockBody(1);
  assert.deepEqual(body.map((entry) => entry.action), ["deploy", "init", "metadata"]);
  assert.deepEqual(body.map((entry) => entry.method), ["deploy", "init", "setMetadata"]);
  assert.equal(body[0].request.code, TOKEN);                   // โค้ดเต็มอยู่ใน block
  assert.deepEqual(body[0].request.metadata, { namespace: "coin" });
  assert.equal(vm.getBlockBody(2).length, 3);
  assert.equal(vm.getBlockBody(99), null);
});

test("replay: node ใหม่รัน block ที่ดึงมา แล้วได้ state เหมือนกันทั้งหมด", () => {
  const source = newVm();
  const token = buildChain(source);

  const target = newVm();
  target.db.load({ "alice:native:received": 1_000_000 }); // ยอดตั้งต้น (genesis) ต้องเท่ากัน
  replay(source, target);

  assert.deepEqual(target.db.snapshot(), source.db.snapshot());
  assert.equal(target.getBlock(2).stateRoot, source.getBlock(2).stateRoot);
  assert.equal(target.db.readKeys([`${token}:code`])[0], source.db.readKeys([`${token}:code`])[0]);
  assert.deepEqual(target.getMetadata(token), source.getMetadata(token));
  assert.deepEqual(target.nativeBalanceOf("alice"), source.nativeBalanceOf("alice"));
  assert.equal(target.resolveNamespace("alice"), "alice");
});

test("replay: address ของโปรแกรมที่ VM คำนวณเอง ออกมาเท่ากันทั้งสองเครื่อง", () => {
  const source = newVm();
  const token = buildChain(source);

  const target = newVm();
  target.db.load({ "alice:native:received": 1_000_000 });
  replay(source, target);

  assert.match(token, /^0x[0-9a-f]{40}$/);
  assert.equal(target.getBlockBody(1)[1].request.programUuid, token); // init อ้าง address เดียวกัน
  assert.equal(target.db.readKeys([`${token}:this`])[0], token);
});

test("replay: ถ้าข้อมูลตั้งต้นต่างกัน → hash ไม่ตรงและหยุดทันที", () => {
  const source = newVm();
  buildChain(source);

  const target = newVm();
  target.db.load({ "alice:native:received": 999 }); // genesis ผิด
  // stateRoot คิดจาก writes ของ block จึงจับได้ตอนที่ยอดเงินเริ่มทำให้ผลต่างกัน (block 2)
  assert.throws(() => replay(source, target), /hash ไม่ตรง/);
});

test("replay: block body พอสำหรับสร้าง explorer ใหม่ทั้งหมด", () => {
  const source = newVm();
  buildChain(source);
  const target = newVm();
  target.db.load({ "alice:native:received": 1_000_000 });
  replay(source, target);

  assert.deepEqual(target.listTransactionsOf("alice").map((tx) => tx.nonce), [4, 3, 2, 1, 0]);
  assert.deepEqual(
    target.getBlock(2).txHashes.map((hash) => target.getTransaction(hash).status),
    source.getBlock(2).txHashes.map((hash) => source.getTransaction(hash).status),
  );
});

test("deploy ที่รันนอก block จะไม่มีใน blockbody (ต้องเรียกผ่าน block เสมอ)", () => {
  const vm = newVm();
  vm.db.load({ "alice:native:received": 1_000_000 });

  vm.commit(vm.deploy({ code: COUNTER, context: user("alice"), nonce: 0 }, { timestamp: T }).writes); // นอก block
  const block = vm.createBlock({ timestamp: T, number: 1, feeRecipient: "miner" });
  block.commit();

  assert.deepEqual(vm.getBlockBody(1), []);      // block ว่าง
  assert.equal(vm.latestBlockNumber(), 1);
  assert.equal(vm.listTransactionsOf("alice").length, 1); // มีแต่ใน <addr>:txn เท่านั้น
});
