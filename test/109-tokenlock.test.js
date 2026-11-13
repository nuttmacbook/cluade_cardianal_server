import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_LOCK_PROGRAM, TOKEN_LOCK_FUNCTIONS, TOKEN_LOCK_EVENTS, TOKEN_LOCK_READS } from "../src/standards/tokenlock.js";
import { TOKEN_PROGRAM, ZERO_ADDRESS, exportedFunctions, checkStandard } from "../src/standards/token.js";
import { reviewProgram } from "../src/core/autoreview.js";

/*
 * Token Lock (src/standards/tokenlock.js) — PinkLock-style token / LP token locks
 *   program time is in seconds · block.timestamp is in milliseconds
 */

const T0 = 1_800_000_000;   // seconds
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b1";
const CAROL = "0x00000000000000000000000000000000000000c1";
const LOCKER = "0x0000000000000000000000000000000000001001";
const TOKEN = "0x0000000000000000000000000000000000002001";
const LP = "0x0000000000000000000000000000000000002002";
const FEE = "0x0000000000000000000000000000000000002003";
const EVIL = "0x0000000000000000000000000000000000002004";
const COIN = 10n ** 18n;
const DAY = 86_400;

/** test tokens with odd behavior: fee (takes 10 % on transferFrom) · lie (returns true without transferring) · greedy (transfer pulls out 2×) · reenter (calls the locker re-entrantly) · inflate */
const WEIRD_TOKEN = `function program() {
  function initialization(params) {
    writeDB("mode", params.input.mode)
    writeDB("locker", params.input.locker)
    writeDB(map("balances", params.context.sender), params.input.supply)
  }
  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }
  function setMode(params) { writeDB("mode", params.input.mode) }
  function move(from, to, amount) {
    const b = readDB(map("balances", from)) || 0n
    if (b < amount) throw new Error("insufficient balance")
    writeDB(map("balances", from), b - amount)
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
  }
  function approve(params) { writeDB(map("allowance", params.context.sender, params.input.spender), params.input.amount); return true }
  function transfer(params) {
    const mode = readDB("mode")
    if (mode === "greedy") { move(params.context.sender, params.input.to, params.input.amount); move(params.context.sender, "0x000000000000000000000000000000000000dead", params.input.amount); return true }
    if (mode === "reenterUnlock") runProgram(readDB("locker"), "unlock", { id: 0n })
    move(params.context.sender, params.input.to, params.input.amount)
    return true
  }
  function transferFrom(params) {
    const mode = readDB("mode")
    const spender = params.context.sender
    const allowed = readDB(map("allowance", params.input.from, spender)) || 0n
    if (allowed < params.input.amount) throw new Error("insufficient allowance")
    writeDB(map("allowance", params.input.from, spender), allowed - params.input.amount)
    if (mode === "lie") return true
    if (mode === "reenter") runProgram(readDB("locker"), "lock", { token: ThisAddress(), amount: 1n, unlockAt: 1900000000n })
    if (mode === "inflate") { move(params.input.from, params.input.to, params.input.amount); writeDB(map("balances", params.input.to), readDB(map("balances", params.input.to)) + 5n); return true }
    if (mode === "fee") {
      const fee = params.input.amount / 10n
      move(params.input.from, params.input.to, params.input.amount - fee)
      move(params.input.from, "0x000000000000000000000000000000000000dead", fee)
      return true
    }
    move(params.input.from, params.input.to, params.input.amount)
    return true
  }
  return { balanceOf, approve, transfer, transferFrom, setMode }
}`;

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, forks: { bluewolf: 0 }, maxBlockGas: 5_000_000 });
  let now = T0;
  const block = (fn) => {
    const b = vm.createBlock({ timestamp: now * 1000 });
    const out = fn(b);
    b.commit();
    return out;
  };
  const ok = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return res;
  };
  const deploy = (programUuid, code, initInput = {}, sender = DEPLOYER) => block((b) => {
    ok(b.deploy({ programUuid, code, context: { sender, origin: sender }, initInput }));
    ok(b.init({ programUuid }));
  });
  const send = (who, programUuid, functionName, input = {}, extra = {}) => block((b) =>
    b.call({ programUuid, functionName, input, context: { sender: who, origin: who }, gasLimit: 4_000_000, ...extra }));
  const fail = (re, ...args) => {
    const res = send(...args);
    assert.equal(res.status, "throw", `expected throw for ${args[2]} ${JSON.stringify(args[3])}`);
    assert.match(res.error.message, re);
    return res;
  };
  const query = (programUuid, functionName, input = {}) => block((b) => ok(b.call({ programUuid, functionName, input, context: { sender: ALICE, origin: ALICE } })).result);
  const q = (programUuid, functionName, input = {}) => ok(vm.query({ programUuid, functionName, input }, { timestamp: now * 1000 })).result;

  deploy(LOCKER, TOKEN_LOCK_PROGRAM, { namespace: "tokenlock", description: "Token & LP locker" });
  deploy(TOKEN, TOKEN_PROGRAM, { name: "Test", ticker: "TST", decimals: "18n", supply: `${1_000_000n * COIN}n` }, ALICE);
  deploy(LP, TOKEN_PROGRAM, { name: "LP TST/WBWSC", ticker: "LP", decimals: "18n", supply: `${1000n * COIN}n` }, ALICE);
  deploy(FEE, WEIRD_TOKEN, { mode: "fee", locker: LOCKER, supply: "1000000n" }, ALICE);
  return {
    vm, ok, send, fail, query, q, deploy,
    at: (seconds) => { now = seconds; },
    now: () => now,
    bal: (token, who) => BigInt(q(token, "balanceOf", { who }).slice(0, -1)),
  };
}
const big = (v) => BigInt(String(v).replace(/n$/, ""));

test("tokenlock: export / autoreview / standard", () => {
  assert.deepEqual(TOKEN_LOCK_FUNCTIONS, ["lock", "vestingLock", "unlock", "extendLock", "increaseLock", "transferLockOwnership", "renounceLockOwnership"]);
  assert.deepEqual(exportedFunctions(TOKEN_LOCK_PROGRAM), [...TOKEN_LOCK_FUNCTIONS, ...TOKEN_LOCK_READS]);
  assert.deepEqual(checkStandard(TOKEN_LOCK_PROGRAM, TOKEN_LOCK_FUNCTIONS, TOKEN_LOCK_EVENTS), { ok: true, missing: [] });
  const review = reviewProgram(TOKEN_LOCK_PROGRAM);
  assert.ok(review.ok, review.message);
  const t = setup();
  assert.equal(t.vm.resolveNamespace("tokenlock"), LOCKER);
  assert.equal(t.vm.getMetadata(LOCKER).upgrader, undefined);
});

test("plain lock: pulls tokens · no withdrawal before time · withdraw once when due", () => {
  const t = setup();
  const amount = 1000n * COIN;
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: LOCKER, amount: `${amount}n` }));
  const unlockAt = T0 + 30 * DAY;
  const res = t.ok(t.send(ALICE, LOCKER, "lock", { token: TOKEN, amount: `${amount}n`, unlockAt: `${unlockAt}n`, description: "team" }));
  console.log("gas lock:", res.gasUsed);
  assert.equal(res.result, "0n");
  const locked = res.events.find((e) => e.name === "Locked");
  assert.equal(locked.program, LOCKER);
  assert.equal(big(locked.data.amount), amount);
  assert.equal(t.bal(TOKEN, LOCKER), amount);
  assert.equal(big(t.q(LOCKER, "totalLocked", { token: TOKEN })), amount);
  assert.equal(t.q(LOCKER, "lockCount"), "1n");
  const info = t.q(LOCKER, "getLock", { id: "0n" });
  assert.equal(info.owner, ALICE);
  assert.equal(info.creator, ALICE);
  assert.equal(info.description, "team");
  assert.equal(info.withdrawable, "0n");
  assert.equal(info.vesting, false);

  t.fail(/not unlocked yet/, ALICE, LOCKER, "unlock", { id: "0n" });
  t.at(unlockAt - 1);
  t.fail(/not unlocked yet/, ALICE, LOCKER, "unlock", { id: "0n" });
  t.at(unlockAt);
  t.fail(/only lock owner/, BOB, LOCKER, "unlock", { id: "0n" });
  t.fail(/only lock owner/, DEPLOYER, LOCKER, "unlock", { id: "0n" });
  assert.equal(big(t.q(LOCKER, "withdrawableOf", { id: "0n" })), amount);
  const before = t.bal(TOKEN, ALICE);
  const out = t.ok(t.send(ALICE, LOCKER, "unlock", { id: "0n" }));
  console.log("gas unlock:", out.gasUsed);
  assert.equal(big(out.result), amount);
  assert.equal(big(out.events.find((e) => e.name === "Unlocked").data.amount), amount);
  assert.equal(t.bal(TOKEN, ALICE), before + amount);
  assert.equal(t.bal(TOKEN, LOCKER), 0n);
  assert.equal(t.q(LOCKER, "totalLocked", { token: TOKEN }), "0n");
  t.fail(/nothing to withdraw/, ALICE, LOCKER, "unlock", { id: "0n" });
});

test("lock: another owner · LP token · every input validated", () => {
  const t = setup();
  t.ok(t.send(ALICE, LP, "approve", { spender: LOCKER, amount: `${100n * COIN}n` }));
  const unlockAt = `${T0 + 365 * DAY}n`;
  t.ok(t.send(ALICE, LOCKER, "lock", { token: LP, amount: `${10n * COIN}n`, unlockAt, owner: BOB }));
  assert.equal(t.q(LOCKER, "getLock", { id: "0n" }).owner, BOB);
  t.fail(/only lock owner/, ALICE, LOCKER, "extendLock", { id: "0n", unlockAt: `${T0 + 400 * DAY}n` });

  const good = { token: LP, amount: "1n", unlockAt };
  const bad = [
    [/token must be an address/, { ...good, token: "nope" }],
    [/token must be a program/, { ...good, token: CAROL }],
    [/zero address/, { ...good, token: ZERO_ADDRESS }],
    [/not be this program/, { ...good, token: LOCKER }],
    [/amount must be/, { ...good, amount: "0n" }],
    [/amount must be/, { ...good, amount: "-5n" }],
    [/amount must be/, { ...good, amount: undefined }],
    [/unlockAt must be in the future/, { ...good, unlockAt: `${T0}n` }],
    [/unlockAt must be a positive/, { ...good, unlockAt: "0n" }],
    [/milliseconds/, { ...good, unlockAt: `${(T0 + DAY) * 1000}n` }],
    [/owner must be an address/, { ...good, owner: "bob" }],
    [/owner must not be the zero/, { ...good, owner: ZERO_ADDRESS }],
    [/description must be a string/, { ...good, description: 5 }],
    [/description too long/, { ...good, description: "x".repeat(201) }],
    [/insufficient allowance/, { ...good, amount: `${1000n * COIN}n` }],
  ];
  for (const [re, input] of bad) t.fail(re, ALICE, LOCKER, "lock", input);
  t.fail(/insufficient allowance/, BOB, LOCKER, "lock", good);
  assert.equal(t.q(LOCKER, "lockCount"), "1n");
});

test("fee-on-transfer: records the amount actually received · lying / inflating tokens are rejected", () => {
  const t = setup();
  t.ok(t.send(ALICE, FEE, "approve", { spender: LOCKER, amount: "10000n" }));
  t.ok(t.send(ALICE, LOCKER, "lock", { token: FEE, amount: "1000n", unlockAt: `${T0 + DAY}n` }));
  const info = t.q(LOCKER, "getLock", { id: "0n" });
  assert.equal(info.amount, "900n");
  assert.equal(t.q(LOCKER, "totalLocked", { token: FEE }), "900n");
  assert.equal(t.bal(FEE, LOCKER), 900n);
  // increaseLock also counts the real amount
  const inc = t.ok(t.send(ALICE, LOCKER, "increaseLock", { id: "0n", amount: "100n" }));
  assert.equal(inc.result, "90n");
  assert.equal(inc.events.find((e) => e.name === "LockIncreased").data.total, "990n");
  t.at(T0 + DAY);
  assert.equal(t.ok(t.send(ALICE, LOCKER, "unlock", { id: "0n" })).result, "990n");

  t.ok(t.send(ALICE, FEE, "setMode", { mode: "lie" }));
  t.fail(/no tokens received/, ALICE, LOCKER, "lock", { token: FEE, amount: "100n", unlockAt: `${T0 + 2 * DAY}n` });
  t.ok(t.send(ALICE, FEE, "setMode", { mode: "inflate" }));
  t.fail(/more than amount/, ALICE, LOCKER, "lock", { token: FEE, amount: "100n", unlockAt: `${T0 + 2 * DAY}n` });
});

test("security: reentrancy · a token that pulls extra on withdrawal · other locks of the same token stay safe", () => {
  const t = setup();
  t.deploy(EVIL, WEIRD_TOKEN, { mode: "normal", locker: LOCKER, supply: "1000000n" }, ALICE);
  t.ok(t.send(ALICE, EVIL, "approve", { spender: LOCKER, amount: "100000n" }));
  t.ok(t.send(ALICE, LOCKER, "lock", { token: EVIL, amount: "1000n", unlockAt: `${T0 + DAY}n` }));
  t.ok(t.send(ALICE, LOCKER, "lock", { token: EVIL, amount: "1000n", unlockAt: `${T0 + 10 * DAY}n`, owner: BOB }));

  t.ok(t.send(ALICE, EVIL, "setMode", { mode: "reenter" }));
  t.fail(/reentrant call/, ALICE, LOCKER, "lock", { token: EVIL, amount: "10n", unlockAt: `${T0 + DAY}n` });

  t.at(T0 + DAY);
  // withdraws its own amount, but the token secretly pulls the same again from the locker (BOB's balance) → rejected
  t.ok(t.send(ALICE, EVIL, "setMode", { mode: "greedy" }));
  t.fail(/unexpected amount/, ALICE, LOCKER, "unlock", { id: "0n" });
  // transfer calls unlock re-entrantly → rejected
  t.ok(t.send(ALICE, EVIL, "setMode", { mode: "reenterUnlock" }));
  t.fail(/reentrant call/, ALICE, LOCKER, "unlock", { id: "0n" });
  assert.equal(t.bal(EVIL, LOCKER), 2000n);

  t.ok(t.send(ALICE, EVIL, "setMode", { mode: "normal" }));
  assert.equal(t.ok(t.send(ALICE, LOCKER, "unlock", { id: "0n" })).result, "1000n");
  t.fail(/nothing to withdraw/, ALICE, LOCKER, "unlock", { id: "0n" });
  t.fail(/not unlocked yet/, BOB, LOCKER, "unlock", { id: "1n" });
  assert.equal(t.bal(EVIL, LOCKER), 1000n);
  assert.equal(t.q(LOCKER, "totalLocked", { token: EVIL }), "1000n");
  // tokens sent in directly are not counted in any lock
  t.ok(t.send(ALICE, TOKEN, "transfer", { to: LOCKER, amount: "5n" }));
  assert.equal(t.q(LOCKER, "totalLocked", { token: TOKEN }), "0n");
});

test("vesting: TGE + cycles · rounds down · reaches 100 % with no leftover dust", () => {
  const t = setup();
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: LOCKER, amount: "1000000n" }));
  const tgeAt = T0 + DAY;
  const input = { token: TOKEN, amount: "1001n", tgeAt: `${tgeAt}n`, tgeBps: "1000n", cycleSeconds: `${7 * DAY}n`, cycleBps: "2500n", owner: BOB };
  const res = t.ok(t.send(ALICE, LOCKER, "vestingLock", input));
  console.log("gas vestingLock:", res.gasUsed);
  const info = t.q(LOCKER, "getLock", { id: "0n" });
  assert.equal(info.vesting, true);
  assert.equal(info.unlockAt, `${tgeAt + 4 * 7 * DAY}n`);   // 10 % + 4 × 25 % ≥ 100 %
  t.fail(/not unlocked yet/, BOB, LOCKER, "unlock", { id: "0n" });
  t.at(tgeAt);
  assert.equal(t.q(LOCKER, "withdrawableOf", { id: "0n" }), "100n");   // 1001 × 10 % rounded down
  assert.equal(t.ok(t.send(BOB, LOCKER, "unlock", { id: "0n" })).result, "100n");
  t.fail(/nothing to withdraw/, BOB, LOCKER, "unlock", { id: "0n" });
  t.at(tgeAt + 7 * DAY - 1);
  t.fail(/nothing to withdraw/, BOB, LOCKER, "unlock", { id: "0n" });
  t.at(tgeAt + 7 * DAY);
  assert.equal(t.ok(t.send(BOB, LOCKER, "unlock", { id: "0n" })).result, "250n");   // 35 % = 350 − 100
  t.at(tgeAt + 3 * 7 * DAY + 5);
  assert.equal(t.ok(t.send(BOB, LOCKER, "unlock", { id: "0n" })).result, "500n");   // 85 % = 850
  t.at(tgeAt + 100 * 7 * DAY);
  assert.equal(t.ok(t.send(BOB, LOCKER, "unlock", { id: "0n" })).result, "151n");   // remainder fully returned
  assert.equal(t.bal(TOKEN, BOB), 1001n);
  t.fail(/nothing to withdraw/, BOB, LOCKER, "unlock", { id: "0n" });
  t.fail(/fully withdrawn/, BOB, LOCKER, "transferLockOwnership", { id: "0n", newOwner: CAROL });

  // tiny bps with a small amount: still fully withdrawable once all cycles pass
  t.ok(t.send(ALICE, LOCKER, "vestingLock", { token: TOKEN, amount: "3n", tgeAt: `${t.now() + 1}n`, tgeBps: "1n", cycleSeconds: "1n", cycleBps: "5000n" }));
  t.at(t.now() + 3);
  assert.equal(t.ok(t.send(ALICE, LOCKER, "unlock", { id: "1n" })).result, "3n");

  const fresh = { ...input, tgeAt: `${t.now() + DAY}n` };
  const bad = [
    [/tgeBps must be/, { ...fresh, tgeBps: "0n" }],
    [/tgeBps must be/, { ...fresh, tgeBps: "10001n" }],
    [/cycleBps must be/, { ...fresh, cycleBps: "0n" }],
    [/tgeBps \+ cycleBps/, { ...fresh, tgeBps: "5000n", cycleBps: "5001n" }],
    [/tgeBps \+ cycleBps/, { ...fresh, tgeBps: "10000n", cycleBps: "1n" }],
    [/cycleSeconds must be/, { ...fresh, cycleSeconds: "0n" }],
    [/tgeAt must be in the future/, { ...fresh, tgeAt: `${t.now()}n` }],
    [/too far/, { ...fresh, tgeBps: "1n", cycleBps: "1n", cycleSeconds: "99999999999n" }],
  ];
  for (const [re, i] of bad) t.fail(re, ALICE, LOCKER, "vestingLock", i);
});

test("extendLock / increaseLock: owner only · plain locks only · time conditions", () => {
  const t = setup();
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: LOCKER, amount: "1000000n" }));
  const unlockAt = T0 + 10 * DAY;
  t.ok(t.send(ALICE, LOCKER, "lock", { token: TOKEN, amount: "100n", unlockAt: `${unlockAt}n` }));
  t.ok(t.send(ALICE, LOCKER, "vestingLock", { token: TOKEN, amount: "100n", tgeAt: `${T0 + DAY}n`, tgeBps: "5000n", cycleSeconds: "60n", cycleBps: "5000n" }));

  t.fail(/later than the current/, ALICE, LOCKER, "extendLock", { id: "0n", unlockAt: `${unlockAt}n` });
  t.fail(/only lock owner/, BOB, LOCKER, "extendLock", { id: "0n", unlockAt: `${unlockAt + DAY}n` });
  t.fail(/vesting locks cannot be extended/, ALICE, LOCKER, "extendLock", { id: "1n", unlockAt: `${unlockAt + DAY}n` });
  t.fail(/lock does not exist/, ALICE, LOCKER, "extendLock", { id: "9n", unlockAt: `${unlockAt + DAY}n` });
  t.fail(/id must be/, ALICE, LOCKER, "extendLock", { id: "x", unlockAt: `${unlockAt + DAY}n` });
  const ext = t.ok(t.send(ALICE, LOCKER, "extendLock", { id: "0n", unlockAt: `${unlockAt + DAY}n` }));
  console.log("gas extendLock:", ext.gasUsed);
  assert.deepEqual(ext.events.map((e) => e.name), ["LockExtended"]);
  assert.equal(ext.events[0].data.previousUnlockAt, `${unlockAt}n`);

  t.fail(/only lock owner/, BOB, LOCKER, "increaseLock", { id: "0n", amount: "1n" });
  t.fail(/vesting locks cannot be increased/, ALICE, LOCKER, "increaseLock", { id: "1n", amount: "1n" });
  t.fail(/amount must be/, ALICE, LOCKER, "increaseLock", { id: "0n", amount: "0n" });
  const inc = t.ok(t.send(ALICE, LOCKER, "increaseLock", { id: "0n", amount: "50n" }));
  console.log("gas increaseLock:", inc.gasUsed);
  assert.equal(t.q(LOCKER, "getLock", { id: "0n" }).amount, "150n");
  assert.equal(t.q(LOCKER, "totalLocked", { token: TOKEN }), "250n");

  t.at(unlockAt + DAY);
  t.fail(/already unlocked/, ALICE, LOCKER, "increaseLock", { id: "0n", amount: "1n" });
  t.ok(t.send(ALICE, LOCKER, "unlock", { id: "0n" }));
  t.fail(/fully withdrawn/, ALICE, LOCKER, "extendLock", { id: "0n", unlockAt: `${unlockAt + 99 * DAY}n` });
});

test("transfer / renounce: moves locksOf entries · once renounced nobody can withdraw (deployer included)", () => {
  const t = setup();
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: LOCKER, amount: "1000000n" }));
  for (let i = 0; i < 3; i += 1) t.ok(t.send(ALICE, LOCKER, "lock", { token: TOKEN, amount: "10n", unlockAt: `${T0 + DAY}n` }));
  assert.deepEqual(t.q(LOCKER, "locksOf", { owner: ALICE }).map((l) => l.id), ["0n", "1n", "2n"]);

  t.fail(/newOwner must be an address/, ALICE, LOCKER, "transferLockOwnership", { id: "0n", newOwner: "x" });
  t.fail(/use renounceLockOwnership/, ALICE, LOCKER, "transferLockOwnership", { id: "0n", newOwner: ZERO_ADDRESS });
  t.fail(/already the owner/, ALICE, LOCKER, "transferLockOwnership", { id: "0n", newOwner: ALICE });
  t.fail(/only lock owner/, BOB, LOCKER, "transferLockOwnership", { id: "0n", newOwner: BOB });
  const tr = t.ok(t.send(ALICE, LOCKER, "transferLockOwnership", { id: "0n", newOwner: BOB }));
  console.log("gas transferLockOwnership:", tr.gasUsed);
  assert.deepEqual(tr.events[0].data, { id: "0n", previousOwner: ALICE, newOwner: BOB });
  assert.deepEqual(t.q(LOCKER, "locksOf", { owner: ALICE }).map((l) => l.id), ["2n", "1n"]);
  assert.deepEqual(t.q(LOCKER, "locksOf", { owner: BOB }).map((l) => l.id), ["0n"]);

  t.fail(/only lock owner/, CAROL, LOCKER, "renounceLockOwnership", { id: "1n" });
  const rn = t.ok(t.send(ALICE, LOCKER, "renounceLockOwnership", { id: "1n" }));
  assert.equal(rn.events[0].data.newOwner, ZERO_ADDRESS);
  assert.deepEqual(t.q(LOCKER, "locksOf", { owner: ALICE }).map((l) => l.id), ["2n"]);
  assert.equal(t.q(LOCKER, "getLock", { id: "1n" }).owner, ZERO_ADDRESS);

  t.at(T0 + 10 * DAY);
  for (const who of [ALICE, DEPLOYER, ZERO_ADDRESS, BOB]) t.fail(/renounced/, who, LOCKER, "unlock", { id: "1n" });
  t.fail(/renounced/, ALICE, LOCKER, "transferLockOwnership", { id: "1n", newOwner: ALICE });
  t.fail(/renounced/, ALICE, LOCKER, "renounceLockOwnership", { id: "1n" });
  t.fail(/only lock owner/, ALICE, LOCKER, "unlock", { id: "0n" });
  assert.equal(t.ok(t.send(BOB, LOCKER, "unlock", { id: "0n" })).result, "10n");
  assert.equal(t.ok(t.send(ALICE, LOCKER, "unlock", { id: "2n" })).result, "10n");
  assert.equal(t.q(LOCKER, "totalLocked", { token: TOKEN }), "10n");   // renounced locks stay forever
  assert.equal(t.bal(TOKEN, LOCKER), 10n);
});

test("paged reads: start / limit · max limit 50 · input validation", () => {
  const t = setup();
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: LOCKER, amount: "1000000n" }));
  t.ok(t.send(ALICE, LP, "approve", { spender: LOCKER, amount: "1000000n" }));
  for (let i = 0; i < 55; i += 1) t.ok(t.send(ALICE, LOCKER, "lock", { token: TOKEN, amount: "1n", unlockAt: `${T0 + DAY}n` }));
  t.ok(t.send(ALICE, LOCKER, "lock", { token: LP, amount: "7n", unlockAt: `${T0 + DAY}n` }));
  assert.equal(t.q(LOCKER, "lockCount"), "56n");
  assert.equal(t.q(LOCKER, "locksOf", { owner: ALICE }).length, 20);
  const big50 = t.q(LOCKER, "locksOf", { owner: ALICE, limit: "1000n" });
  assert.equal(big50.length, 50);
  const tail = t.q(LOCKER, "locksForToken", { token: TOKEN, start: "50n", limit: "50n" });
  assert.deepEqual(tail.map((l) => l.id), ["50n", "51n", "52n", "53n", "54n"]);
  assert.deepEqual(t.q(LOCKER, "locksForToken", { token: LP }).map((l) => l.id), ["55n"]);
  assert.deepEqual(t.q(LOCKER, "locksForToken", { token: TOKEN, start: "999n" }), []);
  assert.deepEqual(t.q(LOCKER, "locksOf", { owner: CAROL }), []);
  assert.equal(t.q(LOCKER, "totalLocked", { token: TOKEN }), "55n");
  assert.equal(t.q(LOCKER, "totalLocked", { token: LP }), "7n");
  t.at(T0 + DAY);
  assert.equal(t.q(LOCKER, "locksOf", { owner: ALICE, limit: "1n" })[0].withdrawable, "1n");
  for (const bad of [{ owner: "x" }, { owner: ALICE, start: "-1n" }, { owner: ALICE, limit: "-1n" }, { owner: ALICE, start: "x" }]) {
    assert.equal(t.vm.query({ programUuid: LOCKER, functionName: "locksOf", input: bad }).status, "throw", JSON.stringify(bad));
  }
  const full = t.vm.query({ programUuid: LOCKER, functionName: "locksOf", input: { owner: ALICE, limit: "50n" } }, { timestamp: t.now() * 1000 });
  console.log("gas locksOf(50):", full.gasUsed);
  assert.ok(full.gasUsed < 1_000_000);
  assert.equal(t.vm.query({ programUuid: LOCKER, functionName: "getLock", input: { id: "56n" } }).status, "throw");
});

test("no native value allowed: lock / lockCount fail · the program holds no native coin", () => {
  const t = setup();
  t.vm.db.load({ [VM.nativeKey(ALICE, "received")]: `${1000n * COIN}n` });
  const nat = (who) => BigInt(t.vm.nativeBalanceOf(who).balance);
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: LOCKER, amount: "100n" }));
  const a0 = nat(ALICE);
  const r1 = t.send(ALICE, LOCKER, "lock", { token: TOKEN, amount: "100n", unlockAt: `${T0 + DAY}n` }, { value: `${5n * COIN}` });
  assert.equal(r1.status, "throw");
  assert.match(r1.error.message, /this function does not accept native value/);
  const r2 = t.send(ALICE, LOCKER, "lockCount", {}, { value: `${COIN}` });
  assert.equal(r2.status, "throw");
  assert.match(r2.error.message, /this function does not accept native value/);
  assert.equal(nat(LOCKER), 0n);
  assert.equal(nat(ALICE), a0);
  assert.equal(t.q(LOCKER, "lockCount"), "0n");
  assert.equal(t.bal(TOKEN, LOCKER), 0n);
});

test("renounced lock: withdrawable = 0 even after the time · unlock still fails", () => {
  const t = setup();
  t.ok(t.send(ALICE, TOKEN, "approve", { spender: LOCKER, amount: "100n" }));
  t.ok(t.send(ALICE, LOCKER, "lock", { token: TOKEN, amount: "100n", unlockAt: `${T0 + DAY}n` }));
  t.ok(t.send(ALICE, LOCKER, "renounceLockOwnership", { id: "0n" }));
  t.at(T0 + 2 * DAY);
  assert.equal(t.q(LOCKER, "getLock", { id: "0n" }).withdrawable, "0n");
  assert.equal(t.q(LOCKER, "withdrawableOf", { id: "0n" }), "0n");
  assert.equal(t.q(LOCKER, "locksForToken", { token: TOKEN })[0].withdrawable, "0n");
  t.fail(/renounced/, ALICE, LOCKER, "unlock", { id: "0n" });
  assert.equal(t.bal(TOKEN, LOCKER), 100n);
});
