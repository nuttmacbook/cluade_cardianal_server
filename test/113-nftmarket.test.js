import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { NFT_MARKET_PROGRAM, NFT_MARKET_FUNCTIONS } from "../src/standards/nftmarket.js";
import { NFT_PROGRAM } from "../src/standards/nft.js";
import { MULTITOKEN_PROGRAM } from "../src/standards/multitoken.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { WALLET_PROGRAM } from "../src/standards/wallet.js";
import { reviewProgram } from "../src/core/autoreview.js";

/*
 * ตลาด NFT (src/standards/nftmarket.js): วางขายแบบ escrow · ERC-721 / ERC-1155 · จ่ายเหรียญหลักหรือ token · ค่าธรรมเนียมคงที่ · ข้อเสนอซื้อ
 */

const T = Date.parse("2026-11-11T00:00:00Z");
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b1";
const CAROL = "0x00000000000000000000000000000000000000c1";
const FEE = "0x00000000000000000000000000000000000000fe";
const NFT = "0x0000000000000000000000000000000000000a01";
const ITEMS = "0x0000000000000000000000000000000000000a02";
const TOKEN = "0x0000000000000000000000000000000000000a03";
const MARKET = "0x0000000000000000000000000000000000000a04";   // ค่าธรรมเนียม 2.5%
const FREE = "0x0000000000000000000000000000000000000a05";     // ไม่มีค่าธรรมเนียม
const WALLET = "0x0000000000000000000000000000000000000a06";
const ATTACKER = "0x0000000000000000000000000000000000000a07";
const COIN = 10n ** 18n;
const gas = {};

// โปรแกรมผู้ซื้อที่พยายามเรียกตลาดซ้อนตอนได้รับ NFT
const ATTACKER_PROGRAM = `function program() {
  function initialization() {}
  function attack(params) {
    writeDB("market", params.input.market)
    writeDB("other", params.input.other)
    return runProgram(params.input.market, "buy", { listingId: params.input.listingId }, { value: params.value })
  }
  function onERC721Received() {
    runProgram(readDB("market"), "cancel", { listingId: readDB("other") })
    return "0x150b7a02"
  }
  return { attack, onERC721Received }
}`;

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, forks: { bluewolf: 0 }, maxBlockGas: 5_000_000 });
  vm.db.load(Object.fromEntries([DEPLOYER, ALICE, BOB, CAROL].map((a) => [VM.nativeKey(a, "received"), `${1000n * COIN}n`])));
  let time = T;
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
  const deploy = (programUuid, code, initInput, sender = DEPLOYER) => block((b) => {
    ok(b.deploy({ programUuid, code, context: { sender, origin: sender }, initInput, gasLimit: 5_000_000 }));
    return b.init({ programUuid });
  });
  const send = (who, programUuid, functionName, input = {}, extra = {}) => block((b) =>
    b.call({ programUuid, functionName, input, context: { sender: who, origin: who }, gasLimit: 5_000_000, ...extra }));
  const fails = (res, message) => {
    assert.equal(res.status, "throw", `expected throw (${message})`);
    assert.ok(String(res.error.message).includes(message), `"${res.error.message}" should include "${message}"`);
  };
  const query = (programUuid, functionName, input = {}) => ok(vm.query({ programUuid, functionName, input })).result;
  const balance = (who) => BigInt(vm.nativeBalanceOf(who).balance);
  const tokens = (who) => BigInt(query(TOKEN, "balanceOf", { who }).slice(0, -1));
  const items = (who, id = "7n") => BigInt(query(ITEMS, "balanceOf", { account: who, id }).slice(0, -1));

  ok(deploy(NFT, NFT_PROGRAM, { name: "Art", symbol: "ART" }));
  ok(deploy(ITEMS, MULTITOKEN_PROGRAM, { name: "Items", uri: "https://i.example/{id}.json" }));
  ok(deploy(TOKEN, TOKEN_PROGRAM, { name: "USD", ticker: "USD", decimals: "6n", supply: "1000000000n" }, BOB));
  ok(deploy(MARKET, NFT_MARKET_PROGRAM, { feeBps: "250n", feeRecipient: FEE, namespace: "nft-market", description: "market" }));
  ok(deploy(FREE, NFT_MARKET_PROGRAM, {}));
  ok(deploy(WALLET, WALLET_PROGRAM, { owner: BOB }));
  ok(deploy(ATTACKER, ATTACKER_PROGRAM, {}));
  for (let i = 0; i < 4; i++) ok(send(DEPLOYER, NFT, "mint", { to: ALICE }));   // tokenId 1..4 ของ alice
  ok(send(DEPLOYER, ITEMS, "mint", { to: ALICE, id: "7n", amount: "10n" }));
  ok(send(BOB, TOKEN, "transfer", { to: CAROL, amount: "100000000n" }));
  for (const market of [MARKET, FREE]) {
    ok(send(ALICE, NFT, "setApprovalForAll", { operator: market, approved: true }));
    ok(send(ALICE, ITEMS, "setApprovalForAll", { operator: market, approved: true }));
    ok(send(BOB, TOKEN, "approve", { spender: market, amount: "1000000000n" }));
    ok(send(CAROL, TOKEN, "approve", { spender: market, amount: "100000000n" }));
  }
  return { vm, ok, deploy, send, fails, query, balance, tokens, items };
}

/** ยอดที่ตลาดถือ = ผลรวมของรายการ / ข้อเสนอที่ยังเปิดอยู่ */
function assertEscrow(t, market) {
  const all = t.query(market, "listings", { limit: "50n" }).items;
  for (const l of all.filter((x) => x.status === "active" && x.kind === "erc721")) {
    assert.equal(t.query(l.collection, "ownerOf", { tokenId: l.tokenId }), market, `listing ${l.listingId} escrowed`);
  }
  const held = all.filter((x) => x.status === "active" && x.kind === "erc1155").reduce((s, x) => s + BigInt(x.amount.slice(0, -1)), 0n);
  assert.equal(t.items(market), held, "1155 escrow");
  let native = 0n;
  let token = 0n;
  const count = BigInt(t.query(market, "offerCount").slice(0, -1));
  for (let i = 0n; i < count; i++) {
    const o = t.query(market, "getOffer", { offerId: `${i}n` });
    if (o.status !== "active") continue;
    if (o.payToken === "") native += BigInt(o.amount.slice(0, -1));
    else token += BigInt(o.amount.slice(0, -1));
  }
  assert.equal(t.balance(market), native, "native escrow");
  assert.equal(t.tokens(market), token, "token escrow");
}

test("nftmarket: โค้ดผ่าน autoreview · export รายชื่อฟังก์ชัน · ค่าเริ่มต้น", () => {
  const review = reviewProgram(NFT_MARKET_PROGRAM);
  assert.ok(review.ok, review.message);
  assert.deepEqual(NFT_MARKET_FUNCTIONS, ["list", "listMulti", "buy", "updatePrice", "cancel", "makeOffer", "cancelOffer", "acceptOffer"]);
  const t = setup();
  assert.deepEqual(t.query(MARKET, "fee"), { feeBps: "250n", feeRecipient: FEE });
  assert.deepEqual(t.query(FREE, "fee"), { feeBps: "0n", feeRecipient: null });
  assert.equal(t.vm.resolveNamespace("nft-market"), MARKET);
  assert.equal(t.vm.getMetadata(MARKET).upgrader, undefined);
  assert.equal(t.query(MARKET, "listingCount"), "0n");
});

test("nftmarket: init ตรวจค่าธรรมเนียม (0..1000 bps · ต้องมี feeRecipient)", () => {
  const t = setup();
  const bad = [{ feeBps: "1001n", feeRecipient: FEE }, { feeBps: "100n" }, { feeBps: "-1n", feeRecipient: FEE },
    { feeBps: "5n", feeRecipient: "0x0000000000000000000000000000000000000000" }, { feeBps: "5n", feeRecipient: "fee" }, { feeBps: 5 }];
  bad.forEach((input, i) => assert.equal(t.deploy(`0x00000000000000000000000000000000000b${String(i).padStart(4, "0")}`, NFT_MARKET_PROGRAM, input).status, "throw", JSON.stringify(input)));
  t.ok(t.deploy("0x00000000000000000000000000000000000bffff", NFT_MARKET_PROGRAM, { feeBps: "1000n", feeRecipient: FEE }));
});

test("nftmarket: ERC-721 ขายด้วยเหรียญหลัก · ค่าธรรมเนียม 2.5% · ต้องจ่ายราคาพอดี", () => {
  const t = setup();
  const res = t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: `${10n * COIN}n` }));
  gas.list = res.gasUsed;
  assert.equal(res.result, "0n");
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), MARKET, "escrowed");
  const listed = res.events.find((e) => e.program === MARKET && e.name === "Listed");
  assert.equal(listed.data.seller, ALICE);
  const listing = t.query(MARKET, "getListing", { listingId: "0n" });
  assert.equal(listing.status, "active");
  assert.equal(listing.kind, "erc721");
  assert.equal(listing.payToken, "");

  t.fails(t.send(ALICE, MARKET, "buy", { listingId: "0n" }, { value: `${10n * COIN}` }), "seller cannot buy own listing");
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n" }, { value: `${10n * COIN - 1n}` }), "value must equal the exact price");
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n" }, { value: `${10n * COIN + 1n}` }), "value must equal the exact price");
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n" }), "value must equal the exact price");
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n", amount: "2n" }, { value: `${20n * COIN}` }), "amount exceeds");
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n", price: "1n" }, { value: `${10n * COIN}` }), "price changed");
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "9n" }, { value: "1" }), "listing not found");

  const aliceBefore = t.balance(ALICE);
  const bobBefore = t.balance(BOB);
  const buy = t.ok(t.send(BOB, MARKET, "buy", { listingId: "0n", price: `${10n * COIN}n` }, { value: `${10n * COIN}` }));
  gas.buyNative = buy.gasUsed;
  const fee = 10n * COIN * 250n / 10000n;
  assert.deepEqual(buy.result, { listingId: "0n", amount: "1n", price: `${10n * COIN}n`, fee: `${fee}n` });
  assert.equal(t.balance(ALICE), aliceBefore + 10n * COIN - fee);
  assert.equal(t.balance(FEE), fee);
  assert.equal(t.balance(BOB), bobBefore - 10n * COIN);
  assert.equal(t.balance(MARKET), 0n);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), BOB);
  const sold = buy.events.find((e) => e.program === MARKET && e.name === "Sold");
  assert.deepEqual(sold.data, { listingId: "0n", buyer: BOB, seller: ALICE, amount: "1n", price: `${10n * COIN}n`, fee: `${fee}n`, payToken: "" });
  assert.equal(t.query(MARKET, "getListing", { listingId: "0n" }).status, "sold");
  t.fails(t.send(CAROL, MARKET, "buy", { listingId: "0n" }, { value: `${10n * COIN}` }), "listing is not active");
  assertEscrow(t, MARKET);
});

test("nftmarket: ERC-721 ขายด้วย token · ค่าธรรมเนียมปัดลง · ตลาดไม่มีค่าธรรมเนียม", () => {
  const t = setup();
  t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1999n", payToken: TOKEN }));
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n" }, { value: "1" }), "paid in tokens");
  t.fails(t.send(DEPLOYER, MARKET, "buy", { listingId: "0n" }), "insufficient");   // ไม่มี token / allowance
  const bobBefore = t.tokens(BOB);
  const buy = t.ok(t.send(BOB, MARKET, "buy", { listingId: "0n" }));
  gas.buyToken = buy.gasUsed;
  const fee = 1999n * 250n / 10000n;   // 49.975 → 49
  assert.equal(fee, 49n);
  assert.equal(buy.result.fee, "49n");
  assert.equal(t.tokens(ALICE), 1999n - 49n);
  assert.equal(t.tokens(FEE), 49n);
  assert.equal(t.tokens(BOB), bobBefore - 1999n);
  assert.equal(t.tokens(MARKET), 0n);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), BOB);

  // ไม่มีค่าธรรมเนียม: ผู้ขายได้เต็ม
  t.ok(t.send(ALICE, FREE, "list", { nft: NFT, tokenId: "2n", price: "500n", payToken: TOKEN }));
  const free = t.ok(t.send(CAROL, FREE, "buy", { listingId: "0n" }));
  assert.equal(free.result.fee, "0n");
  assert.equal(t.tokens(ALICE), 1950n + 500n);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "2n" }), CAROL);
  // ค่าธรรมเนียมของราคาเล็ก ๆ ปัดเป็น 0
  t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "3n", price: "39n", payToken: TOKEN }));
  assert.equal(t.ok(t.send(BOB, MARKET, "buy", { listingId: "1n" })).result.fee, "0n");
  assertEscrow(t, MARKET);
  assertEscrow(t, FREE);
});

test("nftmarket: list ตรวจค่า · คนอื่นวางขายแทนไม่ได้ · ไม่ approve = ล้ม · ห้ามแนบ value", () => {
  const t = setup();
  t.fails(t.send(BOB, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1n" }), "only the nft owner");
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "0n" }), "price must be");
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1" }), "price must be");
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "-1n", price: "1n" }), "tokenId must be");
  t.fails(t.send(ALICE, MARKET, "list", { nft: ALICE, tokenId: "1n", price: "1n" }), "nft must be a program");
  t.fails(t.send(ALICE, MARKET, "list", { nft: "0x12", tokenId: "1n", price: "1n" }), "nft must be an address");
  t.fails(t.send(ALICE, MARKET, "list", { nft: MARKET, tokenId: "1n", price: "1n" }), "must not be the market");
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1n", payToken: BOB }), "payToken must be a program");
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "99n", price: "1n" }), "token does not exist");
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1n" }, { value: "5" }), "does not accept native value");
  t.ok(t.send(ALICE, NFT, "setApprovalForAll", { operator: MARKET, approved: false }));
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1n" }), "not owner nor approved");
  // approve ชิ้นเดียวก็พอ
  t.ok(t.send(ALICE, NFT, "approve", { to: MARKET, tokenId: "1n" }));
  t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1n" }));
  t.fails(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "1n" }), "only the nft owner");   // อยู่ใน escrow แล้ว
  assert.equal(t.query(MARKET, "listingCount"), "1n");
});

test("nftmarket: ส่ง NFT / ของเข้าตลาดตรง ๆ ถูกปฏิเสธ · hook เรียกตรงไม่ได้", () => {
  const t = setup();
  t.fails(t.send(ALICE, NFT, "safeTransferFrom", { from: ALICE, to: MARKET, tokenId: "1n" }), "direct transfers are not accepted");
  t.fails(t.send(ALICE, ITEMS, "safeTransferFrom", { from: ALICE, to: MARKET, id: "7n", amount: "1n" }), "direct transfers are not accepted");
  t.fails(t.send(ALICE, ITEMS, "safeBatchTransferFrom", { from: ALICE, to: MARKET, ids: ["7n"], amounts: ["1n"] }), "batch transfers are not accepted");
  t.fails(t.send(ALICE, MARKET, "onERC721Received", { operator: MARKET, from: ALICE, tokenId: "1n" }), "direct transfers are not accepted");
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), ALICE);
  assert.equal(t.items(ALICE), 10n);
});

test("nftmarket: แก้ราคา / ยกเลิก / วางขายใหม่ · คนอื่นทำแทนไม่ได้ · ซื้อรายการที่ยกเลิกไม่ได้", () => {
  const t = setup();
  t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "100n", payToken: TOKEN }));
  t.fails(t.send(BOB, MARKET, "updatePrice", { listingId: "0n", price: "1n" }), "only the seller");
  t.fails(t.send(ALICE, MARKET, "updatePrice", { listingId: "0n", price: "0n" }), "price must be");
  const up = t.ok(t.send(ALICE, MARKET, "updatePrice", { listingId: "0n", price: "200n" }));
  gas.updatePrice = up.gasUsed;
  assert.deepEqual(up.events.find((e) => e.name === "PriceUpdated").data, { listingId: "0n", oldPrice: "100n", price: "200n" });
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n", price: "100n" }), "price changed");   // กันขึ้นราคาตัดหน้า

  t.fails(t.send(BOB, MARKET, "cancel", { listingId: "0n" }), "only the seller");
  const cancel = t.ok(t.send(ALICE, MARKET, "cancel", { listingId: "0n" }));
  gas.cancel = cancel.gasUsed;
  assert.deepEqual(cancel.events.find((e) => e.name === "Cancelled").data, { listingId: "0n", seller: ALICE, amount: "1n" });
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), ALICE);
  assert.equal(t.query(MARKET, "getListing", { listingId: "0n" }).status, "cancelled");
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n" }), "listing is not active");
  t.fails(t.send(ALICE, MARKET, "cancel", { listingId: "0n" }), "listing is not active");
  t.fails(t.send(ALICE, MARKET, "updatePrice", { listingId: "0n", price: "5n" }), "listing is not active");

  // วางขายใหม่ได้ (id ใหม่)
  assert.equal(t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "300n", payToken: TOKEN })).result, "1n");
  t.ok(t.send(BOB, MARKET, "buy", { listingId: "1n", price: "300n" }));
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), BOB);
  const mine = t.query(MARKET, "listingsOf", { seller: ALICE });
  assert.deepEqual(mine.items.map((l) => [l.listingId, l.status]), [["0n", "cancelled"], ["1n", "sold"]]);
  assertEscrow(t, MARKET);
});

test("nftmarket: ERC-1155 ซื้อบางส่วน · จ่ายเหรียญหลักและ token · ยกเลิกคืนส่วนที่เหลือ", () => {
  const t = setup();
  t.fails(t.send(ALICE, MARKET, "listMulti", { multiToken: ITEMS, id: "7n", amount: "0n", pricePerUnit: "1n" }), "amount must be");
  t.fails(t.send(ALICE, MARKET, "listMulti", { multiToken: ITEMS, id: "7n", amount: "11n", pricePerUnit: "1n" }), "insufficient balance");
  const res = t.ok(t.send(ALICE, MARKET, "listMulti", { multiToken: ITEMS, id: "7n", amount: "6n", pricePerUnit: `${COIN}n` }));
  gas.listMulti = res.gasUsed;
  assert.equal(t.items(MARKET), 6n);
  assert.equal(t.items(ALICE), 4n);
  t.ok(t.send(ALICE, MARKET, "listMulti", { multiToken: ITEMS, id: "7n", amount: "4n", pricePerUnit: "10n", payToken: TOKEN }));
  assertEscrow(t, MARKET);

  const before = t.balance(ALICE);
  t.fails(t.send(BOB, MARKET, "buy", { listingId: "0n", amount: "2n" }, { value: `${COIN}` }), "value must equal the exact price");
  const part = t.ok(t.send(BOB, MARKET, "buy", { listingId: "0n", amount: "2n" }, { value: `${2n * COIN}` }));
  gas.buyMulti = part.gasUsed;
  const fee = 2n * COIN * 250n / 10000n;
  assert.equal(part.result.fee, `${fee}n`);
  assert.equal(t.balance(ALICE), before + 2n * COIN - fee);
  assert.equal(t.items(BOB), 2n);
  let listing = t.query(MARKET, "getListing", { listingId: "0n" });
  assert.deepEqual([listing.amount, listing.sold, listing.status], ["4n", "2n", "active"]);
  t.fails(t.send(CAROL, MARKET, "buy", { listingId: "0n", amount: "5n" }, { value: `${5n * COIN}` }), "amount exceeds");
  t.ok(t.send(CAROL, MARKET, "buy", { listingId: "0n" }, { value: `${COIN}` }));   // ไม่ส่ง amount = 1
  assert.equal(t.items(CAROL), 1n);
  assertEscrow(t, MARKET);

  // token: 3 ชิ้น × 10 = 30 → fee 0 (ปัดลง)
  t.ok(t.send(CAROL, MARKET, "buy", { listingId: "1n", amount: "3n" }));
  assert.equal(t.tokens(ALICE), 30n);
  assert.equal(t.items(CAROL), 4n);

  // ยกเลิก: คืน 3 ชิ้นที่เหลือของรายการแรก
  t.ok(t.send(ALICE, MARKET, "cancel", { listingId: "0n" }));
  assert.equal(t.items(ALICE), 3n);
  listing = t.query(MARKET, "getListing", { listingId: "0n" });
  assert.deepEqual([listing.amount, listing.sold, listing.status], ["0n", "3n", "cancelled"]);
  assertEscrow(t, MARKET);
  // ซื้อชิ้นสุดท้ายของรายการ token → sold
  t.ok(t.send(BOB, MARKET, "buy", { listingId: "1n" }));
  assert.equal(t.query(MARKET, "getListing", { listingId: "1n" }).status, "sold");
  assert.equal(t.items(MARKET), 0n);
  assertEscrow(t, MARKET);
});

test("nftmarket: ข้อเสนอด้วย token · รับโดยเจ้าของที่ไม่ได้วางขาย · คนอื่นรับ / ยกเลิกไม่ได้", () => {
  const t = setup();
  t.fails(t.send(ALICE, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: TOKEN, amount: "1n" }), "your own nft");
  t.fails(t.send(BOB, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: TOKEN, amount: "0n" }), "amount must be");
  t.fails(t.send(BOB, MARKET, "makeOffer", { nft: NFT, tokenId: "99n", payToken: TOKEN, amount: "1n" }), "token does not exist");
  t.fails(t.send(BOB, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: TOKEN, amount: "1n" }, { value: "1" }), "do not accept native value");
  t.fails(t.send(BOB, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: TOKEN, amount: "1n", expiresAt: `${BigInt(T / 1000)}n` }), "expiresAt must be in the future");
  t.fails(t.send(DEPLOYER, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: TOKEN, amount: "1n" }), "insufficient");

  const offer = t.ok(t.send(BOB, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: TOKEN, amount: "1000n" }));
  gas.makeOfferToken = offer.gasUsed;
  assert.equal(offer.result, "0n");
  assert.equal(t.tokens(MARKET), 1000n);
  t.ok(t.send(CAROL, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: TOKEN, amount: "900n" }));
  assertEscrow(t, MARKET);
  assert.deepEqual(t.query(MARKET, "offersFor", { nft: NFT, tokenId: "1n" }).items.map((o) => [o.offerId, o.buyer, o.amount]),
    [["0n", BOB, "1000n"], ["1n", CAROL, "900n"]]);

  t.fails(t.send(CAROL, MARKET, "cancelOffer", { offerId: "0n" }), "only the offer maker");
  t.fails(t.send(CAROL, MARKET, "acceptOffer", { offerId: "0n" }), "only the current nft owner");
  t.fails(t.send(BOB, MARKET, "acceptOffer", { offerId: "0n" }), "only the current nft owner");

  const accept = t.ok(t.send(ALICE, MARKET, "acceptOffer", { offerId: "0n" }));
  gas.acceptOffer = accept.gasUsed;
  assert.deepEqual(accept.result, { offerId: "0n", listingId: null, amount: "1000n", fee: "25n" });
  assert.equal(t.tokens(ALICE), 975n);
  assert.equal(t.tokens(FEE), 25n);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), BOB);
  assert.equal(t.query(MARKET, "getOffer", { offerId: "0n" }).status, "accepted");
  t.fails(t.send(BOB, MARKET, "acceptOffer", { offerId: "0n" }), "offer is not active");
  t.fails(t.send(BOB, MARKET, "cancelOffer", { offerId: "0n" }), "offer is not active");
  assertEscrow(t, MARKET);

  // เจ้าของใหม่ (bob) รับข้อเสนอของ carol ได้ · carol ยกเลิกไม่ทันแล้ว
  t.ok(t.send(BOB, NFT, "setApprovalForAll", { operator: MARKET, approved: true }));
  const carolBefore = t.tokens(CAROL);
  t.ok(t.send(BOB, MARKET, "acceptOffer", { offerId: "1n" }));
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), CAROL);
  assert.equal(t.tokens(CAROL), carolBefore);
  assertEscrow(t, MARKET);
  assert.deepEqual(t.query(MARKET, "offersFor", { nft: NFT, tokenId: "1n", activeOnly: true }).items, []);

  // ผู้เสนอกลายเป็นเจ้าของเองทีหลัง → รับข้อเสนอของตัวเองไม่ได้ (ยกเลิกเอาเงินคืนได้)
  t.ok(t.send(CAROL, MARKET, "makeOffer", { nft: NFT, tokenId: "2n", payToken: TOKEN, amount: "10n" }));
  t.ok(t.send(ALICE, NFT, "transferFrom", { from: ALICE, to: CAROL, tokenId: "2n" }));
  t.ok(t.send(CAROL, NFT, "setApprovalForAll", { operator: MARKET, approved: true }));
  t.fails(t.send(CAROL, MARKET, "acceptOffer", { offerId: "2n" }), "cannot accept your own offer");
  t.ok(t.send(CAROL, MARKET, "cancelOffer", { offerId: "2n" }));
  assertEscrow(t, MARKET);
});

test("nftmarket: ข้อเสนอด้วยเหรียญหลัก · รับขณะวางขายอยู่ → รายการปิด · ยกเลิกคืนเงิน · หมดอายุ", () => {
  const t = setup();
  t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: `${10n * COIN}n` }));
  t.fails(t.send(ALICE, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: "", amount: "5n" }, { value: "5" }), "your own nft");
  t.fails(t.send(BOB, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", payToken: "", amount: "5n" }, { value: "4" }), "value must equal the offer amount");
  const bobBefore = t.balance(BOB);
  const offer = t.ok(t.send(BOB, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", amount: `${8n * COIN}n` }, { value: `${8n * COIN}` }));
  gas.makeOfferNative = offer.gasUsed;
  assert.equal(t.balance(MARKET), 8n * COIN);
  // carol เสนอแบบหมดอายุเร็ว แล้วยกเลิกเอง
  const expiresAt = BigInt(T / 1000) + 1000n;
  t.ok(t.send(CAROL, MARKET, "makeOffer", { nft: NFT, tokenId: "1n", amount: `${9n * COIN}n`, expiresAt: `${expiresAt}n` }, { value: `${9n * COIN}` }));
  assertEscrow(t, MARKET);

  t.fails(t.send(CAROL, MARKET, "acceptOffer", { offerId: "0n" }), "only the current nft owner");
  const aliceBefore = t.balance(ALICE);
  const accept = t.ok(t.send(ALICE, MARKET, "acceptOffer", { offerId: "0n" }));
  const fee = 8n * COIN * 250n / 10000n;
  assert.equal(accept.result.listingId, "0n");
  assert.equal(t.balance(ALICE), aliceBefore + 8n * COIN - fee);
  assert.equal(t.balance(BOB), bobBefore - 8n * COIN);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), BOB);
  assert.equal(t.query(MARKET, "getListing", { listingId: "0n" }).status, "sold");
  t.fails(t.send(CAROL, MARKET, "buy", { listingId: "0n" }, { value: `${10n * COIN}` }), "listing is not active");
  assertEscrow(t, MARKET);

  // ข้อเสนอที่หมดอายุแล้ว: รับไม่ได้ แต่ผู้เสนอยกเลิกเอาเงินคืนได้
  const late = t.vm.createBlock({ timestamp: Number(expiresAt + 10n) * 1000 });
  const expired = late.call({ programUuid: MARKET, functionName: "acceptOffer", input: { offerId: "1n" }, context: { sender: BOB, origin: BOB }, gasLimit: 5_000_000 });
  t.fails(expired, "offer expired");
  late.commit();
  const carolBefore = t.balance(CAROL);
  const cancel = t.ok(t.send(CAROL, MARKET, "cancelOffer", { offerId: "1n" }));
  gas.cancelOffer = cancel.gasUsed;
  assert.equal(t.balance(CAROL), carolBefore + 9n * COIN);
  assert.equal(t.balance(MARKET), 0n);
  assertEscrow(t, MARKET);
});

test("nftmarket: ผู้ซื้อที่เป็นโปรแกรม · เรียกตลาดซ้อน (reentrancy) ถูกปฏิเสธ", () => {
  const t = setup();
  t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "1n", price: "5n" }));
  t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: "2n", price: "5n" }));
  // กระเป๋าโปรแกรม (มี onERC721Received) ซื้อผ่าน execute
  t.vm.db.load({ [VM.nativeKey(WALLET, "received")]: "100n" });
  t.ok(t.send(BOB, WALLET, "execute", { target: MARKET, fn: "buy", input: { listingId: "0n" }, value: "5n" }));
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), WALLET);

  // ผู้โจมตีพยายามยกเลิกรายการระหว่างได้รับ NFT → ทั้ง tx ล้ม
  const res = t.send(BOB, ATTACKER, "attack", { market: MARKET, listingId: "1n", other: "1n" }, { value: "5" });
  t.fails(res, "reentrant call");
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "2n" }), MARKET);
  assert.equal(t.query(MARKET, "getListing", { listingId: "1n" }).status, "active");
  assertEscrow(t, MARKET);
});

test("nftmarket: รายการแบบแบ่งหน้า · กรองตาม collection / ผู้ขาย / activeOnly · limit สูงสุด 50", () => {
  const t = setup();
  for (const id of ["1n", "2n", "3n"]) t.ok(t.send(ALICE, MARKET, "list", { nft: NFT, tokenId: id, price: "5n" }));
  t.ok(t.send(ALICE, MARKET, "listMulti", { multiToken: ITEMS, id: "7n", amount: "1n", pricePerUnit: "5n" }));
  t.ok(t.send(ALICE, MARKET, "cancel", { listingId: "1n" }));
  const first = t.query(MARKET, "listings", { start: "0n", limit: "2n" });
  assert.deepEqual([first.items.map((l) => l.listingId), first.next, first.total], [["0n", "1n"], "2n", "4n"]);
  const rest = t.query(MARKET, "listings", { start: first.next, limit: "2n" });
  assert.deepEqual([rest.items.map((l) => l.listingId), rest.next], [["2n", "3n"], null]);
  assert.deepEqual(t.query(MARKET, "listings", { activeOnly: true }).items.map((l) => l.listingId), ["0n", "2n", "3n"]);
  assert.deepEqual(t.query(MARKET, "listingsForCollection", { nft: NFT }).items.map((l) => l.listingId), ["0n", "1n", "2n"]);
  assert.deepEqual(t.query(MARKET, "listingsForCollection", { nft: ITEMS }).items.map((l) => l.kind), ["erc1155"]);
  assert.equal(t.query(MARKET, "listingsOf", { seller: BOB }).total, "0n");
  assert.equal(t.vm.query({ programUuid: MARKET, functionName: "listings", input: { limit: "51n" } }).status, "throw");
  assert.equal(t.vm.query({ programUuid: MARKET, functionName: "getListing", input: { listingId: "99n" } }).status, "throw");
  assert.equal(t.vm.query({ programUuid: MARKET, functionName: "getOffer", input: { offerId: "0n" } }).status, "throw");
  assertEscrow(t, MARKET);
});

test("nftmarket: ค่าแก๊สของงานหลักอยู่ใต้ 5M ต่อ tx (fork bluewolf)", () => {
  for (const [name, used] of Object.entries(gas)) assert.ok(used > 0 && used < 1_000_000, `${name} = ${used}`);
  console.log("nftmarket gasUsed", gas);
});
