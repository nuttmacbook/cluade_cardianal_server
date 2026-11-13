import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { STAKING_PROGRAM, STAKING_FUNCTIONS, STAKING_EVENTS, STAKING_PRECISION } from "../src/standards/staking.js";
import { TOKEN_PROGRAM, checkStandard } from "../src/standards/token.js";
import { reviewProgram } from "../src/core/autoreview.js";

/*
 * Staking (src/standards/staking.js): many pools in one program · rewards stream per second · deposit / withdraw any time
 *   block times are set manually (seconds × 1000) to check reward accrual
 */

const E = 10n ** 18n;
const P = STAKING_PRECISION;
const T0 = 1_800_000_000n;   // seconds
const STAKING = "0x00000000000000000000000000000000005a4e01";
const TKA = "0x000000000000000000000000000000000000aaa1";   // stake token
const TKB = "0x000000000000000000000000000000000000bbb1";   // reward token
const FEE = "0x000000000000000000000000000000000000fee1";   // token that takes a 10% fee on transfer
const EVIL = "0x000000000000000000000000000000000000e111";  // token that calls back in during transfer
const NOT_PROGRAM = "0x0000000000000000000000000000000000000123";
const CREATOR = "0x00000000000000000000000000000000000000c1";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b1";
const CAROL = "0x00000000000000000000000000000000000000c2";
const USERS = [CREATOR, ALICE, BOB, CAROL];

/** test token: fee% burned on transfer · hook = calls another program during transfer (error caught into hookError) */
const TEST_TOKEN = `function program() {
  function initialization(params) {
    for (const who of params.input.holders) writeDB(map("bal", who), params.input.supply)
    writeDB("fee", params.input.fee || 0n)
  }
  function balanceOf(params) { return readDB(map("bal", params.input.who)) || 0n }
  function move(from, to, amount) {
    const bal = readDB(map("bal", from)) || 0n
    if (amount <= 0n || bal < amount) throw new Error("insufficient balance")
    writeDB(map("bal", from), bal - amount)
    const fee = amount * readDB("fee") / 100n
    writeDB(map("bal", to), (readDB(map("bal", to)) || 0n) + amount - fee)
  }
  function approve(params) { writeDB(map("allow", params.context.sender, params.input.spender), params.input.amount); return true }
  function transferFrom(params) {
    const allowed = readDB(map("allow", params.input.from, params.context.sender)) || 0n
    if (allowed < params.input.amount) throw new Error("insufficient allowance")
    writeDB(map("allow", params.input.from, params.context.sender), allowed - params.input.amount)
    move(params.input.from, params.input.to, params.input.amount)
    return true
  }
  function transfer(params) {
    move(params.context.sender, params.input.to, params.input.amount)
    const hook = readDB("hook")
    if (hook) {
      try { runProgram(hook.target, hook.fn, hook.input) } catch (e) { writeDB("hookError", e.message) }
    }
    return true
  }
  function setHook(params) { writeDB("hook", params.input) }
  function hookError() { return readDB("hookError") || "" }
  return { balanceOf, approve, transferFrom, transfer, setHook, hookError }
}`;

/** "123n" → 123n (deep) */
function big(value) {
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return BigInt(value.slice(0, -1));
  if (Array.isArray(value)) return value.map(big);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, big(v)]));
  return value;
}
const enc = (value) => (typeof value === "bigint" ? `${value}n` : Array.isArray(value) ? value.map(enc)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, enc(v)])) : value);

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, forks: { bluewolf: 0 }, maxBlockGas: 5_000_000 });
  let now = T0 - 10n;
  const block = (fn, at) => {
    if (at !== undefined) {
      assert.ok(at >= now, "time must move forward");
      now = at;
    }
    const b = vm.createBlock({ timestamp: Number(now * 1000n) });
    const out = fn(b);
    b.commit();
    return out;
  };
  const deploy = (programUuid, code, initInput) => block((b) => {
    assert.equal(b.deploy({ programUuid, code, context: { sender: CREATOR, origin: CREATOR }, initInput }).status, "success");
    assert.equal(b.init({ programUuid }).status, "success");
  });
  deploy(STAKING, STAKING_PROGRAM, { namespace: "staking", description: "staking pools" });
  for (const token of [TKA, TKB]) deploy(token, TOKEN_PROGRAM, { name: token, ticker: "T", decimals: "18n", supply: `${4_000_000n * E}n`, owner: CREATOR });
  deploy(FEE, TEST_TOKEN, { holders: USERS, supply: `${1_000_000n * E}n`, fee: "10n" });
  deploy(EVIL, TEST_TOKEN, { holders: USERS, supply: `${1_000_000n * E}n` });
  const send = (who, programUuid, functionName, input = {}, at, extra = {}) => block((b) => {
    const res = b.call({ programUuid, functionName, input: enc(input), context: { sender: who, origin: who }, gasLimit: 4_000_000, ...extra });
    return { ...res, value: big(res.result) };
  }, at);
  const ok = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return res;
  };
  const fail = (res, message) => {
    assert.equal(res.status, "throw", `expected throw (${message})`);
    if (message) assert.match(res.error.message, message instanceof RegExp ? message : new RegExp(message));
    return res;
  };
  const query = (programUuid, functionName, input = {}, at = now) => {
    const res = vm.query({ programUuid, functionName, input: enc(input) }, { timestamp: Number(at * 1000n) });
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return big(res.result);
  };
  const bal = (token, who) => query(token, "balanceOf", { who });
  // hand standard tokens to everyone + unlimited approve for staking
  for (const who of USERS.slice(1)) for (const token of [TKA, TKB]) ok(send(CREATOR, token, "transfer", { to: who, amount: 1_000_000n * E }));
  for (const who of USERS) for (const token of [TKA, TKB, FEE, EVIL]) ok(send(who, token, "approve", { spender: STAKING, amount: 10n ** 30n }));
  const time = () => now;
  return { vm, send, ok, fail, query, bal, time, deploy };
}

/** tokens held by staking ≥ principal + reward funds of every pool using this token */
function assertSolvent(t, token) {
  let owed = 0n;
  for (const pool of t.query(STAKING, "pools", { start: 0n, limit: 50n })) {
    if (pool.stakeToken === token) owed += pool.totalStaked;
    if (pool.rewardToken === token) owed += pool.rewardReserve;
  }
  assert.ok(t.bal(token, STAKING) >= owed, `token ${token} must cover what is owed`);
}

test("staking: passes autoreview · all exports present · every event emitted", () => {
  const result = reviewProgram(STAKING_PROGRAM);
  assert.ok(result.ok, result.message);
  assert.ok(reviewProgram(TEST_TOKEN).ok);
  assert.deepEqual(checkStandard(STAKING_PROGRAM, [...STAKING_FUNCTIONS, "getPool", "poolCount", "pools", "stakedOf", "pendingRewards", "poolsOf"], STAKING_EVENTS),
    { ok: true, missing: [] });
});

test("staking: 1 staker · rewards stream per second · the creator can recover seconds with no stakers", () => {
  const t = setup();
  const start = t.time() + 10n;
  const created = t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKB, rewardAmount: 1000n * E, duration: 100n }, start));
  assert.equal(created.value, 0n);
  const ev = created.events.find((e) => e.name === "PoolCreated");
  assert.deepEqual(big(ev.data), { poolId: 0n, creator: CREATOR, stakeToken: TKA, rewardToken: TKB, rewardAmount: 1000n * E,
    startAt: start, endAt: start + 100n, rewardRate: 10n * E * P });
  assert.equal(t.query(STAKING, "poolCount"), 1n);
  assert.equal(t.bal(TKB, STAKING), 1000n * E);

  const before = t.bal(TKA, ALICE);
  const staked = t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: 50n * E }, start + 10n));
  assert.equal(staked.value, 50n * E);
  assert.deepEqual(big(staked.events.find((e) => e.name === "Staked").data), { poolId: 0n, who: ALICE, amount: 50n * E });
  assert.equal(t.bal(TKA, ALICE), before - 50n * E);
  assert.equal(t.query(STAKING, "stakedOf", { poolId: 0n, who: ALICE }), 50n * E);

  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, start + 10n), 0n);
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, start + 60n), 500n * E);
  const pool = t.query(STAKING, "getPool", { poolId: 0n }, start + 60n);
  assert.equal(pool.totalStaked, 50n * E);
  assert.equal(pool.rewardPerSecond, 10n * E);
  assert.equal(pool.rewardPerYear, 10n * E * 31_536_000n);
  assert.equal(pool.active, true);
  assert.equal(pool.unallocated, 100n * E, "nobody staked for the first 10 seconds");

  const claim1 = t.ok(t.send(ALICE, STAKING, "claim", { poolId: 0n }, start + 60n));
  assert.equal(claim1.value, 500n * E);
  assert.deepEqual(big(claim1.events.find((e) => e.name === "Claimed").data), { poolId: 0n, who: ALICE, amount: 500n * E });
  t.fail(t.send(ALICE, STAKING, "claim", { poolId: 0n }, start + 60n), "nothing to claim");

  // after the end, rewards stop growing
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, start + 500n), 400n * E);
  assert.equal(t.query(STAKING, "getPool", { poolId: 0n }, start + 500n).active, false);
  t.fail(t.send(BOB, STAKING, "stake", { poolId: 0n, amount: E }, start + 100n), "pool has ended");
  const out = t.ok(t.send(ALICE, STAKING, "exit", { poolId: 0n }, start + 500n));
  assert.deepEqual(out.value, { unstaked: 50n * E, claimed: 400n * E });
  assert.deepEqual(out.events.filter((e) => e.program === STAKING).map((e) => e.name), ["Unstaked", "Claimed"]);
  assert.equal(t.bal(TKA, ALICE), before, "principal fully returned, no penalty");

  t.fail(t.send(ALICE, STAKING, "recoverUnallocated", { poolId: 0n }, start + 500n), "only pool creator");
  const rec = t.ok(t.send(CREATOR, STAKING, "recoverUnallocated", { poolId: 0n }, start + 500n));
  assert.equal(rec.value, 100n * E);
  t.fail(t.send(CREATOR, STAKING, "recoverUnallocated", { poolId: 0n }, start + 500n), "nothing to recover");
  assert.equal(t.bal(TKB, STAKING), 0n, "900 distributed + 100 recovered · nothing left over");
  t.fail(t.send(ALICE, STAKING, "exit", { poolId: 0n }, start + 500n), "nothing to exit");
});

test("staking: 2 stakers joining at different times · split proportionally · pool starting in the future", () => {
  const t = setup();
  const start = t.time() + 100n;
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKB, rewardAmount: 1000n * E, duration: 100n, startAt: start }));
  t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: 100n * E }, start - 50n));
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, start), 0n, "no rewards before the start");
  assert.equal(t.query(STAKING, "getPool", { poolId: 0n }, start - 1n).active, false);
  t.ok(t.send(BOB, STAKING, "stake", { poolId: 0n, amount: 300n * E }, start + 40n));
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, start + 40n), 400n * E);
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: BOB }, start + 40n), 0n);
  // 40 → 100: 600 split 1:3
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, start + 100n), 550n * E);
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: BOB }, start + 100n), 450n * E);
  // alice withdraws half midway → the ratio changes (50:300)
  t.ok(t.send(ALICE, STAKING, "unstake", { poolId: 0n, amount: 50n * E }, start + 65n));
  // alice: 400 + 25×10×1/4 = 462.5 · to 100: + 35×10×50/350 = 50 → 512.5
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, start + 100n), 5125n * E / 10n);
  const bob = t.query(STAKING, "pendingRewards", { poolId: 0n, who: BOB }, start + 100n);
  assert.equal(bob, 1875n * E / 10n + 300n * E);   // 25×10×3/4 + 35×10×300/350
  const a = t.ok(t.send(ALICE, STAKING, "exit", { poolId: 0n }, start + 120n)).value.claimed;
  const b = t.ok(t.send(BOB, STAKING, "exit", { poolId: 0n }, start + 120n)).value.claimed;
  assert.ok(a + b <= 1000n * E);
  assert.ok(1000n * E - (a + b) < 10n, "rounding dust of only a few wei");
  assert.deepEqual(t.query(STAKING, "poolsOf", { who: BOB }), [0n]);
  assert.equal(t.query(STAKING, "getPool", { poolId: 0n }).stakers, 0n);
});

test("staking: stakeToken = rewardToken · principal and rewards don't mix · several pools with the same token keep separate accounts", () => {
  const t = setup();
  const s = t.time() + 1n;
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKA, rewardAmount: 100n * E, duration: 100n }, s));
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKB, rewardAmount: 100n * E, duration: 100n }, s));
  t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: 1000n * E }, s));
  t.ok(t.send(BOB, STAKING, "stake", { poolId: 1n, amount: 500n * E }, s));
  assertSolvent(t, TKA);
  const pool = t.query(STAKING, "getPool", { poolId: 0n });
  assert.equal(pool.totalStaked, 1000n * E);
  assert.equal(pool.rewardReserve, 100n * E);
  // cannot withdraw more principal than deposited (even though the program holds 1,600 TKA in total)
  t.fail(t.send(ALICE, STAKING, "unstake", { poolId: 0n, amount: 1000n * E + 1n }, s + 10n), "exceeds staked");
  t.fail(t.send(BOB, STAKING, "unstake", { poolId: 0n, amount: 1n }, s + 10n), "exceeds staked");
  t.ok(t.send(ALICE, STAKING, "claim", { poolId: 0n }, s + 50n));
  assertSolvent(t, TKA);
  // the creator cannot recover anything (someone was staked every second)
  t.fail(t.send(CREATOR, STAKING, "recoverUnallocated", { poolId: 0n }, s + 200n), "nothing to recover");
  const before = t.bal(TKA, ALICE);
  const out = t.ok(t.send(ALICE, STAKING, "exit", { poolId: 0n }, s + 200n)).value;
  assert.equal(out.unstaked, 1000n * E);
  assert.equal(t.bal(TKA, ALICE), before + 1000n * E + out.claimed);
  const p0 = t.query(STAKING, "getPool", { poolId: 0n });
  assert.equal(p0.claimed, 100n * E);
  assert.equal(p0.rewardReserve, 0n);
  // remaining TKA = exactly bob's principal in pool 1
  assert.equal(t.bal(TKA, STAKING), 500n * E);
  assertSolvent(t, TKA);
  t.ok(t.send(BOB, STAKING, "exit", { poolId: 1n }, s + 200n));
  assert.equal(t.bal(TKA, STAKING), 0n);
});

test("staking: addRewards · top up midway (redistributed over the remaining period) · extend · start a new round after the end", () => {
  const t = setup();
  const s = t.time() + 1n;
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKB, rewardAmount: 1000n * E, duration: 100n }, s));
  t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: 10n * E }, s));
  t.fail(t.send(ALICE, STAKING, "addRewards", { poolId: 0n, amount: E }, s + 50n), "only pool creator");
  // at 50 s: 500 left + 500 added → 1000 over 50 s = 20/s
  const add = t.ok(t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount: 500n * E }, s + 50n));
  assert.equal(add.value, 20n * E * P);
  assert.deepEqual(big(add.events.find((e) => e.name === "RewardsAdded").data), { poolId: 0n, amount: 500n * E, endAt: s + 100n, rewardRate: 20n * E * P });
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, s + 75n), 1000n * E);
  // extend 50 s: 500 left (25 s) + 250 → 750 over 75 s = 10/s
  assert.equal(t.ok(t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount: 250n * E, extendSeconds: 50n }, s + 75n)).value, 10n * E * P);
  assert.equal(t.query(STAKING, "getPool", { poolId: 0n }).endAt, s + 150n);
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, s + 400n), 1750n * E);
  // ended: extendSeconds is required
  t.fail(t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount: E }, s + 400n), "extendSeconds");
  t.fail(t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount: E, extendSeconds: 400_000_000n }, s + 400n), "duration too long");
  t.ok(t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount: 100n * E, extendSeconds: 10n }, s + 400n));
  const p = t.query(STAKING, "getPool", { poolId: 0n });
  assert.deepEqual([p.periodStart, p.endAt, p.rewardRate], [s + 400n, s + 410n, 10n * E * P]);
  // 150 → 400 not distributed (pool stopped) · no extra rewards
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, s + 400n), 1750n * E);
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, s + 999n), 1850n * E);
  const out = t.ok(t.send(ALICE, STAKING, "exit", { poolId: 0n }, s + 999n)).value;
  assert.equal(out.claimed, 1850n * E);
  assert.equal(t.query(STAKING, "getPool", { poolId: 0n }).funded, 1850n * E);
  assert.equal(t.bal(TKB, STAKING), 0n);
});

test("staking: emergencyWithdraw returns principal only · the creator can recover forfeited rewards · others keep their rights", () => {
  const t = setup();
  const s = t.time() + 1n;
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKB, rewardAmount: 1000n * E, duration: 100n }, s));
  t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: 10n * E }, s));
  t.ok(t.send(BOB, STAKING, "stake", { poolId: 0n, amount: 10n * E }, s));
  t.fail(t.send(CAROL, STAKING, "emergencyWithdraw", { poolId: 0n }, s + 50n), "nothing staked");
  const before = t.bal(TKA, ALICE);
  const res = t.ok(t.send(ALICE, STAKING, "emergencyWithdraw", { poolId: 0n }, s + 50n));
  assert.equal(res.value, 10n * E);
  assert.deepEqual(big(res.events.find((e) => e.name === "EmergencyWithdraw").data), { poolId: 0n, who: ALICE, amount: 10n * E, forfeited: 250n * E });
  assert.equal(t.bal(TKA, ALICE), before + 10n * E);
  assert.equal(t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, s + 50n), 0n);
  assert.equal(t.bal(TKB, ALICE), 1_000_000n * E, "no rewards received");
  // the creator can recover the forfeited part immediately (the not-yet-due part / bob's share untouched)
  assert.equal(t.ok(t.send(CREATOR, STAKING, "recoverUnallocated", { poolId: 0n }, s + 50n)).value, 250n * E);
  // bob gets 250 + 500 for the last 50 s alone
  assert.equal(t.ok(t.send(BOB, STAKING, "claim", { poolId: 0n }, s + 100n)).value, 750n * E);
  assert.equal(t.bal(TKB, STAKING), 0n);
  // pool ended, no new stakes
  t.fail(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: E }, s + 100n), "pool has ended");
});

test("staking: every input and permission check", () => {
  const t = setup();
  const s = t.time() + 1n;
  const base = { stakeToken: TKA, rewardToken: TKB, rewardAmount: 100n * E, duration: 100n };
  const bad = [
    [{ ...base, stakeToken: "tka" }, "stakeToken must be an address"],
    [{ ...base, rewardToken: NOT_PROGRAM }, "rewardToken must be a token program"],
    [{ ...base, rewardAmount: 0n }, "rewardAmount must be"],
    [{ ...base, rewardAmount: "100" }, "rewardAmount must be"],
    [{ ...base, duration: 0n }, "duration must be"],
    [{ ...base, duration: 315_360_001n }, "duration too long"],
    [{ ...base, startAt: s - 1n }, "past"],
    [{ ...base, startAt: s + 31_536_001n }, "too far"],
    [{ ...base, startAt: "soon" }, "startAt must be"],
    [{ ...base, rewardAmount: 10n ** 40n }, "insufficient"],
  ];
  for (const [input, message] of bad) t.fail(t.send(CREATOR, STAKING, "createPool", input, s), message);
  // no approve
  t.ok(t.send(CAROL, TKB, "approve", { spender: STAKING, amount: 0n }));
  t.fail(t.send(CAROL, STAKING, "createPool", base, s), "insufficient allowance");
  assert.equal(t.query(STAKING, "poolCount"), 0n);

  t.ok(t.send(CREATOR, STAKING, "createPool", base, s));
  for (const [fn, input, message] of [
    ["stake", { poolId: 9n, amount: E }, "pool does not exist"],
    ["stake", { poolId: -1n, amount: E }, "poolId must be"],
    ["stake", { poolId: "0", amount: E }, "poolId must be"],
    ["stake", { poolId: 0n, amount: 0n }, "amount must be"],
    ["stake", { poolId: 0n, amount: -5n }, "amount must be"],
    ["stake", { poolId: 0n, amount: 10n ** 40n }, "insufficient"],
    ["unstake", { poolId: 0n, amount: E }, "exceeds staked"],
    ["unstake", { poolId: 0n, amount: 0n }, "amount must be"],
    ["claim", { poolId: 0n }, "nothing to claim"],
    ["exit", { poolId: 0n }, "nothing to exit"],
    ["emergencyWithdraw", { poolId: 0n }, "nothing staked"],
    ["addRewards", { poolId: 0n, amount: 0n }, "amount must be"],
    ["addRewards", { poolId: 0n, amount: E, extendSeconds: -1n }, "extendSeconds"],
    ["recoverUnallocated", { poolId: 0n }, "only pool creator"],
  ]) t.fail(t.send(ALICE, STAKING, fn, input, s), message);
  t.fail(t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount: E, extendSeconds: 315_360_000n }, s), "duration too long");
  t.fail(t.send(ALICE, STAKING, "initialization", {}, s));
  // reads: paging is capped
  t.fail({ status: t.vm.query({ programUuid: STAKING, functionName: "pools", input: { limit: "51n" } }).status }, undefined);
  t.fail({ status: t.vm.query({ programUuid: STAKING, functionName: "poolsOf", input: { who: ALICE, limit: "101n" } }).status }, undefined);
  t.fail({ status: t.vm.query({ programUuid: STAKING, functionName: "stakedOf", input: { poolId: "0n", who: "x" } }).status }, undefined);
});

test("staking: fee-taking token → records the amount actually received (both rewards and principal)", () => {
  const t = setup();
  const s = t.time() + 1n;
  const created = t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: FEE, rewardToken: FEE, rewardAmount: 1000n * E, duration: 100n }, s));
  assert.equal(big(created.events.find((e) => e.name === "PoolCreated").data).rewardAmount, 900n * E);
  assert.equal(t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: 100n * E }, s)).value, 90n * E);
  assert.equal(t.query(STAKING, "stakedOf", { poolId: 0n, who: ALICE }), 90n * E);
  assert.equal(t.query(STAKING, "getPool", { poolId: 0n }).funded, 900n * E);
  const out = t.ok(t.send(ALICE, STAKING, "exit", { poolId: 0n }, s + 100n)).value;
  assert.deepEqual(out, { unstaked: 90n * E, claimed: 900n * E });
  assert.equal(t.bal(FEE, STAKING), 0n);
});

test("staking: token calling back in during transfer → fails with reentrant call (no double payout)", () => {
  const t = setup();
  const s = t.time() + 1n;
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: EVIL, rewardAmount: 1000n * E, duration: 100n }, s));
  t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: E }, s));
  // during EVIL.transfer (reward payout) the token tries to claim again on its own behalf / emergencyWithdraw
  t.ok(t.send(CREATOR, EVIL, "setHook", { target: STAKING, fn: "claim", input: { poolId: "0n" } }));
  const res = t.ok(t.send(ALICE, STAKING, "claim", { poolId: 0n }, s + 50n));
  assert.equal(res.value, 500n * E);
  assert.equal(t.query(EVIL, "hookError"), "reentrant call");
  assert.equal(t.bal(EVIL, STAKING), 500n * E);
  assert.equal(t.query(STAKING, "getPool", { poolId: 0n }).claimed, 500n * E);
});

test("staking: random stakers at random times → total claim + recover never exceeds what was funded · principal fully returned · only a few wei of dust left", () => {
  const t = setup();
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 65536) % n; };
  let now = t.time() + 1n;
  const created = t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKA, rewardAmount: 777_777n * E + 13n, duration: 997n }, now));
  let funded = big(created.events.find((e) => e.name === "PoolCreated").data).rewardAmount;
  let claimed = 0n;
  const principal = { [ALICE]: 0n, [BOB]: 0n, [CAROL]: 0n };
  const people = Object.keys(principal);
  const done = {};
  const takeClaims = (res) => {
    for (const e of res.events) if (e.program === STAKING && e.name === "Claimed") claimed += big(e.data).amount;
  };
  for (let i = 0; i < 60; i++) {
    now += BigInt(rand(40));
    const who = people[rand(3)];
    const action = rand(6);
    let res;
    if (action <= 1) {
      const amount = BigInt(rand(1000) + 1) * E + BigInt(rand(1000));
      res = t.send(who, STAKING, "stake", { poolId: 0n, amount }, now);
      if (res.status === "success") principal[who] += amount;
    } else if (action === 2 && principal[who] > 0n) {
      const amount = principal[who] / 3n + 1n;
      res = t.ok(t.send(who, STAKING, "unstake", { poolId: 0n, amount }, now));
      principal[who] -= amount;
    } else if (action === 3) {
      res = t.send(who, STAKING, "claim", { poolId: 0n }, now);
    } else if (action === 4 && rand(3) === 0) {
      const amount = BigInt(rand(5000) + 1) * E;
      res = t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount, extendSeconds: BigInt(rand(200)) }, now);
      if (res.status !== "success") res = t.ok(t.send(CREATOR, STAKING, "addRewards", { poolId: 0n, amount, extendSeconds: 100n }, now));
      funded += amount;
    } else if (action === 5 && principal[who] > 0n && rand(4) === 0) {
      res = t.ok(t.send(who, STAKING, "emergencyWithdraw", { poolId: 0n }, now));
      principal[who] = 0n;
    } else continue;
    if (res.status === "success") { takeClaims(res); done[action] = (done[action] || 0) + 1; }
    assertSolvent(t, TKA);
    const pool = t.query(STAKING, "getPool", { poolId: 0n }, now);
    assert.ok(pool.claimed + pool.recovered <= pool.funded);
  }
  for (const action of [0, 2, 3, 4, 5]) assert.ok((done[action] || 0) + (action === 0 ? done[1] || 0 : 0) > 0, `action ${action} never drawn: ${JSON.stringify(done)}`);
  now = t.query(STAKING, "getPool", { poolId: 0n }).endAt + 1n;
  for (const who of people) {
    const res = t.send(who, STAKING, "exit", { poolId: 0n }, now);
    if (res.status === "success") {
      takeClaims(res);
      assert.equal(res.value.unstaked, principal[who], "principal fully returned");
    }
  }
  let recovered = 0n;
  const rec = t.send(CREATOR, STAKING, "recoverUnallocated", { poolId: 0n }, now);
  if (rec.status === "success") recovered = rec.value;
  const pool = t.query(STAKING, "getPool", { poolId: 0n }, now);
  assert.equal(pool.funded, funded);
  assert.equal(pool.claimed, claimed);
  assert.ok(claimed + recovered <= funded, "never pays out more than funded");
  assert.equal(pool.totalStaked, 0n);
  assert.equal(t.bal(TKA, STAKING), funded - claimed - recovered, "the remainder is rounding dust");
  assert.ok(funded - claimed - recovered < 1000n, `dust ${funded - claimed - recovered} wei`);
});

test("staking: pools / poolsOf / getPool · and gas of the main operations (fork bluewolf)", () => {
  const t = setup();
  const s = t.time() + 1n;
  const gas = {};
  gas.createPool = t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKB, rewardAmount: 100n * E, duration: 1000n }, s)).gasUsed;
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKB, rewardToken: TKA, rewardAmount: 100n * E, duration: 1000n }, s));
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKA, rewardAmount: 100n * E, duration: 1000n }, s));
  gas.stakeFirst = t.ok(t.send(ALICE, STAKING, "stake", { poolId: 2n, amount: E }, s)).gasUsed;
  gas.stakeAgain = t.ok(t.send(ALICE, STAKING, "stake", { poolId: 2n, amount: E }, s + 5n)).gasUsed;
  t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: E }, s + 5n));
  gas.claim = t.ok(t.send(ALICE, STAKING, "claim", { poolId: 2n }, s + 10n)).gasUsed;
  gas.unstake = t.ok(t.send(ALICE, STAKING, "unstake", { poolId: 2n, amount: E }, s + 20n)).gasUsed;
  gas.addRewards = t.ok(t.send(CREATOR, STAKING, "addRewards", { poolId: 2n, amount: E }, s + 20n)).gasUsed;
  gas.exit = t.ok(t.send(ALICE, STAKING, "exit", { poolId: 2n }, s + 30n)).gasUsed;
  gas.emergencyWithdraw = t.ok(t.send(ALICE, STAKING, "emergencyWithdraw", { poolId: 0n }, s + 30n)).gasUsed;
  gas.recoverUnallocated = t.ok(t.send(CREATOR, STAKING, "recoverUnallocated", { poolId: 1n }, s + 30n)).gasUsed;
  for (const [name, used] of Object.entries(gas)) assert.ok(used < 300_000, `${name} ${used}`);
  console.log("staking gas:", JSON.stringify(gas));

  assert.equal(t.query(STAKING, "poolCount"), 3n);
  assert.deepEqual(t.query(STAKING, "pools", { start: 1n, limit: 5n }).map((p) => p.poolId), [1n, 2n]);
  assert.deepEqual(t.query(STAKING, "pools", { start: 7n }), []);
  assert.deepEqual(t.query(STAKING, "poolsOf", { who: ALICE }), [2n, 0n]);
  assert.equal(t.query(STAKING, "poolsOfCount", { who: ALICE }), 2n);
  assert.deepEqual(t.query(STAKING, "poolsOf", { who: BOB }), []);
  const p = t.query(STAKING, "getPool", { poolId: 1n }, s + 30n);
  assert.equal(p.creator, CREATOR);
  assert.equal(p.unallocated, 0n);
  assert.equal(p.recovered, 3n * E);   // nobody staked for the first 30 s = 3 coins
  assert.equal(p.rewardReserve, 97n * E);
  assert.equal(t.vm.resolveNamespace("staking"), STAKING);
});

test("staking: no native value allowed — stake / getPool fail · the program holds no native coin", () => {
  const t = setup();
  t.vm.db.load({ [VM.nativeKey(ALICE, "received")]: `${1000n * E}n` });
  const nat = (who) => BigInt(t.vm.nativeBalanceOf(who).balance);
  const start = t.time() + 10n;
  t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: TKB, rewardAmount: 1000n * E, duration: 100n, startAt: start }, start));
  const a0 = nat(ALICE);
  t.fail(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: E }, start, { value: `${E}` }), /this function does not accept native value/);
  t.fail(t.send(ALICE, STAKING, "getPool", { poolId: 0n }, start, { value: `${E}` }), /this function does not accept native value/);
  assert.equal(nat(STAKING), 0n);
  assert.equal(nat(ALICE), a0);
  assert.equal(t.query(STAKING, "stakedOf", { poolId: 0n, who: ALICE }), 0n);
});

test("staking: 6-decimal reward + a large stake · poking every 120 s does not lose rewards (precision 1e36 + dust carry)", () => {
  const USD = "0x000000000000000000000000000000000000bbb6";   // 6-decimal reward token
  const E6 = 10n ** 6n;
  const REWARD = 10_000n * E6;
  const DURATION = 30n * 86400n;
  const WINDOW = 3600n;
  const STEP = 120n;
  const expected = REWARD * WINDOW / DURATION;
  const run = (poke) => {
    const t = setup();
    t.deploy(USD, TOKEN_PROGRAM, { name: "USD", ticker: "USD", decimals: "6n", supply: `${1_000_000n * E6}n`, owner: CREATOR });
    t.ok(t.send(CREATOR, USD, "approve", { spender: STAKING, amount: 10n ** 30n }));
    const start = t.time() + 10n;
    t.ok(t.send(CREATOR, STAKING, "createPool", { stakeToken: TKA, rewardToken: USD, rewardAmount: REWARD, duration: DURATION, startAt: start }, start));
    t.ok(t.send(ALICE, STAKING, "stake", { poolId: 0n, amount: 1_000_000n * E }, start));
    // BOB pokes accrue with a 1 wei stake every STEP seconds
    if (poke) for (let at = start + STEP; at <= start + WINDOW; at += STEP) t.ok(t.send(BOB, STAKING, "stake", { poolId: 0n, amount: 1n }, at));
    const end = start + WINDOW;
    const alice = t.query(STAKING, "pendingRewards", { poolId: 0n, who: ALICE }, end);
    const rec = t.send(CREATOR, STAKING, "recoverUnallocated", { poolId: 0n }, end);
    const recovered = rec.status === "success" ? rec.value : (t.fail(rec, "nothing to recover"), 0n);
    return { alice, recovered };
  };
  for (const poke of [false, true]) {
    const { alice, recovered } = run(poke);
    const diff = alice > expected ? alice - expected : expected - alice;
    assert.ok(diff <= 1n, `poke=${poke}: alice ${alice} vs expected ${expected}`);
    assert.ok(recovered <= 1n, `poke=${poke}: recovered ${recovered}`);
  }
});
