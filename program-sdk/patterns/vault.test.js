/** Safe pattern tests: node --test patterns/vault.test.js */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createChain } from "../lib/testkit.js";
import program from "./vault.program.js";

const setup = () => {
  const chain = createChain({ balances: { alice: 1000, bob: 1000 } });
  return { chain, vault: chain.deploy(program, { as: "owner" }) };
};

test("deposit / withdraw normally", () => {
  const { chain, vault } = setup();
  assert.equal(vault.callRaw("deposit", {}, { as: "alice", value: 300 }).result, "300n");   // return values are "123n"
  assert.equal(vault.call("withdraw", { amount: 100 }, { as: "alice" }), "200n");
  assert.equal(chain.balanceOf("alice").balance, 800n);
});

test("modifier onlyOwner: others cannot pause", () => {
  const { vault } = setup();
  assert.throws(() => vault.call("setPaused", { paused: true }, { as: "alice" }), /not the owner/);
  assert.equal(vault.call("setPaused", { paused: true }, { as: "owner" }), true);
  assert.throws(() => vault.call("deposit", {}, { as: "alice", value: 10 }), /deposits temporarily paused/);
});

test("validate inputs", () => {
  const { vault } = setup();
  vault.callRaw("deposit", {}, { as: "alice", value: 100 });
  for (const amount of [0, -5, "10"]) {
    assert.throws(() => vault.call("withdraw", { amount }, { as: "alice" }), /invalid amount/);
  }
  // decimals can't convert to BigInt → the VM rejects before reaching the program (VM message, kept in Thai)
  assert.throws(() => vault.call("withdraw", { amount: 1.5 }, { as: "alice" }), /ต้องเป็น BigInt/);
  assert.throws(() => vault.call("withdraw", { amount: 999 }, { as: "alice" }), /insufficient balance/);
});

test("events are recorded", () => {
  const { vault } = setup();
  const res = vault.callRaw("deposit", {}, { as: "alice", value: 50 });
  assert.deepEqual(res.events.map((event) => event.name), ["Deposited"]);
  assert.deepEqual(res.events[0].data, { who: "alice", amount: "50n" });
});
