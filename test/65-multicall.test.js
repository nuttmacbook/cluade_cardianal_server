import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { MULTICALL_PROGRAM } from "../src/standards/multicall.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { reviewProgram } from "../src/core/autoreview.js";

/* multicall: aggregate (ทำตามลำดับ ล้มตัวเดียวล้มหมด) / tryAggregate (ผลต่อ call) / readonly (ห้ามแก้ state ทุก call) */

const MC = "0x00000000000000000000000000000000000000e2";
const T = "0x00000000000000000000000000000000000000f1";
const C = "0x00000000000000000000000000000000000000f4";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";

const COUNTER = `function program() {
  function add(params) {
    const next = (readDB("count") || 0n) + params.input.by
    writeDB("count", next)
    emit("Added", { by: params.input.by, sender: params.context.sender })
    return next
  }
  function get() { return readDB("count") || 0n }
  function boom() { throw new Error("boom") }
  return { add, get, boom }
}`;

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 42, recordBlocks: true });
  vm.applyGenesis({ chainId: 42, balances: { [BOB]: 77 } });
  let number = 0;
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: number * 1000, feeRecipient: OWNER });
    const results = fn(b);
    b.commit();
    return results;
  };
  const as = (who) => ({ sender: who, origin: who });
  block((b) => [
    b.deploy({ programUuid: MC, code: MULTICALL_PROGRAM, context: as(OWNER) }),
    b.init({ programUuid: MC }),
    b.deploy({ programUuid: T, code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Coin", ticker: "C", decimals: "0n", supply: "1000n" } }),
    b.init({ programUuid: T }),
    b.deploy({ programUuid: C, code: COUNTER, context: as(OWNER) }),
    b.init({ programUuid: C }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const call = (functionName, input) => block((b) => [b.call({ programUuid: MC, functionName, input, context: as(BOB) })])[0];
  const read = (programUuid, functionName, input = {}) => vm.query({ programUuid, functionName, input });
  return { vm, call, read };
}
const add = (by) => ({ target: C, fn: "add", input: { by } });

test("MULTICALL_PROGRAM ผ่าน autoreview", () => {
  assert.deepEqual(reviewProgram(MULTICALL_PROGRAM).issues, []);
});

test("aggregate: ทำตามลำดับ (call หลังเห็นผลของ call ก่อน) · คืนผลเป็น array · ปลายทางเห็น sender = multicall", () => {
  const { call, read } = chain();
  const res = call("aggregate", { calls: [add("2n"), add("3n"), { target: C, fn: "get" }, { target: T, fn: "balanceOf", input: { who: OWNER } }] });
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.deepEqual(res.result, ["2n", "5n", "5n", "1000n"]);
  assert.deepEqual(res.events.map((e) => e.data.sender), [MC, MC]);
  assert.equal(read(C, "get").result, "5n");
  assert.deepEqual(call("aggregate", { calls: [] }).result, []);
});

test("aggregate: call ไหนล้ม → ทั้ง tx ล้ม และการเขียนของ call ก่อนหน้าถูกย้อนหมด (all-or-nothing)", () => {
  const { call, read } = chain();
  const res = call("aggregate", { calls: [add("2n"), { target: C, fn: "boom" }, add("3n")] });
  assert.equal(res.status, "throw");
  assert.match(res.error.message, /boom/);
  assert.deepEqual(res.writes, []);
  assert.equal(read(C, "get").result, "0n");
  // ปลายทางที่ไม่มีฟังก์ชันนั้น / input ผิดรูปแบบ ก็ล้มทั้งชุดเหมือนกัน
  assert.equal(call("aggregate", { calls: [add("1n"), { target: C, fn: "nope" }] }).status, "throw");
  assert.match(call("aggregate", { calls: [{ target: C }] }).error.message, /each call needs target and fn/);
  assert.match(call("aggregate", { calls: "x" }).error.message, /calls must be an array/);
  assert.equal(read(C, "get").result, "0n");
});

test("tryAggregate: ผลต่อ call { success, result | error } · call ที่ล้มถูกย้อนเฉพาะตัวมัน · requireSuccess = ล้มหมด", () => {
  const { call, read } = chain();
  const res = call("tryAggregate", { calls: [add("2n"), { target: C, fn: "boom" }, add("3n")] });
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.deepEqual(res.result[0], { success: true, result: "2n" });
  assert.equal(res.result[1].success, false);
  assert.match(res.result[1].error, /boom/);
  assert.deepEqual(res.result[2], { success: true, result: "5n" });
  assert.equal(read(C, "get").result, "5n");
  const strict = call("tryAggregate", { calls: [add("1n"), { target: C, fn: "boom" }], requireSuccess: true });
  assert.equal(strict.status, "throw");
  assert.equal(read(C, "get").result, "5n");
});

test("readonly: ทุก call เป็น staticcall · call ที่เขียน state ล้ม (aggregate ล้มหมด / tryAggregate รายงานรายตัว) · ใช้กับ query อ่านหลายค่าได้", () => {
  const { call, read } = chain();
  const reads = read(MC, "aggregate", { readonly: true, calls: [
    { target: T, fn: "name" }, { target: T, fn: "balanceOf", input: { who: OWNER } }, { target: C, fn: "get" },
    { target: MC, fn: "getChainId" }, { target: MC, fn: "getNativeBalance", input: { who: BOB } }] });
  assert.equal(reads.status, "success", JSON.stringify(reads.error));
  assert.deepEqual(reads.result, ["Coin", "1000n", "0n", "42n", "77n"]);
  assert.ok(reads.calls.slice(1).every((c) => c.type === "staticcall" || c.depth > 1));

  const strict = call("aggregate", { readonly: true, calls: [{ target: C, fn: "get" }, add("1n")] });
  assert.equal(strict.status, "throw");
  assert.match(strict.error.message, /อ่านอย่างเดียว/);
  const loose = call("tryAggregate", { readonly: true, calls: [{ target: C, fn: "get" }, add("1n")] });
  assert.equal(loose.status, "success");
  assert.deepEqual(loose.result[0], { success: true, result: "0n" });
  assert.equal(loose.result[1].success, false);
  assert.match(loose.result[1].error, /writeDB\(\) ใช้ไม่ได้ในการเรียกแบบอ่านอย่างเดียว/);
  assert.equal(read(C, "get").result, "0n");
  // ไม่ readonly → เขียนได้ตามปกติ
  assert.equal(call("tryAggregate", { calls: [add("1n")] }).result[0].success, true);
  assert.equal(read(C, "get").result, "1n");
});

test("ตัวช่วยของเชน: getBlockNumber / getChainId / getNativeBalance", () => {
  const { read, call } = chain();
  assert.equal(read(MC, "getChainId").result, "42n");
  assert.equal(read(MC, "getNativeBalance", { who: BOB }).result, "77n");
  assert.equal(call("getBlockNumber", {}).result, "2n");   // block ที่ 2 (block 1 = deploy)
});
