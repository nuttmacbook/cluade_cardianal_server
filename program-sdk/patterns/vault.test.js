/** ทดสอบ pattern ปลอดภัย: node --test patterns/vault.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChain } from "../lib/testkit.js";
import program from "./vault.program.js";

const setup = () => {
  const chain = createChain({ balances: { alice: 1000, bob: 1000 } });
  return { chain, vault: chain.deploy(program, { as: "owner" }) };
};

test("deposit / withdraw ปกติ", () => {
  const { chain, vault } = setup();
  assert.equal(vault.callRaw("deposit", {}, { as: "alice", value: 300 }).result, 300);
  assert.equal(vault.call("withdraw", { amount: 100 }, { as: "alice" }), 200);
  assert.equal(chain.balanceOf("alice").balance, 800);
});

test("modifier onlyOwner: คนอื่นสั่งหยุดไม่ได้", () => {
  const { vault } = setup();
  assert.throws(() => vault.call("setPaused", { paused: true }, { as: "alice" }), /ไม่ใช่เจ้าของ/);
  assert.equal(vault.call("setPaused", { paused: true }, { as: "owner" }), true);
  assert.throws(() => vault.call("deposit", {}, { as: "alice", value: 10 }), /ปิดรับฝาก/);
});

test("ตรวจค่าที่รับมา", () => {
  const { vault } = setup();
  vault.callRaw("deposit", {}, { as: "alice", value: 100 });
  for (const amount of [0, -5, 1.5, "10"]) {
    assert.throws(() => vault.call("withdraw", { amount }, { as: "alice" }), /amount ไม่ถูกต้อง/);
  }
  assert.throws(() => vault.call("withdraw", { amount: 999 }, { as: "alice" }), /ยอดไม่พอ/);
});

test("event ถูกบันทึก", () => {
  const { vault } = setup();
  const res = vault.callRaw("deposit", {}, { as: "alice", value: 50 });
  assert.deepEqual(res.events.map((event) => event.name), ["Deposited"]);
  assert.deepEqual(res.events[0].data, { who: "alice", amount: 50 });
});
