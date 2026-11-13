/**
 * The real server — node server.js    (plain node:http, no extra dependencies)
 *   PORT=3000 DATA=./data PRODUCER_KEY=0x… ADMINS=0x… node server.js      (development: DEV=1 node server.js or npm run dev)
 *   HOST=127.0.0.1    listen on localhost only (behind nginx · outsiders can't hit the port directly) · unset = all interfaces · for production setup see deploy/README.md
 *   EXPLORER_DIR=./my-explorer   a forked, customized explorer folder (default explorerscan/ · layout in explorerscan/README.md)
 *   DEV=1             development: ADMINS / PRODUCER_KEY not required (no ADMINS = anyone can approve deploy / upgrade)
 *   GENESIS=genesis.json   genesis file · its config locks values every machine must share (src/node/genesis.js) — env differing from genesis = refuses to start
 *   PRODUCER_KEY=0x…  the block producer key (signs every block hash · reader nodes check it against config.producers in genesis)
 *   MINER=0x…         recipient of block gas fees (default = the PRODUCER_KEY address)
 *   TIMEOUT_MS=5000   max time a program may run per tx / query (ms) — the last line of defense; infinite loops run out of gas first
 *   MEMORY_LIMIT_MB=32   sandbox (QuickJS) memory per tx across every program in the call chain — exceeded = OUT_OF_MEMORY (1–1024)
 *   STACK_LIMIT_KB=256   sandbox stack per tx (calls nested too deep = a catchable RangeError) (16–256)
 *   GAS_PRICE=10000000000000 minimum base fee (wei per gas · native has 18 decimals · default 10,000 gwei) — EIP-1559: no block's base fee goes below this
 *   BLOCK_MS=2000          time per block (ms) · blocks are sealed only when txs are waiting
 *   MAX_BLOCK_GAS=5000000  max total gas per block (lockable in genesis config) · MAX_TX_GAS=<MAX_BLOCK_GAS> max gas per tx · MAX_TX_PER_BLOCK=500
 *   GAS_TARGET=2500000     target gas per block (default = maxBlockGas / 2) · used more → base fee rises, used less → falls
 *   BASE_FEE_DENOMINATOR=8 base fee changes by at most 1/this per block (8 = 12.5%, like Ethereum)
 *   BURN_PERCENT=100       share of the base fee that is burned (the tip always goes to the block sealer) — must match on every machine in the network
 *   RATE_LIMIT=120    POSTs (/sendtx, /query) per IP per minute — 0 = unlimited
 *   TRUST_PROXY=0     number of reverse proxy hops in front (nginx / Caddy = 1) → rate limiting uses the IP from X-Forwarded-For (src/node/client-ip.js)
 *   EVM_RATE_LIMIT=600  /evm requests per IP per minute (counted separately from RATE_LIMIT: EVM wallets poll often and shouldn't eat the /sendtx quota)
 *                     a batch counts every request in it · ws counts every frame (eth_sendRawTransaction over ws also counts toward RATE_LIMIT, like HTTP)
 *   EVM_MAX_BATCH=1000  max requests per /evm batch (HTTP and ws) · same as geth · indexers like Blockscout send batches of up to 500
 *   MAX_BODY_BYTES=1048576  max POST body size (/sendtx, /query, /evm) · exceeded = 413 (the largest program code is 64 KB)
 *   EVM_DECIMALS=0    decimals /evm adds to native amounts (native is already 18-decimal wei, so 0)
 *   EVM_NAME=Bluewolfchain EVM_SYMBOL=BWSC   coin name / symbol in GET /evm (values for wallet_addEthereumChain)
 *   UPGRADE_DELAY_BLOCKS=0   program upgrade timelock: new code takes effect at block (approval + N) · 0 = immediately
 *   REJECTED_PER_BLOCK=1000  rejected txs (signature OK but not executed) recorded per block (the excess carries over to the next block)
 *   REPLACED_LOG_MAX=100000  replaced txs remembered (off-chain · with DATA = stored in <DATA>/replaced-tx.jsonl, survives restarts)
 *   REPLACED_LOG_DAYS=30     max age of replaced-tx records
 *   VERIFY_WORKERS=N         worker threads verifying /sendtx signatures (default = CPU count − 1, at most 4) · 0 = verify on the main thread
 *   HISTORY_KEEP_BLOCKS=N    pruning: keep history (pre-write state values) for only the last N blocks → state lookback / replay / rebuild only within that range · unset = keep everything (archive)
 *   SNAPSHOT_EVERY=N         take a state snapshot every N blocks (GET /snapshot · new nodes can start from a snapshot — src/node/snapshot.js) · 0 = off
 *   SNAPSHOT_DIR=<DATA>/snapshots   where snapshot files are kept · SNAPSHOT_KEEP=2 number of files kept
 *   FOLLOW=<url>             standby machine: keeps syncing blocks from the producer, doesn't produce blocks or accept txs (/sendtx = 503) · no PRODUCER_KEY needed
 *   FOLLOW_SNAPSHOT=1        standby with an empty DB: start from the source's snapshot (GET /snapshot) instead of syncing from block 1
 *   FAILOVER_FROM=<url>      take over production from the old machine: asks it first — still producing = refuses to start · no longer producing = syncs what's missing first (src/node/failover.js)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { VirtualMachine } from "./src/core/virtualmachine.js";
import { reviewProgram } from "./src/core/autoreview.js";
import { DB, MemoryDB, DEFAULT_MAP_SIZE, parseSize } from "./src/storage/db.js";
import { addressOf } from "./src/crypto/signature.js";
import { signTypedDataDigest } from "./src/crypto/program-signature.js";
import { resolveSettings, startupProblems, startupWarnings, producersAt } from "./src/node/genesis.js";
import { startSync } from "./src/node/sync.js";
import { prepareFailover } from "./src/node/failover.js";
import { Mempool } from "./src/node/mempool.js";
import { TxLog } from "./src/node/txlog.js";
import { simulate } from "./src/node/simulate.js";
import { RateLimiter } from "./src/node/ratelimit.js";
import { createEvmRpc, parseError } from "./src/node/evm-rpc.js";
import { VerifyPool, DEFAULT_VERIFY_WORKERS } from "./src/node/verify-pool.js";
import { attachEvmWebSocket } from "./src/node/evm-ws.js";
import { clientIp } from "./src/node/client-ip.js";
import { withSystemAbi } from "./src/standards/system-abi.js";
import { createSnapshotter } from "./src/node/snapshot.js";
import { storageLayout, storageMap, storageGet, programFlags, tokenInfo, tokenHoldings, collectionInfo, nftHoldings,
  pageOf, pageBlocks, pageTransactionsOf, pageTransactionsTo, pageEvents, pageStorageMap, pageHolders,
  programCounts, pagePendingPrograms, pageApprovedPrograms, cursorOf, cursorTransactionsTo, cursorEvents,
  storageGroups, pageRejected, indexedFilterOf, cursorIndexedEvents, programAbi } from "./src/node/explorer-api.js";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST || undefined;   // undefined = all interfaces
export const DEV = ["1", "true", "yes", "on"].includes(String(process.env.DEV ?? "").toLowerCase());
// genesis: initial balances + values every machine must share (config) — env set differently from genesis = refuses to start (see startupProblems)
const GENESIS_FILE = process.env.GENESIS ?? "genesis.json";
export const genesis = fs.existsSync(GENESIS_FILE) ? JSON.parse(fs.readFileSync(GENESIS_FILE, "utf8")) : null;
export const { settings, errors: settingErrors } = resolveSettings(genesis ?? {}, process.env);
// block producer: signs every block hash with this key (the key lives only on this machine; no endpoint accepts / returns keys)
const PRODUCER_KEY = process.env.PRODUCER_KEY || null;
export const producer = PRODUCER_KEY
  ? { address: addressOf(PRODUCER_KEY), sign: (hash) => signTypedDataDigest(hash, PRODUCER_KEY) }
  : null;
// standby (FOLLOW) syncs from the producer · taking over production (FAILOVER_FROM) must pass prepareFailover before the miner starts
export const FOLLOW = process.env.FOLLOW || null;
const FAILOVER_FROM = process.env.FAILOVER_FROM || null;
const MINER = process.env.MINER ?? producer?.address ?? "0x1111111111111111111111111111111111111111";
const BLOCK_MS = settings.blockMs;
const MAX_TX_PER_BLOCK = Number(process.env.MAX_TX_PER_BLOCK ?? 500);
const MAX_TX_GAS = Math.min(Number(process.env.MAX_TX_GAS ?? settings.maxBlockGas), settings.maxBlockGas);   // max gas per tx (at most maxBlockGas)
// programs run synchronously on the same thread as HTTP → the server can't answer anyone while one runs, so this must be short
// (loops run out of gas on their own, see src/core/gasmeter.js — this time limit is the last line of defense)
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 5000);
export const verifyPool = new VerifyPool({ size: process.env.VERIFY_WORKERS ?? DEFAULT_VERIFY_WORKERS });
const RATE_LIMIT = Number(process.env.RATE_LIMIT ?? 120);
// program sandbox (see src/core/sandbox.js): every machine in the network must use the same values, otherwise memory-heavy txs give different results
const MEMORY_LIMIT_MB = settings.memoryLimitMb;
const STACK_LIMIT_KB = settings.stackLimitKb;
const GAS_PRICE = settings.minBaseFee;   // wei per gas (default 10,000 gwei)
// automatic code review (src/core/autoreview.js) on /sendtx deploy / upgrade · AUTO_REVIEW=0 = off (sandbox + gas still apply)
export const AUTO_REVIEW = !["0", "false", "off", "no"].includes(String(process.env.AUTO_REVIEW ?? "1").toLowerCase());

// the most LMDB may reserve (full = writes fail, the chain stops) · default 1T · usage is shown at /health
const LMDB_MAP_SIZE = process.env.LMDB_MAP_SIZE ? parseSize(process.env.LMDB_MAP_SIZE) : DEFAULT_MAP_SIZE;
export const vm = new VirtualMachine(process.env.DATA ? new DB(process.env.DATA, { mapSize: LMDB_MAP_SIZE }) : new MemoryDB(), {
  chainId: settings.chainId,
  requireNonce: true, chargeGas: true, deriveProgramAddress: true,
  recordTransactions: true, recordBlocks: true, recordHistory: true,
  // EIP-1559: base fee (adjusted by block fullness) is burned · tip (maxPriorityFeePerGas) goes to the block sealer
  feeRecipient: MINER, burnPercent: settings.burnPercent, timeoutMs: TIMEOUT_MS,
  minBaseFee: GAS_PRICE, gasTarget: settings.gasTarget,
  baseFeeChangeDenominator: settings.baseFeeDenominator,
  producer,
  memoryLimitBytes: MEMORY_LIMIT_MB * 1024 * 1024, maxStackBytes: STACK_LIMIT_KB * 1024,
  gas: { price: GAS_PRICE },   // native 18 decimals (wei) · min gas price from genesis (default 10,000 gwei)
  // 1 s blocks · 1M gas · 500 txs (measured: block-time-sim.md) — the per-block tx cap / per-tx gas aren't checked by other nodes and may differ
  maxTransactions: MAX_TX_PER_BLOCK, maxTransactionsPerSender: 16, maxBlockGas: settings.maxBlockGas, maxTxGas: MAX_TX_GAS,
  admins: settings.admins,
  upgradeDelayBlocks: settings.upgradeDelayBlocks,   // upgrade timelock (0 = new code applies as soon as approved)
  forks: settings.forks,   // genesis.json "forks": new rules from a given block (names the code doesn't know = refuses to start)
  historyKeep: process.env.HISTORY_KEEP_BLOCKS ? Number(process.env.HISTORY_KEEP_BLOCKS) : null,   // pruning (null = archive)
});
// state snapshot every SNAPSHOT_EVERY blocks (taken without stopping the chain · requires DATA or SNAPSHOT_DIR)
const SNAPSHOT_EVERY = Number(process.env.SNAPSHOT_EVERY ?? 0);
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || (process.env.DATA ? path.join(process.env.DATA, "snapshots") : null);
export const snapshots = SNAPSHOT_EVERY > 0 && SNAPSHOT_DIR
  ? createSnapshotter(vm, { dir: SNAPSHOT_DIR, every: SNAPSHOT_EVERY, keep: Number(process.env.SNAPSHOT_KEEP ?? 2) })
  : null;
// replaced txs (replace-by-fee): remembered off-chain, bounded · with DATA = a JSON lines file next to LMDB → /tx can answer "replaced" even after restart
export const replacedLog = new TxLog({
  file: process.env.DATA ? path.join(process.env.DATA, "replaced-tx.jsonl") : null,
  maxEntries: Number(process.env.REPLACED_LOG_MAX ?? 100_000),
  maxAgeMs: Number(process.env.REPLACED_LOG_DAYS ?? 30) * 24 * 60 * 60_000,
});
// rejected txs (signature passed) are recorded in the next block (block.recordRejected) — see src/node/mempool.js
export const mempool = new Mempool(vm, { replacedLog, maxRejectedPerBlock: Number(process.env.REJECTED_PER_BLOCK ?? 1000) });
// every POST may run a program → limited per IP (/sendtx also has a per-address rate limit in the mempool)
export const postLimiter = new RateLimiter({ limit: RATE_LIMIT, windowMs: 60_000 });
// adapter for EVM wallets / tools (read-only, changes nothing on the chain) — see src/node/evm-rpc.js
export const evmLimiter = new RateLimiter({ limit: Number(process.env.EVM_RATE_LIMIT ?? 600), windowMs: 60_000 });
const EVM_MAX_BATCH = Math.max(1, Number(process.env.EVM_MAX_BATCH ?? 1000));
const MAX_BODY_BYTES = Math.max(1024, Number(process.env.MAX_BODY_BYTES ?? 1024 * 1024));
// eth_sendRawTransaction → the same intake as /sendtx (the function is declared below; works thanks to hoisting)
export const evmRpc = createEvmRpc({ vm, mempool, decimals: Number(process.env.EVM_DECIMALS ?? 0),
  submit: (verified) => intake({ tx: verified.tx, signature: verified.request.signature }, verified) });   // native is already wei (18 decimals)
if (genesis) vm.applyGenesis(genesis);

// only rejected txs → hold them to ride along with a block that has real txs, or seal when the oldest has waited REJECTED_HOLD_MS (0 = seal immediately)
export const REJECTED_HOLD_MS = Number(process.env.REJECTED_HOLD_MS ?? 60_000);
export function shouldMine(now = Date.now()) {
  if (mempool.size > 0) return true;
  if (mempool.rejectedPending === 0) return false;
  return now - (mempool.oldestRejectionAt ?? now) >= REJECTED_HOLD_MS;
}

// producer list for block n (config.producers, then changed per producerSchedule) · null = genesis doesn't define one
export const producersOf = settings.producers?.length ? (number) => producersAt(settings, number) : null;
/** can this node's key produce the next block? (removed via producerSchedule = no) */
export function canProduce(number = (vm.latestBlockNumber() ?? 0) + 1) {
  const allowed = producersOf?.(number);
  return !allowed || (producer !== null && allowed.includes(producer.address));
}
// false = don't produce blocks (FOLLOW / waiting for prepareFailover at startup)
export let miningEnabled = !FOLLOW && !(FAILOVER_FROM && process.argv[1]?.endsWith("server.js"));

let mining = false;
// result of the latest block seal (lets /health tell whether the chain stopped due to repeated seal failures)
export const minerState = { failures: 0, lastError: null, lastErrorAt: null, idleAt: null };
const STARTED_AT = Date.now();
/** seal one block (the miner calls this every BLOCK_MS) → the sealed block | null (nothing to seal / can't seal) */
export function mineOnce(now = Date.now()) {
  if (mining || !miningEnabled || !shouldMine(now)) return null;
  mining = true;
  try {
    const next = (vm.latestBlockNumber() ?? 0) + 1;
    if (!canProduce(next)) {   // producerSchedule removed this key from this block on → stop producing (other nodes would reject its blocks)
      throw new Error(`PRODUCER_KEY (${producer?.address ?? "none"}) is not in the producer list for block ${next} (${producersOf(next).join(", ")})`);
    }
    const block = vm.createBlock({ timestamp: now, feeRecipient: MINER });
    const included = mempool.take(block);
    // nothing can enter the block (waiting txs blocked on a missing nonce etc.) and the base fee is already at the minimum → don't seal an empty block (empty blocks only lower the base fee)
    if (included.length === 0 && block.rejectedTransactions().length === 0 && BigInt(String(block.baseFee ?? vm.minBaseFee).replace(/n$/, "")) <= vm.minBaseFeeNow()) {
      minerState.idleAt = now;   // the miner is still running, there's just nothing that fits (/health doesn't count it as stalled)
      return null;
    }
    block.commit();
    snapshots?.onBlock(block.number);
    const rejected = block.rejectedTransactions().length;
    console.log(`block ${block.number} sealed (${included.length} tx${rejected ? ` · rejected ${rejected}` : ""})`);
    minerState.failures = 0;
    return block;
  } catch (error) {
    console.error("block seal failed:", error.message);
    Object.assign(minerState, { failures: minerState.failures + 1, lastError: error.message, lastErrorAt: now });
    return null;
  } finally { mining = false; }
}
export const miner = setInterval(() => mineOnce(), BLOCK_MS);
miner.unref?.();

const lower = (value) => String(value ?? "").toLowerCase();

// /health: chain stalled = txs waiting but no new block for longer than this · LMDB usage above this = warning
// standby: sync status (lets /health tell whether syncing is stuck / stopped due to a block mismatch)
export const followState = { url: FOLLOW, lastSyncAt: null, error: null, errorAt: null };
export let stopFollow = null;
if (FOLLOW) {
  stopFollow = startSync(vm, { url: FOLLOW, producers: producersOf, intervalMs: Math.max(BLOCK_MS, 1000),
    snapshot: ["1", "true", "yes", "on"].includes(String(process.env.FOLLOW_SNAPSHOT ?? "").toLowerCase()),
    onBlock: (number) => { followState.lastSyncAt = Date.now(); snapshots?.onBlock(number); },
    onSnapshot: (loaded) => console.log(`started from snapshot block ${loaded.number ?? loaded}`),
    onError: (error) => { Object.assign(followState, { error: error.message, errorAt: Date.now() }); console.error("sync stopped:", error.message); } });
}

export const STALL_MS = Number(process.env.HEALTH_STALL_MS ?? Math.max(BLOCK_MS * 10, 30_000));
export const DISK_WARN_PERCENT = Number(process.env.HEALTH_DISK_PERCENT ?? 90);

export function role() {
  if (FOLLOW) return "follower";
  if (!canProduce()) return "retired";
  return miningEnabled ? "producer" : "standby";
}

/** node status → { ok, problems, ... } · problems = HTTP 503 (load balancers / monitors see it immediately) */
export function health(now = Date.now()) {
  const latest = vm.latestBlockNumber();
  const latestAt = latest === null ? null : vm.getBlock(latest)?.timestamp ?? null;
  const since = latestAt ?? STARTED_AT;
  const db = typeof vm.db.stats === "function" ? vm.db.stats() : null;
  const waiting = mempool.size + (shouldMine(now) ? mempool.rejectedPending : 0);
  const problems = [];
  const idle = minerState.idleAt !== null && now - minerState.idleAt < Math.max(BLOCK_MS * 3, 5_000);   // txs that can't enter a block (e.g. missing nonce) ≠ chain stalled
  if (waiting > 0 && !idle && now - since > STALL_MS) problems.push(`stalled: ${waiting} tx waiting but no new block for ${Math.round((now - since) / 1000)} s`);
  if (followState.error) problems.push(`follow: sync from ${FOLLOW} stopped (${followState.error})`);
  if (minerState.failures > 0) problems.push(`miner: block seal failed ${minerState.failures} times in a row (${minerState.lastError})`);
  if (db && db.usedPercent >= DISK_WARN_PERCENT) problems.push(`disk: LMDB has used ${db.usedPercent}% of mapSize`);
  return {
    ok: problems.length === 0, problems,
    latest, latestAt, blockAgeMs: latestAt === null ? null : now - latestAt, blockMs: BLOCK_MS,
    historyFrom: vm.historyFrom(), pending: mempool.size, rejectedPending: mempool.rejectedPending,
    // role: producer = producing blocks · follower = standby (FOLLOW) · retired = key removed from the list · standby = waiting for prepareFailover
    role: role(), producer: producer?.address ?? null, miner: { ...minerState }, follow: FOLLOW ? { ...followState } : null, db,
  };
}
const limitOf = (query) => Math.min(Number(query.get("limit")) || 20, 200);

const ROUTES = {
  "/blocks": (query) => {
    const before = Number(query.get("before"));
    const latest = vm.latestBlockNumber() ?? 0;
    const from = Number.isInteger(before) && before > 0 ? before - 1 : latest;
    const list = [];
    for (let n = from; n > 0 && list.length < limitOf(query); n -= 1) { const b = vm.getBlock(n); if (b) list.push(b); }
    return list;
  },
  // paginated: ?page=<page number>&limit=<per page> → { items, total, page, pages, limit, truncated }
  "/blocks/page": (query) => pageBlocks(vm, pageOf(query)),
  "/block/latest": () => vm.getBlock(vm.latestBlockNumber()) ?? { error: "No blocks yet" },
  "/pending": () => ({ size: mempool.size, transactions: mempool.list(), rejectedPending: mempool.rejectedPending, rejectedHoldMs: REJECTED_HOLD_MS }),
  // rejected txs (recorded in blocks) newest to oldest: ?address=<sender>&limit=&cursor= → { items, next }
  "/rejected": (query) => pageRejected(vm, { address: query.get("address") || undefined, ...cursorOf(query) }),
  // programs: approved / pending counts + paginated lists
  "/programs": () => programCounts(vm),
  "/programs/pending": (query) => pagePendingPrograms(vm, pageOf(query)),
  "/programs/approved": (query) => pageApprovedPrograms(vm, pageOf(query)),
  "/events": (query) => vm.listEvents({ program: query.get("program") ?? undefined, name: query.get("name") ?? "", limit: limitOf(query) }),
  "/is-program": (query) => programFlags(vm, (query.get("addresses") ?? "").split(",").filter(Boolean)),
  // node status: latest block · earliest block available for lookback · LMDB space used (beyond mapSize = writes fail)
  "/health": () => {
    const body = health();
    return body.ok ? body : { status: 503, body };
  },
  "/genesis": () => ({ hash: vm.genesisHash(), chainId: vm.chainId, latest: vm.latestBlockNumber(), pending: mempool.size,
    gasPrice: vm.minBaseFeeNow(), decimals: 18,   // current minimum base fee (wei · from genesis or set by an admin via setGasConfig) · native has 18 decimals
    minBaseFee: vm.minBaseFeeNow(), genesisMinBaseFee: vm.minBaseFee,
    gasConfig: vm.gasConfig(), gas: vm.gasAt(), admins: settings.admins,   // values set on-chain by admins (null = never set) · per-unit price table for the next block
    baseFee: vm.currentBaseFee(), gasTarget: vm.gasTarget, maxBlockGas: vm.maxBlockGas, burnPercent: vm.burnPercent,   // EIP-1559: next block's base fee
    burned: vm.nativeBalanceOf("0x0000000000000000000000000000000000000000").balance,
    forks: vm.forkSchedule(),   // [{ name, block, active, description }] new rules from a given block
    // this node's block producer + the producers genesis allows (reader nodes pass them to startSync({ producers }))
    // producers = the list for the next block · producerSchedule = [{ fromBlock, producers }] changes the list from a given block
    producer: producer?.address ?? null, role: role(),
    producers: producersOf?.((vm.latestBlockNumber() ?? 0) + 1) ?? settings.producers, baseProducers: settings.producers,
    producerSchedule: settings.producerSchedule }),
};

const DYNAMIC = [
  [/^\/block\/(\d+)$/, (m, query) => {
    const header = vm.getBlock(Number(m[1]));
    if (!header) return { status: 404, body: { error: "Block not found" } };
    if (query.get("full") !== "1") return header;
    try { return vm.replayBlock(Number(m[1])); } catch (error) { return { status: 409, body: { error: error.message, header } }; }
  }],
  [/^\/tx\/([^/]+)\/receipt$/, (m) => {
    const found = vm.getTransaction(m[1]);
    if (!found) return { status: 404, body: { error: "Transaction not found" } };
    try { return { ...vm.replayBlock(found.blockNumber).transactions[found.index], blockNumber: found.blockNumber, signature: vm.transactionSignature(found) }; }
    catch (error) { return { status: 409, body: { error: error.message, tx: found } }; }
  }],
  [/^\/tx\/([^/]+)$/, (m) => {
    const found = vm.getTransaction(m[1], { signature: true });
    if (found) return found;
    if (mempool.has(m[1])) return { status: "pending", hash: m[1] };
    const replacedBy = mempool.replacedBy(m[1]);   // replaced by a tx with the same nonce and higher gas price (off-chain · with DATA = survives restarts)
    if (replacedBy) return { status: "replaced", hash: m[1], replacedBy };
    // rejected (not executed): already recorded in a block, or still waiting for the next block (block: null)
    const rejected = vm.getRejectedTransaction(m[1]);
    if (rejected) return { status: "rejected", ...rejected, block: rejected.blockNumber };
    const waiting = mempool.pendingRejection(m[1]);
    if (waiting) return { status: "rejected", ...waiting, block: null, blockNumber: null };
    return { status: 404, body: { error: "Transaction not found" } };
  }],
  [/^\/address\/([^/]+)$/, (m, query) => ({
    address: lower(m[1]), native: vm.nativeBalanceOf(m[1]),
    nonce: vm.checkTransaction({ from: m[1], nonce: -1 }).expectedNonce,
    metadata: withSystemAbi(vm.getMetadata(m[1]), (dbKey) => vm.read(dbKey), m[1]), isProgram: vm.read(`${lower(m[1])}:this`) !== undefined,
    transactions: vm.listTransactionsOf(m[1], { limit: limitOf(query) }),
    incoming: vm.listTransactionsTo(m[1], { limit: limitOf(query) }),
  })],
  [/^\/program\/([^/]+)$/, (m, query) => {
    const code = vm.read(`${lower(m[1])}:code`);
    if (!code) return { status: 404, body: { error: "Program not found (it may not be initialized yet)" } };
    return { address: lower(m[1]), code, context: vm.read(`${lower(m[1])}:context`), metadata: withSystemAbi(vm.getMetadata(m[1]), (dbKey) => vm.read(dbKey), m[1]),   // bundled programs: abi from code
      // upgrade: pending review / approved and waiting for the timelock (none = null)
      pendingUpgrade: vm.read(`pending-upgrade:${lower(m[1])}`) ?? null, scheduledUpgrade: vm.read(`scheduled-upgrade:${lower(m[1])}`) ?? null,
      native: vm.nativeBalanceOf(m[1]), storage: vm.listProgramStorage(m[1], { limit: 50 }),
      interactions: vm.listTransactionsTo(m[1], { limit: limitOf(query) }),
      events: vm.listEvents({ program: m[1], limit: limitOf(query) }), token: tokenInfo(vm, m[1]),
      collection: collectionInfo(vm, m[1]) };   // standard NFT (ERC-721) / multi-token (ERC-1155) · otherwise = null
  }],
  [/^\/program\/([^/]+)\/storage$/, (m, query) => {
    const address = lower(m[1]);
    const group = query.get("prefix") ?? "";
    const limit = limitOf(query);
    const base = `${address}:storage:`;
    const start = query.get("start") || undefined;

    // single-part keys (e.g. "owner") have no children, so read directly rather than by prefix
    const leaf = group && !start ? vm.read(base + group) : undefined;
    const head = leaf === undefined ? [] : [{ key: [group], value: leaf }];

    const rows = vm.listEntries(`${base}${group ? group + ":" : ""}`, { limit: limit + 1 - head.length, start });
    const hasMore = rows.length > limit - head.length;
    const items = [...head, ...rows.slice(0, limit - head.length)
      .map(({ dbKey, value }) => ({ key: dbKey.slice(base.length).split(":"), value }))];
    return { items, next: hasMore ? rows[limit - head.length].dbKey : null, prefix: group };
  }],
  // every code version of a program that has been upgraded [{ version, code, blockNumber, timestamp }]
  [/^\/program\/([^/]+)\/versions$/, (m) => vm.listCodeVersions(m[1])],
  // the ABI the program declares in metadata.abi (none = null) + the Ethereum JSON ABI form
  [/^\/program\/([^/]+)\/abi$/, (m) => programAbi(vm, m[1])],
  // count keys by first key part, chunk by chunk ?scan=<keys per call ≤ 50,000>&cursor=<next> → { total, groups, scanned, next, complete }
  [/^\/program\/([^/]+)\/groups$/, (m, query) => storageGroups(vm, m[1], { cursor: query.get("cursor") || undefined, scan: query.get("scan") })],
  // cursor-based (no full count): ?limit=&cursor=<next> → { items, next }
  [/^\/program\/([^/]+)\/interactions$/, (m, query) => cursorTransactionsTo(vm, m[1], cursorOf(query))],
  // the explorer's "data" tab: variables (1-part keys) / contract (2 parts) / get storage (3+ parts)
  // coins an address holds (counted from Transfer events) / standard token info
  [/^\/address\/([^/]+)\/tokens$/, (m) => tokenHoldings(vm, m[1])],
  // NFTs / multi-tokens an address holds (programs from the holding: index · items from the program's storage)
  [/^\/address\/([^/]+)\/nfts$/, (m) => nftHoldings(vm, m[1])],
  [/^\/token\/([^/]+)$/, (m) => tokenInfo(vm, m[1]) ?? { status: 404, body: { error: "Not a standard token" } }],
  [/^\/address\/([^/]+)\/txs$/, (m, query) => pageTransactionsOf(vm, m[1], pageOf(query))],
  [/^\/address\/([^/]+)\/incoming$/, (m, query) => (query.has("cursor") ? cursorTransactionsTo(vm, m[1], cursorOf(query)) : pageTransactionsTo(vm, m[1], pageOf(query)))],
  // ?page= → page number (counts up to 50,000) · ?cursor= (may be empty = first page) → cursor-based, no cap
  // ?name=<event>&<field>=<value> → searches via the index of a field emitted as indexed (cursor) — see indexedEventsQuery
  [/^\/program\/([^/]+)\/events$/, (m, query) => (indexedFilterOf(query) ? cursorIndexedEvents(vm, m[1], query.get("name") ?? "", indexedFilterOf(query), cursorOf(query))
    : query.has("cursor") ? cursorEvents(vm, m[1], cursorOf(query), query.get("name") ?? "")
    : pageEvents(vm, m[1], pageOf(query), query.get("name") ?? ""))],
  [/^\/address\/([^/]+)\/rejected$/, (m, query) => pageRejected(vm, { address: m[1], ...cursorOf(query) })],
  [/^\/program\/([^/]+)\/entries$/, (m, query) => pageStorageMap(vm, m[1], query.get("name") ?? "", pageOf(query))],
  [/^\/token\/([^/]+)\/holders$/, (m, query) => pageHolders(vm, m[1], pageOf(query))],
  [/^\/program\/([^/]+)\/layout$/, (m) => storageLayout(vm, m[1])],
  [/^\/program\/([^/]+)\/map$/, (m, query) => storageMap(vm, m[1], query.get("name") ?? "", { limit: Math.min(Number(query.get("limit")) || 50, 200), start: query.get("start") || undefined })],
  [/^\/program\/([^/]+)\/get$/, (m, query) => storageGet(vm, m[1], query.getAll("key"))],
  [/^\/nonce\/([^/]+)$/, (m) => ({ address: lower(m[1]), nonce: mempool.nextNonce(m[1]) })],
  [/^\/name\/([^/]+)$/, (m) => ({ namespace: lower(m[1]), address: vm.resolveNamespace(m[1]) })],
  [/^\/state\/([^/]+)$/, (m, query) => {
    const block = Number(query.get("block"));
    if (!Number.isInteger(block)) return vm.listProgramStorage(m[1]);
    const prefix = `${lower(m[1])}:storage:`;
    // ?limit=&cursor= → { items: { dbKey: value }, next } (cost scales with keys requested, not chain length) · omitted = everything, as before
    try {
      if (!query.has("limit") && !query.has("cursor")) return vm.snapshotAt(block, prefix);
      const page = vm.pageSnapshotAt(block, prefix, { limit: limitOf(query), after: query.get("cursor") || undefined });
      return { items: Object.fromEntries(page.items), next: page.next };
    } catch (error) { return { status: 409, body: { error: error.message } }; }
  }],
  // Merkle proofs of keys in the latest state: ?key=<dbKey>&key=… → { blockNumber, blockHash, stateRoot, proofs } (verify with client-sdk's verifyProof)
  [/^\/proof$/, (m, query) => {
    const keys = query.getAll("key");
    if (!keys.length || keys.length > 100) return { status: 400, body: { error: "send 1–100 keys" } };
    return vm.getProof(keys);
  }],
  [/^\/sync$/, (m, query) => {
    const from = Math.max(1, Number(query.get("from")) || 1);
    const blocks = [];
    // rejected = rejected txs recorded in the block (part of the block hash; syncing nodes must include all of them in order)
    for (let n = from; n <= Math.min(vm.latestBlockNumber() ?? 0, from + 49); n += 1) {
      blocks.push({ header: vm.getBlock(n), body: vm.getBlockBody(n), rejected: vm.getBlockRejected(n) });
    }
    return blocks;
  }],
];

/**
 * Admit signature-verified txs into the mempool (shared by /sendtx and /evm eth_sendRawTransaction)
 * code review + simulate (the expensive part) run only after the mempool has checked rate limit / quota / nonce
 */
function intake({ tx, signature, sponsorSignature }, verified) {
  if (FOLLOW) return { ok: false, follower: true, error: `this node is a standby (doesn't accept txs) — send to ${FOLLOW}` };
  const check = (item) => {
    if (AUTO_REVIEW && (tx.action === "deploy" || tx.action === "upgrade")) {   // new upgrade code goes through the same review as deploy
      const reviewed = reviewProgram(tx.code);
      if (!reviewed.ok) return { ok: false, error: "code failed review", issues: reviewed.issues };
    }
    return simulate(vm, item);
  };
  return mempool.add({ tx, signature, sponsorSignature }, { simulate: check, verified });   // signature already verified → no second recover
}

async function handlePost(url, body) {
  if (url === "/sendtx") {
    const { tx, signature, sponsorSignature } = body ?? {};   // sponsorSignature: the gas sponsor (tx.sponsor) signs the same digest
    if (FOLLOW) return { status: 503, body: { queued: false, error: `this node is a standby (doesn't accept txs) — send to ${FOLLOW}` } };
    let verified;
    try { verified = await verifyPool.verify({ tx, signature, sponsorSignature }); }   // recover the signature in a worker → the main thread keeps serving other requests
    catch (error) { return { status: 400, body: { queued: false, error: error.message } }; }

    const queued = intake({ tx, signature, sponsorSignature }, verified);
    if (queued.simulation?.issues) return { status: 400, body: { queued: false, error: queued.simulation.error, issues: queued.simulation.issues } };
    if (queued.simulation && !queued.ok) return { status: 400, body: { queued: false, hash: verified.hash, simulation: queued.simulation } };
    if (!queued.ok) return { status: 400, body: { queued: false, ...queued } };
    return { queued: true, hash: queued.hash, sender: queued.sender, simulation: queued.simulation };
  }
  if (url === "/query") {
    const result = vm.query(body ?? {});
    return result.status === "success" ? result : { status: 400, body: result };
  }
  return { status: 404, body: { error: "Endpoint not found" } };
}

const send = (response, status, data) => {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  response.end(JSON.stringify(data, (key, value) => (typeof value === "bigint" ? `${value}n` : value)));
};

/**
 * /evm — EVM-style JSON-RPC (POST) · values for adding the chain to MetaMask (GET /evm)
 * /evm/explorer/{tx,address,token,block}/:id — wallets' "view in explorer" links (EIP-3091) → the existing explorer pages
 * /evm/explorer — the explorer home page (the URL registered in chainlist · ethereum-lists CI really opens it and needs a 2xx after redirects)
 */
/** read a POST body up to MAX_BODY_BYTES · exceeded → null (stops reading immediately, never buffers the whole thing) */
async function readBody(request) {
  if (Number(request.headers["content-length"] ?? 0) > MAX_BODY_BYTES) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const TOO_LARGE = { error: `body exceeds ${MAX_BODY_BYTES} bytes` };

async function handleEvm(request, response, url) {
  if (url.pathname === "/evm/explorer" || url.pathname === "/evm/explorer/") {
    response.writeHead(302, { location: "/" });
    return response.end();
  }
  const explorerLink = /^\/evm\/explorer\/(tx|address|token|block)\/([^/]+)$/.exec(url.pathname);
  if (explorerLink) {
    const [, kind, raw] = explorerLink;
    // EIP-3091: block/<hash or number> · the explorer's block page accepts only numbers
    const id = kind === "block" && /^0x[0-9a-f]{64}$/i.test(raw) ? (vm.getBlockByHash(raw.toLowerCase())?.number ?? raw) : raw;
    response.writeHead(302, { location: `/#${kind === "token" ? "address" : kind}/${encodeURIComponent(id)}` });
    return response.end();
  }
  if (url.pathname !== "/evm") return send(response, 404, { error: "Endpoint not found" });
  if (request.method === "OPTIONS") {   // browser dApps send content-type: application/json → a preflight must be answered
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type" });
    return response.end();
  }
  if (request.method === "GET") {
    const origin = `${request.headers["x-forwarded-proto"] ?? "http"}://${request.headers.host ?? "localhost"}`;
    return send(response, 200, evmRpc.chainParams({ rpcUrl: `${origin}/evm`, explorerUrl: `${origin}/evm/explorer`,
      name: process.env.EVM_NAME ?? "Bluewolfchain", symbol: process.env.EVM_SYMBOL ?? "BWSC" }));
  }
  if (request.method !== "POST") return send(response, 405, { error: "Use POST for JSON-RPC" });
  const raw = await readBody(request);
  if (raw === null) return send(response, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: TOO_LARGE.error } });
  const ip = clientIp(request);
  if (!evmLimiter.allow(ip)) {
    response.setHeader("retry-after", String(evmLimiter.retryAfter(ip)));
    return send(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32005, message: "Too many requests, try again later" } });
  }
  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return send(response, 200, parseError()); }
  // batch: capped in size + every request in it counts against EVM_RATE_LIMIT (the first was already counted above)
  if (Array.isArray(body) && body.length > EVM_MAX_BATCH) {
    return send(response, 200, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `batch too large (max ${EVM_MAX_BATCH})` } });
  }
  for (let i = 1; Array.isArray(body) && i < body.length; i += 1) {
    if (evmLimiter.allow(ip)) continue;
    response.setHeader("retry-after", String(evmLimiter.retryAfter(ip)));
    return send(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32005, message: "Too many requests, try again later" } });
  }
  // sending txs via /evm counts against the same quota as POST /sendtx (RATE_LIMIT), not the /evm read quota
  const sends = (Array.isArray(body) ? body : [body]).filter((item) => item?.method === "eth_sendRawTransaction").length;
  for (let i = 0; i < sends; i += 1) {
    if (postLimiter.allow(ip)) continue;
    response.setHeader("retry-after", String(postLimiter.retryAfter(ip)));
    return send(response, 429, { jsonrpc: "2.0", id: null, error: { code: -32005, message: "Too many requests, try again later" } });
  }
  try { return send(response, 200, evmRpc.handle(body, { client: ip })); }
  catch (error) { console.error(error); return send(response, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: error.message } }); }
}

/**
 * GET /snapshot → { number, hash, stateRoot, size, file } of the latest snapshot · GET /snapshot/<N> → the file (gzip JSON lines)
 * downloaders verify everything themselves (src/node/snapshot.js loadSnapshot), so it can be served without trusting this node
 */
function handleSnapshot(response, url) {
  const latest = snapshots?.latest();
  if (!latest) return send(response, 404, { error: "this node has no snapshots (set SNAPSHOT_EVERY)" });
  if (url.pathname === "/snapshot") {
    const header = vm.getBlock(latest.number);
    return send(response, 200, { number: latest.number, hash: header?.hash ?? null, stateRoot: header?.stateRoot ?? null, size: latest.size, file: `/snapshot/${latest.number}` });
  }
  const number = Number(url.pathname.slice("/snapshot/".length));
  const file = Number.isSafeInteger(number) ? snapshots.fileOf(number) : null;
  if (!file || !fs.existsSync(file)) return send(response, 404, { error: "no snapshot for this block" });
  response.writeHead(200, { "content-type": "application/gzip", "content-length": fs.statSync(file).size, "access-control-allow-origin": "*" });
  return fs.createReadStream(file).pipe(response);
}

/**
 * explorer pages = files in the explorerscan/ folder (or EXPLORER_DIR = a forked, customized folder) served at /explorerscan/*
 * "/" serves the same index.html with <base href="/explorerscan/"> added so relative paths in the file resolve correctly
 */
const EXPLORER_DIR = path.resolve(process.env.EXPLORER_DIR ?? path.join(import.meta.dirname, "explorerscan"));
const STATIC_TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8", ".woff2": "font/woff2" };
function serveExplorer(response, file, base = false) {
  let full;
  try { full = path.resolve(EXPLORER_DIR, `.${decodeURIComponent(file)}`); } catch { return send(response, 404, { error: "Endpoint not found" }); }
  const type = STATIC_TYPES[path.extname(full).toLowerCase()];
  if (!type || !full.startsWith(EXPLORER_DIR + path.sep) || !fs.statSync(full, { throwIfNoEntry: false })?.isFile()) {
    return send(response, 404, { error: "Endpoint not found" });
  }
  let body = fs.readFileSync(full);
  if (base) body = body.toString("utf8").replace("<head>", '<head><base href="/explorerscan/">');
  response.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
  return response.end(body);
}

export const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/evm" || url.pathname.startsWith("/evm/")) return handleEvm(request, response, url);
  if (request.method === "GET" && (url.pathname === "/snapshot" || url.pathname.startsWith("/snapshot/"))) return handleSnapshot(response, url);
  if (request.method === "OPTIONS") {   // explorers hosted on another domain (EXPLORER.api) send JSON POSTs → a preflight must be answered
    response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type" });
    return response.end();
  }
  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/explorer")) return serveExplorer(response, "/index.html", true);
  if (request.method === "GET" && url.pathname === "/explorerscan") { response.writeHead(301, { location: "/explorerscan/" }); return response.end(); }
  if (request.method === "GET" && url.pathname.startsWith("/explorerscan/")) {
    return serveExplorer(response, url.pathname === "/explorerscan/" ? "/index.html" : url.pathname.slice("/explorerscan".length));
  }
  try {
    let result;
    if (request.method === "POST") {
      const raw = await readBody(request);
      if (raw === null) return send(response, 413, TOO_LARGE);
      const ip = clientIp(request);
      if (!postLimiter.allow(ip)) {
        response.setHeader("retry-after", String(postLimiter.retryAfter(ip)));
        return send(response, 429, { error: "Too many requests, try again later" });
      }
      result = await handlePost(url.pathname, raw.length ? JSON.parse(raw) : {});
    } else if (ROUTES[url.pathname]) {
      result = ROUTES[url.pathname](url.searchParams);
    } else {
      const found = DYNAMIC.map(([pattern, handler]) => [pattern.exec(url.pathname), handler]).find(([match]) => match);
      result = found ? found[1](found[0], url.searchParams) : { status: 404, body: { error: "Endpoint not found" } };
    }
    if (result?.status && result?.body) return send(response, result.status, result.body);
    return send(response, 200, result);
  } catch (error) {
    console.error(error);
    return send(response, 500, { error: error.message });
  }
});

// ws://host/evm: eth_subscribe newHeads / logs (rate limit shared with POST /evm)
export const evmWs = attachEvmWebSocket(server, { rpc: evmRpc, vm, allow: (ip) => evmLimiter.allow(ip), allowSend: (ip) => postLimiter.allow(ip),
  maxBatch: EVM_MAX_BATCH });

if (process.argv[1]?.endsWith("server.js")) {
  const problems = startupProblems({ settings, errors: settingErrors, dev: DEV, producer: producer?.address ?? null,
    follow: Boolean(FOLLOW), nextBlock: FAILOVER_FROM ? null : (vm.latestBlockNumber() ?? 0) + 1 });   // failover: check the list after syncing
  if (FOLLOW && FAILOVER_FROM) problems.push("FOLLOW and FAILOVER_FROM can't both be set (standby / replacement producer: pick one)");
  if (problems.length) {
    console.error(`server not starting:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    process.exit(1);
  }
  if (DEV) console.warn("DEV=1: development mode (ADMINS / PRODUCER_KEY not required) — never use on a real network");
  for (const warning of startupWarnings({ settings, dev: DEV })) console.warn(`warning: ${warning}`);
  if (FOLLOW) console.log(`standby: syncing from ${FOLLOW} (doesn't produce blocks or accept txs)`);
  if (FAILOVER_FROM) {
    try {
      const result = await prepareFailover(vm, { url: FAILOVER_FROM, producers: producersOf });
      if (result.warning) console.warn(`warning: ${result.warning}`);
      else console.log(`failover: synced ${result.synced} blocks from ${FAILOVER_FROM}`);
      const next = (vm.latestBlockNumber() ?? 0) + 1;
      if (!canProduce(next)) throw new Error(`PRODUCER_KEY (${producer?.address ?? "none"}) is not in the producer list for block ${next}`);
      miningEnabled = true;
    } catch (error) {
      console.error(`server not starting (failover):\n  - ${error.message}`);
      process.exit(1);
    }
  }
  server.listen(PORT, HOST, () => console.log(`chain running at http://${HOST ?? "localhost"}:${server.address().port}`));
}
