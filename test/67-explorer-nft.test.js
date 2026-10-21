import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { NFT_PROGRAM } from "../src/standards/nft.js";
import { MULTITOKEN_PROGRAM } from "../src/standards/multitoken.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { collectionInfo, collectionStandard, nftHoldings, tokenHoldings, pageApprovedPrograms, pagePendingPrograms } from "../src/node/explorer-api.js";

/* explorer: รู้จัก NFT (ERC-721) / multi-token (ERC-1155) มาตรฐาน · ของที่ address ถือ (tokenId / ยอด / uri) */

const N = "0x00000000000000000000000000000000000000f2";
const G = "0x00000000000000000000000000000000000000f3";
const T = "0x00000000000000000000000000000000000000f1";
const P = "0x00000000000000000000000000000000000000f9";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const CAROL = "0x00000000000000000000000000000000000000c3";

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  let number = 0;
  const as = (who) => ({ sender: who, origin: who });
  const block = (...requests) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: number * 1000, feeRecipient: OWNER });
    const results = requests.map(([method, request]) => b[method](request));
    b.commit();
    results.forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  };
  const call = (who, programUuid, functionName, input) => ["call", { programUuid, functionName, input, context: as(who) }];
  block(
    ["deploy", { programUuid: N, code: NFT_PROGRAM, context: as(OWNER), initInput: { name: "Siam Art", symbol: "SART", baseURI: "https://art.test/" } }],
    ["init", { programUuid: N }],
    ["deploy", { programUuid: G, code: MULTITOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Items", symbol: "ITM", uri: "ipfs://items/{id}" } }],
    ["init", { programUuid: G }],
    ["deploy", { programUuid: T, code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Coin", ticker: "C", decimals: "0n", supply: "10n" } }],
    ["init", { programUuid: T }],
    ["deploy", { programUuid: P, code: NFT_PROGRAM, context: as(OWNER), initInput: { name: "Pending", symbol: "P" } }],
  );
  block(call(OWNER, N, "mint", { to: BOB }), call(OWNER, N, "mint", { to: BOB }), call(OWNER, N, "mint", { to: CAROL }),
    call(BOB, N, "transferFrom", { from: BOB, to: CAROL, tokenId: "1n" }),
    call(OWNER, G, "mintBatch", { to: BOB, ids: ["4n", "5n"], amounts: ["3n", "1n"] }),
    call(BOB, G, "safeTransferFrom", { from: BOB, to: CAROL, id: "5n", amount: "1n" }),
    call(OWNER, T, "transfer", { to: BOB, amount: "2n" }));
  return vm;
}

test("collectionInfo: NFT → ERC-721 (+ totalSupply) · multi-token → ERC-1155 · token / กระเป๋า → null", () => {
  const vm = chain();
  assert.deepEqual(collectionInfo(vm, N), { address: N, standard: "ERC-721", name: "Siam Art", symbol: "SART", totalSupply: "3n" });
  assert.deepEqual(collectionInfo(vm, G.toUpperCase().replace("0X", "0x")), { address: G, standard: "ERC-1155", name: "Items", symbol: "ITM" });
  assert.equal(collectionInfo(vm, T), null);
  assert.equal(collectionInfo(vm, BOB), null);
  assert.equal(collectionStandard(TOKEN_PROGRAM), null);
  assert.equal(collectionStandard(undefined), null);
});

test("nftHoldings: ชิ้น ERC-721 ตามเจ้าของปัจจุบัน + tokenURI · ยอด ERC-1155 ต่อ id + uri · ยอด 0 ไม่แสดง · เหรียญ ERC-20 แยกอยู่ที่ tokenHoldings", () => {
  const vm = chain();
  const pick = (items) => items.map((i) => [i.program, i.standard, i.tokenId, i.amount, i.uri]);
  assert.deepEqual(pick(nftHoldings(vm, BOB)), [
    [N, "ERC-721", "2n", "1n", "https://art.test/2"],
    [G, "ERC-1155", "4n", "3n", "ipfs://items/{id}"],
  ]);
  assert.deepEqual(pick(nftHoldings(vm, CAROL)), [
    [N, "ERC-721", "1n", "1n", "https://art.test/1"],
    [N, "ERC-721", "3n", "1n", "https://art.test/3"],
    [G, "ERC-1155", "5n", "1n", "ipfs://items/{id}"],
  ]);
  assert.equal(nftHoldings(vm, BOB)[0].name, "Siam Art");
  assert.deepEqual(tokenHoldings(vm, BOB).map((t) => t.address), [T]);
  assert.deepEqual(nftHoldings(vm, OWNER), []);
  assert.equal(nftHoldings(vm, CAROL, { limit: 2 }).length, 2);
});

test("รายการโปรแกรม: NFT / multi-token มีฟิลด์ collection (ทั้งที่อนุมัติแล้วและรออนุมัติ) · token และโปรแกรมอื่นไม่มี", () => {
  const vm = chain();
  const approved = Object.fromEntries(pageApprovedPrograms(vm, { page: 1, limit: 20 }).items.map((p) => [p.address, p.collection]));
  assert.deepEqual(approved, { [N]: "ERC-721", [G]: "ERC-1155", [T]: undefined });
  const [pending] = pagePendingPrograms(vm, { page: 1, limit: 20 }).items;
  assert.deepEqual([pending.address, pending.collection, pending.token], [P, "ERC-721", false]);
});
