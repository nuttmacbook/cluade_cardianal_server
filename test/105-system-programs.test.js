import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { systemPrograms, factorySalt, WCARD_PROGRAM, MULTISIG_PROGRAM, FACTORY_PROGRAM } from "../src/standards/system.js";
import { checkTokenStandard } from "../src/standards/token.js";
import { MULTICALL_PROGRAM } from "../src/standards/multicall.js";
import { checkNftStandard } from "../src/standards/nft.js";
import { checkMultiTokenStandard } from "../src/standards/multitoken.js";
import { reviewProgram } from "../src/core/autoreview.js";
import { approvedProgramAddresses } from "../src/node/explorer-api.js";
import { ERC1271_MAGIC_VALUE, ERC1271_INVALID_VALUE } from "../src/standards/wallet.js";

/*
 * ชุดโปรแกรมกลาง (src/standards/system.js): Multicall · WCARD · Multisig · ต้นแบบ token / NFT / multi-token · Factory
 *   deploy ตามลำดับ nonce ของ deployer → address ตรงกับแผน (systemPrograms) · ชื่อ (namespace) ตั้งตอน initialization
 */

const T = Date.parse("2026-10-27T00:00:00Z");
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b1";
const CAROL = "0x00000000000000000000000000000000000000c1";
const DAVE = "0x00000000000000000000000000000000000000d2";
const COIN = 10n ** 18n;

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, chainId: 272727, requireNonce: true, recordTransactions: true, recordBlocks: true });
  vm.db.load(Object.fromEntries([DEPLOYER, ALICE, BOB, CAROL, DAVE].map((a) => [VM.nativeKey(a, "received"), `${1000n * COIN}n`])));
  const nonces = {};
  let time = T;
  const nextNonce = (who) => {
    nonces[who] = (nonces[who] ?? -1) + 1;
    return nonces[who];
  };
  const block = (fn) => {
    const b = vm.createBlock({ timestamp: (time += 1000) });
    const out = fn(b);
    b.commit();
    return out;
  };
  const ok = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return res;
  };
  const send = (who, programUuid, functionName, input = {}, extra = {}) => block((b) =>
    b.call({ programUuid, functionName, input, context: { sender: who, origin: who }, nonce: nextNonce(who), gasLimit: 1_000_000, ...extra }));
  const query = (programUuid, functionName, input = {}) => ok(vm.query({ programUuid, functionName, input })).result;
  const balance = (who) => BigInt(vm.nativeBalanceOf(who).balance);

  const plan = systemPrograms({ addressAt: (n) => vm.programAddressFor(DEPLOYER, n) });
  for (const item of plan) {
    block((b) => {
      ok(b.deploy({ code: item.code, context: { sender: DEPLOYER, origin: DEPLOYER }, initInput: item.input, nonce: nextNonce(DEPLOYER), gasLimit: 1_000_000 }));
      ok(b.init({ programUuid: item.address }));
    });
  }
  const at = Object.fromEntries(plan.map((item) => [item.key, item.address]));
  return { vm, plan, at, send, ok, query, balance };
}

test("system: deploy ตามลำดับ nonce → address ตรงแผน · มีชื่อ · อนุมัติแล้ว · ไม่มี upgrader", () => {
  const t = setup();
  assert.deepEqual(t.plan.map((item) => item.key), ["multicall", "wcard", "multisigTemplate", "tokenTemplate", "nftTemplate", "multiTokenTemplate", "factory"]);
  assert.deepEqual(t.plan.map((item) => item.nonce), [0, 1, 2, 3, 4, 5, 6]);
  const approved = approvedProgramAddresses(t.vm);
  for (const item of t.plan) {
    assert.equal(item.address, t.vm.programAddressFor(DEPLOYER, item.nonce));
    assert.ok(approved.includes(item.address), item.key);
    assert.equal(t.vm.resolveNamespace(item.namespace), item.address, item.namespace);
    assert.equal(t.vm.getMetadata(item.address).upgrader, undefined, `${item.key} แก้ไม่ได้`);
  }
  assert.deepEqual(t.plan.map((item) => item.namespace),
    ["multicall", "wcard", "multisig-template", "token-template", "nft-template", "multitoken-template", "factory"]);
  assert.deepEqual(t.query(t.at.factory, "templates"),
    { token: t.at.tokenTemplate, nft: t.at.nftTemplate, multiToken: t.at.multiTokenTemplate, multisig: t.at.multisigTemplate });
  // ต้นแบบ token ไม่มี supply (ไม่มี event Transfer ตอนสร้าง)
  assert.equal(t.query(t.at.tokenTemplate, "totalSupply"), "0n");
  // Multicall อ่านหลายค่าในครั้งเดียว
  assert.deepEqual(t.query(t.at.multicall, "aggregate", { readonly: true, calls: [
    { target: t.at.wcard, fn: "ticker" }, { target: t.at.factory, fn: "count" }] }), ["WCARD", "0n"]);
});

test("system: สัญลักษณ์เหรียญหลักเปลี่ยนได้ → ชื่อ WCARD ตาม (เช่น WBNB / wbnb)", () => {
  const plan = systemPrograms({ addressAt: (n) => `0x${String(n).padStart(40, "0")}`, symbol: "BNB" });
  const wrapped = plan.find((item) => item.key === "wcard");
  assert.equal(wrapped.namespace, "wbnb");
  assert.equal(wrapped.input.ticker, "WBNB");
  assert.equal(wrapped.input.name, "Wrapped BNB");
});

test("system: โค้ดทุกตัวผ่าน autoreview และทำตามมาตรฐานที่เกี่ยวข้อง", () => {
  for (const code of [MULTICALL_PROGRAM, WCARD_PROGRAM, MULTISIG_PROGRAM, FACTORY_PROGRAM]) {
    const result = reviewProgram(code);
    assert.ok(result.ok, result.message);
  }
  assert.deepEqual(checkTokenStandard(WCARD_PROGRAM), { ok: true, missing: [] });
});

test("WCARD: ฝากได้ 1:1 · โอนได้ · ถอนคืนเป็นเหรียญหลัก", () => {
  const t = setup();
  const before = t.balance(ALICE);
  const dep = t.ok(t.send(ALICE, t.at.wcard, "deposit", {}, { value: `${5n * COIN}` }));
  assert.equal(dep.result, `${5n * COIN}n`);
  assert.deepEqual(dep.events.map((e) => e.name), ["Transfer", "Deposit"]);
  assert.equal(t.balance(ALICE), before - 5n * COIN);
  assert.equal(t.balance(t.at.wcard), 5n * COIN);
  assert.equal(t.query(t.at.wcard, "balanceOf", { who: ALICE }), `${5n * COIN}n`);
  assert.equal(t.query(t.at.wcard, "totalSupply"), `${5n * COIN}n`);
  assert.equal(t.query(t.at.wcard, "decimals"), "18n");

  t.ok(t.send(ALICE, t.at.wcard, "transfer", { to: BOB, amount: `${2n * COIN}n` }));
  t.ok(t.send(ALICE, t.at.wcard, "depositTo", { to: CAROL }, { value: `${1n * COIN}` }));
  assert.equal(t.query(t.at.wcard, "balanceOf", { who: CAROL }), `${COIN}n`);

  const bobBefore = t.balance(BOB);
  const out = t.ok(t.send(BOB, t.at.wcard, "withdraw", { amount: `${2n * COIN}n` }));
  assert.deepEqual(out.events.map((e) => e.name), ["Transfer", "Withdrawal"]);
  assert.equal(t.balance(BOB), bobBefore + 2n * COIN);
  assert.equal(t.query(t.at.wcard, "balanceOf", { who: BOB }), "0n");
  t.ok(t.send(CAROL, t.at.wcard, "withdrawTo", { to: DAVE, amount: `${COIN}n` }));
  assert.equal(t.balance(DAVE), 1001n * COIN);
  assert.equal(t.query(t.at.wcard, "totalSupply"), `${3n * COIN}n`);
  assert.equal(t.balance(t.at.wcard), 3n * COIN, "เหรียญหลักที่ฝากอยู่ = totalSupply");

  assert.equal(t.send(BOB, t.at.wcard, "withdraw", { amount: "1n" }).status, "throw", "ถอนเกินยอด");
  assert.equal(t.send(BOB, t.at.wcard, "deposit", {}).status, "throw", "ฝากโดยไม่แนบ value");
});

test("factory: ใครก็สร้าง token ได้ทันที (ไม่ต้องรอ admin) · supply เป็นของผู้สร้าง · address รู้ล่วงหน้า", () => {
  const t = setup();
  const code = t.vm.read(VM.codeKey(t.at.tokenTemplate));
  const expected = t.vm.cloneAddressFor(t.at.factory, factorySalt(ALICE, "#0"), code);
  const res = t.ok(t.send(ALICE, t.at.factory, "createToken", { name: "Alice Coin", ticker: "ALC", decimals: "6n", supply: "1000000n", description: "เหรียญของ alice" }));
  const token = res.result;
  assert.equal(token, expected);
  assert.ok(approvedProgramAddresses(t.vm).includes(token));
  assert.equal(t.vm.getMetadata(token).template, t.at.tokenTemplate);
  assert.equal(t.vm.getMetadata(token).description, "เหรียญของ alice");
  assert.deepEqual(checkTokenStandard(code), { ok: true, missing: [] });
  assert.equal(t.query(token, "balanceOf", { who: ALICE }), "1000000n");
  assert.equal(t.query(token, "name"), "Alice Coin");
  t.ok(t.send(ALICE, token, "transfer", { to: BOB, amount: "250n" }));
  assert.equal(t.query(token, "balanceOf", { who: BOB }), "250n");

  const created = res.events.find((e) => e.program === t.at.factory && e.name === "Created");
  assert.deepEqual(created.data, { kind: "token", address: token, creator: ALICE });
  assert.equal(t.query(t.at.factory, "count"), "1n");
  assert.deepEqual(t.query(t.at.factory, "created", { index: "0n" }), { kind: "token", address: token, creator: ALICE });
  assert.equal(t.query(t.at.factory, "createdCount", { creator: ALICE }), "1n");
  assert.equal(t.query(t.at.factory, "createdBy", { creator: ALICE, index: "0n" }), token);
  assert.equal(t.query(t.at.factory, "kindOf", { address: token }), "token");

  // salt เอง: address = f(ผู้สร้าง + salt) · ใช้ซ้ำไม่ได้ · คนอื่นใช้ salt เดียวกันได้ address คนละตัว
  const mine = t.ok(t.send(ALICE, t.at.factory, "createToken", { name: "A2", ticker: "A2", decimals: "0n", supply: "1n", salt: "launch" })).result;
  assert.equal(mine, t.vm.cloneAddressFor(t.at.factory, factorySalt(ALICE, "launch"), code));
  assert.equal(t.send(ALICE, t.at.factory, "createToken", { name: "A3", ticker: "A3", decimals: "0n", supply: "1n", salt: "launch" }).status, "throw");
  const bobs = t.ok(t.send(BOB, t.at.factory, "createToken", { name: "B", ticker: "B", decimals: "0n", supply: "1n", salt: "launch" })).result;
  assert.notEqual(bobs, mine);

  // ตรวจค่า
  for (const bad of [{ name: "", ticker: "X", decimals: "0n", supply: "1n" }, { name: "X", ticker: "X", decimals: "37n", supply: "1n" },
    { name: "X", ticker: "X", decimals: "0n", supply: "-1n" }, { name: "X", ticker: "X", decimals: "0n", supply: "1n", salt: "#9" }]) {
    assert.equal(t.send(CAROL, t.at.factory, "createToken", bad).status, "throw", JSON.stringify(bad));
  }
});

test("factory: NFT / multi-token ที่สร้างแล้ว ผู้สร้างเป็น owner (mint ได้) คนอื่น mint ไม่ได้", () => {
  const t = setup();
  const nft = t.ok(t.send(ALICE, t.at.factory, "createNft", { name: "Alice Art", symbol: "AART", baseURI: "https://a.example/" })).result;
  assert.deepEqual(checkNftStandard(t.vm.read(VM.codeKey(nft))), { ok: true, missing: [] });
  assert.equal(t.query(nft, "owner"), ALICE);
  assert.equal(t.ok(t.send(ALICE, nft, "mint", { to: BOB })).result, "1n");
  assert.equal(t.query(nft, "ownerOf", { tokenId: "1n" }), BOB);
  assert.equal(t.query(nft, "tokenURI", { tokenId: "1n" }), "https://a.example/1");
  assert.equal(t.send(BOB, nft, "mint", { to: BOB }).status, "throw");

  const items = t.ok(t.send(BOB, t.at.factory, "createMultiToken", { name: "Bob Items", uri: "https://b.example/{id}.json" })).result;
  assert.deepEqual(checkMultiTokenStandard(t.vm.read(VM.codeKey(items))), { ok: true, missing: [] });
  assert.equal(t.query(items, "owner"), BOB);
  t.ok(t.send(BOB, items, "mint", { to: CAROL, id: "7n", amount: "3n" }));
  assert.equal(t.query(items, "balanceOf", { account: CAROL, id: "7n" }), "3n");
  assert.equal(t.send(ALICE, items, "mint", { to: ALICE, id: "7n", amount: "1n" }).status, "throw");
  assert.equal(t.query(t.at.factory, "kindOf", { address: items }), "multiToken");
});

test("multisig: 2 ใน 3 · ยืนยันครบก่อนถึงทำได้ · โอนเหรียญหลัก + เรียกโปรแกรม", () => {
  const t = setup();
  const safe = t.ok(t.send(ALICE, t.at.factory, "createMultisig", { owners: [ALICE, BOB, CAROL], threshold: "2n", namespace: "team-safe" })).result;
  assert.equal(t.vm.resolveNamespace("team-safe"), safe);
  assert.deepEqual(t.query(safe, "owners"), [ALICE, BOB, CAROL]);
  assert.equal(t.query(safe, "threshold"), "2n");

  // เติมเงินเข้ากระเป๋าทีม
  t.ok(t.send(DAVE, safe, "deposit", {}, { value: `${10n * COIN}` }));
  assert.equal(t.balance(safe), 10n * COIN);

  // โอน 3 เหรียญให้ dave: alice เสนอ (ยืนยัน 1) → ยังทำไม่ได้ → bob ยืนยัน → ทำได้
  const id = t.ok(t.send(ALICE, safe, "submit", { target: DAVE, value: `${3n * COIN}n` })).result;
  assert.equal(id, "0n");
  assert.equal(t.send(ALICE, safe, "execute", { id: "0n" }).status, "throw", "ยืนยันยังไม่ครบ");
  assert.equal(t.send(DAVE, safe, "confirm", { id: "0n" }).status, "throw", "คนนอกยืนยันไม่ได้");
  assert.equal(t.send(ALICE, safe, "confirm", { id: "0n" }).status, "throw", "ยืนยันซ้ำไม่ได้");
  t.ok(t.send(BOB, safe, "confirm", { id: "0n" }));
  assert.equal(t.query(safe, "getTransaction", { id: "0n" }).confirmations, "2n");
  const daveBefore = t.balance(DAVE);
  t.ok(t.send(CAROL, safe, "execute", { id: "0n" }));
  assert.equal(t.balance(DAVE), daveBefore + 3n * COIN);
  assert.equal(t.balance(safe), 7n * COIN);
  assert.equal(t.query(safe, "getTransaction", { id: "0n" }).executed, true);
  assert.equal(t.send(BOB, safe, "execute", { id: "0n" }).status, "throw", "ทำซ้ำไม่ได้");

  // เรียกโปรแกรม: กระเป๋าทีมฝากเข้า WCARD (แนบ value) → WCARD เป็นของกระเป๋าทีม
  t.ok(t.send(BOB, safe, "submit", { target: t.at.wcard, fn: "deposit", value: `${2n * COIN}n` }));
  t.ok(t.send(CAROL, safe, "confirm", { id: "1n" }));
  t.ok(t.send(BOB, safe, "execute", { id: "1n" }));
  assert.equal(t.query(t.at.wcard, "balanceOf", { who: safe }), `${2n * COIN}n`);

  // revoke: ถอนแล้วยืนยันไม่ครบ
  t.ok(t.send(ALICE, safe, "submit", { target: DAVE, value: "1n" }));
  t.ok(t.send(BOB, safe, "confirm", { id: "2n" }));
  t.ok(t.send(BOB, safe, "revoke", { id: "2n" }));
  assert.equal(t.send(ALICE, safe, "execute", { id: "2n" }).status, "throw");

  assert.equal(t.send(DAVE, safe, "submit", { target: DAVE, value: "1n" }).status, "throw", "คนนอกเสนอไม่ได้");
});

test("multisig: เปลี่ยนเจ้าของ / threshold / รับรองลายเซ็น ได้เฉพาะผ่านรายการของ multisig เอง", () => {
  const t = setup();
  const safe = t.ok(t.send(ALICE, t.at.factory, "createMultisig", { owners: [ALICE, BOB], threshold: "2n" })).result;
  assert.equal(t.send(ALICE, safe, "addOwner", { owner: CAROL }).status, "throw", "เรียกตรงไม่ได้");

  const run = (input) => {
    const id = t.ok(t.send(ALICE, safe, "submit", { target: safe, ...input })).result;
    t.ok(t.send(BOB, safe, "confirm", { id }));
    return t.ok(t.send(BOB, safe, "execute", { id }));
  };
  run({ fn: "addOwner", input: { owner: CAROL, threshold: "3n" } });
  assert.deepEqual(t.query(safe, "owners"), [ALICE, BOB, CAROL]);
  assert.equal(t.query(safe, "threshold"), "3n");

  // threshold 3: ต้องครบ 3 คน
  const id = t.ok(t.send(ALICE, safe, "submit", { target: safe, fn: "removeOwner", input: { owner: BOB } })).result;
  t.ok(t.send(BOB, safe, "confirm", { id }));
  assert.equal(t.send(BOB, safe, "execute", { id }).status, "throw");
  t.ok(t.send(CAROL, safe, "confirm", { id }));
  t.ok(t.send(CAROL, safe, "execute", { id }));
  assert.deepEqual(t.query(safe, "owners"), [ALICE, CAROL]);
  assert.equal(t.query(safe, "threshold"), "2n", "threshold ลดลงตามจำนวนเจ้าของ");

  // ERC-1271: digest ที่ทีมรับรองแล้ว → magic
  const hash = `0x${"ab".repeat(32)}`;
  assert.equal(t.query(safe, "isValidSignature", { hash, signature: "0x" }), ERC1271_INVALID_VALUE);
  const approveId = t.ok(t.send(ALICE, safe, "submit", { target: safe, fn: "approveHash", input: { hash } })).result;
  t.ok(t.send(CAROL, safe, "confirm", { id: approveId }));
  t.ok(t.send(CAROL, safe, "execute", { id: approveId }));
  assert.equal(t.query(safe, "isValidSignature", { hash, signature: "0x" }), ERC1271_MAGIC_VALUE);
});

test("multisig: ค่าเริ่มต้นผิด → สร้างไม่ได้ · ต้นแบบไม่มีเจ้าของ ทำอะไรไม่ได้", () => {
  const t = setup();
  for (const bad of [{ owners: [], threshold: "1n" }, { owners: [ALICE, ALICE], threshold: "1n" }, { owners: [ALICE], threshold: "2n" },
    { owners: [ALICE], threshold: "0n" }, { owners: ["alice"], threshold: "1n" }]) {
    assert.equal(t.send(ALICE, t.at.factory, "createMultisig", bad).status, "throw", JSON.stringify(bad));
  }
  assert.deepEqual(t.query(t.at.multisigTemplate, "owners"), []);
  assert.equal(t.send(DEPLOYER, t.at.multisigTemplate, "submit", { target: ALICE, value: "1n" }).status, "throw");
});
