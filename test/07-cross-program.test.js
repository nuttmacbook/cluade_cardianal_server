import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { resetVM, ok, fails, activate, callAs, trace, stored, dbKeys, mockData } from "./helpers.js";
import { TOKEN, SHOP, REGISTRY, PROBE } from "./programs.js";

beforeEach(() => {
  resetVM();
  activate("token", TOKEN, { initInput: { supply: 1000 } }); // owner gets 1000
  activate("shop", SHOP, { initInput: { shopId: "shop", token: "token", price: 100 } });
  ok(callAs("owner", "token", "transfer", { to: "alice", amount: 300 }));
});

test("token: transfer / balanceOf / mint (owner only)", () => {
  assert.equal(stored("token", "balances", "owner"), "700n");
  assert.equal(stored("token", "balances", "alice"), "300n");

  fails(callAs("alice", "token", "transfer", { to: "bob", amount: 301 }), "PROGRAM_ERROR", "insufficient balance");
  fails(callAs("alice", "token", "transfer", { to: "bob", amount: -1 }), "PROGRAM_ERROR", "invalid amount");
  fails(callAs("alice", "token", "mint", { to: "alice", amount: 1 }), "PROGRAM_ERROR", "not the owner");

  assert.equal(ok(callAs("owner", "token", "mint", { to: "bob", amount: 50 })).result, "1050n");
  assert.equal(ok(callAs("x", "token", "balanceOf", { account: "bob" })).result, "50n");
});

test("token: transfer to self leaves the balance unchanged", () => {
  const res = ok(callAs("alice", "token", "transfer", { to: "alice", amount: 100 }));
  assert.equal(stored("token", "balances", "alice"), "300n");
  assert.deepEqual(res.afterValues, [{ dbKey: "token:storage:balances:alice", afterValue: "300n", changed: false }]);
});

test("shop.buy: charges the user through token (cross-program) and saves shop data in one request", () => {
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

test("shop.buy: no approve → everything throws, no data changes", () => {
  const before = new Map(mockData);
  const res = fails(callAs("alice", "shop", "buy"), "PROGRAM_ERROR", "insufficient allowance");
  assert.deepEqual(trace(res), ["0:shop.buy:throw:PROGRAM_ERROR", "1:token.transferFrom:throw:PROGRAM_ERROR"]);
  assert.deepEqual(new Map(mockData), before);
});

test("shop.buySafe: token fails but shop catches → success, only shop's log is saved", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 50 }));
  const res = ok(callAs("alice", "shop", "buySafe"));

  assert.equal(res.result, false);
  assert.deepEqual(trace(res), ["0:shop.buySafe:success", "1:token.transferFrom:throw:PROGRAM_ERROR"]);
  assert.deepEqual(dbKeys(res), ["put shop:storage:attempts:alice", "put shop:storage:failed:alice"]);
  assert.equal(stored("shop", "failed", "alice"), "insufficient allowance");
  assert.equal(stored("token", "allowance", "alice", "shop"), "50n");
});

test("shop.buyMany: 3rd item runs out of funds, no catch → all 3 items revert", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 1000 }));
  const res = fails(callAs("alice", "shop", "buyMany", { qty: 4 }), "PROGRAM_ERROR", "insufficient balance");
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

test("shop.buyMany: all purchases succeed → balances and data are correct in every program", () => {
  ok(callAs("alice", "token", "approve", { spender: "shop", amount: 1000 }));
  const res = ok(callAs("alice", "shop", "buyMany", { qty: 3 }));
  assert.deepEqual(res.result, ["1n", "2n", "3n"]);
  assert.equal(stored("token", "balances", "alice"), "0n");
  assert.equal(stored("token", "balances", "shop"), "300n");
  assert.equal(stored("shop", "sales"), "3n");
});

test("an intermediary program cannot change token data on the user's behalf: sender is the program, not the user", () => {
  activate("probe", PROBE);
  const res = fails(callAs("alice", "probe", "relay", { target: "token", fn: "transfer", args: { to: "probe", amount: 1 } }), "PROGRAM_ERROR", "insufficient balance");
  assert.equal(res.calls[1].sender, "probe");
  assert.equal(stored("token", "balances", "alice"), "300n");
});

test("registry: writes to another program only through that program's functions", () => {
  activate("registry", REGISTRY);
  activate("probe", PROBE);
  const res = ok(callAs("alice", "probe", "relay", { target: "registry", fn: "register" }));
  assert.deepEqual(res.result, { sender: "probe", origin: "alice" });
  assert.deepEqual(dbKeys(res), ["put registry:storage:members:probe"]);
  assert.equal(stored("registry", "members", "probe"), "alice");
});

test("reads data another program just wrote in the same request (through that program's functions)", () => {
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
