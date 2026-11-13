import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM, checkTokenStandard, unescapeCode, ZERO_ADDRESS } from "../src/standards/token.js";
import { tokenInfo, tokenHoldings } from "../src/node/explorer-api.js";
import { reviewProgram } from "../src/core/autoreview.js";

/* token standard (name / ticker / decimals + Transfer / Approval events) and the list of tokens an address holds (counted from Transfer events) */

const T = "0x00000000000000000000000000000000000000f1";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000B2";   // mixed case
const CAROL = "0x00000000000000000000000000000000000000c3";

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  let number = 0;
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: number * 1000, feeRecipient: OWNER });
    const results = fn(b);
    b.commit();
    return results;
  };
  const as = (who) => ({ sender: who.toLowerCase(), origin: who.toLowerCase() });
  block((b) => [
    b.deploy({ programUuid: T, code: TOKEN_PROGRAM, context: as(OWNER),
      initInput: { name: "Thai Baht Coin", ticker: "THBC", decimals: "6n", supply: "1000000000000n" } }),   // 1,000,000.000000
    b.init({ programUuid: T }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const call = (who, functionName, input) => block((b) => b.call({ programUuid: T, functionName, input, context: as(who) }));
  return { vm, call };
}

test("TOKEN_PROGRAM meets the standard · programs missing functions / events fail and report what is missing", () => {
  assert.deepEqual(checkTokenStandard(TOKEN_PROGRAM), { ok: true, missing: [] });
  assert.deepEqual(reviewProgram(TOKEN_PROGRAM).issues, []);   // can be deployed via /sendtx (autoreview)
  const noEvents = TOKEN_PROGRAM.replace(/emit\("Approval"[^\n]*\n/, "");
  assert.deepEqual(checkTokenStandard(noEvents).missing, ["event Approval"]);
  const noTicker = TOKEN_PROGRAM.replace("name, ticker, decimals,", "name, decimals,");
  assert.deepEqual(checkTokenStandard(noTicker).missing, ["ticker"]);
  // code stored escaped by the VM (\\n) can be checked too
  assert.equal(checkTokenStandard(JSON.stringify(TOKEN_PROGRAM).slice(1, -1)).ok, true);
  assert.equal(unescapeCode("a\\nb"), "a\nb");
});

test("token 6 decimals: name / ticker / decimals / totalSupply are readable, and mint emits Transfer from the zero address", () => {
  const { vm } = chain();
  assert.deepEqual(tokenInfo(vm, T), { address: T, name: "Thai Baht Coin", ticker: "THBC", decimals: "6n", totalSupply: "1000000000000n" });
  const [mint] = vm.listEvents({ program: T, name: "Transfer" });
  assert.deepEqual(mint.data, { from: ZERO_ADDRESS, to: OWNER, amount: "1000000000000n" });
  assert.equal(tokenInfo(vm, OWNER), null);   // not a program
});

test("token: icon / url / contact / description sent at deploy become program metadata", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const context = { sender: OWNER, origin: OWNER };
  for (const res of [
    vm.deploy({ programUuid: T, code: TOKEN_PROGRAM, context, initInput: { name: "A", ticker: "A", decimals: "6n", supply: "1n",
      icon: "https://a.test/a.png", url: "https://a.test", contact: "team@a.test" } }),
  ]) vm.commit(res.writes);
  vm.commit(vm.init({ programUuid: T }).writes);
  const meta = vm.getMetadata(T);
  assert.deepEqual({ icon: meta.icon, url: meta.url, contact: meta.contact, description: meta.description },
    { icon: "https://a.test/a.png", url: "https://a.test", contact: "team@a.test", description: undefined });
});

test("transfer / approve / transferFrom emit Transfer + Approval, and balances are correct in the smallest unit", () => {
  const { vm, call } = chain();
  assert.equal(call(OWNER, "transfer", { to: BOB, amount: "1500000n" }).status, "success");          // 1.5 THBC
  assert.equal(call(BOB, "approve", { spender: CAROL, amount: "1000000n" }).status, "success");
  const moved = call(CAROL, "transferFrom", { from: BOB, to: CAROL, amount: "400000n" });
  assert.equal(moved.status, "success");
  assert.deepEqual(moved.events.map((e) => e.name), ["Transfer"]);
  assert.equal(call(CAROL, "transferFrom", { from: BOB, to: CAROL, amount: "700000n" }).status, "throw");   // allowance left is 600000
  const read = (fn, input) => vm.query({ programUuid: T, functionName: fn, input }).result;
  assert.equal(read("balanceOf", { who: BOB }), "1100000n");
  assert.equal(read("balanceOf", { who: CAROL }), "400000n");
  assert.equal(read("allowance", { owner: BOB, spender: CAROL }), "600000n");
  assert.deepEqual(vm.listEvents({ program: T, name: "Approval" })[0].data,
    { owner: BOB.toLowerCase(), spender: CAROL, amount: "1000000n" });
});

test("holdings: come from Transfer events to the address · drop off the list at 0 · failed txs are not counted", () => {
  const { vm, call } = chain();
  assert.deepEqual(tokenHoldings(vm, BOB), []);
  assert.equal(call(BOB, "transfer", { to: CAROL, amount: "1n" }).status, "throw");   // no balance → no index entry
  assert.deepEqual(vm.listHoldings(CAROL), []);

  call(OWNER, "transfer", { to: BOB, amount: "2500000n" });
  const [held] = tokenHoldings(vm, BOB);
  assert.deepEqual({ ticker: held.ticker, decimals: held.decimals, balance: held.balance }, { ticker: "THBC", decimals: "6n", balance: "2500000n" });
  assert.equal(tokenHoldings(vm, OWNER)[0].balance, "999997500000n");
  assert.deepEqual(vm.listHoldings(ZERO_ADDRESS), []);                               // zero address is not counted

  call(BOB, "transfer", { to: CAROL, amount: "2500000n" });                          // transfer everything out
  assert.deepEqual(tokenHoldings(vm, BOB), []);
  assert.equal(tokenHoldings(vm, CAROL)[0].balance, "2500000n");
});

test("a program that emits Transfer but is not a standard token → not shown in holdings", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  const fake = `function program() {
  function poke(params) { emit("Transfer", { from: params.context.sender, to: params.input.to, amount: 1n }) }
  return { poke }
}`;
  const b = vm.createBlock({ number: 1, timestamp: 1, feeRecipient: OWNER });
  b.deploy({ programUuid: "0x00000000000000000000000000000000000000ee", code: fake, context: { sender: OWNER, origin: OWNER } });
  b.init({ programUuid: "0x00000000000000000000000000000000000000ee" });
  b.call({ programUuid: "0x00000000000000000000000000000000000000ee", functionName: "poke", input: { to: BOB }, context: { sender: OWNER, origin: OWNER } });
  b.commit();
  assert.equal(vm.listHoldings(BOB).length, 1);
  assert.deepEqual(tokenHoldings(vm, BOB), []);
});
