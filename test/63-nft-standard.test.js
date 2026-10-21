import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { NFT_PROGRAM, checkNftStandard, NFT_INTERFACES } from "../src/standards/nft.js";
import { WALLET_PROGRAM } from "../src/standards/wallet.js";
import { MULTICALL_PROGRAM } from "../src/standards/multicall.js";
import { TOKEN_PROGRAM, ZERO_ADDRESS, checkTokenStandard } from "../src/standards/token.js";
import { reviewProgram } from "../src/core/autoreview.js";

/* มาตรฐาน NFT (คล้าย ERC-721): mint / transferFrom / safeTransferFrom / approve / setApprovalForAll / tokenURI / burn + event */

const N = "0x00000000000000000000000000000000000000f2";
const W = "0x00000000000000000000000000000000000000e1";
const M = "0x00000000000000000000000000000000000000e2";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const CAROL = "0x00000000000000000000000000000000000000c3";
const MINTER = "0x00000000000000000000000000000000000000d4";

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
    b.deploy({ programUuid: N, code: NFT_PROGRAM, context: as(OWNER), initInput: { name: "Siam Art", symbol: "SART", baseURI: "ipfs://art/", namespace: "siam-art" } }),
    b.init({ programUuid: N }),
    b.deploy({ programUuid: W, code: WALLET_PROGRAM, context: as(BOB) }),
    b.init({ programUuid: W }),
    b.deploy({ programUuid: M, code: MULTICALL_PROGRAM, context: as(BOB) }),
    b.init({ programUuid: M }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const call = (who, functionName, input) => block((b) => [b.call({ programUuid: N, functionName, input, context: as(who) })])[0];
  const read = (functionName, input = {}) => vm.query({ programUuid: N, functionName, input });
  return { vm, call, read };
}
const ok = (res) => { assert.equal(res.status, "success", JSON.stringify(res.error)); return res; };
const fails = (res, message) => { assert.equal(res.status, "throw"); assert.match(res.error.message, message); return res; };

test("NFT_PROGRAM ผ่านมาตรฐาน NFT และ autoreview · ไม่ถูกนับเป็น token (ERC-20) · โค้ดที่ขาดฟังก์ชัน / event บอกว่าขาดอะไร", () => {
  assert.deepEqual(checkNftStandard(NFT_PROGRAM), { ok: true, missing: [] });
  assert.deepEqual(reviewProgram(NFT_PROGRAM).issues, []);
  assert.equal(checkTokenStandard(NFT_PROGRAM).ok, false);
  assert.equal(checkNftStandard(TOKEN_PROGRAM).ok, false);
  const noApproval = NFT_PROGRAM.replace(/emit\("ApprovalForAll"[^\n]*\n/, "");
  assert.deepEqual(checkNftStandard(noApproval).missing, ["event ApprovalForAll"]);
  assert.deepEqual(checkNftStandard(NFT_PROGRAM.replace("tokenURI, supportsInterface", "supportsInterface")).missing, ["tokenURI"]);
});

test("mint: เจ้าของ / minter เท่านั้น · tokenId ถัดไปอัตโนมัติ (1n, 2n …) หรือระบุเอง · ซ้ำไม่ได้ · emit Transfer จาก zero address", () => {
  const { call, read } = chain();
  assert.equal(read("name").result, "Siam Art");
  assert.equal(read("symbol").result, "SART");
  const first = ok(call(OWNER, "mint", { to: BOB }));
  assert.equal(first.result, "1n");
  assert.deepEqual(first.events.map((e) => [e.name, e.data]), [["Transfer", { from: ZERO_ADDRESS, to: BOB, tokenId: "1n" }]]);
  assert.equal(ok(call(OWNER, "mint", { to: BOB, tokenId: "10n", uri: "ipfs://special" })).result, "10n");
  assert.equal(ok(call(OWNER, "mint", { to: CAROL })).result, "11n");   // ข้ามเลขที่ระบุเองไปแล้ว
  fails(call(OWNER, "mint", { to: CAROL, tokenId: "10n" }), /token already minted/);
  fails(call(BOB, "mint", { to: BOB }), /only owner or minter/);
  ok(call(OWNER, "setMinter", { minter: MINTER, allowed: true }));
  fails(call(BOB, "setMinter", { minter: BOB, allowed: true }), /only owner/);
  assert.equal(ok(call(MINTER, "mint", { to: MINTER })).result, "12n");
  ok(call(OWNER, "setMinter", { minter: MINTER, allowed: false }));
  fails(call(MINTER, "mint", { to: MINTER }), /only owner or minter/);
  fails(call(OWNER, "mint", { to: ZERO_ADDRESS }), /zero address/);
  fails(call(OWNER, "mint", { to: BOB, tokenId: "abc" }), /tokenId must be a non-negative bigint/);
  assert.equal(read("totalSupply").result, "4n");
  assert.equal(read("balanceOf", { owner: BOB }).result, "2n");
  assert.equal(read("ownerOf", { tokenId: "11n" }).result, CAROL);
  assert.match(read("ownerOf", { tokenId: "99n" }).error.message, /token does not exist/);
});

test("tokenURI: uri ของชิ้นนั้นก่อน ไม่มีแล้วใช้ baseURI + tokenId · supportsInterface ตาม ERC-165", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(OWNER, "mint", { to: BOB, uri: "https://x.test/2.json" }));
  assert.equal(read("tokenURI", { tokenId: "1n" }).result, "ipfs://art/1");
  assert.equal(read("tokenURI", { tokenId: "2n" }).result, "https://x.test/2.json");
  assert.equal(read("tokenURI", { tokenId: "3n" }).status, "throw");
  for (const id of NFT_INTERFACES) assert.equal(read("supportsInterface", { interfaceId: id }).result, true);
  assert.equal(read("supportsInterface", { interfaceId: "0xd9b67a26" }).result, false);
});

test("transferFrom: เจ้าของ / ผู้ได้ approve / operator ย้ายได้ · approve ถูกล้างหลังย้าย · คนอื่นย้ายไม่ได้", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(OWNER, "mint", { to: BOB }));
  fails(call(CAROL, "transferFrom", { from: BOB, to: CAROL, tokenId: "1n" }), /not owner nor approved/);
  fails(call(BOB, "transferFrom", { from: CAROL, to: BOB, tokenId: "1n" }), /from is not the owner/);
  fails(call(BOB, "transferFrom", { from: BOB, to: ZERO_ADDRESS, tokenId: "1n" }), /zero address/);

  const approval = ok(call(BOB, "approve", { to: CAROL, tokenId: "1n" }));
  assert.deepEqual(approval.events[0].data, { owner: BOB, approved: CAROL, tokenId: "1n" });
  assert.equal(read("getApproved", { tokenId: "1n" }).result, CAROL);
  fails(call(CAROL, "approve", { to: CAROL, tokenId: "2n" }), /not owner nor operator/);
  const moved = ok(call(CAROL, "transferFrom", { from: BOB, to: CAROL, tokenId: "1n" }));
  assert.deepEqual(moved.events.map((e) => [e.name, e.data]), [["Transfer", { from: BOB, to: CAROL, tokenId: "1n" }]]);
  assert.equal(read("getApproved", { tokenId: "1n" }).result, null);
  assert.equal(read("ownerOf", { tokenId: "1n" }).result, CAROL);
  assert.deepEqual([read("balanceOf", { owner: BOB }).result, read("balanceOf", { owner: CAROL }).result], ["1n", "1n"]);

  // operator ย้ายได้ทุกชิ้นของเจ้าของ และ approve แทนเจ้าของได้
  const all = ok(call(BOB, "setApprovalForAll", { operator: OWNER, approved: true }));
  assert.deepEqual(all.events[0].data, { owner: BOB, operator: OWNER, approved: true });
  assert.equal(read("isApprovedForAll", { owner: BOB, operator: OWNER }).result, true);
  ok(call(OWNER, "approve", { to: MINTER, tokenId: "2n" }));
  ok(call(OWNER, "transferFrom", { from: BOB, to: OWNER, tokenId: "2n" }));
  ok(call(BOB, "setApprovalForAll", { operator: OWNER, approved: false }));
  assert.equal(read("isApprovedForAll", { owner: BOB, operator: OWNER }).result, false);
  fails(call(BOB, "setApprovalForAll", { operator: BOB, approved: true }), /approve to caller/);
});

test("safeTransferFrom: ส่งให้กระเป๋าคน = เหมือน transferFrom · ส่งให้โปรแกรมที่ตอบ onERC721Received ได้ · โปรแกรมที่ไม่ตอบ → ทั้ง tx ล้ม", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(BOB, "safeTransferFrom", { from: BOB, to: CAROL, tokenId: "1n" }));
  const toWallet = ok(call(BOB, "safeTransferFrom", { from: BOB, to: W, tokenId: "2n", data: "hello" }));
  const hook = toWallet.calls.find((c) => c.functionName === "onERC721Received");
  assert.deepEqual(hook.input, { operator: BOB, from: BOB, tokenId: "2n", data: "hello" });
  assert.equal(read("ownerOf", { tokenId: "2n" }).result, W);
  ok(call(CAROL, "transferFrom", { from: CAROL, to: BOB, tokenId: "1n" }));
  fails(call(BOB, "safeTransferFrom", { from: BOB, to: M, tokenId: "1n" }), /onERC721Received/);   // multicall ไม่มี hook
  assert.equal(read("ownerOf", { tokenId: "1n" }).result, BOB);   // ย้อนทั้งหมด
});

test("burn: เจ้าของ / ผู้ได้ approve · emit Transfer ไป zero address · ลด supply และหายจาก ownerOf", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mint", { to: BOB, uri: "ipfs://one" }));
  fails(call(CAROL, "burn", { tokenId: "1n" }), /not owner nor approved/);
  const burned = ok(call(BOB, "burn", { tokenId: "1n" }));
  assert.deepEqual(burned.events[0].data, { from: BOB, to: ZERO_ADDRESS, tokenId: "1n" });
  assert.equal(read("totalSupply").result, "0n");
  assert.equal(read("balanceOf", { owner: BOB }).result, "0n");
  assert.equal(read("ownerOf", { tokenId: "1n" }).status, "throw");
});

test("ดัชนีของที่ถือ: owned:<owner>:<id> ตามเจ้าของปัจจุบัน · event Transfer ทำ holding ให้ทั้งผู้ส่งและผู้รับ", () => {
  const { call, vm } = chain();
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(BOB, "transferFrom", { from: BOB, to: CAROL, tokenId: "1n" }));
  const owned = (who) => vm.listKeys(`${N}:storage:owned:${who}:`).map((key) => key.split(":").pop());
  assert.deepEqual(owned(BOB), ["2"]);
  assert.deepEqual(owned(CAROL), ["1"]);
  assert.deepEqual(vm.listHoldings(CAROL).map((h) => h.program), [N]);
});
