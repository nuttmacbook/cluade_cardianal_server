import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { MULTISENDER_PROGRAM, MULTISENDER_FUNCTIONS, MULTISENDER_MAX_ITEMS } from "../src/standards/multisender.js";
import { TOKEN_PROGRAM, ZERO_ADDRESS, exportedFunctions } from "../src/standards/token.js";
import { NFT_PROGRAM } from "../src/standards/nft.js";
import { MULTITOKEN_PROGRAM } from "../src/standards/multitoken.js";
import { ERC721_RECEIVED, ERC1155_RECEIVED } from "../src/standards/wallet.js";
import { reviewProgram } from "../src/core/autoreview.js";

/*
 * multisender (src/standards/multisender.js): one tx sends native coin / tokens / NFTs / multi-tokens to many recipients
 *   all-or-nothing · pulled from the sender straight to recipients (the program holds nothing) · 1 Sent event per call · at most MULTISENDER_MAX_ITEMS items
 */

const T = Date.parse("2026-11-11T00:00:00Z");
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b1";
const CAROL = "0x00000000000000000000000000000000000000c1";
const SENDER = "0x000000000000000000000000000000000000c0d0";   // multisender
const TOKEN = "0x000000000000000000000000000000000000c0d1";
const TOKEN2 = "0x000000000000000000000000000000000000c0d2";
const NFT = "0x000000000000000000000000000000000000c0d3";
const MT = "0x000000000000000000000000000000000000c0d4";
const RECEIVER = "0x000000000000000000000000000000000000c0d5";   // accepts NFT / 1155
const REJECTOR = "0x000000000000000000000000000000000000c0d6";   // rejects
const REENTER = "0x000000000000000000000000000000000000c0d7";    // accepts, but tries to re-enter multisender
const LIAR = "0x000000000000000000000000000000000000c0d8";       // token that returns false
const COIN = 10n ** 18n;
const addr = (i) => `0x${(0xe000 + i).toString(16).padStart(40, "0")}`;

const RECEIVER_CODE = `function program() {
  function initialization() {}
  function onERC721Received(params) { writeDB("got", params.input.tokenId); return "${ERC721_RECEIVED}" }
  function onERC1155Received(params) { return "${ERC1155_RECEIVED}" }
  return { onERC721Received, onERC1155Received }
}`;
const REJECTOR_CODE = `function program() {
  function initialization() {}
  function onERC721Received() { return "0x00000000" }
  function onERC1155Received() { return "0x00000000" }
  return { onERC721Received, onERC1155Received }
}`;
const REENTER_CODE = `function program() {
  function initialization() {}
  function onERC721Received(params) {
    try {
      runProgram("${SENDER}", "sendNft", { nft: "${NFT}", transfers: [{ to: "${CAROL}", tokenId: 3n }] })
      writeDB("reentry", "succeeded")
    } catch (e) { writeDB("reentry", String(e.message)) }
    return "${ERC721_RECEIVED}"
  }
  return { onERC721Received }
}`;
const LIAR_CODE = `function program() {
  function initialization() {}
  function transferFrom() { return false }
  return { transferFrom }
}`;

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 20_000, forks: { bluewolf: 0 }, maxBlockGas: 5_000_000, maxTxGas: 5_000_000 });
  vm.db.load(Object.fromEntries([ALICE, BOB, CAROL].map((a) => [VM.nativeKey(a, "received"), `${1000n * COIN}n`])));
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
  const deploy = (programUuid, code, initInput = {}, sender = ALICE) => block((b) => {
    ok(b.deploy({ programUuid, code, context: { sender, origin: sender }, initInput }));
    ok(b.init({ programUuid }));
  });
  const send = (who, programUuid, functionName, input = {}, extra = {}) => block((b) =>
    b.call({ programUuid, functionName, input, context: { sender: who, origin: who }, gasLimit: 5_000_000, ...extra }));
  const fail = (res, message) => {
    assert.equal(res.status, "throw", `expected throw, got ${JSON.stringify(res.result)}`);
    if (message) assert.match(res.error.message, message);
    return res;
  };
  const query = (programUuid, functionName, input = {}) => ok(vm.query({ programUuid, functionName, input })).result;
  const balance = (who) => BigInt(vm.nativeBalanceOf(who).balance);
  const tokenBalance = (token, who) => BigInt(query(token, "balanceOf", { who }).slice(0, -1));
  const storage = (program, key) => vm.read(VM.storageKey(program, key));

  deploy(SENDER, MULTISENDER_PROGRAM, { namespace: "multisender", description: "send many assets in one tx" });
  deploy(TOKEN, TOKEN_PROGRAM, { name: "A", ticker: "A", decimals: "18n", supply: `${1_000_000n * COIN}n` });
  deploy(TOKEN2, TOKEN_PROGRAM, { name: "B", ticker: "B", decimals: "6n", supply: "1000000000n" });
  deploy(NFT, NFT_PROGRAM, { name: "N", symbol: "N" });
  deploy(MT, MULTITOKEN_PROGRAM, { uri: "x" });
  deploy(RECEIVER, RECEIVER_CODE);
  deploy(REJECTOR, REJECTOR_CODE);
  deploy(REENTER, REENTER_CODE);
  deploy(LIAR, LIAR_CODE);
  return { vm, send, ok, fail, query, balance, tokenBalance, storage, block };
}

const sentEvent = (res) => {
  const sent = res.events.filter((e) => e.name === "Sent");
  assert.equal(sent.length, 1, "exactly one Sent event per call");
  return sent[0].data;
};
/** the multisender program must hold nothing after a call · no leftover state */
function assertEmpty(t, tokens = [TOKEN, TOKEN2]) {
  assert.equal(t.balance(SENDER), 0n, "no native left in multisender");
  for (const token of tokens) assert.equal(t.tokenBalance(token, SENDER), 0n, "no token left in multisender");
  assert.equal(t.storage(SENDER, "lock"), undefined, "lock cleared");
}

test("multisender: metadata · passes autoreview · exports match MULTISENDER_FUNCTIONS", () => {
  const t = setup();
  assert.equal(t.vm.resolveNamespace("multisender"), SENDER);
  assert.equal(t.vm.getMetadata(SENDER).description, "send many assets in one tx");
  assert.equal(t.vm.getMetadata(SENDER).upgrader, undefined);
  const review = reviewProgram(MULTISENDER_PROGRAM);
  assert.ok(review.ok, review.message);
  assert.deepEqual(exportedFunctions(MULTISENDER_PROGRAM), MULTISENDER_FUNCTIONS);
  assert.equal(t.send(ALICE, SENDER, "initialization", {}).status, "throw", "initialization cannot be called again");
});

test("sendNative: value = exact sum → recipients get everything · Sent event once · program keeps no funds", () => {
  const t = setup();
  const [b0, c0, a0] = [t.balance(BOB), t.balance(CAROL), t.balance(ALICE)];
  const res = t.ok(t.send(ALICE, SENDER, "sendNative", { transfers: [{ to: BOB, amount: `${2n * COIN}n` }, { to: CAROL, amount: `${3n * COIN}n` }, { to: BOB, amount: "1n" }] },
    { value: `${5n * COIN + 1n}` }));
  assert.deepEqual(res.result, { count: "3n", total: `${5n * COIN + 1n}n` });
  assert.deepEqual(sentEvent(res), { kind: "native", asset: ZERO_ADDRESS, sender: ALICE, count: "3n", total: `${5n * COIN + 1n}n` });
  assert.equal(t.balance(BOB), b0 + 2n * COIN + 1n);
  assert.equal(t.balance(CAROL), c0 + 3n * COIN);
  assert.equal(t.balance(ALICE), a0 - 5n * COIN - 1n);
  assertEmpty(t);
  // recipients may be programs (transferNative does not run the recipient's code)
  t.ok(t.send(ALICE, SENDER, "sendNative", { transfers: [{ to: RECEIVER, amount: "7n" }] }, { value: "7" }));
  assert.equal(t.balance(RECEIVER), 7n);
  assertEmpty(t);
});

test("sendNative: value short / over / missing → the whole call fails, nobody gets funds", () => {
  const t = setup();
  const b0 = t.balance(BOB);
  const transfers = [{ to: BOB, amount: "10n" }, { to: CAROL, amount: "20n" }];
  t.fail(t.send(ALICE, SENDER, "sendNative", { transfers }, { value: "29" }), /value must equal the sum of amounts \(30\)/);
  t.fail(t.send(ALICE, SENDER, "sendNative", { transfers }, { value: "31" }), /value must equal/);
  t.fail(t.send(ALICE, SENDER, "sendNative", { transfers }), /value must equal/);
  assert.equal(t.balance(BOB), b0);
  assertEmpty(t);
});

test("input validation: bad items / recipients / amounts → fails with a clear message", () => {
  const t = setup();
  const native = (transfers, value = "1") => t.send(ALICE, SENDER, "sendNative", { transfers }, { value });
  t.fail(native(undefined), /transfers must be an array/);
  t.fail(native([]), /no transfers/);
  t.fail(native([null]), /each transfer must be an object/);
  t.fail(native(["x"]), /each transfer must be an object/);
  t.fail(native([{ to: "bob", amount: "1n" }]), /to must be an address/);
  t.fail(native([{ to: ZERO_ADDRESS, amount: "1n" }]), /zero address/);
  t.fail(native([{ to: SENDER, amount: "1n" }]), /must not be the multisender/);
  t.fail(native([{ to: ALICE, amount: "1n" }]), /must not be the sender/);
  t.fail(native([{ to: BOB, amount: "0n" }], "0"), /amount must be a bigint greater than 0/);
  t.fail(native([{ to: BOB, amount: "-1n" }]), /amount must be a bigint greater than 0/);
  t.fail(native([{ to: BOB, amount: "1" }]), /amount must be a bigint/);
  t.fail(native([{ to: BOB }]), /amount must be a bigint/);
  const tooMany = Array.from({ length: MULTISENDER_MAX_ITEMS + 1 }, (_, i) => ({ to: addr(i), amount: "1n" }));
  t.fail(native(tooMany, String(MULTISENDER_MAX_ITEMS + 1)), new RegExp(`too many transfers \\(max ${MULTISENDER_MAX_ITEMS}\\)`));

  // asset must be a program
  t.fail(t.send(ALICE, SENDER, "sendToken", { token: BOB, transfers: [{ to: CAROL, amount: "1n" }] }), /token is not a program/);
  t.fail(t.send(ALICE, SENDER, "sendToken", { token: "x", transfers: [{ to: CAROL, amount: "1n" }] }), /token must be an address/);
  t.fail(t.send(ALICE, SENDER, "sendToken", { token: SENDER, transfers: [{ to: CAROL, amount: "1n" }] }), /token is not a valid program/);
  t.fail(t.send(ALICE, SENDER, "sendTokens", { transfers: [{ token: ZERO_ADDRESS, to: CAROL, amount: "1n" }] }), /token is not a valid program/);
  t.fail(t.send(ALICE, SENDER, "sendNft", { nft: BOB, transfers: [{ to: CAROL, tokenId: "1n" }] }), /nft is not a program/);
  t.fail(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: BOB, transfers: [{ to: CAROL, id: "1n", amount: "1n" }] }), /multiToken is not a program/);
  t.fail(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers: [{ to: CAROL, tokenId: "-1n" }] }), /tokenId must be a non-negative bigint/);
  t.fail(t.send(ALICE, SENDER, "sendNft", { nft: NFT, data: 5, transfers: [{ to: CAROL, tokenId: "1n" }] }), /data must be a string/);
  t.fail(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: MT, transfers: [{ to: CAROL, id: "x", amount: "1n" }] }), /id must be a non-negative bigint/);

  // other functions must not attach value (funds would get stuck in the program)
  for (const [fn, input] of [["sendToken", { token: TOKEN, transfers: [{ to: BOB, amount: "1n" }] }],
    ["sendTokens", { transfers: [{ token: TOKEN, to: BOB, amount: "1n" }] }],
    ["sendNft", { nft: NFT, transfers: [{ to: BOB, tokenId: "1n" }] }],
    ["sendMultiToken", { multiToken: MT, transfers: [{ to: BOB, id: "1n", amount: "1n" }] }]]) {
    t.fail(t.send(ALICE, SENDER, fn, input, { value: "5" }), /do not attach native value/);
  }
  assertEmpty(t);
});

test("sendToken: transferFrom from the sender straight to recipients · approve first · insufficient allowance = everything fails", () => {
  const t = setup();
  const transfers = [{ to: BOB, amount: "100n" }, { to: CAROL, amount: "250n" }];
  t.fail(t.send(ALICE, SENDER, "sendToken", { token: TOKEN, transfers }), /insufficient allowance/);
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: SENDER, amount: "300n" }));
  t.fail(t.send(ALICE, SENDER, "sendToken", { token: TOKEN, transfers }), /insufficient allowance/);
  assert.equal(t.tokenBalance(TOKEN, BOB), 0n, "all-or-nothing: first item rolled back");
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: SENDER, amount: "350n" }));
  const a0 = t.tokenBalance(TOKEN, ALICE);
  const res = t.ok(t.send(ALICE, SENDER, "sendToken", { token: TOKEN, transfers }));
  assert.deepEqual(res.result, { count: "2n", total: "350n" });
  assert.deepEqual(sentEvent(res), { kind: "token", asset: TOKEN, sender: ALICE, count: "2n", total: "350n" });
  assert.equal(res.events.filter((e) => e.name === "Transfer").length, 2, "token emits its own Transfer per item");
  assert.equal(t.tokenBalance(TOKEN, BOB), 100n);
  assert.equal(t.tokenBalance(TOKEN, CAROL), 250n);
  assert.equal(t.tokenBalance(TOKEN, ALICE), a0 - 350n);
  assert.equal(t.query(TOKEN, "allowance", { owner: ALICE, spender: SENDER }), "0n");
  assertEmpty(t);
  // alice's allowance cannot be used for bob (from is always the call's sender)
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: SENDER, amount: "1000n" }));
  t.fail(t.send(BOB, SENDER, "sendToken", { token: TOKEN, from: ALICE, transfers: [{ to: CAROL, amount: "1n" }] }), /insufficient (allowance|balance)/);
  // insufficient balance
  t.ok(t.send(BOB, TOKEN, "approve", { spender: SENDER, amount: "1000n" }));
  t.fail(t.send(BOB, SENDER, "sendToken", { token: TOKEN, transfers: [{ to: CAROL, amount: "101n" }] }), /insufficient balance/);
});

test("sendToken: a token that does not return true → fails", () => {
  const t = setup();
  t.fail(t.send(ALICE, SENDER, "sendToken", { token: LIAR, transfers: [{ to: BOB, amount: "1n" }] }), /token transferFrom did not return true/);
});

test("sendTokens: several tokens in one call · if any fails, everything reverts", () => {
  const t = setup();
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: SENDER, amount: "10n" }));
  t.ok(t.send(ALICE, TOKEN2, "approve", { spender: SENDER, amount: "5n" }));
  const transfers = [{ token: TOKEN, to: BOB, amount: "10n" }, { token: TOKEN2, to: CAROL, amount: "5n" }, { token: TOKEN2, to: BOB, amount: "1n" }];
  t.fail(t.send(ALICE, SENDER, "sendTokens", { transfers }), /insufficient allowance/);
  assert.equal(t.tokenBalance(TOKEN, BOB), 0n);
  assert.equal(t.tokenBalance(TOKEN2, CAROL), 0n);
  t.ok(t.send(ALICE, TOKEN2, "approve", { spender: SENDER, amount: "6n" }));
  const res = t.ok(t.send(ALICE, SENDER, "sendTokens", { transfers }));
  assert.deepEqual(sentEvent(res), { kind: "tokens", asset: ZERO_ADDRESS, sender: ALICE, count: "3n", total: "16n" });
  assert.equal(t.tokenBalance(TOKEN, BOB), 10n);
  assert.equal(t.tokenBalance(TOKEN2, CAROL), 5n);
  assert.equal(t.tokenBalance(TOKEN2, BOB), 1n);
  assertEmpty(t);
  t.fail(t.send(ALICE, SENDER, "sendTokens", { transfers: [{ token: LIAR, to: BOB, amount: "1n" }] }), /did not return true/);
});

test("sendNft: safeTransferFrom from the sender · requires setApprovalForAll · program recipients must return the magic value · duplicate item = fails", () => {
  const t = setup();
  for (let i = 1; i <= 5; i += 1) t.ok(t.send(ALICE, NFT, "mint", { to: ALICE }));
  const transfers = [{ to: BOB, tokenId: "1n" }, { to: CAROL, tokenId: "2n" }, { to: RECEIVER, tokenId: "3n" }];
  t.fail(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers }), /not owner nor approved/);
  t.ok(t.send(ALICE, NFT, "setApprovalForAll", { operator: SENDER, approved: true }));
  const res = t.ok(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers }));
  assert.deepEqual(res.result, { count: "3n", total: "3n" });
  assert.deepEqual(sentEvent(res), { kind: "nft", asset: NFT, sender: ALICE, count: "3n", total: "3n" });
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "1n" }), BOB);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "2n" }), CAROL);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "3n" }), RECEIVER);
  assert.equal(t.storage(RECEIVER, "got"), "3n", "receiver hook was called");
  assert.equal(t.query(NFT, "balanceOf", { owner: SENDER }), "0n");
  // recipient rejects → the whole call reverts (the first item does not move)
  t.fail(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers: [{ to: BOB, tokenId: "4n" }, { to: REJECTOR, tokenId: "5n" }] }), /receiver did not accept/);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "4n" }), ALICE);
  // safe: false = plain transferFrom (recipient not asked)
  t.ok(t.send(ALICE, SENDER, "sendNft", { nft: NFT, safe: false, transfers: [{ to: REJECTOR, tokenId: "5n" }] }));
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "5n" }), REJECTOR);
  // an item the sender doesn't own / the same item twice in one call
  t.fail(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers: [{ to: CAROL, tokenId: "1n" }] }), /from is not the owner/);
  t.fail(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers: [{ to: BOB, tokenId: "4n" }, { to: CAROL, tokenId: "4n" }] }), /from is not the owner/);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "4n" }), ALICE);
  // others cannot use alice's operator approval
  t.fail(t.send(BOB, SENDER, "sendNft", { nft: NFT, transfers: [{ to: CAROL, tokenId: "4n" }] }), /from is not the owner/);
  assertEmpty(t);
});

test("reentrancy guard: an NFT recipient calling back into multisender during the callback → reentrant call", () => {
  const t = setup();
  for (let i = 1; i <= 3; i += 1) t.ok(t.send(ALICE, NFT, "mint", { to: i === 3 ? REENTER : ALICE }));
  t.ok(t.send(ALICE, NFT, "setApprovalForAll", { operator: SENDER, approved: true }));
  t.ok(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers: [{ to: REENTER, tokenId: "1n" }] }));
  assert.match(String(t.storage(REENTER, "reentry")), /reentrant call/);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: "3n" }), REENTER, "nested send did not happen");
  assertEmpty(t);
});

test("sendMultiToken: 1155 safeTransferFrom · must be an operator · insufficient balance / recipient rejects = everything fails", () => {
  const t = setup();
  t.ok(t.send(ALICE, MT, "mint", { to: ALICE, id: "1n", amount: "100n" }));
  t.ok(t.send(ALICE, MT, "mint", { to: ALICE, id: "2n", amount: "10n" }));
  const transfers = [{ to: BOB, id: "1n", amount: "30n" }, { to: CAROL, id: "2n", amount: "4n" }, { to: RECEIVER, id: "1n", amount: "5n" }];
  t.fail(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: MT, transfers }), /caller is not owner nor approved/);
  t.ok(t.send(ALICE, MT, "setApprovalForAll", { operator: SENDER, approved: true }));
  const res = t.ok(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: MT, transfers, data: "hi" }));
  assert.deepEqual(sentEvent(res), { kind: "multiToken", asset: MT, sender: ALICE, count: "3n", total: "39n" });
  assert.equal(res.events.filter((e) => e.name === "TransferSingle").length, 3);
  const bal = (account, id) => t.query(MT, "balanceOf", { account, id });
  assert.deepEqual([bal(ALICE, "1n"), bal(BOB, "1n"), bal(RECEIVER, "1n"), bal(CAROL, "2n"), bal(ALICE, "2n"), bal(SENDER, "1n")],
    ["65n", "30n", "5n", "4n", "6n", "0n"]);
  t.fail(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: MT, transfers: [{ to: BOB, id: "2n", amount: "6n" }, { to: CAROL, id: "2n", amount: "1n" }] }), /insufficient balance/);
  t.fail(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: MT, transfers: [{ to: BOB, id: "2n", amount: "1n" }, { to: REJECTOR, id: "2n", amount: "1n" }] }), /receiver did not accept/);
  assert.equal(bal(BOB, "2n"), "0n");
  t.fail(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: MT, transfers: [{ to: BOB, id: "2n", amount: "0n" }] }), /amount must be a bigint greater than 0/);
  assertEmpty(t);
});

test(`gas: ${MULTISENDER_MAX_ITEMS} items per call stay under half a 5M block for every kind (fork bluewolf)`, () => {
  const t = setup();
  const n = MULTISENDER_MAX_ITEMS;
  const recipients = Array.from({ length: n }, (_, i) => addr(i));
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: SENDER, amount: `${COIN}n` }));
  t.ok(t.send(ALICE, TOKEN2, "approve", { spender: SENDER, amount: `${COIN}n` }));
  t.ok(t.send(ALICE, NFT, "setApprovalForAll", { operator: SENDER, approved: true }));
  t.ok(t.send(ALICE, MT, "setApprovalForAll", { operator: SENDER, approved: true }));
  t.ok(t.send(ALICE, MT, "mint", { to: ALICE, id: "1n", amount: `${n}n` }));
  for (let i = 0; i < n; i += 1) t.ok(t.send(ALICE, NFT, "mint", { to: ALICE }));
  const gas = {
    native: t.ok(t.send(ALICE, SENDER, "sendNative", { transfers: recipients.map((to) => ({ to, amount: "1n" })) }, { value: String(n) })).gasUsed,
    token: t.ok(t.send(ALICE, SENDER, "sendToken", { token: TOKEN, transfers: recipients.map((to) => ({ to, amount: "1n" })) })).gasUsed,
    tokens: t.ok(t.send(ALICE, SENDER, "sendTokens", { transfers: recipients.map((to, i) => ({ token: i % 2 ? TOKEN : TOKEN2, to, amount: "1n" })) })).gasUsed,
    nft: t.ok(t.send(ALICE, SENDER, "sendNft", { nft: NFT, transfers: recipients.map((to, i) => ({ to, tokenId: `${i + 1}n` })) })).gasUsed,
    multiToken: t.ok(t.send(ALICE, SENDER, "sendMultiToken", { multiToken: MT, transfers: recipients.map((to) => ({ to, id: "1n", amount: "1n" })) })).gasUsed,
    tokenOne: t.ok(t.send(ALICE, SENDER, "sendToken", { token: TOKEN, transfers: [{ to: BOB, amount: "1n" }] })).gasUsed,
  };
  console.log(`multisender gas (${n} items):`, JSON.stringify(gas));
  for (const [kind, used] of Object.entries(gas)) assert.ok(used < 2_500_000, `${kind}: ${used}`);
  assertEmpty(t);
  assert.equal(t.tokenBalance(TOKEN, recipients[1]), 2n);
  assert.equal(t.query(NFT, "ownerOf", { tokenId: `${n}n` }), recipients[n - 1]);
});

test("addresses must be 40 hex chars: 0x+'g'*40 → fails, nothing moves", () => {
  const t = setup();
  const bad = `0x${"g".repeat(40)}`;
  const a0 = t.balance(ALICE);
  t.fail(t.send(ALICE, SENDER, "sendNative", { transfers: [{ to: bad, amount: "5n" }] }, { value: "5" }), /must be an address/);
  assert.equal(t.balance(bad), 0n);
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: SENDER, amount: "100n" }));
  const tok0 = t.tokenBalance(TOKEN, ALICE);
  t.fail(t.send(ALICE, SENDER, "sendToken", { token: TOKEN, transfers: [{ to: bad, amount: "5n" }] }), /must be an address/);
  assert.equal(t.tokenBalance(TOKEN, ALICE), tok0);
  assert.equal(t.query(TOKEN, "allowance", { owner: ALICE, spender: SENDER }), "100n");
  assert.equal(t.balance(ALICE), a0, "native not sent");
  assertEmpty(t);
});
