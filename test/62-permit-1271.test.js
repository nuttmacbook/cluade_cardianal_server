import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM, PERMIT_TYPE, checkTokenStandard } from "../src/standards/token.js";
import { WALLET_PROGRAM, SIGNATURE_CHECKER, ERC1271_MAGIC_VALUE, ERC1271_INVALID_VALUE } from "../src/standards/wallet.js";
import { MULTICALL_PROGRAM } from "../src/standards/multicall.js";
import { addressOf } from "../src/crypto/signature.js";
import { permitTypedData, permitDigest, permitDomainSeparator, signPermit, signWalletHash, signProgramMessage, recoverProgramMessage,
  recoverTypedDataDigest } from "../src/crypto/program-signature.js";
import { TypedDataEncoder } from "ethers";
import { reviewProgram } from "../src/core/autoreview.js";

/* permit (ERC-2612 + real EIP-712) on TOKEN_PROGRAM + signature checks for program wallets (ERC-1271) · deadline in seconds */

const T = "0x00000000000000000000000000000000000000f1";
const W = "0x00000000000000000000000000000000000000e1";
const M = "0x00000000000000000000000000000000000000e2";
const OWNER_KEY = `0x${"11".repeat(32)}`;
const WALLET_KEY = `0x${"22".repeat(32)}`;
const OTHER_KEY = `0x${"33".repeat(32)}`;
const OWNER = addressOf(OWNER_KEY);
const WALLET_OWNER = addressOf(WALLET_KEY);
const SPENDER = "0x00000000000000000000000000000000000000b2";
const RELAYER = "0x00000000000000000000000000000000000000c3";
const START = 1_000_000;

function chain({ chainId = 7777 } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId, recordBlocks: true });
  let number = 0;
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: START + number * 1000, feeRecipient: RELAYER });
    const results = fn(b);
    b.commit();
    return results;
  };
  const as = (who) => ({ sender: who.toLowerCase(), origin: who.toLowerCase() });
  block((b) => [
    b.deploy({ programUuid: T, code: TOKEN_PROGRAM, context: as(OWNER),
      initInput: { name: "Thai Baht Coin", ticker: "THBC", decimals: "6n", supply: "1000000000n" } }),
    b.init({ programUuid: T }),
    b.deploy({ programUuid: W, code: WALLET_PROGRAM, context: as(RELAYER), initInput: { owner: WALLET_OWNER } }),
    b.init({ programUuid: W }),
    b.deploy({ programUuid: M, code: MULTICALL_PROGRAM, context: as(RELAYER) }),
    b.init({ programUuid: M }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const call = (who, programUuid, functionName, input) => block((b) => [b.call({ programUuid, functionName, input, context: as(who) })])[0];
  const read = (programUuid, functionName, input = {}) => vm.query({ programUuid, functionName, input }).result;
  /** Time of the next block (as the next tx sees it) in seconds (permit uses an EIP-2612 deadline) */
  const nextTime = () => (START + (number + 1) * 1000) / 1000;
  return { vm, call, read, nextTime, chainId };
}

const fields = (c, overrides = {}) => ({
  name: "Thai Baht Coin", chainId: c.chainId, verifyingContract: T, owner: OWNER, spender: SPENDER,
  value: 5_000_000n, nonce: BigInt(String(c.read(T, "nonces", { owner: overrides.owner ?? OWNER })).replace(/n$/, "")),
  deadline: BigInt(c.nextTime() + 60), ...overrides,
});
const input = (f, signature) => ({ owner: f.owner, spender: f.spender, value: `${f.value}n`, deadline: `${f.deadline}n`, signature });

test("TOKEN_PROGRAM with permit still meets the token standard and autoreview · WALLET_PROGRAM / SIGNATURE_CHECKER pass autoreview", () => {
  assert.deepEqual(checkTokenStandard(TOKEN_PROGRAM), { ok: true, missing: [] });
  assert.deepEqual(reviewProgram(TOKEN_PROGRAM).issues, []);
  assert.deepEqual(reviewProgram(WALLET_PROGRAM).issues, []);
  assert.deepEqual(reviewProgram(`function program() {\n  ${SIGNATURE_CHECKER}\n  function check(params) { return isValidSignatureNow(params.input.signer, params.input.value, params.input.signature) }\n  return { check }\n}`).issues, []);
  assert.ok(TOKEN_PROGRAM.includes(PERMIT_TYPE));
});

test("permit message: permitDomain() / DOMAIN_SEPARATOR() in the program match ethers' EIP-712 · digest = TypedDataEncoder.hash", () => {
  const c = chain();
  assert.deepEqual(c.read(T, "permitDomain"), { name: "Thai Baht Coin", version: "1", chainId: "7777n", verifyingContract: T });
  const typed = permitTypedData(fields(c));
  const domain = { name: "Thai Baht Coin", version: "1", chainId: 7777, verifyingContract: T };
  assert.equal(c.read(T, "DOMAIN_SEPARATOR"), TypedDataEncoder.hashDomain(domain));
  assert.equal(c.read(T, "DOMAIN_SEPARATOR"), permitDomainSeparator(fields(c)));
  assert.equal(typed.primaryType, "Permit");
  assert.equal(TypedDataEncoder.from({ Permit: typed.types.Permit }).encodeType("Permit"), PERMIT_TYPE);
  assert.deepEqual(typed.types.EIP712Domain.map((f) => f.name), ["name", "version", "chainId", "verifyingContract"]);
  assert.equal(permitDigest(fields(c)), TypedDataEncoder.hash(domain, { Permit: typed.types.Permit }, typed.message));
  assert.doesNotThrow(() => JSON.stringify(typed));   // can be passed whole to eth_signTypedData_v4
  // the signature recovers from the digest · the old message helper (ecrecover of a message) still works
  const signature = signPermit(fields(c), OWNER_KEY);
  assert.equal(recoverTypedDataDigest(permitDigest(fields(c)), signature), OWNER);
  assert.equal(recoverTypedDataDigest(permitDigest(fields(c)), "0x1234"), null);
  assert.equal(recoverProgramMessage("hello", signProgramMessage("hello", OTHER_KEY)), addressOf(OTHER_KEY));
});

test("permit: someone else can send the tx for the owner → sets allowance + emits Approval + increments nonce · spender can then use transferFrom", () => {
  const c = chain();
  assert.equal(c.read(T, "nonces", { owner: OWNER }), "0n");
  const f = fields(c);
  const res = c.call(RELAYER, T, "permit", input(f, signPermit(f, OWNER_KEY)));
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.deepEqual(res.events.map((e) => [e.name, e.data]), [["Approval", { owner: OWNER, spender: SPENDER, amount: "5000000n" }]]);
  assert.equal(c.read(T, "allowance", { owner: OWNER, spender: SPENDER }), "5000000n");
  assert.equal(c.read(T, "nonces", { owner: OWNER }), "1n");
  assert.equal(c.call(SPENDER, T, "transferFrom", { from: OWNER, to: SPENDER, amount: "2000000n" }).status, "success");
  assert.equal(c.read(T, "balanceOf", { who: SPENDER }), "2000000n");
  // the second signature (nonce 1) works · plain approve still works as before
  const second = fields(c, { value: 7n });
  assert.equal(c.call(RELAYER, T, "permit", input(second, signPermit(second, OWNER_KEY))).status, "success");
  assert.equal(c.read(T, "allowance", { owner: OWNER, spender: SPENDER }), "7n");
  assert.equal(c.call(OWNER, T, "approve", { spender: SPENDER, amount: "9n" }).status, "success");
  assert.equal(c.read(T, "allowance", { owner: OWNER, spender: SPENDER }), "9n");
});

test("permit: the same signature cannot be reused (replay) · failed txs use no nonce", () => {
  const c = chain();
  const f = fields(c);
  const signature = signPermit(f, OWNER_KEY);
  assert.equal(c.call(RELAYER, T, "permit", input(f, signature)).status, "success");
  const replay = c.call(RELAYER, T, "permit", input(f, signature));
  assert.equal(replay.status, "throw");
  assert.match(replay.error.message, /invalid permit signature/);
  assert.equal(c.read(T, "nonces", { owner: OWNER }), "1n");
});

test("permit: expired (block.timestamp > deadline) → permit expired · deadline equal to the block time still works", () => {
  const c = chain();
  const late = fields(c, { deadline: BigInt(c.nextTime() - 1) });
  const expired = c.call(RELAYER, T, "permit", input(late, signPermit(late, OWNER_KEY)));
  assert.equal(expired.status, "throw");
  assert.match(expired.error.message, /permit expired/);
  assert.equal(c.read(T, "nonces", { owner: OWNER }), "0n");
  const exact = fields(c, { deadline: BigInt(c.nextTime()) });
  assert.equal(c.call(RELAYER, T, "permit", input(exact, signPermit(exact, OWNER_KEY))).status, "success");
});

test("permit: signed for another chain / another token / other values / signer not owner → invalid permit signature", () => {
  const c = chain();
  const cases = {
    "other chain": [fields(c, { chainId: 1 }), OWNER_KEY],
    "other token": [fields(c, { verifyingContract: M }), OWNER_KEY],
    "other token name": [fields(c, { name: "Other" }), OWNER_KEY],
    "future nonce": [fields(c, { nonce: 1n }), OWNER_KEY],
    "signed by someone else": [fields(c), OTHER_KEY],
  };
  for (const [label, [f, key]] of Object.entries(cases)) {
    const res = c.call(RELAYER, T, "permit", input(f, signPermit(f, key)));
    assert.equal(res.status, "throw", label);
    assert.match(res.error.message, /invalid permit signature/, label);
  }
  // sign one value but send another
  const f = fields(c);
  const tampered = c.call(RELAYER, T, "permit", { ...input(f, signPermit(f, OWNER_KEY)), value: "999999999n" });
  assert.match(tampered.error.message, /invalid permit signature/);
  // a chain 7777 signature cannot be used on another chain (chainId 1) with the same token at the same address
  const other = chain({ chainId: 1 });
  const res = other.call(RELAYER, T, "permit", input(f, signPermit(f, OWNER_KEY)));
  assert.match(res.error.message, /invalid permit signature/);
  // on chain 1, signed with chainId 1 → works
  const ok = fields(other);
  assert.equal(other.call(RELAYER, T, "permit", input(ok, signPermit(ok, OWNER_KEY))).status, "success");
  assert.equal(c.read(T, "nonces", { owner: OWNER }), "0n");
});

test("permit: wrong input types → clear errors · malformed signatures do not crash the program", () => {
  const c = chain();
  const f = fields(c);
  const signature = signPermit(f, OWNER_KEY);
  const cases = [
    [{ ...input(f, signature), deadline: "tomorrow" }, /deadline must be a bigint/],
    [{ ...input(f, signature), owner: "0x1234" }, /owner and spender must be addresses/],
    [{ ...input(f, signature), value: "-1n" }, /value must be a non-negative bigint/],
    [{ ...input(f, signature), spender: undefined }, /owner and spender must be addresses/],
    [{ ...input(f, "0xdead") }, /invalid permit signature/],
    [{ ...input(f, undefined) }, /invalid permit signature/],
  ];
  for (const [bad, message] of cases) assert.match(c.call(RELAYER, T, "permit", bad).error.message, message);
});

test("ERC-1271: a program wallet answers isValidSignature = magic only for its owner's signature", () => {
  const c = chain();
  const hash = VM.keccak256Hex("hello");
  assert.equal(c.read(W, "owner"), WALLET_OWNER);
  assert.equal(c.read(W, "isValidSignature", { hash, signature: signWalletHash(hash, WALLET_KEY) }), ERC1271_MAGIC_VALUE);
  assert.equal(c.read(W, "isValidSignature", { hash, signature: signWalletHash(hash, OTHER_KEY) }), ERC1271_INVALID_VALUE);
  assert.equal(c.read(W, "isValidSignature", { hash, signature: "0x00" }), ERC1271_INVALID_VALUE);
  assert.equal(c.read(W, "isValidSignature", { hash: "1n", signature: signWalletHash(hash, WALLET_KEY) }), ERC1271_INVALID_VALUE);
});

test("ERC-1271: permit whose owner is a program wallet → the token asks isValidSignature read-only (staticcall)", () => {
  const c = chain();
  assert.equal(c.call(OWNER, T, "transfer", { to: W, amount: "3000000n" }).status, "success");
  const f = fields(c, { owner: W });
  const res = c.call(RELAYER, T, "permit", input(f, signWalletHash(permitDigest(f), WALLET_KEY)));
  assert.equal(res.status, "success", JSON.stringify(res.error));
  const check = res.calls.find((entry) => entry.functionName === "isValidSignature");
  assert.equal(check.programUuid, W);
  assert.equal(check.type, "staticcall");
  assert.equal(c.read(T, "allowance", { owner: W, spender: SPENDER }), "5000000n");
  assert.equal(c.read(T, "nonces", { owner: W }), "1n");
  // the wallet owner can sign the permit typed data (owner = wallet) with eth_signTypedData_v4 = the same signature as signWalletHash(digest)
  const g = fields(c, { owner: W });
  assert.equal(signPermit(g, WALLET_KEY), signWalletHash(permitDigest(g), WALLET_KEY));
  // someone else signing for the wallet owner / the owner signing a permit with themselves as owner (different digest) → invalid
  for (const signature of [signWalletHash(permitDigest(g), OTHER_KEY), signPermit({ ...g, owner: WALLET_OWNER }, WALLET_KEY)]) {
    assert.match(c.call(RELAYER, T, "permit", input(g, signature)).error.message, /invalid permit signature/);
  }
  // owner is a program without isValidSignature → false (not some other error)
  const h = fields(c, { owner: M });
  assert.match(c.call(RELAYER, T, "permit", input(h, signWalletHash(permitDigest(h), WALLET_KEY))).error.message, /invalid permit signature/);
});

test("program wallet: execute is owner-only (the target's sender = the wallet) · transferOwnership", () => {
  const c = chain();
  c.call(OWNER, T, "transfer", { to: W, amount: "100n" });
  const moved = c.call(WALLET_OWNER, W, "execute", { target: T, fn: "transfer", input: { to: SPENDER, amount: "40n" } });
  assert.equal(moved.status, "success", JSON.stringify(moved.error));
  assert.equal(c.read(T, "balanceOf", { who: SPENDER }), "40n");
  assert.equal(c.read(T, "balanceOf", { who: W }), "60n");
  assert.match(c.call(RELAYER, W, "execute", { target: T, fn: "transfer", input: { to: RELAYER, amount: "1n" } }).error.message, /only owner/);
  assert.equal(c.call(WALLET_OWNER, W, "transferOwnership", { owner: RELAYER }).status, "success");
  assert.equal(c.read(W, "owner"), RELAYER);
  const hash = VM.keccak256Hex("x");
  assert.equal(c.read(W, "isValidSignature", { hash, signature: signWalletHash(hash, WALLET_KEY) }), ERC1271_INVALID_VALUE);
});
