import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { instrument } from "../src/core/gasmeter.js";

/* แก๊สแบบนับขั้น: ตัวนับที่ฉีดตอนคอมไพล์ (src/core/gasmeter.js) */

const T = 1_700_000_000_000;
const as = (who) => ({ sender: who, origin: who });

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, ...options });
  const run = (request) => {
    const res = vm.call(request, { timestamp: T });
    if (res.status === "success") vm.commit(res.writes);
    return res;
  };
  const activate = (programUuid, code) => {
    vm.commit(vm.deploy({ programUuid, code, context: as("owner") }, { timestamp: T }).writes);
    vm.commit(vm.init({ programUuid }, { timestamp: T }).writes);
  };
  const call = (programUuid, functionName, input = {}) => run({ programUuid, functionName, input, context: as("alice") });
  return { vm, activate, call };
}

const LOOPS = `function program() {
  function count(params) { let total = 0; for (let i = 0; i < params.input.n; i++) total += i; return total }
  function spin() { while (true) {} }
  function swallow() { while (true) { try { while (true) {} } catch (e) {} } }
  function swallowFinally() { try { while (true) {} } finally { return 1 } }
  function recurse() { return recurse() + 1 }
  return { count, spin, swallow, swallowFinally, recurse }
}`;

test("ผลลัพธ์ของโค้ดที่ฉีดตัวนับเหมือนเดิมทุกโครงสร้าง (if / switch / try / ลูป / arrow / เมธอดในตัว)", () => {
  const body = `
    function pick(x) { if (x > 2) return "big"; else if (x > 0) { return "small" } else return "zero" }
    function kind(x) { switch (x) { case 1: return "one"; case 2: case 3: { return "few" } default: return "many" } }
    function safe(f) { try { return f() } catch (e) { return "caught:" + e.message } finally { log.push("f") } }
    const log = [];
    const doubled = [1, 2, 3].map((x) => x * 2).filter((x) => x > 2);
    const text = "a,b,c".split(",").join(";").toUpperCase();
    const obj = { list: [3, 1, 2] };
    const sorted = obj.list.slice().sort((a, b) => a - b);
    const name = "join";
    const dynamic = [1, 2][name]("-");
    const json = JSON.parse(JSON.stringify({ a: [1, { b: 2 }] }));
    let n = 0; for (const v of [1, 2, 3]) n += v; do { n++ } while (n < 10); while (n < 12) n++;
    return [pick(3), pick(1), pick(0), kind(1), kind(3), kind(9), safe(() => { throw new Error("x") }), safe(() => 5), log.length, doubled, text, sorted, dynamic, json, n, Object.keys({ p: 1, q: 2 })];
  `;
  const expected = new Function(body)();
  let gas = 0;
  const metered = new Function("__gas", "__call", instrument(body));
  const actual = metered((n) => { gas += n; }, (target, method, args) => target[method](...args));
  assert.deepEqual(actual, expected);
  assert.ok(gas > 0);
});

test("บรรทัดของโค้ดไม่เปลี่ยนหลังฉีดตัวนับ (error ยังชี้บรรทัดเดิม)", () => {
  const body = "const a = [1]\n  .map((x) => x)\n  .join(',');\nfunction f() {\n  return 1\n}";
  assert.equal(instrument(body).split("\n").length, body.split("\n").length);
});

test("แก๊สเพิ่มตามจำนวนรอบของลูป (ได้ค่าเท่ากันทุกครั้ง)", () => {
  const { activate, call } = setup();
  activate("loops", LOOPS);
  const g = (n) => call("loops", "count", { n }).gasUsed;
  const [g10, g20, g30] = [g(10), g(20), g(30)];
  assert.equal(g20 - g10, g30 - g20);   // ต่อรอบคงที่
  assert.ok(g20 - g10 > 0);
  assert.equal(g(20), g20);             // ซ้ำได้ค่าเดิม
});

test("ลูปไม่รู้จบ → OUT_OF_GAS ที่เพดาน maxTxGas (ไม่ต้องรอ timeout) แม้ไม่ได้หักค่าแก๊ส", () => {
  const { activate, call } = setup({ maxTxGas: 1_000_000 });
  activate("loops", LOOPS);
  const res = call("loops", "spin");
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.ok(res.gasUsed > 1_000_000 && res.gasUsed < 1_000_010);   // หยุดที่ช่วงแรกที่เกินเพดาน
});

test("catch / finally กลืน OUT_OF_GAS ไม่ได้", () => {
  const { activate, call } = setup({ maxTxGas: 1_000_000 });
  activate("loops", LOOPS);
  assert.equal(call("loops", "swallow").error.code, "OUT_OF_GAS");
  assert.equal(call("loops", "swallowFinally").error.code, "OUT_OF_GAS");
});

test("ลูปไม่รู้จบใน block: หมดแก๊สตามยอดเงิน → เข้า block และเสียค่าแก๊ส (ผลไม่ขึ้นกับความเร็วเครื่อง)", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true, recordBlocks: true, timeoutMs: 5000 });
  vm.db.load({ "alice:native:received": 50_000 });
  const plain = new VM.VirtualMachine(vm.db);   // เตรียมโปรแกรมโดยไม่ต้องใช้ nonce / ค่าแก๊ส
  plain.commit(plain.deploy({ programUuid: "loops", code: LOOPS, context: as("owner") }, { timestamp: T }).writes);
  plain.commit(plain.init({ programUuid: "loops" }, { timestamp: T }).writes);
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  const res = block.call({ programUuid: "loops", functionName: "spin", context: as("alice"), nonce: 0 });
  block.commit();
  assert.equal(res.error.code, "OUT_OF_GAS");
  assert.equal(res.accepted, true);
  assert.equal(vm.nativeBalanceOf("alice").balance, 0);   // จ่ายเท่าที่มี
  assert.equal(vm.getBlock(1).txCount, 1);
});

test("เมธอดในตัวคิดแก๊สตามขนาดข้อมูล · repeat ขนาดใหญ่ถูกหยุดก่อนสร้างข้อมูล", () => {
  const code = `function program() {
    function joinN(params) { const list = []; list.length = params.input.n; return list.fill("x").join("").length }
    function huge() { return "x".repeat(1e9).length }
    return { joinN, huge }
  }`;
  const { activate, call } = setup({ maxTxGas: 5_000_000 });
  activate("b", code);
  const small = call("b", "joinN", { n: 1_000 }).gasUsed;
  const big = call("b", "joinN", { n: 2_000 }).gasUsed;
  assert.equal(big - small, 4_000);   // fill (เข้า + ออก) + join (เข้า + ออก) = 4 ต่อสมาชิกที่เพิ่ม × 1,000
  const started = Date.now();
  assert.equal(call("b", "huge").error.code, "OUT_OF_GAS");
  assert.ok(Date.now() - started < 1000);
});

test("ราคาต่อ node / builtin ปรับได้ · ตั้ง 0 = คิดเฉพาะ API แบบเดิม", () => {
  const plain = setup({ gas: API_GAS_ONLY });
  const priced = setup({ gas: { node: 3 } });
  for (const s of [plain, priced]) s.activate("loops", LOOPS);
  const base = plain.call("loops", "count", { n: 5 }).gasUsed;
  assert.equal(base, VM.DEFAULT_GAS.call);
  assert.ok(priced.call("loops", "count", { n: 5 }).gasUsed > base);
});

test("ชื่อ __gas / __call สงวนไว้ → deploy ไม่ผ่าน", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  for (const code of [
    "function program() { function f() { const __gas = () => 0; while (true) {} } return { f } }",
    "function program() { function f() { return __call } return { f } }",
  ]) {
    const res = vm.deploy({ programUuid: "x", code, context: as("owner") }, { timestamp: T });
    assert.equal(res.status, "throw");
    assert.match(res.error.message, /สงวนไว้/);
  }
});
