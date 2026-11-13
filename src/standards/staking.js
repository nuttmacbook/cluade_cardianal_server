/**
 * Staking — a system program to stake tokens and earn rewards (like Synthetix StakingRewards / MasterChef) · many pools in one program
 *   deposit / withdraw any time, no lock-up, no penalty · no owner / admin · no upgrader (immutable)
 *   input on deploy: { namespace?, icon?, url?, contact?, description? }
 *   all times are in **seconds** (unix seconds) = params.block.timestamp / 1000n · amounts are bigint in the token's smallest unit
 *   before calling createPool / addRewards / stake you must approve this program on that token (the program calls transferFrom)
 *
 * State-changing functions
 *   createPool({ stakeToken, rewardToken, rewardAmount, duration, startAt? }) → poolId (0n, 1n, …)
 *       anyone can create one · the creator prefunds the rewards (transferFrom, then measures the amount actually received via balanceOf before / after)
 *       rewards flow evenly every second from startAt (omitted = now · not in the past · at most now + 365 days) for duration seconds (1 … 10 years)
 *       stakeToken = rewardToken is allowed: staked principal (totalStaked) and the reward pot (funded - claimed - recovered) are always accounted separately per pool
 *       event PoolCreated { poolId, creator, stakeToken, rewardToken, rewardAmount, startAt, endAt, rewardRate }
 *   stake({ poolId, amount }) → amount actually received     can stake before startAt · not after endAt · event Staked { poolId, who, amount }
 *   unstake({ poolId, amount }) → true              withdraw principal any time (pending rewards are kept to claim later) · event Unstaked
 *   claim({ poolId }) → reward amount                   event Claimed { poolId, who, amount }
 *   exit({ poolId }) → { unstaked, claimed }        withdraw all principal + claim (events Unstaked / Claimed as applicable)
 *   emergencyWithdraw({ poolId }) → principal          withdraw principal only, **forfeiting all pending rewards** (use when the reward token is broken / can't transfer)
 *       forfeited rewards go back to the pool's "unallocated" → the creator can reclaim them via recoverUnallocated (never stuck forever)
 *       event EmergencyWithdraw { poolId, who, amount, forfeited }
 *   addRewards({ poolId, amount, extendSeconds? }) → new rewardRate   pool creator only
 *       pool still running: remaining rewards + amount are spread over the remaining period (extendable via extendSeconds)
 *       pool ended: extendSeconds is required → starts a new period from now to now + extendSeconds
 *       event RewardsAdded { poolId, amount, endAt, rewardRate }
 *   recoverUnallocated({ poolId }) → amount          creator only · reclaims rewards "nobody can ever get", any time:
 *       rewards for seconds with no stakers (never distributed) + rounding dust + rewards forfeited via emergencyWithdraw
 *       never touches rewards already distributed (owed to stakers) or rewards for time not yet elapsed · event RewardsRecovered { poolId, to, amount }
 *
 * Read functions
 *   getPool({ poolId }) → { poolId, creator, stakeToken, rewardToken, startAt, periodStart, endAt, lastUpdate, totalStaked, stakers,
 *       rewardRate (units per second × 1e18), rewardPerSecond (rounded down), rewardPerYear (current · 0n if not active), active, accRewardPerShare,
 *       funded, claimed, recovered, rewardReserve, unallocated }   APR ≈ rewardPerYear × reward price ÷ (totalStaked × stake price)
 *   poolCount() · pools({ start?, limit? ≤ 50 }) → [pool] · stakedOf({ poolId, who }) · pendingRewards({ poolId, who })
 *   poolsOf({ who, start?, limit? ≤ 100 }) → [poolId]  (pools who has staked in) · poolsOfCount({ who })
 *
 * Math: accRewardPerShare accumulates ×1e18 (bigint) · rewardRate is ×1e18 too · rounded down at every payout
 *   an interval dt with stakers: inc = rewardRate × dt / totalStaked (rounded down) · allocated += inc × totalStaked (the amount acc actually covers)
 *   a user's reward = stake × (acc − acc already paid) / 1e18 (rounded down) → sum over all users ≤ allocated / 1e18 ≤ funded
 *   unallocated = ((funded − recovered) × 1e18 − allocated − rewardRate × (endAt − lastUpdate)) / 1e18
 *   every reward payout checks it does not exceed the pool's rewardReserve (can never eat principal or another pool)
 * Security: reentrancy lock (a token calling back in during a transfer fails) · state written before transfers out · deposits measured via balanceOf
 *   no loops that depend on the number of users · the only loops are pools / poolsOf (at most 50 / 100 entries)
 *
 * storage: poolCount · pools:<id> (pool object) · stakes:<id>:<who> · rewards:<id>:<who> (recorded rewards)
 *   paid:<id>:<who> (acc at the last checkpoint) · joined:<id>:<who> · userPools:<who>:<i> · userPoolCount:<who> · locked (during a tx)
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";

export const STAKING_PRECISION = 10n ** 36n;   // 1e36 (not 1e18 like Synthetix) → high-supply stake tokens + low-decimal reward tokens don't lose rewards to rounding
export const STAKING_MAX_DURATION = 315_360_000n;   // 10 years (seconds)
export const STAKING_MAX_START_DELAY = 31_536_000n; // 365 days
export const STAKING_MAX_PAGE = 50;
export const STAKING_MAX_USER_PAGE = 100;
export const STAKING_FUNCTIONS = ["createPool", "stake", "unstake", "claim", "exit", "emergencyWithdraw", "addRewards", "recoverUnallocated"];
export const STAKING_EVENTS = ["PoolCreated", "Staked", "Unstaked", "Claimed", "RewardsAdded", "EmergencyWithdraw", "RewardsRecovered"];

export const STAKING_PROGRAM = `function program() {
  // called as a tx with native coin attached → reject (this program has no way to send native coin out, so it would be stuck forever)
  function rejectValue(params) { if (params && params.value !== undefined && params.value !== null && params.value !== 0n) throw new Error("this function does not accept native value") }
  const P = ${STAKING_PRECISION}n
  const MAX_DURATION = ${STAKING_MAX_DURATION}n
  const MAX_START_DELAY = ${STAKING_MAX_START_DELAY}n
  const YEAR = 31536000n
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    writeDB("poolCount", 0n)
    setProgramMetadata(params.input)
  }

  // ---------- helpers ----------
  function nowOf(params) { return params.block.timestamp / 1000n }
  function lock() {
    if (readDB("locked") === true) throw new Error("reentrant call")
    writeDB("locked", true)
  }
  function unlock() { deleteDB("locked") }
  function checkAmount(value, label) {
    if (typeof value !== "bigint" || value <= 0n) throw new Error(label + " must be a bigint greater than 0")
    return value
  }
  function checkId(poolId) {
    if (typeof poolId !== "bigint" || poolId < 0n) throw new Error("poolId must be a non-negative bigint")
    return poolId
  }
  function loadPool(poolId) {
    const pool = readDB(map("pools", checkId(poolId)))
    if (pool === undefined) throw new Error("pool does not exist")
    return pool
  }
  function savePool(poolId, pool) { writeDB(map("pools", poolId), pool) }
  function checkToken(address, label) {
    const token = checkAddress(address, label)
    if (!IsProgram(token)) throw new Error(label + " must be a token program")
    return token
  }
  function balanceHere(token) { return runProgram(token, "balanceOf", { who: ThisAddress() }, { readonly: true }) }
  // pull funds in and measure what actually arrived (a fee-on-transfer or lying token cannot fool the accounting)
  function pullFrom(token, from, amount) {
    const before = balanceHere(token)
    runProgram(token, "transferFrom", { from: from, to: ThisAddress(), amount: amount })
    const after = balanceHere(token)
    if (typeof before !== "bigint" || typeof after !== "bigint" || after <= before) throw new Error("no tokens received")
    return after - before
  }
  function pushTo(token, to, amount) { runProgram(token, "transfer", { to: to, amount: amount }) }

  // advance the pool's clock to now (capped at endAt) — mutates pool in memory
  function accrue(pool, now) {
    const t = now < pool.endAt ? now : pool.endAt
    if (t <= pool.lastUpdate) return pool
    if (pool.totalStaked > 0n) {
      // the division remainder carries over to the next round (carry), not dropped → frequent calls neither lose rewards nor turn them into funds the creator can recover
      const scaled = pool.rewardRate * (t - pool.lastUpdate) + (pool.carry || 0n)
      const inc = scaled / pool.totalStaked
      pool.carry = scaled - inc * pool.totalStaked
      pool.acc = pool.acc + inc
      pool.allocated = pool.allocated + inc * pool.totalStaked
    }
    pool.lastUpdate = t
    return pool
  }
  function futureScaled(pool) { return pool.lastUpdate < pool.endAt ? pool.rewardRate * (pool.endAt - pool.lastUpdate) : 0n }
  function unallocatedOf(pool) {
    const free = (pool.funded - pool.recovered) * P - pool.allocated - (pool.carry || 0n) - futureScaled(pool)   // carry = rewards already streamed but not yet a whole unit
    return free > 0n ? free / P : 0n
  }
  function reserveOf(pool) { return pool.funded - pool.claimed - pool.recovered }
  function earnedOf(pool, poolId, who) {
    const stake = readDB(map("stakes", poolId, who)) || 0n
    const paid = readDB(map("paid", poolId, who)) || 0n
    const saved = readDB(map("rewards", poolId, who)) || 0n
    return { stake: stake, reward: saved + stake * (pool.acc - paid) / P, paid: paid, saved: saved }
  }
  // settle who's rewards up to now (after accrue) → { stake, reward }
  function settle(pool, poolId, who) {
    const user = earnedOf(pool, poolId, who)
    if (user.reward !== user.saved) writeDB(map("rewards", poolId, who), user.reward)
    if (user.paid !== pool.acc) writeDB(map("paid", poolId, who), pool.acc)
    return user
  }
  function payReward(pool, poolId, who, amount) {
    if (amount > reserveOf(pool)) throw new Error("reward reserve exhausted")
    pool.claimed = pool.claimed + amount
    writeDB(map("rewards", poolId, who), 0n)
    return amount
  }
  function view(poolId, pool, now) {
    accrue(pool, now)
    const active = now >= pool.startAt && now < pool.endAt
    return { poolId: poolId, creator: pool.creator, stakeToken: pool.stakeToken, rewardToken: pool.rewardToken,
      startAt: pool.startAt, periodStart: pool.periodStart, endAt: pool.endAt, lastUpdate: pool.lastUpdate,
      totalStaked: pool.totalStaked, stakers: pool.stakers, rewardRate: pool.rewardRate, rewardPerSecond: pool.rewardRate / P,
      rewardPerYear: active ? pool.rewardRate * YEAR / P : 0n, active: active, accRewardPerShare: pool.acc,
      funded: pool.funded, claimed: pool.claimed, recovered: pool.recovered, rewardReserve: reserveOf(pool), unallocated: unallocatedOf(pool) }
  }

  // ---------- state changes ----------
  function createPool(params) { rejectValue(params);
    lock()
    const input = params.input
    const now = nowOf(params)
    const creator = params.context.sender
    const stakeToken = checkToken(input.stakeToken, "stakeToken")
    const rewardToken = checkToken(input.rewardToken, "rewardToken")
    const amount = checkAmount(input.rewardAmount, "rewardAmount")
    const duration = checkAmount(input.duration, "duration")
    if (duration > MAX_DURATION) throw new Error("duration too long (max " + MAX_DURATION + " seconds)")
    let startAt = now
    if (input.startAt !== undefined && input.startAt !== null) {
      if (typeof input.startAt !== "bigint") throw new Error("startAt must be a bigint (unix seconds)")
      if (input.startAt < now) throw new Error("startAt must not be in the past")
      if (input.startAt > now + MAX_START_DELAY) throw new Error("startAt too far in the future")
      startAt = input.startAt
    }
    const received = pullFrom(rewardToken, creator, amount)
    const rewardRate = received * P / duration
    if (rewardRate <= 0n) throw new Error("rewardAmount too small for duration")
    const poolId = readDB("poolCount") || 0n
    const pool = { creator: creator, stakeToken: stakeToken, rewardToken: rewardToken, startAt: startAt, periodStart: startAt,
      endAt: startAt + duration, lastUpdate: startAt, rewardRate: rewardRate, acc: 0n, allocated: 0n, totalStaked: 0n, stakers: 0n,
      funded: received, claimed: 0n, recovered: 0n, createdAt: now }
    savePool(poolId, pool)
    writeDB("poolCount", poolId + 1n)
    emit("PoolCreated", { poolId: poolId, creator: creator, stakeToken: stakeToken, rewardToken: rewardToken, rewardAmount: received,
      startAt: startAt, endAt: pool.endAt, rewardRate: rewardRate }, { indexed: ["poolId", "creator", "stakeToken"] })
    unlock()
    return poolId
  }

  function stake(params) { rejectValue(params);
    lock()
    const poolId = checkId(params.input.poolId)
    const who = params.context.sender
    const amount = checkAmount(params.input.amount, "amount")
    const now = nowOf(params)
    const pool = accrue(loadPool(poolId), now)
    if (now >= pool.endAt) throw new Error("pool has ended")
    const user = settle(pool, poolId, who)
    const received = pullFrom(pool.stakeToken, who, amount)
    if (user.stake === 0n) pool.stakers = pool.stakers + 1n
    pool.totalStaked = pool.totalStaked + received
    writeDB(map("stakes", poolId, who), user.stake + received)
    savePool(poolId, pool)
    if (readDB(map("joined", poolId, who)) !== true) {
      const count = readDB(map("userPoolCount", who)) || 0n
      writeDB(map("joined", poolId, who), true)
      writeDB(map("userPools", who, count), poolId)
      writeDB(map("userPoolCount", who), count + 1n)
    }
    emit("Staked", { poolId: poolId, who: who, amount: received }, { indexed: ["poolId", "who"] })
    unlock()
    return received
  }

  // reduce the account's principal (no transfer yet)
  function reduceStake(pool, poolId, who, stakeNow, amount) {
    const rest = stakeNow - amount
    if (rest === 0n) { deleteDB(map("stakes", poolId, who)); pool.stakers = pool.stakers - 1n }
    else writeDB(map("stakes", poolId, who), rest)
    pool.totalStaked = pool.totalStaked - amount
  }

  function unstake(params) { rejectValue(params);
    lock()
    const poolId = checkId(params.input.poolId)
    const who = params.context.sender
    const amount = checkAmount(params.input.amount, "amount")
    const pool = accrue(loadPool(poolId), nowOf(params))
    const user = settle(pool, poolId, who)
    if (amount > user.stake) throw new Error("amount exceeds staked balance")
    reduceStake(pool, poolId, who, user.stake, amount)
    savePool(poolId, pool)
    emit("Unstaked", { poolId: poolId, who: who, amount: amount }, { indexed: ["poolId", "who"] })
    pushTo(pool.stakeToken, who, amount)
    unlock()
    return true
  }

  function claim(params) { rejectValue(params);
    lock()
    const poolId = checkId(params.input.poolId)
    const who = params.context.sender
    const pool = accrue(loadPool(poolId), nowOf(params))
    const user = settle(pool, poolId, who)
    if (user.reward === 0n) throw new Error("nothing to claim")
    payReward(pool, poolId, who, user.reward)
    savePool(poolId, pool)
    emit("Claimed", { poolId: poolId, who: who, amount: user.reward }, { indexed: ["poolId", "who"] })
    pushTo(pool.rewardToken, who, user.reward)
    unlock()
    return user.reward
  }

  function exit(params) { rejectValue(params);
    lock()
    const poolId = checkId(params.input.poolId)
    const who = params.context.sender
    const pool = accrue(loadPool(poolId), nowOf(params))
    const user = settle(pool, poolId, who)
    if (user.stake === 0n && user.reward === 0n) throw new Error("nothing to exit")
    if (user.stake > 0n) reduceStake(pool, poolId, who, user.stake, user.stake)
    if (user.reward > 0n) payReward(pool, poolId, who, user.reward)
    savePool(poolId, pool)
    if (user.stake > 0n) emit("Unstaked", { poolId: poolId, who: who, amount: user.stake }, { indexed: ["poolId", "who"] })
    if (user.reward > 0n) emit("Claimed", { poolId: poolId, who: who, amount: user.reward }, { indexed: ["poolId", "who"] })
    if (user.stake > 0n) pushTo(pool.stakeToken, who, user.stake)
    if (user.reward > 0n) pushTo(pool.rewardToken, who, user.reward)
    unlock()
    return { unstaked: user.stake, claimed: user.reward }
  }

  function emergencyWithdraw(params) { rejectValue(params);
    lock()
    const poolId = checkId(params.input.poolId)
    const who = params.context.sender
    const pool = accrue(loadPool(poolId), nowOf(params))
    const user = earnedOf(pool, poolId, who)
    if (user.stake === 0n) throw new Error("nothing staked")
    // forfeited rewards → back to "unallocated" (already rounded down, so it never eats into others' share)
    pool.allocated = pool.allocated - user.reward * P
    reduceStake(pool, poolId, who, user.stake, user.stake)
    if (user.saved !== 0n) deleteDB(map("rewards", poolId, who))
    if (user.paid !== 0n) deleteDB(map("paid", poolId, who))
    savePool(poolId, pool)
    emit("EmergencyWithdraw", { poolId: poolId, who: who, amount: user.stake, forfeited: user.reward }, { indexed: ["poolId", "who"] })
    pushTo(pool.stakeToken, who, user.stake)
    unlock()
    return user.stake
  }

  function addRewards(params) { rejectValue(params);
    lock()
    const poolId = checkId(params.input.poolId)
    const amount = checkAmount(params.input.amount, "amount")
    let extend = 0n
    if (params.input.extendSeconds !== undefined && params.input.extendSeconds !== null) {
      if (typeof params.input.extendSeconds !== "bigint" || params.input.extendSeconds < 0n) throw new Error("extendSeconds must be a non-negative bigint")
      extend = params.input.extendSeconds
    }
    const now = nowOf(params)
    const pool = accrue(loadPool(poolId), now)
    if (params.context.sender !== pool.creator) throw new Error("only pool creator")
    let base = pool.lastUpdate      // = max(now, startAt) while the pool has not ended
    let leftover = 0n
    if (now >= pool.endAt) {
      if (extend === 0n) throw new Error("pool has ended: give extendSeconds to start a new period")
      base = now
      pool.lastUpdate = now
      pool.periodStart = now
      pool.endAt = now + extend
    } else {
      leftover = pool.rewardRate * (pool.endAt - base)
      pool.endAt = pool.endAt + extend
    }
    if (pool.endAt - now > MAX_DURATION) throw new Error("duration too long (max " + MAX_DURATION + " seconds)")
    const received = pullFrom(pool.rewardToken, params.context.sender, amount)
    pool.funded = pool.funded + received
    pool.rewardRate = (leftover + received * P) / (pool.endAt - base)
    if (pool.rewardRate <= 0n) throw new Error("amount too small for the period")
    savePool(poolId, pool)
    emit("RewardsAdded", { poolId: poolId, amount: received, endAt: pool.endAt, rewardRate: pool.rewardRate }, { indexed: ["poolId"] })
    unlock()
    return pool.rewardRate
  }

  function recoverUnallocated(params) { rejectValue(params);
    lock()
    const poolId = checkId(params.input.poolId)
    const pool = accrue(loadPool(poolId), nowOf(params))
    if (params.context.sender !== pool.creator) throw new Error("only pool creator")
    const amount = unallocatedOf(pool)
    if (amount === 0n) throw new Error("nothing to recover")
    if (amount > reserveOf(pool)) throw new Error("reward reserve exhausted")
    pool.recovered = pool.recovered + amount
    savePool(poolId, pool)
    emit("RewardsRecovered", { poolId: poolId, to: pool.creator, amount: amount }, { indexed: ["poolId", "to"] })
    pushTo(pool.rewardToken, pool.creator, amount)
    unlock()
    return amount
  }

  // ---------- reads ----------
  function pageArgs(input, max) {
    const start = input.start === undefined || input.start === null ? 0n : input.start
    const limit = input.limit === undefined || input.limit === null ? BigInt(max) : input.limit
    if (typeof start !== "bigint" || start < 0n) throw new Error("start must be a non-negative bigint")
    if (typeof limit !== "bigint" || limit <= 0n || limit > BigInt(max)) throw new Error("limit must be 1n … " + max + "n")
    return { start: start, limit: limit }
  }
  function getPool(params) { rejectValue(params); return view(checkId(params.input.poolId), loadPool(params.input.poolId), nowOf(params)) }
  function poolCount(params) { rejectValue(params); return readDB("poolCount") || 0n }
  function pools(params) { rejectValue(params);
    const page = pageArgs(params.input || {}, ${STAKING_MAX_PAGE})
    const total = poolCount()
    const out = []
    const now = nowOf(params)
    for (let id = page.start; id < total && id < page.start + page.limit; id = id + 1n) out.push(view(id, loadPool(id), now))
    return out
  }
  function stakedOf(params) { rejectValue(params);
    checkId(params.input.poolId)
    return readDB(map("stakes", params.input.poolId, checkAddress(params.input.who, "who"))) || 0n
  }
  function pendingRewards(params) { rejectValue(params);
    const poolId = checkId(params.input.poolId)
    const pool = accrue(loadPool(poolId), nowOf(params))
    return earnedOf(pool, poolId, checkAddress(params.input.who, "who")).reward
  }
  function poolsOfCount(params) { rejectValue(params); return readDB(map("userPoolCount", checkAddress(params.input.who, "who"))) || 0n }
  function poolsOf(params) { rejectValue(params);
    const who = checkAddress(params.input.who, "who")
    const page = pageArgs(params.input, ${STAKING_MAX_USER_PAGE})
    const total = readDB(map("userPoolCount", who)) || 0n
    const out = []
    for (let i = page.start; i < total && i < page.start + page.limit; i = i + 1n) out.push(readDB(map("userPools", who, i)))
    return out
  }

  return { createPool, stake, unstake, claim, exit, emergencyWithdraw, addRewards, recoverUnallocated,
    getPool, poolCount, pools, stakedOf, pendingRewards, poolsOf, poolsOfCount }
}`;
