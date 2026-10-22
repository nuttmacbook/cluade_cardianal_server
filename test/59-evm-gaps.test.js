import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { reviewProgram } from "../src/core/autoreview.js";
import { createFakeApi } from "../program-sdk/lib/program-globals.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/*
 * API ที่ EVM มีแต่เดิมเราไม่มี:
 *   BlockHash / ChainId / Coinbase / BlockGasLimit / GasPrice / GasLeft / CodeHashOf / CodeSizeOf
 *   sha256 / ripemd160 / blake2b / modexp · runProgram(..., { readonly: true }) (STATICCALL)
 */

const T = Date.parse("2025-03-01T00:00:00Z");
const user = (name) => ({ sender: name, origin: name });

const ENV = `function program() {
  function env() {
    return { chainId: ChainId(), coinbase: Coinbase(), blockGasLimit: BlockGasLimit(), gasPrice: GasPrice(), number: BlockNumber() }
  }
  function hashes(params) {
    const n = params.input.n;
    return { prev: BlockHash(n - 1n), self: BlockHash(n), next: BlockHash(n + 1n) }
  }
  function hashOf(params) { return BlockHash(params.input.n) }
  function gasLeft() { const a = GasLeft(); const b = GasLeft(); return { a, b } }
  function code(params) { return { hash: CodeHashOf(params.input.address), size: CodeSizeOf(params.input.address) } }
  function digest(params) {
    const v = params.input.value;
    return { sha: sha256(v), ripe: ripemd160(v), blake: blake2b(v), keccak: keccak256(v) }
  }
  function one(params) {
    const v = params.input.value;
    if (params.input.kind === "sha256") return sha256(v);
    if (params.input.kind === "ripemd160") return ripemd160(v);
    if (params.input.kind === "blake2b") return blake2b(v);
    return keccak256(v);
  }
  function pow(params) { return modexp(params.input.b, params.input.e, params.input.m) }
  function powNumber() { return modexp(2, 3n, 5n) }
  function hashNumber() { return BlockHash(1) }
  return { env, hashes, hashOf, gasLeft, code, digest, one, pow, powNumber, hashNumber }
}`;

/** โปรแกรมที่ลองแก้ state ทุกแบบ (ใช้เป็นปลายทางของ readonly call) */
const TARGET = `function program() {
  function initialization() { writeDB("count", 0n) }
  function get() { return readDB("count") }
  function bump() { writeDB("count", readDB("count") + 1n); return readDB("count") }
  function remove() { deleteDB("count") }
  function pay(params) { transferNative(params.input.to, 1n) }
  function meta() { setMetadata("description", "x") }
  function log() { emit("Ping", {}) }
  function clone(params) { return cloneProgram(params.input.template, {}, { salt: "s" }) }
  function forward(params) { return runProgram(params.input.next, params.input.fn, params.input.args ?? {}) }
  function tryBump() { try { writeDB("count", 9n); return "wrote" } catch (e) { return "caught: " + e.message } }
  return { get, bump, remove, pay, meta, log, clone, forward, tryBump }
}`;

const CALLER = `function program() {
  function look(params) { return runProgram(params.input.target, params.input.fn, params.input.args ?? {}, { readonly: true }) }
  function attempt(params) {
    try { runProgram(params.input.target, params.input.fn, params.input.args ?? {}, { readonly: true }); return "ok" }
    catch (e) { return "caught: " + e.message }
  }
  function normal(params) { return runProgram(params.input.target, params.input.fn, params.input.args ?? {}) }
  function withValue(params) { return runProgram(params.input.target, "get", {}, { readonly: true, value: 1n }) }
  function badFlag(params) { return runProgram(params.input.target, "get", {}, { readonly: "yes" }) }
  function lookThenWrite(params) {
    const before = runProgram(params.input.target, "get", {}, { readonly: true });
    writeDB("seen", before);
    return readDB("seen")
  }
  return { look, attempt, normal, withValue, badFlag, lookThenWrite }
}`;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, recordHistory: true, chainId: 77, timeoutMs: 5000, ...options });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "0xMiner" });
  for (const [programUuid, code] of [["env", ENV], ["target", TARGET], ["caller", CALLER]]) {
    block.deploy({ programUuid, code, context: user("owner") });
    block.init({ programUuid });
  }
  block.commit();
  const call = (programUuid, functionName, input = {}, extra = {}) =>
    vm.call({ programUuid, functionName, input, context: user("alice"), ...extra }, { timestamp: T + 1000 });
  return { vm, call };
}

/** สร้าง block ว่างต่อกันจนถึงเลข n */
function blocksUntil(vm, n) {
  let t = T + 10_000;
  while ((vm.latestBlockNumber() ?? 0) < n) vm.createBlock({ timestamp: (t += 1000) }).commit();
}

const hex = (fn, text) => `0x${bytesToHex(fn(utf8ToBytes(text)))}`;
const nodeHash = (name, text) => `0x${createHash(name).update(text, "utf8").digest("hex")}`;

// ---------------------------------------------------------------------------

test("ChainId / Coinbase / BlockGasLimit / GasPrice: ค่าของ chain / block / tx (BigInt)", () => {
  const { vm, call } = setup({ maxBlockGas: 5_000_000 });
  const block = vm.createBlock({ timestamp: T + 5000, feeRecipient: "0xMiner" });
  const res = block.call({ programUuid: "env", functionName: "env", context: user("alice"), gasPrice: 7 });
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.deepEqual(res.result, { chainId: "77n", coinbase: "0xminer", blockGasLimit: "5000000n", gasPrice: "7n", number: "2n" });

  // query นอก block: ไม่มีผู้ปิด block · ราคาแก๊สเริ่มต้น
  const plain = new VM.VirtualMachine(vm.db, { chainId: 77 });
  const q = plain.call({ programUuid: "env", functionName: "env", context: user("alice") }, { timestamp: T + 6000 });
  assert.deepEqual(q.result, { chainId: "77n", coinbase: null, blockGasLimit: null, gasPrice: `${VM.DEFAULT_GAS.price}n`, number: null });
  assert.ok(call("env", "env").status === "success");
});

test("BlockHash: hash ของ block ก่อนหน้า · block ปัจจุบัน / อนาคต → null", () => {
  const { vm } = setup();
  blocksUntil(vm, 3);
  const block = vm.createBlock({ timestamp: T + 100_000 });   // block 4
  const res = block.call({ programUuid: "env", functionName: "hashes", input: { n: 4 }, context: user("alice") });
  block.commit();
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.equal(res.result.prev, vm.getBlock(3).hash);
  assert.equal(res.result.self, null);    // block ที่กำลังสร้างยังไม่มี hash
  assert.equal(res.result.next, null);
  // query นอก block: block ล่าสุด (4) ถือว่าเป็นอดีตแล้ว
  const q = vm.call({ programUuid: "env", functionName: "hashOf", input: { n: 4 }, context: user("alice") }, { timestamp: T + 200_000 });
  assert.equal(q.result, vm.getBlock(4).hash);
  // block 0 ไม่มี header → null
  assert.equal(vm.call({ programUuid: "env", functionName: "hashOf", input: { n: 0 }, context: user("alice") }, { timestamp: T + 200_000 }).result, null);
});

test("BlockHash: ย้อนได้แค่ 256 block ล่าสุด (เหมือน BLOCKHASH)", () => {
  const { vm } = setup();
  blocksUntil(vm, 260);
  const at = (n) => vm.call({ programUuid: "env", functionName: "hashOf", input: { n }, context: user("alice") }, { timestamp: T + 10_000_000 }).result;
  // block ปัจจุบัน (query) = 261 → ย้อนได้ 5..260
  assert.equal(at(260), vm.getBlock(260).hash);
  assert.equal(at(5), vm.getBlock(5).hash);
  assert.equal(at(4), null);
  assert.equal(at(1), null);
});

test("BlockHash: ตัวเลขต้องเป็น BigInt · replay block ที่ใช้ BlockHash ได้ hash เดิม", () => {
  const { vm } = setup();
  const res = vm.call({ programUuid: "env", functionName: "hashNumber", context: user("alice") }, { timestamp: T + 1 });
  assert.equal(res.status, "throw");
  assert.match(res.error.message, /BigInt/);

  blocksUntil(vm, 2);
  const block = vm.createBlock({ timestamp: T + 50_000 });
  block.call({ programUuid: "env", functionName: "hashes", input: { n: 3 }, context: user("alice") });
  block.commit();
  const replay = vm.replayBlock(3);
  assert.equal(replay.hash, vm.getBlock(3).hash);
});

test("GasLeft: แก๊สที่เหลือของ tx ลดลงตามที่ใช้ (นับค่าของตัวเองด้วย)", () => {
  const { vm } = setup({ gas: API_GAS_ONLY, maxTxGas: 1_000_000 });
  const res = vm.call({ programUuid: "env", functionName: "gasLeft", context: user("alice"), gasLimit: 50_000 }, { timestamp: T + 1 });
  assert.equal(res.status, "success", JSON.stringify(res.error));
  const { call, env } = VM.DEFAULT_GAS;
  assert.equal(res.result.a, `${50_000 - call - env}n`);
  assert.equal(res.result.b, `${50_000 - call - 2 * env}n`);
  assert.equal(res.gasUsed, call + 2 * env);
});

test("CodeHashOf / CodeSizeOf: keccak256 / ความยาวของโค้ดที่เก็บ · ไม่ใช่โปรแกรม → null / 0n", () => {
  const { vm, call } = setup();
  const stored = vm.read("target:code");
  const res = call("env", "code", { address: "target" });
  assert.equal(res.result.hash, VM.keccak256Hex(stored));
  assert.equal(res.result.size, `${Buffer.byteLength(stored, "utf8")}n`);
  assert.deepEqual(call("env", "code", { address: "alice" }).result, { hash: null, size: "0n" });
  assert.equal(call("env", "code", { address: "" }).status, "throw");
});

test("CodeHashOf ของโปรแกรมที่ clone = codeHash ที่ใช้คำนวณ address (แบบ EXTCODEHASH)", () => {
  const { vm, call } = setup();
  const factory = `function program() {
    function make() { return cloneProgram("target", {}, { salt: "a" }) }
    function sameCode(params) { return CodeHashOf(params.input.a) === CodeHashOf(params.input.b) }
    return { make, sameCode }
  }`;
  vm.commit(vm.deploy({ programUuid: "factory", code: factory, context: user("owner") }, { timestamp: T + 1 }).writes);
  vm.commit(vm.init({ programUuid: "factory" }, { timestamp: T + 1 }).writes);
  const made = call("factory", "make");
  vm.commit(made.writes);
  assert.equal(made.result, vm.cloneAddressFor("factory", "a", vm.read("target:code")));
  assert.equal(call("factory", "sameCode", { a: made.result, b: "target" }).result, true);
  assert.equal(call("factory", "sameCode", { a: "factory", b: "target" }).result, false);
});

test("sha256 / ripemd160 / blake2b: ค่าตรงกับ library มาตรฐาน · object ใช้ canonical JSON แบบ keccak256", () => {
  const { call } = setup();
  const res = call("env", "digest", { value: "abc" });
  assert.equal(res.result.sha, nodeHash("sha256", "abc"));
  assert.equal(res.result.sha, "0xba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(res.result.ripe, "0x8eb208f7e05d987a9b044a8e98c6b087f15a0bfc");
  assert.equal(res.result.blake, hex(blake2b, "abc"));
  assert.equal(res.result.blake.length, 2 + 128);   // BLAKE2b-512
  assert.equal(res.result.keccak, VM.keccak256Hex("abc"));

  const a = call("env", "digest", { value: { b: 2, a: [1, "x"] } }).result;
  const b = call("env", "digest", { value: { a: [1, "x"], b: 2 } }).result;
  assert.deepEqual(a, b);
  assert.equal(a.sha, nodeHash("sha256", '{"a":["1n","x"],"b":"2n"}'));
});

test("แก๊สของ sha256 / ripemd160 / blake2b = ค่าต่อครั้ง + byte ของข้อมูล", () => {
  const { call } = setup({ gas: API_GAS_ONLY });
  const g = VM.DEFAULT_GAS;
  for (const kind of ["sha256", "ripemd160", "blake2b", "keccak256"]) {
    const used = (value) => call("env", "one", { kind, value }).gasUsed;
    const perCall = kind === "keccak256" ? g.hash : g[kind];
    assert.equal(used("abc"), g.call + perCall + 3 * g.byte, kind);
    assert.equal(used("abcdef") - used("abc"), 3 * g.byte, kind);
  }
  assert.ok(g.ripemd160 > g.sha256);
});

test("modexp: (base ** exp) % mod แบบ BigInt · mod 0 → 0n · ค่าติดลบ / number / ใหญ่เกิน → error", () => {
  const { call } = setup();
  const pow = (b, e, m) => call("env", "pow", { b: `${b}n`, e: `${e}n`, m: `${m}n` });
  assert.equal(pow(3n, 200n, 1000007n).result, `${3n ** 200n % 1000007n}n`);
  assert.equal(pow(2n, 0n, 7n).result, "1n");
  assert.equal(pow(2n, 0n, 1n).result, "0n");
  assert.equal(pow(5n, 3n, 0n).result, "0n");
  assert.equal(pow(0n, 0n, 9n).result, "1n");
  // RSA-ish: ตรวจกับ BigInt ปกติ
  const m = (1n << 521n) - 1n;
  const b = 0x1234567890abcdefn ** 7n;
  const e = 65537n;
  let expect = 1n;
  for (let i = 0n; i < e; i += 1n) expect = (expect * b) % m;   // ช้าแต่ถูกแน่
  assert.equal(pow(b, e, m).result, `${expect}n`);

  assert.equal(pow(-1n, 2n, 5n).status, "throw");
  // ค่าเกิน 1024 ไบต์ (8192 bit) เป็น BigInt ในโปรแกรมไม่ได้แล้ว (เพดาน BigInt ของ sandbox = ขนาดสูงสุดของ modexp · เทสต์ 81)
  assert.equal(pow(1n << 8200n, 2n, 5n).error.message, "โปรแกรมทำงานผิดพลาด (RangeError)");
  assert.equal(pow((1n << 8192n) - 1n, 2n, 5n).result, `${((1n << 8192n) - 1n) ** 2n % 5n}n`);   // 1024 ไบต์พอดี ยังใช้ได้
  const res = call("env", "powNumber");
  assert.equal(res.status, "throw");
  assert.match(res.error.message, /BigInt/);
});

test("modexp: แก๊สโตตามขนาดของค่า (word² × bit ของ exponent / 3)", () => {
  const { call } = setup({ gas: API_GAS_ONLY });
  const g = VM.DEFAULT_GAS;
  const used = (b, e, m) => call("env", "pow", { b: `${b}n`, e: `${e}n`, m: `${m}n` }).gasUsed;
  assert.equal(used(3n, 5n, 7n), g.call + g.modexp + Math.floor((1 * 1 * 3) / 3));
  const big = (1n << 1023n) + 1n;   // 1024 bit = 16 word
  assert.equal(used(big, big, big), g.call + g.modexp + Math.floor((16 * 16 * 1024) / 3));
});

test("runProgram { readonly: true }: อ่านได้ตามปกติ · trace เป็น staticcall", () => {
  const { call } = setup();
  const res = call("caller", "look", { target: "target", fn: "get" });
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.equal(res.result, "0n");
  assert.equal(res.calls[1].type, "staticcall");
  assert.equal(call("caller", "normal", { target: "target", fn: "get" }).calls[1].type, undefined);
  // ผู้เรียกยังเขียนได้หลังอ่านแบบ readonly (เฉพาะปลายทางที่ถูกห้าม)
  assert.equal(call("caller", "lookThenWrite", { target: "target" }).result, "0n");
});

test("runProgram { readonly: true }: เขียน / ลบ / โอน / metadata / emit / clone → error ที่ catch ได้ (ข้อความภาษาไทย)", () => {
  const { call } = setup();
  for (const [fn, name] of [["bump", "writeDB"], ["remove", "deleteDB"], ["pay", "transferNative"], ["meta", "setMetadata"], ["log", "emit"], ["clone", "cloneProgram"]]) {
    const args = fn === "pay" ? { to: "bob" } : fn === "clone" ? { template: "target" } : {};
    const res = call("caller", "attempt", { target: "target", fn, args });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    assert.equal(res.result, `caught: ${name}() ใช้ไม่ได้ในการเรียกแบบอ่านอย่างเดียว (runProgram แบบ { readonly: true } ห้ามแก้ state ทุกชั้น)`, fn);
    assert.equal(res.writes.length, 0, fn);
    assert.equal(res.events.length, 0, fn);
  }
  // ไม่ catch → ทั้ง tx ล้มด้วย FORBIDDEN
  const res = call("caller", "look", { target: "target", fn: "bump" });
  assert.equal(res.status, "throw");
  assert.equal(res.error.code, "FORBIDDEN");
  // ปลายทาง catch เองก็ได้ (state ไม่เปลี่ยน)
  assert.match(call("caller", "look", { target: "target", fn: "tryBump" }).result, /^caught: writeDB\(\) ใช้ไม่ได้/);
});

test("runProgram { readonly: true }: ห้ามแก้ state ทุกชั้นที่เรียกต่อ แม้ชั้นในเรียกแบบปกติ", () => {
  const { call } = setup();
  const nested = { target: "target", fn: "forward", args: { next: "target", fn: "bump" } };
  assert.match(call("caller", "attempt", nested).result, /^caught: writeDB\(\) ใช้ไม่ได้/);
  // ชั้นในสุดอ่านได้
  assert.equal(call("caller", "look", { target: "target", fn: "forward", args: { next: "target", fn: "get" } }).result, "0n");
  // เรียกแบบปกติ: เขียนได้เหมือนเดิม
  const normal = call("caller", "normal", nested);
  assert.equal(normal.status, "success");
  assert.equal(normal.result, "1n");
});

test("runProgram { readonly: true }: แนบ value ไม่ได้ · readonly ต้องเป็น boolean", () => {
  const { call } = setup();
  const withValue = call("caller", "withValue", { target: "target" });
  assert.equal(withValue.status, "throw");
  assert.match(withValue.error.message, /แนบ value ไม่ได้/);
  const bad = call("caller", "badFlag", { target: "target" });
  assert.equal(bad.status, "throw");
  assert.match(bad.error.message, /readonly ต้องเป็น true \/ false/);
});

test("autoreview ยอมรับ API ใหม่ทุกตัว และ deploy ผ่านเมื่อเปิด autoReview", () => {
  for (const code of [ENV, TARGET, CALLER]) {
    const result = reviewProgram(code);
    assert.equal(result.ok, true, result.message);
  }
  const { call } = setup({ autoReview: true });
  assert.equal(call("env", "digest", { value: "x" }).status, "success");
  assert.equal(call("caller", "look", { target: "target", fn: "get" }).result, "0n");
});

test("API ปลอมของ SDK (program-globals) ให้ผลตรงกับ chain สำหรับ hash / modexp / ค่าของ block", () => {
  const { call } = setup();
  const fake = createFakeApi({ blockNumber: 10, blockHashes: { 9: "0xaa" }, chainId: 77, code: { "0xp": "abc" } });
  for (const [value, input] of [["abc", "abc"], [{ b: 2n, a: [1n, "x"] }, { b: 2, a: [1, "x"] }]]) {
    const chain = call("env", "digest", { value: input }).result;
    assert.equal(fake.sha256(value), chain.sha);
    assert.equal(fake.ripemd160(value), chain.ripe);
    assert.equal(fake.blake2b(value), chain.blake);
  }
  assert.equal(fake.modexp(3n, 200n, 1000007n), 3n ** 200n % 1000007n);
  assert.equal(fake.modexp(5n, 3n, 0n), 0n);
  assert.equal(fake.BlockHash(9n), "0xaa");
  assert.equal(fake.BlockHash(10n), null);
  assert.equal(fake.ChainId(), 77n);
  assert.equal(fake.CodeSizeOf("0xP"), 3n);
  assert.equal(fake.CodeSizeOf("0xq"), 0n);
  assert.equal(fake.CodeHashOf("0xq"), null);
});

test("ผลของ API ใหม่เท่ากันทุกครั้ง (deterministic) · แก๊สเท่ากันทุกครั้ง", () => {
  const { call } = setup();
  const run = () => {
    const results = [call("env", "env"), call("env", "digest", { value: { a: 1 } }), call("env", "pow", { b: 7, e: 99, m: 1000 }),
      call("env", "code", { address: "target" }), call("env", "gasLeft")];
    return results.map((r) => [r.result, r.gasUsed]);
  };
  assert.deepEqual(run(), run());
});
