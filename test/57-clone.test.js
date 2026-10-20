import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { review } from "../src/core/autoreview.js";
import { PROGRAM_API } from "../src/core/autoreview.js";
import { approvedProgramAddresses } from "../src/node/explorer-api.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * cloneProgram(template, initInput, { salt, value }) → address ใหม่ (decision 9–11)
 *   - template ต้องเป็นโปรแกรมที่อนุมัติแล้ว · address = hash(chainId + factory + salt + keccak256(code)) แบบ CREATE2
 *   - copy โค้ดไปที่ address ใหม่ แล้วรัน initialization ทันทีใน tx เดียวกัน (sender = factory) · value โอนจาก factory
 *   - metadata: type program, creator = factory, template = ต้นแบบ · อนุมัติทันที
 *   - trace: call ชนิด "create" (explorer / callTracer = CREATE) · ล้มที่ไหน ย้อนทั้งหมด
 */

const T = Date.parse("2026-04-01T00:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const TEMPLATE = "0x00000000000000000000000000000000000000e1";
const FACTORY = "0x00000000000000000000000000000000000000f1";
const OUTER = "0x00000000000000000000000000000000000000c1";

const WALLET = `function program() {
  function initialization(params) {
    if (!params.input.owner) return   // ตัวต้นแบบเอง (deploy ตรง) ไม่มีเจ้าของ
    writeDB("owner", params.input.owner)
    writeDB("factory", params.context.sender)
    writeDB("funded", params.value)
    if (params.input.fail) throw new Error("init ล้ม")
  }
  function info() {
    return { owner: readDB("owner"), factory: readDB("factory"), funded: readDB("funded"), balance: ThisBalance(), self: ThisAddress() }
  }
  return { info }
}`;

const PLAIN = `function program() {
  function hello() { return "hi" }
  return { hello }
}`;

const FACTORY_CODE = `function program() {
  function make(params) {
    const address = cloneProgram(params.input.template, { owner: params.input.owner, fail: params.input.fail || false },
      { salt: params.input.salt, value: params.input.value || 0n })
    writeDB(map("made", params.input.salt), address)
    emit("Created", { address })
    return address
  }
  function makeThenFail(params) {
    cloneProgram(params.input.template, { owner: params.input.owner }, { salt: params.input.salt })
    throw new Error("ล้มหลัง clone")
  }
  function nested(params) {
    return runProgram(ThisAddress(), "make", params.input)
  }
  return { make, makeThenFail, nested }
}`;

const OUTER_CODE = `function program() {
  function go(params) {
    try {
      runProgram(params.input.factory, "makeThenFail", params.input)
    } catch (e) {
      writeDB("caught", e.message)
    }
    return "done"
  }
  return { go }
}`;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, recordBlocks: true, recordHistory: true, recordTransactions: true, ...options });
  vm.db.load({ [VM.nativeKey("alice", "received")]: "1000n" });
  let time = T;
  const block = (fn) => {
    time += 1000;
    const b = vm.createBlock({ timestamp: time });
    const out = fn(b);
    b.commit();
    return { b, out };
  };
  const ok = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return res;
  };
  block((b) => {
    for (const [programUuid, code] of [[TEMPLATE, WALLET], [FACTORY, FACTORY_CODE], [OUTER, OUTER_CODE]]) {
      ok(b.deploy({ programUuid, code, context: user("alice") }));
      ok(b.init({ programUuid }));
    }
  });
  const call = (programUuid, functionName, input = {}, extra = {}) =>
    block((b) => b.call({ programUuid, functionName, input, context: user("alice"), ...extra })).out;
  const make = (input) => call(FACTORY, "make", { template: TEMPLATE, owner: "bob", ...input });
  return { vm, block, ok, call, make };
}

test("clone: สร้างโปรแกรมใหม่จากต้นแบบ → copy โค้ด, รัน initialization (sender = factory), อนุมัติทันที", () => {
  const t = setup();
  const res = t.ok(t.make({ salt: "one" }));
  const clone = res.result;
  assert.match(clone, /^0x[0-9a-f]{40}$/);

  assert.equal(t.vm.read(VM.codeKey(clone)), t.vm.read(VM.codeKey(TEMPLATE)));
  assert.deepEqual(t.vm.read(VM.contextKey(clone)), { sender: FACTORY, origin: "alice" });
  assert.equal(t.vm.read(VM.thisKey(clone)), clone);
  assert.deepEqual(t.vm.getMetadata(clone), { type: "program", creator: FACTORY, createdAt: res.timestamp, template: TEMPLATE });
  assert.equal(t.vm.read(VM.pendingKey(clone)), undefined);
  assert.ok(approvedProgramAddresses(t.vm).includes(clone), "นับเป็นโปรแกรมที่อนุมัติแล้วใน explorer");

  const info = t.ok(t.call(clone, "info")).result;
  assert.deepEqual(info, { owner: "bob", factory: FACTORY, funded: "0n", balance: "0n", self: clone });
  assert.equal(t.vm.read(VM.storageKey(FACTORY, VM.map("made", "one"))), clone);
  assert.deepEqual(res.events.map((e) => [e.program, e.name, e.data.address]), [[FACTORY, "Created", clone]]);
  // clone แก้ไม่ได้ (ไม่มี upgrader) และ template ไม่ถูกแตะ
  assert.equal(t.vm.read(VM.metadataKey(clone, "upgrader")), undefined);
  assert.equal(t.vm.read(VM.storageKey(TEMPLATE, "owner")), undefined);
});

test("clone: address แบบ CREATE2 รู้ได้ก่อนสร้าง · salt ต่างกัน address ต่างกัน · factory ต่างกัน address ต่างกัน", () => {
  const t = setup();
  const code = t.vm.read(VM.codeKey(TEMPLATE));
  const predicted = t.vm.cloneAddressFor(FACTORY, "salt-a", code);
  assert.equal(predicted, VM.addressFromHash(t.vm.hashData({ chainId: 1, factory: FACTORY, salt: "salt-a", codeHash: VM.keccak256Hex(code) })));
  assert.equal(t.ok(t.make({ salt: "salt-a" })).result, predicted);
  const other = t.ok(t.make({ salt: "salt-b" })).result;
  assert.notEqual(other, predicted);
  assert.notEqual(t.vm.cloneAddressFor(OUTER, "salt-a", code), predicted);
  // salt เป็น BigInt ก็ได้ (ใช้ค่าตัวเลขเป็น string)
  assert.equal(t.ok(t.make({ salt: "7n" })).result, t.vm.cloneAddressFor(FACTORY, "7", code));
  // ข้อมูลเดิม → ผลเดิมทุกเครื่อง
  assert.equal(setup().vm.cloneAddressFor(FACTORY, "salt-a", code), predicted);
});

test("clone: salt ซ้ำ → error (address มีอยู่แล้ว) · salt ว่างไม่ได้", () => {
  const t = setup();
  t.ok(t.make({ salt: "dup" }));
  const again = t.make({ salt: "dup" });
  assert.deepEqual([again.status, again.error.code], ["throw", "INVALID_REQUEST"]);
  assert.match(again.error.message, /ถูกใช้แล้ว/);
  const empty = t.make({ salt: "" });
  assert.match(empty.error.message, /salt/);
});

test("clone: ต้นแบบที่ยังรออนุมัติ / ถูกปฏิเสธ / ไม่มีอยู่ → error", () => {
  const t = setup();
  t.block((b) => {
    t.ok(b.deploy({ programUuid: "waiting", code: WALLET, context: user("alice") }));
    t.ok(b.deploy({ programUuid: "nope", code: WALLET, context: user("alice") }));
    t.ok(b.reject({ programUuid: "nope" }));
  });
  for (const template of ["waiting", "nope", "0x0000000000000000000000000000000000000999"]) {
    const res = t.make({ template, salt: template });
    assert.deepEqual([res.status, res.error.code], ["throw", "NOT_FOUND"], template);
    assert.match(res.error.message, /ต้นแบบ/);
  }
});

test("clone: initialization ล้ม → ย้อนทั้งหมด (ไม่มีโปรแกรมใหม่ ไม่มีเงินย้าย)", () => {
  const t = setup();
  t.ok(t.block((b) => b.transfer({ from: "alice", to: FACTORY, amount: 100 })).out);
  const code = t.vm.read(VM.codeKey(TEMPLATE));
  const address = t.vm.cloneAddressFor(FACTORY, "bad", code);
  const res = t.make({ salt: "bad", fail: true, value: "10n" });
  assert.deepEqual([res.status, res.error.message], ["throw", "init ล้ม"]);
  assert.equal(t.vm.read(VM.codeKey(address)), undefined);
  assert.equal(t.vm.read(VM.thisKey(address)), undefined);
  assert.equal(t.vm.nativeBalanceOf(FACTORY).balance, 100n);
  assert.equal(t.vm.nativeBalanceOf(address).balance, 0n);
  // salt เดิมยังใช้ได้ (ไม่มีอะไรค้าง)
  assert.equal(t.ok(t.make({ salt: "bad" })).result, address);
});

test("clone: value โอน native จาก factory ไปโปรแกรมใหม่ · initialization เห็นที่ params.value", () => {
  const t = setup();
  t.ok(t.block((b) => b.transfer({ from: "alice", to: FACTORY, amount: 100 })).out);
  const clone = t.ok(t.make({ salt: "rich", value: "30n" })).result;
  assert.equal(t.vm.nativeBalanceOf(clone).balance, 30n);
  assert.equal(t.vm.nativeBalanceOf(FACTORY).balance, 70n);
  const info = t.ok(t.call(clone, "info")).result;
  assert.deepEqual([info.funded, info.balance], ["30n", "30n"]);
  // เงินไม่พอ → ล้มทั้ง tx
  const broke = t.make({ salt: "broke", value: "1000n" });
  assert.match(broke.error.message, /ไม่พอ/);
});

test("clone: คิดแก๊ส call + ตามขนาดโค้ด (เหมือน deploy) + write", () => {
  const gas = { node: 0, builtin: 0 };
  const t = setup({ gas });
  const codeSize = Buffer.byteLength(t.vm.read(VM.codeKey(TEMPLATE)), "utf8");
  const plain = t.ok(t.call(TEMPLATE, "info"));   // เทียบกับการเรียกธรรมดา
  const res = t.ok(t.make({ salt: "gas" }));
  const create = res.calls.find((c) => c.type === "create");
  assert.ok(res.gasUsed > plain.gasUsed);
  const g = VM.DEFAULT_GAS;
  assert.ok(res.gasUsed >= g.call * 2 + g.code * codeSize + 7 * g.write, `${res.gasUsed}`);
  assert.ok(create.gasUsed >= g.call, "รายการ create มีแก๊สของ initialization");
  // แก๊สไม่พอ → OUT_OF_GAS
  const starved = t.call(FACTORY, "make", { template: TEMPLATE, owner: "bob", salt: "starved" }, { gasLimit: g.code * codeSize });
  assert.equal(starved.error.code, "OUT_OF_GAS");
});

test("clone: ถูกย้อนทั้งหมดเมื่อ call ชั้นนอก throw (แม้ชั้นบนสุด catch ไว้)", () => {
  const t = setup();
  const code = t.vm.read(VM.codeKey(TEMPLATE));
  const address = t.vm.cloneAddressFor(FACTORY, "gone", code);
  const res = t.ok(t.call(OUTER, "go", { factory: FACTORY, template: TEMPLATE, owner: "bob", salt: "gone" }));
  assert.equal(res.result, "done");
  assert.equal(t.vm.read(VM.storageKey(OUTER, "caught")), "ล้มหลัง clone");
  for (const key of [VM.codeKey(address), VM.thisKey(address), VM.contextKey(address), VM.metadataKey(address, "template")]) {
    assert.equal(t.vm.read(key), undefined, key);
  }
  assert.ok(!res.writes.some((w) => w.dbKey.startsWith(address)), "ไม่มี write ของโปรแกรมใหม่ใน tx");
  // trace ยังบอกได้ว่าเคยสร้าง (แล้วถูกย้อน)
  assert.deepEqual(res.calls.map((c) => [c.depth, c.type ?? "call", c.functionName, c.status]), [
    [0, "call", "go", "success"], [1, "call", "makeThenFail", "throw"], [2, "create", "initialization", "success"],
  ]);
  // tx ทั้งใบล้ม → ไม่มีอะไรเหลือ
  const whole = t.call(FACTORY, "makeThenFail", { template: TEMPLATE, owner: "bob", salt: "gone" });
  assert.equal(whole.status, "throw");
  assert.equal(t.vm.read(VM.codeKey(address)), undefined);
});

test("clone: trace มีรายการ create → receipt / txto ของ explorer / debug_traceTransaction (CREATE)", () => {
  const t = setup();
  const { b, out: res } = t.block((block) => block.call({ programUuid: FACTORY, functionName: "nested", input: { template: TEMPLATE, owner: "bob", salt: "trace" }, context: user("alice") }));
  t.ok(res);
  const clone = res.result;
  assert.deepEqual(res.calls.map((c) => [c.depth, c.type ?? "call", c.programUuid, c.functionName, c.sender]), [
    [0, "call", FACTORY, "nested", "alice"], [1, "call", FACTORY, "make", FACTORY], [2, "create", clone, "initialization", FACTORY],
  ]);
  const receipt = b.receipt().transactions[0];
  assert.deepEqual(receipt.trace.map((c) => c.type ?? "call"), ["call", "call", "create"]);
  assert.equal("type" in receipt.trace[0], false, "call ธรรมดาไม่มี field type (receipt เดิมไม่เปลี่ยน)");
  const incoming = t.vm.listTransactionsTo(clone);
  assert.deepEqual(incoming.map((i) => [i.action, i.depth, i.from]), [["create", 2, FACTORY]]);

  const rpc = createEvmRpc({ vm: t.vm });
  const hash = t.vm.getBlock(b.number).txHashes[0];
  const frame = rpc.handle({ jsonrpc: "2.0", id: 1, method: "debug_traceTransaction", params: [hash, { tracer: "callTracer" }] }).result;
  assert.equal(frame.type, "CALL");
  const inner = frame.calls[0];
  assert.deepEqual([inner.type, inner.to], ["CALL", FACTORY]);
  assert.deepEqual([inner.calls[0].type, inner.calls[0].from, inner.calls[0].to], ["CREATE", FACTORY, clone]);
});

test("clone: ต้นแบบที่ไม่มี initialization ก็ยังมีรายการ create · เกินความลึกที่กำหนด → error", () => {
  const t = setup();
  t.block((b) => {
    t.ok(b.deploy({ programUuid: "plain", code: PLAIN, context: user("alice") }));
    t.ok(b.init({ programUuid: "plain" }));
  });
  const res = t.ok(t.call(FACTORY, "make", { template: "plain", owner: "bob", salt: "p" }));
  assert.deepEqual(res.calls.map((c) => [c.depth, c.type ?? "call", c.functionName, c.status]), [[0, "call", "make", "success"], [1, "create", "create", "success"]]);
  assert.equal(t.ok(t.call(res.result, "hello")).result, "hi");

  const shallow = setup({ maxCallDepth: 0 });
  assert.equal(shallow.make({ salt: "deep" }).error.code, "LIMIT_EXCEEDED");
});

test("clone: autoreview รู้จัก cloneProgram · โค้ดของต้นแบบที่ถูกอัปเกรดแล้ว = clone ได้โค้ดล่าสุด", () => {
  assert.ok(PROGRAM_API.includes("cloneProgram"));
  assert.equal(review(FACTORY_CODE, { apiNames: PROGRAM_API }).ok, true);
  const reviewed = setup({ autoReview: true });
  assert.ok(reviewed.vm.read(VM.codeKey(FACTORY)), "factory ผ่าน autoreview ตอน deploy");

  const t = setup();
  t.block((b) => {
    t.ok(b.deploy({ programUuid: "up", code: PLAIN, context: user("alice"), upgrader: "alice" }));
    t.ok(b.init({ programUuid: "up" }));
  });
  t.ok(t.block((b) => b.upgrade({ programUuid: "up", code: PLAIN.replace('"hi"', '"v2"'), context: user("alice") })).out);
  t.ok(t.block((b) => b.initUpgrade({ programUuid: "up" })).out);
  const clone = t.ok(t.call(FACTORY, "make", { template: "up", owner: "bob", salt: "x" })).result;
  assert.equal(t.ok(t.call(clone, "hello")).result, "v2");
  assert.equal(t.vm.read(VM.metadataKey(clone, "version")), undefined);
});
