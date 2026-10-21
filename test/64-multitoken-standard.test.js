import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { MULTITOKEN_PROGRAM, checkMultiTokenStandard, MULTITOKEN_INTERFACES } from "../src/standards/multitoken.js";
import { WALLET_PROGRAM } from "../src/standards/wallet.js";
import { MULTICALL_PROGRAM } from "../src/standards/multicall.js";
import { ZERO_ADDRESS, checkTokenStandard } from "../src/standards/token.js";
import { checkNftStandard } from "../src/standards/nft.js";
import { reviewProgram } from "../src/core/autoreview.js";

/* มาตรฐาน multi-token (คล้าย ERC-1155): balanceOf / balanceOfBatch / safeTransferFrom / safeBatchTransferFrom / mint / mintBatch / uri + event */

const G = "0x00000000000000000000000000000000000000f3";
const W = "0x00000000000000000000000000000000000000e1";
const M = "0x00000000000000000000000000000000000000e2";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
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
  const as = (who) => ({ sender: who, origin: who });
  block((b) => [
    b.deploy({ programUuid: G, code: MULTITOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Game Items", symbol: "ITEM", uri: "https://game.test/{id}.json" } }),
    b.init({ programUuid: G }),
    b.deploy({ programUuid: W, code: WALLET_PROGRAM, context: as(BOB) }),
    b.init({ programUuid: W }),
    b.deploy({ programUuid: M, code: MULTICALL_PROGRAM, context: as(BOB) }),
    b.init({ programUuid: M }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const call = (who, functionName, input) => block((b) => [b.call({ programUuid: G, functionName, input, context: as(who) })])[0];
  const read = (functionName, input = {}) => vm.query({ programUuid: G, functionName, input });
  return { vm, call, read };
}
const ok = (res) => { assert.equal(res.status, "success", JSON.stringify(res.error)); return res; };
const fails = (res, message) => { assert.equal(res.status, "throw"); assert.match(res.error.message, message); return res; };

test("MULTITOKEN_PROGRAM ผ่านมาตรฐาน multi-token และ autoreview · ไม่ถูกนับเป็น token / NFT", () => {
  assert.deepEqual(checkMultiTokenStandard(MULTITOKEN_PROGRAM), { ok: true, missing: [] });
  assert.deepEqual(reviewProgram(MULTITOKEN_PROGRAM).issues, []);
  assert.equal(checkTokenStandard(MULTITOKEN_PROGRAM).ok, false);
  assert.equal(checkNftStandard(MULTITOKEN_PROGRAM).ok, false);
  assert.deepEqual(checkMultiTokenStandard(MULTITOKEN_PROGRAM.replace(/emit\("TransferBatch"[^\n]*\n/, "")).missing, ["event TransferBatch"]);
});

test("mint / mintBatch: เจ้าของ / minter เท่านั้น · emit TransferSingle / TransferBatch จาก zero address · totalSupply ต่อ id", () => {
  const { call, read } = chain();
  const single = ok(call(OWNER, "mint", { to: BOB, id: "1n", amount: "100n" }));
  assert.deepEqual(single.events.map((e) => [e.name, e.data]),
    [["TransferSingle", { operator: OWNER, from: ZERO_ADDRESS, to: BOB, id: "1n", amount: "100n" }]]);
  const many = ok(call(OWNER, "mintBatch", { to: CAROL, ids: ["1n", "2n", "3n"], amounts: ["5n", "1n", "7n"] }));
  assert.deepEqual(many.events[0].data, { operator: OWNER, from: ZERO_ADDRESS, to: CAROL, ids: ["1n", "2n", "3n"], amounts: ["5n", "1n", "7n"] });
  fails(call(BOB, "mint", { to: BOB, id: "1n", amount: "1n" }), /only owner or minter/);
  ok(call(OWNER, "setMinter", { minter: BOB, allowed: true }));
  ok(call(BOB, "mint", { to: BOB, id: "9n", amount: "1n" }));
  fails(call(OWNER, "mintBatch", { to: BOB, ids: ["1n"], amounts: ["1n", "2n"] }), /length mismatch/);
  fails(call(OWNER, "mint", { to: BOB, id: "1n", amount: "-1n" }), /amount must be a non-negative bigint/);
  fails(call(OWNER, "mint", { to: ZERO_ADDRESS, id: "1n", amount: "1n" }), /zero address/);
  assert.equal(read("totalSupply", { id: "1n" }).result, "105n");
  assert.equal(read("balanceOf", { account: BOB, id: "1n" }).result, "100n");
  assert.deepEqual(read("balanceOfBatch", { accounts: [BOB, CAROL, CAROL, BOB], ids: ["1n", "1n", "3n", "3n"] }).result, ["100n", "5n", "7n", "0n"]);
  assert.match(read("balanceOfBatch", { accounts: [BOB], ids: [] }).error.message, /length mismatch/);
});

test("safeTransferFrom / safeBatchTransferFrom: เจ้าของหรือ operator · ยอดไม่พอ → ล้มทั้งชุด · emit พร้อม operator", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mintBatch", { to: BOB, ids: ["1n", "2n"], amounts: ["10n", "20n"] }));
  const moved = ok(call(BOB, "safeTransferFrom", { from: BOB, to: CAROL, id: "1n", amount: "4n" }));
  assert.deepEqual(moved.events[0], { ...moved.events[0], name: "TransferSingle", data: { operator: BOB, from: BOB, to: CAROL, id: "1n", amount: "4n" } });
  fails(call(CAROL, "safeTransferFrom", { from: BOB, to: CAROL, id: "1n", amount: "1n" }), /not owner nor approved/);
  fails(call(BOB, "safeTransferFrom", { from: BOB, to: CAROL, id: "1n", amount: "7n" }), /insufficient balance/);
  fails(call(BOB, "safeTransferFrom", { from: BOB, to: ZERO_ADDRESS, id: "1n", amount: "1n" }), /zero address/);

  const approval = ok(call(BOB, "setApprovalForAll", { operator: CAROL, approved: true }));
  assert.deepEqual(approval.events[0].data, { account: BOB, operator: CAROL, approved: true });
  assert.equal(read("isApprovedForAll", { account: BOB, operator: CAROL }).result, true);
  fails(call(CAROL, "safeBatchTransferFrom", { from: BOB, to: CAROL, ids: ["1n", "2n"], amounts: ["1n", "21n"] }), /insufficient balance/);
  assert.equal(read("balanceOf", { account: BOB, id: "1n" }).result, "6n");   // ตัวแรกในชุดถูกย้อนด้วย
  const batch = ok(call(CAROL, "safeBatchTransferFrom", { from: BOB, to: CAROL, ids: ["1n", "2n"], amounts: ["6n", "20n"] }));
  assert.deepEqual(batch.events[0].data, { operator: CAROL, from: BOB, to: CAROL, ids: ["1n", "2n"], amounts: ["6n", "20n"] });
  assert.deepEqual(read("balanceOfBatch", { accounts: [BOB, BOB, CAROL, CAROL], ids: ["1n", "2n", "1n", "2n"] }).result, ["0n", "0n", "10n", "20n"]);
});

test("ปลายทางเป็นโปรแกรม: ต้องตอบ onERC1155Received / onERC1155BatchReceived · ไม่ตอบ → ล้ม (รวมตอน mint)", () => {
  const { call, read } = chain();
  const single = ok(call(OWNER, "mint", { to: W, id: "1n", amount: "3n", data: "hi" }));
  assert.deepEqual(single.calls.find((c) => c.functionName === "onERC1155Received").input,
    { operator: OWNER, from: ZERO_ADDRESS, id: "1n", amount: "3n", data: "hi" });
  const batch = ok(call(OWNER, "mintBatch", { to: W, ids: ["2n"], amounts: ["1n"] }));
  assert.deepEqual(batch.calls.find((c) => c.functionName === "onERC1155BatchReceived").input,
    { operator: OWNER, from: ZERO_ADDRESS, ids: ["2n"], amounts: ["1n"], data: "" });
  fails(call(OWNER, "mint", { to: M, id: "1n", amount: "1n" }), /onERC1155Received/);
  assert.equal(read("balanceOf", { account: M, id: "1n" }).result, "0n");
});

test("uri: template ของโปรแกรม หรือ uri ของ id (setURI emit URI) · supportsInterface · burn ลด supply", () => {
  const { call, read } = chain();
  assert.equal(read("uri", { id: "5n" }).result, "https://game.test/{id}.json");
  const set = ok(call(OWNER, "setURI", { id: "5n", uri: "ipfs://five" }));
  assert.deepEqual(set.events[0].data, { value: "ipfs://five", id: "5n" });
  assert.equal(read("uri", { id: "5n" }).result, "ipfs://five");
  fails(call(BOB, "setURI", { id: "5n", uri: "x" }), /only owner/);
  for (const id of MULTITOKEN_INTERFACES) assert.equal(read("supportsInterface", { interfaceId: id }).result, true);
  assert.equal(read("supportsInterface", { interfaceId: "0x80ac58cd" }).result, false);

  ok(call(OWNER, "mint", { to: BOB, id: "5n", amount: "10n" }));
  fails(call(CAROL, "burn", { from: BOB, id: "5n", amount: "1n" }), /not owner nor approved/);
  const burned = ok(call(BOB, "burn", { from: BOB, id: "5n", amount: "4n" }));
  assert.deepEqual(burned.events[0].data, { operator: BOB, from: BOB, to: ZERO_ADDRESS, id: "5n", amount: "4n" });
  assert.equal(read("totalSupply", { id: "5n" }).result, "6n");
});

test("ดัชนีของที่ถือ: TransferSingle / TransferBatch ทำ holding · ยอดอยู่ที่ balances:<account>:<id>", () => {
  const { call, vm } = chain();
  ok(call(OWNER, "mintBatch", { to: BOB, ids: ["1n", "2n"], amounts: ["1n", "2n"] }));
  ok(call(BOB, "safeTransferFrom", { from: BOB, to: CAROL, id: "2n", amount: "2n" }));
  assert.deepEqual(vm.listHoldings(BOB).map((h) => h.program), [G]);
  assert.deepEqual(vm.listHoldings(CAROL).map((h) => h.program), [G]);
  assert.deepEqual(vm.listKeys(`${G}:storage:balances:${CAROL}:`), [`${G}:storage:balances:${CAROL}:2`]);
});
