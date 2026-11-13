/**
 * Token Lock — lock tokens / LP tokens (like PinkSale's PinkLock) · works with any program that follows the token standard (src/standards/token.js)
 *   DEX LP tokens are ordinary standard tokens → liquidity can be locked with the same functions
 *   no owner / admin · no upgrade path · nobody (including the deployer) can pull tokens out early
 *   input on deploy: { namespace?, icon?, url?, contact?, description? }
 *
 * Times (unlockAt / tgeAt / cycleSeconds) are unix **seconds** (bigint) · compared with params.block.timestamp / 1000n
 *   values ≥ 100_000_000_000n (year ~5138) are treated as milliseconds passed by mistake → throw
 *
 * State-changing functions (approve the token to this program before lock / vestingLock / increaseLock)
 *   lock({ token, amount, unlockAt, owner?, description? }) → id
 *       pulls via token.transferFrom · records the amount "actually received" (program's token balance before/after → supports fee-on-transfer tokens)
 *       owner = who can withdraw (omitted = caller) · unlockAt must be in the future · description ≤ 200 characters
 *   vestingLock({ token, amount, tgeAt, tgeBps, cycleSeconds, cycleBps, owner?, description? }) → id
 *       releases tgeBps/10000 of the amount at tgeAt, then another cycleBps every cycleSeconds until 100 %
 *       each bps is 1..10000 and tgeBps + cycleBps ≤ 10000 · computed in bps before multiplying the amount (rounded down; 10000 bps = full amount, no dust left)
 *   unlock({ id }) → amount     owner withdraws everything released and not yet withdrawn (too early / nothing to withdraw → throw)
 *   extendLock({ id, unlockAt }) → true          owner · plain locks only · the new unlockAt must be later than the old one and in the future
 *   increaseLock({ id, amount }) → amount actually received  owner · plain locks not yet unlocked
 *   transferLockOwnership({ id, newOwner }) → true  owner transfers the withdrawal right (newOwner ≠ zero / ≠ self)
 *   renounceLockOwnership({ id }) → true           ⚠️ owner = zero address → nobody can ever withdraw, tokens locked forever (burns the liquidity)
 * Read functions
 *   getLock({ id }) → { id, token, owner, creator, amount, withdrawn, withdrawable, lockedAt, unlockAt,
 *                       vesting, tgeAt, tgeBps, cycleSeconds, cycleBps, description }   (vesting: unlockAt = time fully released)
 *   lockCount() → bigint · withdrawableOf({ id }) → bigint · totalLocked({ token }) → bigint (amount still locked for that token)
 *   locksOf({ owner, start?, limit? }) / locksForToken({ token, start?, limit? }) → [lock, …]
 *       start defaults to 0n · limit defaults to 20n, max 50n · fully withdrawn locks stay in the list (withdrawn = amount)
 * event
 *   Locked { id, token, owner, creator, amount, unlockAt, vesting }      indexed id, token, owner
 *   Unlocked { id, token, owner, amount }                                indexed id, token, owner
 *   LockExtended { id, previousUnlockAt, unlockAt }                      indexed id
 *   LockIncreased { id, amount, total }                                  indexed id
 *   LockOwnerChanged { id, previousOwner, newOwner }                     indexed id, previousOwner, newOwner
 * storage
 *   count · locks:<id> · total:<token> · entered (reentrancy guard while calling tokens)
 *   ownerCount:<owner> · ownerLocks:<owner>:<i> → id · ownerIndex:<id> → i   (ownership transfer = removed by swapping in the last one)
 *   tokenCount:<token> · tokenLocks:<token>:<i> → id
 *
 * Security
 *   locked amounts are tracked per token and counted from what the program actually received · tokens sent in directly (not via lock) are stuck forever
 *   on withdrawal: withdrawn is recorded before calling token.transfer · the program's balance must drop by no more than the withdrawal (stops a token draining other locks of the same token)
 *   tokens whose balances can shrink on their own (negative rebase) are not supported
 *   every state-changing function has a reentrancy guard via the entered flag
 *   gas: every function does constant work · loops only in paginated reads (≤ 50 locks per call)
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";
import { ZERO_ADDRESS } from "./token.js";

export const TOKEN_LOCK_MAX_PAGE = 50;
export const TOKEN_LOCK_DEFAULT_PAGE = 20;
export const TOKEN_LOCK_MAX_DESCRIPTION = 200;
export const TOKEN_LOCK_FUNCTIONS = ["lock", "vestingLock", "unlock", "extendLock", "increaseLock", "transferLockOwnership", "renounceLockOwnership"];
export const TOKEN_LOCK_READS = ["getLock", "lockCount", "locksOf", "locksForToken", "totalLocked", "withdrawableOf"];
export const TOKEN_LOCK_EVENTS = ["Locked", "Unlocked", "LockExtended", "LockIncreased", "LockOwnerChanged"];

export const TOKEN_LOCK_PROGRAM = `function program() {
  // called as a tx with native coin attached → reject (this program has no way to send native coin out, so it would be stuck forever)
  function rejectValue(params) { if (params && params.value !== undefined && params.value !== null && params.value !== 0n) throw new Error("this function does not accept native value") }
  const ZERO = "${ZERO_ADDRESS}"
  const BPS = 10000n
  const MAX_TIME = 100000000000n
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    setProgramMetadata(params.input)
    writeDB("count", 0n)
  }

  // ---------- helpers ----------
  function nowSeconds(params) { return params.block.timestamp / 1000n }
  function enter() {
    if (readDB("entered") === true) throw new Error("reentrant call")
    writeDB("entered", true)
  }
  function leave() { deleteDB("entered") }
  function checkAmount(amount) {
    if (typeof amount !== "bigint" || amount <= 0n) throw new Error("amount must be a bigint greater than 0")
    return amount
  }
  function checkTime(value, label) {
    if (typeof value !== "bigint" || value <= 0n) throw new Error(label + " must be a positive bigint (unix seconds)")
    if (value >= MAX_TIME) throw new Error(label + " is too large (use unix seconds, not milliseconds)")
    return value
  }
  function checkFuture(value, label, params) {
    checkTime(value, label)
    if (value <= nowSeconds(params)) throw new Error(label + " must be in the future")
    return value
  }
  function checkBps(value, label) {
    if (typeof value !== "bigint" || value < 1n || value > BPS) throw new Error(label + " must be 1n..10000n")
    return value
  }
  function checkId(id) {
    if (typeof id !== "bigint" || id < 0n) throw new Error("id must be a non-negative bigint")
    return id
  }
  function checkDescription(text) {
    if (text === undefined || text === null) return ""
    if (typeof text !== "string") throw new Error("description must be a string")
    if (text.length > ${TOKEN_LOCK_MAX_DESCRIPTION}) throw new Error("description too long (max ${TOKEN_LOCK_MAX_DESCRIPTION})")
    return text
  }
  function checkToken(token) {
    const address = checkAddress(token, "token")
    if (address === ZERO) throw new Error("token must not be the zero address")
    if (address === ThisAddress()) throw new Error("token must not be this program")
    if (!IsProgram(address)) throw new Error("token must be a program")
    return address
  }
  function checkOwner(owner, fallback) {
    if (owner === undefined || owner === null) return fallback
    const address = checkAddress(owner, "owner")
    if (address === ZERO) throw new Error("owner must not be the zero address")
    return address
  }
  function load(id) {
    const item = readDB(map("locks", checkId(id)))
    if (item === undefined) throw new Error("lock does not exist")
    return item
  }
  function onlyLockOwner(item, params) {
    if (item.owner === ZERO) throw new Error("lock ownership renounced")
    if (params.context.sender !== item.owner) throw new Error("only lock owner")
  }
  function tokenBalance(token) {
    const balance = runProgram(token, "balanceOf", { who: ThisAddress() }, { readonly: true })
    if (typeof balance !== "bigint" || balance < 0n) throw new Error("token balanceOf must return a bigint")
    return balance
  }
  // pull tokens in and return the amount actually received
  function pull(token, from, amount) {
    const before = tokenBalance(token)
    const ok = runProgram(token, "transferFrom", { from: from, to: ThisAddress(), amount: amount })
    if (ok === false) throw new Error("token transferFrom failed")
    const after = tokenBalance(token)
    if (after <= before) throw new Error("no tokens received")
    const received = after - before
    if (received > amount) throw new Error("token balance increased by more than amount")
    return received
  }
  function push(token, to, amount) {
    const before = tokenBalance(token)
    const ok = runProgram(token, "transfer", { to: to, amount: amount })
    if (ok === false) throw new Error("token transfer failed")
    const after = tokenBalance(token)
    if (after > before || before - after > amount) throw new Error("token moved an unexpected amount")
  }
  function unlockedAmount(item, now) {
    if (!item.vesting) return now >= item.unlockAt ? item.amount : 0n
    if (now < item.tgeAt) return 0n
    const cycles = (now - item.tgeAt) / item.cycleSeconds
    let bps = item.tgeBps + cycles * item.cycleBps
    if (bps > BPS) bps = BPS
    return item.amount * bps / BPS
  }
  function withdrawableNow(item, now) {
    if (item.owner === ZERO) return 0n   // renounced = nobody can withdraw (UIs / lock checkers must not see it as withdrawable)
    const unlocked = unlockedAmount(item, now)
    return unlocked > item.withdrawn ? unlocked - item.withdrawn : 0n
  }
  function view(item, params) {
    item.withdrawable = withdrawableNow(item, nowSeconds(params))
    return item
  }
  function addToOwner(owner, id) {
    const n = readDB(map("ownerCount", owner)) || 0n
    writeDB(map("ownerLocks", owner, n), id)
    writeDB(map("ownerIndex", id), n)
    writeDB(map("ownerCount", owner), n + 1n)
  }
  function removeFromOwner(owner, id) {
    const n = readDB(map("ownerCount", owner)) || 0n
    const index = readDB(map("ownerIndex", id))
    const last = n - 1n
    if (index !== last) {
      const moved = readDB(map("ownerLocks", owner, last))
      writeDB(map("ownerLocks", owner, index), moved)
      writeDB(map("ownerIndex", moved), index)
    }
    deleteDB(map("ownerLocks", owner, last))
    deleteDB(map("ownerIndex", id))
    writeDB(map("ownerCount", owner), last)
  }
  function addTotal(token, delta) {
    writeDB(map("total", token), (readDB(map("total", token)) || 0n) + delta)
  }
  function create(params, item) {
    enter()
    const sender = params.context.sender
    const received = pull(item.token, sender, item.amount)
    const id = readDB("count") || 0n
    item.id = id
    item.amount = received
    item.withdrawn = 0n
    item.creator = sender
    item.lockedAt = nowSeconds(params)
    writeDB(map("locks", id), item)
    writeDB("count", id + 1n)
    addToOwner(item.owner, id)
    const tn = readDB(map("tokenCount", item.token)) || 0n
    writeDB(map("tokenLocks", item.token, tn), id)
    writeDB(map("tokenCount", item.token), tn + 1n)
    addTotal(item.token, received)
    emit("Locked", { id: id, token: item.token, owner: item.owner, creator: sender, amount: received, unlockAt: item.unlockAt, vesting: item.vesting },
      { indexed: ["id", "token", "owner"] })
    leave()
    return id
  }
  function page(input) {
    const start = input.start === undefined || input.start === null ? 0n : input.start
    let limit = input.limit === undefined || input.limit === null ? ${TOKEN_LOCK_DEFAULT_PAGE}n : input.limit
    if (typeof start !== "bigint" || start < 0n) throw new Error("start must be a non-negative bigint")
    if (typeof limit !== "bigint" || limit < 0n) throw new Error("limit must be a non-negative bigint")
    if (limit > ${TOKEN_LOCK_MAX_PAGE}n) limit = ${TOKEN_LOCK_MAX_PAGE}n
    return { start: start, limit: limit }
  }
  function listFrom(prefix, key, params) {
    const range = page(params.input)
    const total = readDB(map(prefix + "Count", key)) || 0n
    const out = []
    for (let i = range.start; i < total && i < range.start + range.limit; i = i + 1n) {
      out.push(view(readDB(map("locks", readDB(map(prefix + "Locks", key, i)))), params))
    }
    return out
  }

  // ---------- state-changing ----------
  function lock(params) { rejectValue(params);
    const input = params.input
    const token = checkToken(input.token)
    return create(params, {
      token: token, owner: checkOwner(input.owner, params.context.sender), amount: checkAmount(input.amount),
      unlockAt: checkFuture(input.unlockAt, "unlockAt", params), vesting: false,
      tgeAt: 0n, tgeBps: 0n, cycleSeconds: 0n, cycleBps: 0n, description: checkDescription(input.description) })
  }

  function vestingLock(params) { rejectValue(params);
    const input = params.input
    const token = checkToken(input.token)
    const tgeAt = checkFuture(input.tgeAt, "tgeAt", params)
    const tgeBps = checkBps(input.tgeBps, "tgeBps")
    const cycleBps = checkBps(input.cycleBps, "cycleBps")
    if (tgeBps + cycleBps > BPS) throw new Error("tgeBps + cycleBps must be at most 10000n")
    const cycleSeconds = checkTime(input.cycleSeconds, "cycleSeconds")
    const cycles = (BPS - tgeBps + cycleBps - 1n) / cycleBps
    const unlockAt = tgeAt + cycles * cycleSeconds
    if (unlockAt >= MAX_TIME) throw new Error("vesting ends too far in the future")
    return create(params, {
      token: token, owner: checkOwner(input.owner, params.context.sender), amount: checkAmount(input.amount),
      unlockAt: unlockAt, vesting: true, tgeAt: tgeAt, tgeBps: tgeBps, cycleSeconds: cycleSeconds, cycleBps: cycleBps,
      description: checkDescription(input.description) })
  }

  function unlock(params) { rejectValue(params);
    enter()
    const id = params.input.id
    const item = load(id)
    onlyLockOwner(item, params)
    const now = nowSeconds(params)
    if (unlockedAmount(item, now) === 0n) throw new Error("lock is not unlocked yet")
    const amount = withdrawableNow(item, now)
    if (amount === 0n) throw new Error("nothing to withdraw")
    item.withdrawn = item.withdrawn + amount
    writeDB(map("locks", id), item)
    addTotal(item.token, -amount)
    emit("Unlocked", { id: id, token: item.token, owner: item.owner, amount: amount }, { indexed: ["id", "token", "owner"] })
    push(item.token, item.owner, amount)
    leave()
    return amount
  }

  function extendLock(params) { rejectValue(params);
    enter()
    const id = params.input.id
    const item = load(id)
    onlyLockOwner(item, params)
    if (item.vesting) throw new Error("vesting locks cannot be extended")
    if (item.withdrawn >= item.amount) throw new Error("lock is fully withdrawn")
    const unlockAt = checkFuture(params.input.unlockAt, "unlockAt", params)
    if (unlockAt <= item.unlockAt) throw new Error("unlockAt must be later than the current unlockAt")
    const previous = item.unlockAt
    item.unlockAt = unlockAt
    writeDB(map("locks", id), item)
    emit("LockExtended", { id: id, previousUnlockAt: previous, unlockAt: unlockAt }, { indexed: ["id"] })
    leave()
    return true
  }

  function increaseLock(params) { rejectValue(params);
    enter()
    const id = params.input.id
    const item = load(id)
    onlyLockOwner(item, params)
    if (item.vesting) throw new Error("vesting locks cannot be increased")
    if (nowSeconds(params) >= item.unlockAt) throw new Error("lock is already unlocked")
    const amount = checkAmount(params.input.amount)
    const received = pull(item.token, params.context.sender, amount)
    const fresh = load(id)
    fresh.amount = fresh.amount + received
    writeDB(map("locks", id), fresh)
    addTotal(fresh.token, received)
    emit("LockIncreased", { id: id, amount: received, total: fresh.amount }, { indexed: ["id"] })
    leave()
    return received
  }

  function changeOwner(item, newOwner) {
    const previous = item.owner
    item.owner = newOwner
    writeDB(map("locks", item.id), item)
    removeFromOwner(previous, item.id)
    if (newOwner !== ZERO) addToOwner(newOwner, item.id)
    emit("LockOwnerChanged", { id: item.id, previousOwner: previous, newOwner: newOwner }, { indexed: ["id", "previousOwner", "newOwner"] })
  }

  function transferLockOwnership(params) { rejectValue(params);
    enter()
    const item = load(params.input.id)
    onlyLockOwner(item, params)
    const newOwner = checkAddress(params.input.newOwner, "newOwner")
    if (newOwner === ZERO) throw new Error("use renounceLockOwnership to give up a lock")
    if (newOwner === item.owner) throw new Error("newOwner is already the owner")
    if (item.withdrawn >= item.amount) throw new Error("lock is fully withdrawn")
    changeOwner(item, newOwner)
    leave()
    return true
  }

  // ⚠️ nobody can withdraw anymore — the tokens in this lock are stuck forever
  function renounceLockOwnership(params) { rejectValue(params);
    enter()
    const item = load(params.input.id)
    onlyLockOwner(item, params)
    if (item.withdrawn >= item.amount) throw new Error("lock is fully withdrawn")
    changeOwner(item, ZERO)
    leave()
    return true
  }

  // ---------- reads ----------
  function getLock(params) { rejectValue(params); return view(load(params.input.id), params) }
  function lockCount(params) { rejectValue(params); return readDB("count") || 0n }
  function withdrawableOf(params) { rejectValue(params); return withdrawableNow(load(params.input.id), nowSeconds(params)) }
  function totalLocked(params) { rejectValue(params); return readDB(map("total", checkAddress(params.input.token, "token"))) || 0n }
  function locksOf(params) { rejectValue(params); return listFrom("owner", checkAddress(params.input.owner, "owner"), params) }
  function locksForToken(params) { rejectValue(params); return listFrom("token", checkAddress(params.input.token, "token"), params) }

  return { lock, vestingLock, unlock, extendLock, increaseLock, transferLockOwnership, renounceLockOwnership, getLock, lockCount, locksOf, locksForToken, totalLocked, withdrawableOf }
}`;
