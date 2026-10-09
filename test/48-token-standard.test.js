import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM, checkTokenStandard, unescapeCode, ZERO_ADDRESS } from "../src/standards/token.js";
import { tokenInfo, tokenHoldings } from "../src/node/explorer-api.js";

/* มาตรฐาน token (name / ticker / decimals + event Transfer / Approval) และรายการเหรียญที่ address ถือ (นับจาก event Transfer) */

const T = "0x00000000000000000000000000000000000000f1";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000B2";   // ตัวพิมพ์ใหญ่ปน
const CAROL = "0x00000000000000000000000000000000000000c3";

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { bigintValues: true, recordBlocks: true });
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

test("TOKEN_PROGRAM ผ่านมาตรฐาน · โปรแกรมที่ขาดฟังก์ชัน / event ไม่ผ่าน และบอกว่าขาดอะไร", () => {
  assert.deepEqual(checkTokenStandard(TOKEN_PROGRAM), { ok: true, missing: [] });
  const noEvents = TOKEN_PROGRAM.replace(/emit\("Approval"[^\n]*\n/, "");
  assert.deepEqual(checkTokenStandard(noEvents).missing, ["event Approval"]);
  const noTicker = TOKEN_PROGRAM.replace("name, ticker, decimals,", "name, decimals,");
  assert.deepEqual(checkTokenStandard(noTicker).missing, ["ticker"]);
  // โค้ดที่ VM เก็บไว้เป็นแบบ escape (\\n) ก็ตรวจได้
  assert.equal(checkTokenStandard(JSON.stringify(TOKEN_PROGRAM).slice(1, -1)).ok, true);
  assert.equal(unescapeCode("a\\nb"), "a\nb");
});

test("token 6 decimals: name / ticker / decimals / totalSupply อ่านได้ และ mint emit Transfer จาก zero address", () => {
  const { vm } = chain();
  assert.deepEqual(tokenInfo(vm, T), { address: T, name: "Thai Baht Coin", ticker: "THBC", decimals: "6n", totalSupply: "1000000000000n" });
  const [mint] = vm.listEvents({ program: T, name: "Transfer" });
  assert.deepEqual(mint.data, { from: ZERO_ADDRESS, to: OWNER, amount: "1000000000000n" });
  assert.equal(tokenInfo(vm, OWNER), null);   // ไม่ใช่โปรแกรม
});

test("transfer / approve / transferFrom emit Transfer + Approval และยอดถูกต้องตามหน่วยเล็กสุด", () => {
  const { vm, call } = chain();
  assert.equal(call(OWNER, "transfer", { to: BOB, amount: "1500000n" }).status, "success");          // 1.5 THBC
  assert.equal(call(BOB, "approve", { spender: CAROL, amount: "1000000n" }).status, "success");
  const moved = call(CAROL, "transferFrom", { from: BOB, to: CAROL, amount: "400000n" });
  assert.equal(moved.status, "success");
  assert.deepEqual(moved.events.map((e) => e.name), ["Transfer"]);
  assert.equal(call(CAROL, "transferFrom", { from: BOB, to: CAROL, amount: "700000n" }).status, "throw");   // วงเงินเหลือ 600000
  const read = (fn, input) => vm.query({ programUuid: T, functionName: fn, input }).result;
  assert.equal(read("balanceOf", { who: BOB }), "1100000n");
  assert.equal(read("balanceOf", { who: CAROL }), "400000n");
  assert.equal(read("allowance", { owner: BOB, spender: CAROL }), "600000n");
  assert.deepEqual(vm.listEvents({ program: T, name: "Approval" })[0].data,
    { owner: BOB.toLowerCase(), spender: CAROL, amount: "1000000n" });
});

test("เหรียญที่ถือ: มาจาก event Transfer ที่ส่งมาถึง address · ยอดเป็น 0 แล้วหายจากรายการ · tx ที่ล้มเหลวไม่นับ", () => {
  const { vm, call } = chain();
  assert.deepEqual(tokenHoldings(vm, BOB), []);
  assert.equal(call(BOB, "transfer", { to: CAROL, amount: "1n" }).status, "throw");   // ไม่มียอด → ไม่เกิด index
  assert.deepEqual(vm.listHoldings(CAROL), []);

  call(OWNER, "transfer", { to: BOB, amount: "2500000n" });
  const [held] = tokenHoldings(vm, BOB);
  assert.deepEqual({ ticker: held.ticker, decimals: held.decimals, balance: held.balance }, { ticker: "THBC", decimals: "6n", balance: "2500000n" });
  assert.equal(tokenHoldings(vm, OWNER)[0].balance, "999997500000n");
  assert.deepEqual(vm.listHoldings(ZERO_ADDRESS), []);                               // zero address ไม่ถูกนับ

  call(BOB, "transfer", { to: CAROL, amount: "2500000n" });                          // โอนออกหมด
  assert.deepEqual(tokenHoldings(vm, BOB), []);
  assert.equal(tokenHoldings(vm, CAROL)[0].balance, "2500000n");
});

test("โปรแกรมที่ emit Transfer แต่ไม่ใช่ token ตามมาตรฐาน → ไม่แสดงในเหรียญที่ถือ", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { bigintValues: true, recordBlocks: true });
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
