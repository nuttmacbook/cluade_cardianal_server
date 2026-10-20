import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetVM, ok, fails, activate, callAs, trace, stored, dbKeys, mockData } from "./helpers.js";
import { TOKEN, SHOP, REGISTRY, PROBE } from "./programs.js";

beforeEach(() => {
  resetVM();
  activate("token", TOKEN, { initInput: { supply: 1000 } }); // owner ได้ 1000
  activate("shop", SHOP, { initInput: { shopId: "shop", token: "token", price: 100 } });
  ok(callAs("owner", "token", "transfer", { to: "alice", amount: 300 }));
});

test("token: transfer / balanceOf / mint (สิทธิ์ owner)", () => {
  assert.equal(stored("token", "balances", "owner"), "700n");
  assert.equal(stored("token", "balances", "alice"), "300n");

  fails(callAs("alice", "token", "transfer", { to: "bob", amount: 301 }), "PROGRAM_ERROR", "ยอดไม่พอ");
  fails(callAs("alice", "token", "transfer", { to: "bob", amount: -1 }), "PROGRAM_ERROR", "amount ไม่ถูกต้อง");
  fails(callAs("alice", "token", "mint", { to: "alice", amount: 1 }), "PROGRAM_ERROR", "ไม่ใช่ owner");

  assert.equal(ok(callAs("owner", "token", "mint", { to: "bob", amount: 50 })).result, "1050n");
  assert.equal(ok(callAs("x", "token", "balanceOf", { account: "bob" })).result, "50n");
});

test("token: transfer ให้ตัวเอง ยอดไม่เปลี่ยน", () => {
  const res = ok(callAs("alice", "token", "transfer", { to: "alice", amount: 100 }));
  assert.equal(stored("token", "balances", "alice"), "300n");
  assert.deepEqual(res.afterValues, [{ dbKey: "token:storage:balances:alice", afterValue: "300n", changed: false }]);
});

test("shop.buy: หักเงิน user ผ่าน token (ข้ามโปรแกรม) และบันทึกข้อมูล shop ใน request เดียว", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 250 }));
  const res = ok(callAs("alice", "shop", "buy"));

  assert.equal(res.result, "1n");
  assert.deepEqual(trace(res), ["0:shop.buy:success", "1:token.transferFrom:success"]);
  assert.deepEqual(res.calls[1].sender, "shop");
  assert.deepEqual(res.calls[1].origin, "alice");
  assert.deepEqual(dbKeys(res), [
    "put token:storage:allowance:alice:shop",
    "put token:storage:balances:alice",
    "put token:storage:balances:shop",
    "put shop:storage:items:alice",
    "put shop:storage:sales",
  ]);
  assert.equal(stored("token", "balances", "alice"), "200n");
  assert.equal(stored("token", "balances", "shop"), "100n");
  assert.equal(stored("token", "allowance", "alice", "shop"), "150n");
  assert.equal(stored("shop", "items", "alice"), "1n");
  assert.equal(stored("shop", "sales"), "1n");
});

test("shop.buy: ไม่ได้ approve → throw ทั้งหมด ไม่มีข้อมูลเปลี่ยน", () => {
  const before = new Map(mockData);
  const res = fails(callAs("alice", "shop", "buy"), "PROGRAM_ERROR", "allowance ไม่พอ");
  assert.deepEqual(trace(res), ["0:shop.buy:throw:PROGRAM_ERROR", "1:token.transferFrom:throw:PROGRAM_ERROR"]);
  assert.deepEqual(new Map(mockData), before);
});

test("shop.buySafe: token ล้มแต่ shop catch → success, บันทึกเฉพาะ log ของ shop", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 50 }));
  const res = ok(callAs("alice", "shop", "buySafe"));

  assert.equal(res.result, false);
  assert.deepEqual(trace(res), ["0:shop.buySafe:success", "1:token.transferFrom:throw:PROGRAM_ERROR"]);
  assert.deepEqual(dbKeys(res), ["put shop:storage:attempts:alice", "put shop:storage:failed:alice"]);
  assert.equal(stored("shop", "failed", "alice"), "allowance ไม่พอ");
  assert.equal(stored("token", "allowance", "alice", "shop"), "50n");
});

test("shop.buyMany: ชิ้นที่ 3 เงินไม่พอ ไม่มี catch → ย้อนทั้ง 3 ชิ้น", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 1000 }));
  const res = fails(callAs("alice", "shop", "buyMany", { qty: 4 }), "PROGRAM_ERROR", "ยอดไม่พอ");
  assert.deepEqual(trace(res), [
    "0:shop.buyMany:throw:PROGRAM_ERROR",
    "1:token.transferFrom:success",
    "1:token.transferFrom:success",
    "1:token.transferFrom:success",
    "1:token.transferFrom:throw:PROGRAM_ERROR",
  ]);
  assert.equal(stored("token", "balances", "alice"), "300n");
  assert.equal(stored("shop", "items", "alice"), undefined);
});

test("shop.buyMany: ซื้อได้หมด → ยอดและข้อมูลถูกต้องทุกโปรแกรม", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 1000 }));
  const res = ok(callAs("alice", "shop", "buyMany", { qty: 3 }));
  assert.deepEqual(res.result, ["1n", "2n", "3n"]);
  assert.equal(stored("token", "balances", "alice"), "0n");
  assert.equal(stored("token", "balances", "shop"), "300n");
  assert.equal(stored("shop", "sales"), "3n");
});

test("โปรแกรมกลางแก้ข้อมูลของ token แทน user ไม่ได้: sender เป็นโปรแกรม ไม่ใช่ user", () => {
  activate("probe", PROBE);
  const res = fails(callAs("alice", "probe", "relay", { target: "token", fn: "transfer", args: { to: "probe", amount: 1 } }), "PROGRAM_ERROR", "ยอดไม่พอ");
  assert.equal(res.calls[1].sender, "probe");
  assert.equal(stored("token", "balances", "alice"), "300n");
});

test("registry: บันทึกข้อมูลลงโปรแกรมอื่นผ่านฟังก์ชันของโปรแกรมนั้นเท่านั้น", () => {
  activate("registry", REGISTRY);
  activate("probe", PROBE);
  const res = ok(callAs("alice", "probe", "relay", { target: "registry", fn: "register" }));
  assert.deepEqual(res.result, { sender: "probe", origin: "alice" });
  assert.deepEqual(dbKeys(res), ["put registry:storage:members:probe"]);
  assert.equal(stored("registry", "members", "probe"), "alice");
});

test("อ่านข้อมูลที่อีกโปรแกรมเพิ่งเขียนใน request เดียวกัน (ผ่านฟังก์ชันของโปรแกรมนั้น)", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 100 }));
  activate("probe", PROBE);
  const res = ok(callAs("alice", "probe", "relaySequence", {
    steps: [
      { target: "token", fn: "balanceOf", args: { account: "alice" } },
      { target: "shop", fn: "buy" },
      { target: "token", fn: "balanceOf", args: { account: "alice" } },
    ],
  }));
  assert.deepEqual(res.result, ["300n", "1n", "200n"]);
  assert.deepEqual(res.loadValues.find((v) => v.dbKey === "token:storage:balances:alice"), { dbKey: "token:storage:balances:alice", loadValue: "300n" });
  assert.deepEqual(res.afterValues.find((v) => v.dbKey === "token:storage:balances:alice"), { dbKey: "token:storage:balances:alice", afterValue: "200n", changed: true });
});
