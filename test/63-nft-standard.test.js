import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { NFT_PROGRAM, checkNftStandard, NFT_INTERFACES } from "../src/standards/nft.js";
import { WALLET_PROGRAM } from "../src/standards/wallet.js";
import { MULTICALL_PROGRAM } from "../src/standards/multicall.js";
import { TOKEN_PROGRAM, ZERO_ADDRESS, checkTokenStandard } from "../src/standards/token.js";
import { reviewProgram } from "../src/core/autoreview.js";

/* NFT standard (like ERC-721): mint / transferFrom / safeTransferFrom / approve / setApprovalForAll / tokenURI / burn + event */

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

test("NFT_PROGRAM meets the NFT standard and autoreview · not counted as a token (ERC-20) · code missing functions / events reports what is missing", () => {
  assert.deepEqual(checkNftStandard(NFT_PROGRAM), { ok: true, missing: [] });
  assert.deepEqual(reviewProgram(NFT_PROGRAM).issues, []);
  assert.equal(checkTokenStandard(NFT_PROGRAM).ok, false);
  assert.equal(checkNftStandard(TOKEN_PROGRAM).ok, false);
  const noApproval = NFT_PROGRAM.replace(/emit\("ApprovalForAll"[^\n]*\n/, "");
  assert.deepEqual(checkNftStandard(noApproval).missing, ["event ApprovalForAll"]);
  assert.deepEqual(checkNftStandard(NFT_PROGRAM.replace("tokenURI, supportsInterface", "supportsInterface")).missing, ["tokenURI"]);
});

test("mint: owner / minter only · next tokenId is automatic (1n, 2n …) or explicit · no duplicates · emits Transfer from the zero address", () => {
  const { call, read } = chain();
  assert.equal(read("name").result, "Siam Art");
  assert.equal(read("symbol").result, "SART");
  const first = ok(call(OWNER, "mint", { to: BOB }));
  assert.equal(first.result, "1n");
  assert.deepEqual(first.events.map((e) => [e.name, e.data]), [["Transfer", { from: ZERO_ADDRESS, to: BOB, tokenId: "1n" }]]);
  assert.equal(ok(call(OWNER, "mint", { to: BOB, tokenId: "10n", uri: "ipfs://special" })).result, "10n");
  assert.equal(ok(call(OWNER, "mint", { to: CAROL })).result, "11n");   // skips the explicitly used id
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

test("tokenURI: the token's own uri first, otherwise baseURI + tokenId · supportsInterface per ERC-165", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(OWNER, "mint", { to: BOB, uri: "https://x.test/2.json" }));
  assert.equal(read("tokenURI", { tokenId: "1n" }).result, "ipfs://art/1");
  assert.equal(read("tokenURI", { tokenId: "2n" }).result, "https://x.test/2.json");
  assert.equal(read("tokenURI", { tokenId: "3n" }).status, "throw");
  for (const id of NFT_INTERFACES) assert.equal(read("supportsInterface", { interfaceId: id }).result, true);
  assert.equal(read("supportsInterface", { interfaceId: "0xd9b67a26" }).result, false);
});

test("transferFrom: owner / approved / operator can move it · approval is cleared after a move · others cannot move it", () => {
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

  // an operator can move all of the owner's tokens and approve on the owner's behalf
  const all = ok(call(BOB, "setApprovalForAll", { operator: OWNER, approved: true }));
  assert.deepEqual(all.events[0].data, { owner: BOB, operator: OWNER, approved: true });
  assert.equal(read("isApprovedForAll", { owner: BOB, operator: OWNER }).result, true);
  ok(call(OWNER, "approve", { to: MINTER, tokenId: "2n" }));
  ok(call(OWNER, "transferFrom", { from: BOB, to: OWNER, tokenId: "2n" }));
  ok(call(BOB, "setApprovalForAll", { operator: OWNER, approved: false }));
  assert.equal(read("isApprovedForAll", { owner: BOB, operator: OWNER }).result, false);
  fails(call(BOB, "setApprovalForAll", { operator: BOB, approved: true }), /approve to caller/);
});

test("safeTransferFrom: to a user wallet = like transferFrom · to a program that answers onERC721Received works · a program that does not answer → the whole tx fails", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(BOB, "safeTransferFrom", { from: BOB, to: CAROL, tokenId: "1n" }));
  const toWallet = ok(call(BOB, "safeTransferFrom", { from: BOB, to: W, tokenId: "2n", data: "hello" }));
  const hook = toWallet.calls.find((c) => c.functionName === "onERC721Received");
  assert.deepEqual(hook.input, { operator: BOB, from: BOB, tokenId: "2n", data: "hello" });
  assert.equal(read("ownerOf", { tokenId: "2n" }).result, W);
  ok(call(CAROL, "transferFrom", { from: CAROL, to: BOB, tokenId: "1n" }));
  fails(call(BOB, "safeTransferFrom", { from: BOB, to: M, tokenId: "1n" }), /onERC721Received/);   // multicall has no hook
  assert.equal(read("ownerOf", { tokenId: "1n" }).result, BOB);   // fully reverted
});

test("burn: owner / approved · emits Transfer to the zero address · lowers supply and disappears from ownerOf", () => {
  const { call, read } = chain();
  ok(call(OWNER, "mint", { to: BOB, uri: "ipfs://one" }));
  fails(call(CAROL, "burn", { tokenId: "1n" }), /not owner nor approved/);
  const burned = ok(call(BOB, "burn", { tokenId: "1n" }));
  assert.deepEqual(burned.events[0].data, { from: BOB, to: ZERO_ADDRESS, tokenId: "1n" });
  assert.equal(read("totalSupply").result, "0n");
  assert.equal(read("balanceOf", { owner: BOB }).result, "0n");
  assert.equal(read("ownerOf", { tokenId: "1n" }).status, "throw");
});

test("holdings index: owned:<owner>:<id> by current owner · Transfer events create holdings for both sender and recipient", () => {
  const { call, vm } = chain();
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(OWNER, "mint", { to: BOB }));
  ok(call(BOB, "transferFrom", { from: BOB, to: CAROL, tokenId: "1n" }));
  const owned = (who) => vm.listKeys(`${N}:storage:owned:${who}:`).map((key) => key.split(":").pop());
  assert.deepEqual(owned(BOB), ["2"]);
  assert.deepEqual(owned(CAROL), ["1"]);
  assert.deepEqual(vm.listHoldings(CAROL).map((h) => h.program), [N]);
});
