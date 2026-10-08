/** ทดสอบโปรแกรมในเครื่องก่อน deploy: node --test client/token.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeApi } from "./program-globals.js";
import program from "./token.program.js";

const api = createFakeApi({ self: "0xtoken" });
Object.assign(globalThis, api);          // ใส่ API ให้เหมือนตอน VM รัน
const { transfer, myBalance } = program();
const alice = { sender: "alice", origin: "alice" };

test("โอนแล้วยอดลด", () => {
  api.store.set("balances:alice", 100);
  transfer({ input: { to: "bob", amount: 30 }, context: alice, value: 0, block: { timestamp: 0 } });
  assert.equal(api.store.get("balances:alice"), 70);
  assert.equal(api.store.get("balances:bob"), 30);
});

test("ยอดไม่พอ", () => {
  api.store.set("balances:alice", 1);
  assert.throws(() => transfer({ input: { to: "bob", amount: 5 }, context: alice }), /ยอดไม่พอ/);
});

test("ฟังก์ชันภายในไม่ถูก export", () => {
  assert.equal(program().balanceOf, undefined);
  assert.equal(typeof myBalance, "function");
});

test("String(program) ส่งผ่าน API ได้ (ไม่มีคำว่า export ติดไป)", () => {
  const code = String(program);
  assert.match(code, /^function program\(\)/);
  assert.equal(code.includes("export"), false);
});
