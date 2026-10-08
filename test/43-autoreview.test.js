import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { review, reviewMessage } from "../src/core/autoreview.js";
import { TOKEN } from "./programs.js";

const API = ["readDB", "writeDB", "deleteDB", "map", "runProgram", "transferNative", "setMetadata", "emit",
  "keccak256", "ecrecover", "ThisAddress", "ThisBalance", "BalanceOf", "IsProgram", "MetadataOf", "BlockNumber", "params"];
const check = (code) => review(code, { apiNames: API });
const wrap = (body) => `function program() {\n${body}\n  return {}\n}`;

test("โปรแกรมปกติผ่าน", () => {
  assert.equal(check(TOKEN).ok, true);
  assert.equal(reviewMessage(check(TOKEN)), "ผ่านการตรวจ");
});

test("ปฏิเสธการเข้าถึง global ของ Node โดยไม่ต้องไล่ห้ามทีละตัว", () => {
  for (const name of ["process", "fetch", "globalThis", "require", "eval", "Function", "WebAssembly", "Proxy", "Reflect", "performance"]) {
    const result = check(wrap(`  function f() { return ${name} }`));
    assert.equal(result.ok, false, name);
    assert.match(result.issues[0].message, /ไม่รู้จัก/);
  }
});

test("ปฏิเสธประตูหนีออกจาก sandbox", () => {
  assert.match(check(wrap('  function f() { return (function(){}).constructor("return process")() }')).issues[0].message, /constructor/);
  assert.match(check(wrap("  function f(x) { return x.__proto__ }")).issues[0].message, /__proto__/);
  assert.match(check(wrap("  function f(x) { return x.prototype }")).issues[0].message, /prototype/);
  assert.match(check(wrap('  function f(x, k) { return x[k] }')).issues[0].message, /obj\[key\]/);
  assert.match(check(wrap('  function f(x) { return x["constr" + "uctor"] }')).issues[0].message, /obj\[key\]/);
});

test("ปฏิเสธโครงสร้างที่ไม่ deterministic หรือไม่จำเป็น", () => {
  for (const body of ["class A {}", "async function f() {}", "function* g() {}", "const r = /x/g"]) {
    assert.equal(check(wrap(`  ${body}`)).ok, false, body);
  }
  assert.equal(check(wrap("  function f(o) { for (const k in o) {} }")).ok, false);
  assert.equal(check(wrap("  function f() { return this }")).ok, false);
});

test("อนุญาต new Error และ new Date", () => {
  assert.equal(check(wrap('  function f() { throw new Error("ผิด") }')).ok, true);
  assert.equal(check(wrap("  function f() { return new Date().getTime() }")).ok, true);
  assert.equal(check(wrap("  function f() { return new Map() }")).ok, false);
});

test("บอกบรรทัดที่ผิดให้แก้ได้", () => {
  const result = check("function program() {\n  function f() {\n    return process.env\n  }\n  return { f }\n}");
  assert.equal(result.issues[0].line, 3);
  assert.match(reviewMessage(result), /^บรรทัด 3:/);
});

test("VM: เปิด autoReview แล้ว deploy โค้ดที่ไม่ผ่านถูกปฏิเสธ", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { autoReview: true });
  const context = { sender: "alice", origin: "alice" };
  assert.equal(vm.deploy({ programUuid: "ok", code: TOKEN, context, initInput: { supply: 100 } }).status, "success");

  const bad = vm.deploy({ programUuid: "bad", code: wrap("  function f() { return process.env }"), context });
  assert.equal(bad.error.code, "INVALID_REQUEST");
  assert.match(bad.error.message, /โค้ดไม่ผ่านการตรวจอัตโนมัติ[\s\S]*บรรทัด/);
});

test("VM: ปิด autoReview (ค่าเริ่มต้น) → ตรวจด้วยคนเหมือนเดิม", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  assert.equal(VM.DEFAULT_OPTIONS.autoReview, false);
  assert.equal(vm.deploy({ programUuid: "p", code: wrap("  function f() { return 1 }"), context: { sender: "a", origin: "a" } }).status, "success");
});

test("ปิด prototype pollution ผ่าน Object", () => {
  for (const method of ["getPrototypeOf", "setPrototypeOf", "defineProperty", "create", "freeze", "assign", "getOwnPropertyNames"]) {
    const result = check(wrap(`  function f(o) { return Object.${method}(o) }`));
    assert.equal(result.ok, false, method);
    assert.match(result.issues[0].message, /ใช้ไม่ได้/);
  }
  assert.equal(check(wrap("  function f(o) { return Object.keys(o) }")).ok, true);
});

test("ปิดสิ่งที่ผลต่างกันข้ามเครื่อง", () => {
  const banned = [
    "function f() { return Math.sin(1) }",
    "function f(n) { return n.toLocaleString() }",
    "function f(a, b) { return a.localeCompare(b) }",
    "function f(a) { return a.sort() }",
    'function f() { try { readDB("a") } catch (e) { writeDB("s", e.stack) } }',
  ];
  for (const body of banned) assert.equal(check(wrap(`  ${body}`)).ok, false, body);
  assert.equal(check(wrap("  function f(n) { return Math.floor(n) }")).ok, true);
});

test("ปิดคำสั่งเดียวที่สร้างข้อมูลมหาศาล", () => {
  for (const body of ['function f() { return "x".repeat(1e9) }', 'function f(s) { return s.padStart(1e9) }']) {
    assert.match(check(wrap(`  ${body}`)).issues[0].message, /สร้างข้อมูลใหญ่|ไม่ได้/);
  }
});

test("ปิด getter / setter / เมธอดใน object literal", () => {
  assert.match(check(wrap("  function f() { return { get a() { return 1 } } }")).issues[0].message, /getter/);
  assert.match(check(wrap("  function f() { return { m() { return 1 } } }")).issues[0].message, /getter/);
  assert.equal(check(wrap("  function f() { return { a: 1 } }")).ok, true);
});

test("ปิดการเปลี่ยน this ด้วย call / apply / bind", () => {
  for (const method of ["call", "apply", "bind"]) {
    assert.equal(check(wrap(`  function f(g) { return g.${method}(null) }`)).ok, false, method);
  }
});
