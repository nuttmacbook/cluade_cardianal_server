import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { review, reviewMessage } from "../src/core/autoreview.js";
import { TOKEN } from "./programs.js";

const API = ["readDB", "writeDB", "deleteDB", "map", "runProgram", "transferNative", "setMetadata", "emit",
  "keccak256", "ecrecover", "ThisAddress", "ThisBalance", "BalanceOf", "IsProgram", "MetadataOf", "BlockNumber", "params"];
const check = (code) => review(code, { apiNames: API });
const wrap = (body) => `function program() {\n${body}\n  return {}\n}`;

test("a normal program passes", () => {
  assert.equal(check(TOKEN).ok, true);
  assert.equal(reviewMessage(check(TOKEN)), "review passed");
});

test("rejects access to Node globals without listing each one", () => {
  for (const name of ["process", "fetch", "globalThis", "require", "eval", "Function", "WebAssembly", "Proxy", "Reflect", "performance"]) {
    const result = check(wrap(`  function f() { return ${name} }`));
    assert.equal(result.ok, false, name);
    assert.match(result.issues[0].message, /is unknown/);
  }
});

test("rejects sandbox escape hatches", () => {
  assert.match(check(wrap('  function f() { return (function(){}).constructor("return process")() }')).issues[0].message, /constructor/);
  assert.match(check(wrap("  function f(x) { return x.__proto__ }")).issues[0].message, /__proto__/);
  assert.match(check(wrap("  function f(x) { return x.prototype }")).issues[0].message, /prototype/);
  assert.match(check(wrap('  function f(x, k) { return x[k] }')).issues[0].message, /obj\[key\]/);
  assert.match(check(wrap('  function f(x) { return x["constr" + "uctor"] }')).issues[0].message, /obj\[key\]/);
});

test("rejects non-deterministic or unnecessary constructs", () => {
  for (const body of ["class A {}", "async function f() {}", "function* g() {}", "const r = /x/g"]) {
    assert.equal(check(wrap(`  ${body}`)).ok, false, body);
  }
  assert.equal(check(wrap("  function f(o) { for (const k in o) {} }")).ok, false);
  assert.equal(check(wrap("  function f() { return this }")).ok, false);
});

test("allows new Error and new Date", () => {
  assert.equal(check(wrap('  function f() { throw new Error("bad") }')).ok, true);
  assert.equal(check(wrap("  function f() { return new Date().getTime() }")).ok, true);
  assert.equal(check(wrap("  function f() { return new Map() }")).ok, false);
});

test("reports the offending line so it can be fixed", () => {
  const result = check("function program() {\n  function f() {\n    return process.env\n  }\n  return { f }\n}");
  assert.equal(result.issues[0].line, 3);
  assert.match(reviewMessage(result), /^line 3:/);
});

test("VM: with autoReview on, deploying failing code is rejected", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { autoReview: true });
  const context = { sender: "alice", origin: "alice" };
  assert.equal(vm.deploy({ programUuid: "ok", code: TOKEN, context, initInput: { supply: 100 } }).status, "success");

  const bad = vm.deploy({ programUuid: "bad", code: wrap("  function f() { return process.env }"), context });
  assert.equal(bad.error.code, "INVALID_REQUEST");
  assert.match(bad.error.message, /code failed automatic review[\s\S]*line/);
});

test("VM: autoReview off (default) → manual review as before", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  assert.equal(VM.DEFAULT_OPTIONS.autoReview, false);
  assert.equal(vm.deploy({ programUuid: "p", code: wrap("  function f() { return 1 }"), context: { sender: "a", origin: "a" } }).status, "success");
});

test("blocks prototype pollution via Object", () => {
  for (const method of ["getPrototypeOf", "setPrototypeOf", "defineProperty", "create", "freeze", "assign", "getOwnPropertyNames"]) {
    const result = check(wrap(`  function f(o) { return Object.${method}(o) }`));
    assert.equal(result.ok, false, method);
    assert.match(result.issues[0].message, /is not allowed/);
  }
  assert.equal(check(wrap("  function f(o) { return Object.keys(o) }")).ok, true);
});

test("blocks things whose results differ across machines", () => {
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

test("repeat / padStart / padEnd pass review (the sandbox charges gas by result size instead)", () => {
  for (const body of ['function f() { return "x".repeat(3) }', 'function f(s) { return s.padStart(8, "0") }', 'function f(s) { return s.padEnd(8) }']) {
    assert.equal(check(wrap(`  ${body}`)).ok, true, body);
  }
});

test("blocks getters / setters / methods in object literals", () => {
  assert.match(check(wrap("  function f() { return { get a() { return 1 } } }")).issues[0].message, /getter/);
  assert.match(check(wrap("  function f() { return { m() { return 1 } } }")).issues[0].message, /getter/);
  assert.equal(check(wrap("  function f() { return { a: 1 } }")).ok, true);
});

test("blocks rebinding this with call / apply / bind", () => {
  for (const method of ["call", "apply", "bind"]) {
    assert.equal(check(wrap(`  function f(g) { return g.${method}(null) }`)).ok, false, method);
  }
});
