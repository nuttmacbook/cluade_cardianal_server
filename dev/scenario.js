/**
 * Large test suite against a running server: 1000 wallets · 10 txs per block · programs calling each other in complex ways
 *
 *   RATE_LIMIT=0 GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run dev   # server (sends from one machine, so the per-IP rate limit must be off · prices / gas budget based on 1 gwei + DEFAULT_GAS · see HANDOFF.md item 10)
 *   npm run scenario                               # in another terminal · http://localhost:3000
 *   GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run scenario -- --spawn   # starts the server itself (MemoryDB, random PORT · env is passed to the server)
 *
 * Steps
 *   (every block takes ready jobs until it has 10 txs: setup jobs first, then filled with jobs from wallets that already have coins)
 *   1 deploy + init   token TEST (6 decimals) · multisend · chain A–F (6 chained hops) · router 1–4 (multi-hop forwarding)
 *   2 distribute      multiSend native to 1000 wallets (100 per tx) · multiTransfer token to all 1000 wallets (100 per tx)
 *                     the target wallet (--target) gets both native for gas and token TEST
 *   3 usage           every block sends 10 txs from different wallets: chain A→F (sometimes level F fails but D catches it)
 *                     forward token + native through 4 router hops · small multiTransfers · token / native transfers · naming
 *   4 verify          did every tx land in a block · succeed / fail as intended · txs per block · token holder count · --target balance
 *
 * Options
 *   --url <url>         server (http://localhost:3000)
 *   --wallets <n>       number of wallets (1000)
 *   --per-block <n>     txs per block (10)
 *   --blocks <n>        number of blocks in step 3 (60)
 *   --target <address>  wallet that gets both native and token (0xF10FF4d0f48b1fb63f7A0d2672Bfc18C765480Cf)
 *   --seed <text>       wallet set / randomness (scenario)
 *   --spawn             start server.js itself · --data <dir> to use LMDB
 *   --out <file>        JSON report (scenario-report.json)
 *
 * ⚠️ wallet keys are derived from --seed for testing only · never use them with real funds
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { MULTISEND_PROGRAM, CHAIN_PROGRAM, ROUTER_PROGRAM } from "./scenario-programs.js";

const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const OPTIONS = {
  url: option("url", "http://localhost:3000"),
  wallets: Number(option("wallets", 1000)),
  perBlock: Number(option("per-block", 10)),
  blocks: Number(option("blocks", 60)),
  target: option("target", "0xF10FF4d0f48b1fb63f7A0d2672Bfc18C765480Cf").toLowerCase(),
  seed: option("seed", "scenario"),
  funderKey: option("funder-key", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
  spawn: args.includes("--spawn"),
  data: option("data", null),
  out: option("out", "scenario-report.json"),
};

// ---------- native coin budget (genesis gives the funder 10,000,000 coins) ----------
// native has 18 decimals (wei) and the gas price is 1 gwei → budgets in this script are counted in gwei, so the numbers equal the gas they can buy
const GWEI = 10n ** 9n;
const gwei = (amount) => `${BigInt(amount) * GWEI}`;   // amount sent in a tx (string because it can exceed 2^53)
const UNIT = 10n ** 6n;                 // TEST 6 decimals
const POWER = 50;                       // wallets doing heavy txs (chain / router / multiTransfer) get a bigger budget
const NATIVE_EACH = 4_500;              // native per regular wallet (token transfer ≈ 2,570 gas incl. indexed from / to · native transfer ≈ 1,300)
const NATIVE_POWER = 60_000;            // extra native for power wallets (4-hop forward ≈ 21,500 gas · 6-hop chain ≈ 8,100 · multiTransfer ≈ 2,300 per recipient)
const NATIVE_TARGET = 500_000;          // for --target to pay its own gas
// estimated cost (gas + value) of each kind of job → don't send jobs a wallet can't afford (rejected at /sendtx)
const COST = { chainHop: 1_500, chainBase: 2_000, router: 24_000, approve: 2_000, multiPer: 2_500, multiBase: 2_000,
  tokenTransfer: 2_700, nativeTransfer: 1_400, metadata: 2_500 };   // tokenTransfer includes topic 375 × 2 (Transfer indexes from / to)
const TOKEN_EACH = 1_000n * UNIT;       // TEST per wallet
const TOKEN_POWER = 50_000n * UNIT;
const TOKEN_TARGET = 1_000_000n * UNIT;
const BATCH = 100;                      // recipients per multiSend / multiTransfer
// EIP-1559: pay at most 10 gwei per gas (the base fee can rise when blocks are full) · no tip → pay only the base fee
const GAS = { gasLimit: 1_000_000, maxFeePerGas: gwei(10), maxPriorityFeePerGas: "0" };

// ---------- helpers ----------
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;
let rngState = parseInt(keyOf(`rng:${OPTIONS.seed}`).slice(2, 10), 16);
const random = () => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

const makeWallet = (key, name) => ({ key, name, address: sign.addressOf(key) });
const funder = makeWallet(OPTIONS.funderKey, "funder");
const wallets = Array.from({ length: OPTIONS.wallets }, (_, i) => makeWallet(keyOf(`wallet:${OPTIONS.seed}:${i}`), `w${String(i).padStart(4, "0")}`));
const power = wallets.slice(0, POWER);
const normal = wallets.slice(POWER);

let API = OPTIONS.url.replace(/\/$/, "");
const get = (path) => fetch(API + path).then((r) => r.json());
const post = async (path, body) => {
  const response = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 429) throw new Error("server returned 429 (per-IP rate limit) — start the server with RATE_LIMIT=0 or use --spawn");
  return response.json();
};

const report = {
  options: { ...OPTIONS, funderKey: undefined },
  startedAt: new Date().toISOString(),
  stages: {}, programs: {},
  sent: 0, queued: 0, rejected: 0, rejectedReasons: {},
  byLabel: {},          // label → { sent, queued, success, throw, expectThrow }
  tracked: [],          // { hash, label, expectThrow }
  perSlot: [],
};

let CHAIN_ID = 1;
async function send(wallet, fields, label, { expectThrow = false } = {}) {
  const { nonce } = await get(`/nonce/${wallet.address}`);
  const tx = { chainId: CHAIN_ID, from: wallet.address, to: "", method: "", input: {}, value: 0, nonce, ...GAS, ...fields };
  const result = await post("/sendtx", { tx, signature: sign.signTransaction(tx, wallet.key) });
  const stats = (report.byLabel[label] ??= { sent: 0, queued: 0, success: 0, throw: 0, expectThrow });
  report.sent += 1;
  stats.sent += 1;
  if (result.queued) {
    report.queued += 1;
    stats.queued += 1;
    report.tracked.push({ hash: result.hash, label, expectThrow });
    return result.hash;
  }
  report.rejected += 1;
  const reason = String(result.simulation?.error?.message ?? result.simulation?.error ?? result.error ?? result.reason ?? "unknown")
    .replace(/0x[0-9a-f]{40}/gi, "0x…").slice(0, 100);
  report.rejectedReasons[`${label}: ${reason}`] = (report.rejectedReasons[`${label}: ${reason}`] ?? 0) + 1;
  return null;
}

// ---------- block pacing: send at most perBlock txs, then wait for the next block ----------
let lastSeen = 0;
async function nextBlock() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { latest } = await get("/genesis");
    if ((latest ?? 0) > lastSeen) return (lastSeen = latest ?? 0);
    await wait(100);
  }
  throw new Error("no new block in 60 seconds — is the server closing blocks?");
}
// ---------- job queue: every block takes ready jobs (whose prerequisites are already in a block) up to perBlock txs ----------
const done = new Set();     // events already landed in a block, e.g. "init token"
const queue = [];           // { label, ready(), run() → hash, onDone(found, hash) }
const waiting = [];         // { hash, onDone }
const task = (label, ready, run, onDone) => queue.push({ label, ready, run, onDone });

/** Has a sent tx landed in a block yet → calls onDone */
async function settle() {
  for (const item of [...waiting]) {
    const found = await get(`/tx/${item.hash}`);
    if (!found?.blockNumber) continue;
    waiting.splice(waiting.indexOf(item), 1);
    await item.onDone?.(found, item.hash);
  }
}

async function runSlot(stage, jobs) {
  const before = report.queued;
  const started = Date.now();
  for (const job of jobs) await job();
  report.perSlot.push({ stage, sent: jobs.length, queued: report.queued - before, ms: Date.now() - started });
  process.stdout.write(`\rslot ${String(report.perSlot.length).padStart(4)}  ${stage.padEnd(16)} sent ${String(jobs.length).padStart(2)}  queued ${String(report.queued - before).padStart(2)}  (chain block ${lastSeen})   `);
  await nextBlock();
  await settle();
}

// TEST icon: a blue-purple gradient square with the letter T
const ICON = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b5bdb"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="43" font-size="30" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">T</text></svg>');

// ============================================================================
//  1–2 deploy + init + distribute coins (setup jobs, queued in order, sent when ready)
// ============================================================================
const P = {};                 // program name → address
const tokenFunded = new Set();
const PROGRAM_NAMES = ["token", "multisend", "chain-a", "chain-b", "chain-c", "chain-d", "chain-e", "chain-f", "router-1", "router-2", "router-3", "router-4"];
const allReady = () => PROGRAM_NAMES.every((name) => done.has(`init ${name}`));
const mustSucceed = (label) => (found) => { if (found.status !== "success") throw new Error(`${label} failed: ${JSON.stringify(found.error ?? found)}`); };

function deployTask(name, code, input, ready = () => true) {
  task(`deploy ${name}`, ready, () => send(funder, { action: "deploy", code, input: typeof input === "function" ? input() : input }, `deploy ${name}`),
    async (found, hash) => {
      mustSucceed(`deploy ${name}`)(found);
      P[name] = (await get(`/tx/${hash}/receipt`)).result.programUuid;
      task(`init ${name}`, () => true, () => send(funder, { action: "init", to: P[name] }, `init ${name}`),
        (initFound) => { mustSucceed(`init ${name}`)(initFound); done.add(`init ${name}`); });
    });
}

function planSetup() {
  deployTask("token", TOKEN_PROGRAM, { name: "Scenario Test Token", ticker: "TEST", decimals: "6n", supply: `${1_000_000_000n * UNIT}n`,
    namespace: `${OPTIONS.seed}-test`, icon: ICON, description: "Test token spread to every scenario wallet" });
  deployTask("multisend", MULTISEND_PROGRAM, { name: `${OPTIONS.seed}-multisend` });
  for (const label of ["a", "b", "d", "f"]) deployTask(`chain-${label}`, CHAIN_PROGRAM, { label, name: `${OPTIONS.seed}-chain-${label}`, catch: label === "d" });
  for (const i of [1, 2, 3, 4]) deployTask(`router-${i}`, ROUTER_PROGRAM, { name: `${OPTIONS.seed}-router-${i}` });
  // C / E read TEST's balanceOf along the way → deploy after the token address is known
  for (const label of ["c", "e"]) deployTask(`chain-${label}`, CHAIN_PROGRAM, () => ({ label, name: `${OPTIONS.seed}-chain-${label}`, probe: P.token }), () => Boolean(P.token));

  task("transfer native → target", () => true, () => send(funder, { action: "transfer", to: OPTIONS.target, value: gwei(NATIVE_TARGET) }, "transfer native → target"), mustSucceed("native → target"));
  for (const group of chunk(wallets, BATCH)) {
    const recipients = group.map((w) => ({ to: w.address, amount: `${gwei(NATIVE_EACH)}n` }));
    task("multiSend native", () => done.has("init multisend"),
      () => send(funder, { action: "call", to: P.multisend, method: "multiSend", input: { recipients }, value: gwei(NATIVE_EACH * group.length) }, "multiSend native"),
      (found) => { mustSucceed("multiSend")(found); for (const w of group) budget.set(w.address, (budget.get(w.address) ?? 0) + NATIVE_EACH); });
  }
  task("multiSend native (power)", () => done.has("init multisend"), () => send(funder, { action: "call", to: P.multisend, method: "multiSend",
    input: { recipients: power.map((w) => ({ to: w.address, amount: `${gwei(NATIVE_POWER)}n` })) }, value: gwei(NATIVE_POWER * power.length) }, "multiSend native (power)"),
    (found) => { mustSucceed("multiSend power")(found); for (const w of power) budget.set(w.address, (budget.get(w.address) ?? 0) + NATIVE_POWER); });
  for (const group of chunk(wallets, BATCH)) {
    const transfers = group.map((w) => ({ to: w.address, amount: `${power.includes(w) ? TOKEN_POWER : TOKEN_EACH}n` }));
    task("multiTransfer TEST", () => done.has("init token"),
      () => send(funder, { action: "call", to: P.token, method: "multiTransfer", input: { transfers } }, "multiTransfer TEST"),
      (found) => { mustSucceed("multiTransfer")(found); for (const w of group) tokenFunded.add(w.address); });
  }
  task("transfer TEST → target", () => done.has("init token"),
    () => send(funder, { action: "call", to: P.token, method: "transfer", input: { to: OPTIONS.target, amount: `${TOKEN_TARGET}n` } }, "transfer TEST → target"),
    mustSucceed("TEST → target"));
}

// ============================================================================
//  3 usage: every block, 10 txs from different wallets
// ============================================================================
const approved = new Set();
const named = new Set();
const budget = new Map();   // address → approximate remaining native (set when the multiSend lands in a block)
// EIP-1559: budgets are counted as gas at 1 gwei · the base fee rises when blocks are full (e.g. multiSend to 100) → cost multiplied by base fee / 1 gwei
//   (+13% in case the base fee rises one more block before the tx lands) — don't send jobs a wallet can't afford
let feeFactor = 1;
async function refreshFeeFactor() {
  const { baseFee } = await get("/genesis");
  const ratio = Number((BigInt(String(baseFee ?? GWEI).replace(/n$/, "")) * 1000n) / GWEI) / 1000;
  feeFactor = ratio > 1 ? ratio * 1.13 : 1;
}
const others = (wallet, n) => { const set = new Set(); while (set.size < n) { const w = pick(wallets); if (w !== wallet) set.add(w.address); } return [...set]; };
const CHAIN_ORDER = ["chain-a", "chain-b", "chain-c", "chain-d", "chain-e", "chain-f"];

/** Jobs for power wallets: chain / router / small multiTransfer → [cost, job] */
function powerJob(wallet) {
  if (!allReady() || !tokenFunded.has(wallet.address)) return normalJob(wallet);
  const roll = random();
  if (roll < 0.4) {
    // chain A→… 3–6 hops long · 20% of 6-hop chains make F fail but D catches it (tx succeeds, trace shows the failed level)
    // (txs that fail entirely are rejected by the simulation at /sendtx first, so they never land in a block)
    const length = randomInt(3, 6);
    const [head, ...path] = CHAIN_ORDER.slice(0, length).map((name) => P[name]);
    const failAt = length === 6 && random() < 0.2 ? "f" : "";
    const label = failAt ? "call chain ×6 (F fails, D catches)" : `call chain ×${length}`;
    return [COST.chainBase + COST.chainHop * length,
      () => send(wallet, { action: "call", to: head, method: "step", input: { path, depth: "0n", failAt, note: wallet.name } }, label)];
  }
  if (roll < 0.75) {
    if (!approved.has(wallet.address)) {
      return [COST.approve, () => {
        approved.add(wallet.address);
        return send(wallet, { action: "call", to: P.token, method: "approve", input: { spender: P["router-1"], amount: `${TOKEN_POWER}n` } }, "call token.approve router");
      }];
    }
    // token + native through router 1→2→3→4 to the recipient (sometimes --target)
    const to = random() < 0.25 ? OPTIONS.target : pick(others(wallet, 1));
    const amount = BigInt(randomInt(10, 500)) * UNIT;
    const value = randomInt(5, 50);
    return [COST.router + value, () => send(wallet, { action: "call", to: P["router-1"], method: "forward", value: gwei(value),
      input: { token: P.token, path: [P["router-2"], P["router-3"], P["router-4"]], to, amount: `${amount}n`, pull: true } },
      to === OPTIONS.target ? "call router ×4 → target" : "call router ×4")];
  }
  const recipients = others(wallet, randomInt(10, 30));
  return [COST.multiBase + COST.multiPer * recipients.length, () => send(wallet, { action: "call", to: P.token, method: "multiTransfer",
    input: { transfers: recipients.map((to) => ({ to, amount: `${BigInt(randomInt(1, 20)) * UNIT}n` })) } }, "call token.multiTransfer")];
}

/** Jobs for regular wallets: token / native transfers · naming → [cost, job] */
function normalJob(wallet) {
  const roll = random();
  if (roll < 0.5 && tokenFunded.has(wallet.address)) {
    const to = random() < 0.05 ? OPTIONS.target : pick(others(wallet, 1));
    return [COST.tokenTransfer, () => send(wallet, { action: "call", to: P.token, method: "transfer", input: { to, amount: `${BigInt(randomInt(1, 100)) * UNIT}n` } },
      to === OPTIONS.target ? "call token.transfer → target" : "call token.transfer")];
  }
  if (roll < 0.8 || named.has(wallet.address)) {
    const value = randomInt(1, 50);
    return [COST.nativeTransfer + value, () => send(wallet, { action: "transfer", to: pick(others(wallet, 1)), value: gwei(value) }, "transfer native")];
  }
  return [COST.metadata, () => {
    named.add(wallet.address);
    return send(wallet, { action: "metadata", input: { namespace: `${OPTIONS.seed}-${wallet.name}`, description: `Scenario wallet ${wallet.name}` } }, "metadata");
  }];
}

/** Picks a wallet not yet used in this block that can afford the job · at most 200 tries */
function assign(pool, makeJob, busy) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const wallet = pick(pool);
    if (busy.has(wallet)) continue;
    const [estimate, job] = makeJob(wallet);
    const cost = Math.ceil(estimate * feeFactor);
    if ((budget.get(wallet.address) ?? 0) < cost) continue;
    budget.set(wallet.address, budget.get(wallet.address) - cost);
    busy.add(wallet);
    return job;
  }
  return null;
}

/** Loops block by block: ready setup jobs first, then filled with user jobs (wallets that already have coins) up to perBlock txs */
async function runAll() {
  const started = Date.now();
  let activitySlots = 0;
  while (queue.length || activitySlots < OPTIONS.blocks) {
    const jobs = [];
    for (const item of [...queue]) {
      if (jobs.length >= OPTIONS.perBlock) break;
      if (!item.ready()) continue;
      queue.splice(queue.indexOf(item), 1);
      jobs.push(async () => { const hash = await item.run(); if (hash) waiting.push({ hash, onDone: item.onDone }); else throw new Error(`${item.label} not queued: ${JSON.stringify(report.rejectedReasons)}`); });
    }
    const setup = jobs.length;
    if (activitySlots < OPTIONS.blocks) {
      await refreshFeeFactor();
      const busy = new Set();
      for (let n = 0; n < 3 && jobs.length < OPTIONS.perBlock; n += 1) { const job = assign(power, powerJob, busy); if (job) jobs.push(job); }
      while (jobs.length < OPTIONS.perBlock) { const job = assign(normal, normalJob, busy); if (!job) break; jobs.push(job); }
    }
    if (jobs.length > setup) activitySlots += 1;
    if (!jobs.length) {   // wait for setup txs to land in a block first
      if (!waiting.length) throw new Error("no ready jobs and no pending txs — queue is stuck");
      await wait(200);
      await settle();
      continue;
    }
    await runSlot(setup === jobs.length ? "setup" : setup ? "setup+activity" : "activity", jobs);
    if (!queue.length && !report.stages.setup) report.stages.setup = { block: lastSeen, seconds: (Date.now() - started) / 1000 };
  }
  report.stages.all = { blocks: [report.firstBlock, lastSeen], seconds: (Date.now() - started) / 1000 };
}

// ============================================================================
//  4 verify
// ============================================================================
async function verify() {
  process.stdout.write("\n\nverifying every tx…\n");
  await wait(4_000);
  const missing = [];
  for (const item of report.tracked) {
    const found = await get(`/tx/${item.hash}`);
    if (!found?.blockNumber) { missing.push(item); continue; }
    report.byLabel[item.label][found.status === "success" ? "success" : "throw"] += 1;
    report.byLabel[item.label].gas = (report.byLabel[item.label].gas ?? 0) + (found.gasUsed ?? 0);
  }
  report.missing = missing.length;
  report.programs = P;
  report.unexpected = Object.entries(report.byLabel)
    .filter(([, s]) => (s.expectThrow ? s.success : s.throw) > 0)
    .map(([label, s]) => ({ label, ...s }));

  const latest = (await get("/block/latest")).number;
  const headers = [];
  for (let n = report.firstBlock; n <= latest; n += 1) headers.push(await get(`/block/${n}`));
  const counts = headers.map((h) => h.txCount).filter((n) => n > 0);
  const histogram = {};
  for (const n of counts) histogram[n] = (histogram[n] ?? 0) + 1;
  report.blocks = { range: [headers[0]?.number, latest], txPerBlock: histogram,
    avg: +(counts.reduce((a, b) => a + b, 0) / Math.max(1, counts.length)).toFixed(2),
    gasUsed: headers.reduce((sum, h) => sum + (h.gasUsed ?? 0), 0) };

  const holders = await get(`/token/${P.token}/holders?limit=1`);
  const target = await get(`/address/${OPTIONS.target}?limit=1`);
  const targetToken = (await get(`/address/${OPTIONS.target}/tokens`)).find((t) => t.address === P.token);
  const routerDeliveries = (await get(`/address/${OPTIONS.target}/incoming?limit=1`)).total;
  report.token = { address: P.token, holders: holders.total };
  report.target = { address: OPTIONS.target, native: target.native, test: targetToken?.balance ?? null, incoming: routerDeliveries };
  report.funderLeft = (await get(`/address/${funder.address}?limit=1`)).native.balance;
  report.finishedAt = new Date().toISOString();
}

function summary() {
  const line = (label, value) => console.log(`  ${label.padEnd(30)} ${value}`);
  console.log("\n================ scenario ================");
  line("wallets", `${OPTIONS.wallets} (${POWER} power)`);
  line("programs", Object.entries(P).map(([n, a]) => `${n} ${a.slice(0, 6)}…${a.slice(-4)}`).join(" · "));
  line("tx sent / queued / rejected", `${report.sent} / ${report.queued} / ${report.rejected}`);
  line("queued but not in a block", report.missing);
  line("tx per block (count of blocks)", JSON.stringify(report.blocks.txPerBlock));
  line("gas used (all blocks)", report.blocks.gasUsed);
  line("token holders", report.token.holders);
  line("target native / TEST", `${report.target.native.balance} / ${report.target.test}`);
  line("funder native left", report.funderLeft);
  console.log("\n  label                                     sent  queued  ok  throw  gas/tx");
  for (const [label, s] of Object.entries(report.byLabel).sort()) {
    const done = s.success + s.throw;
    const gas = done ? Math.round((s.gas ?? 0) / done) : 0;
    console.log(`  ${label.padEnd(40)} ${String(s.sent).padStart(5)} ${String(s.queued).padStart(7)} ${String(s.success).padStart(4)} ${String(s.throw).padStart(6)} ${String(gas).padStart(7)}${s.expectThrow ? "  (expected to throw)" : ""}`);
  }
  if (report.rejected) {
    console.log("\n  rejected at /sendtx");
    for (const [reason, count] of Object.entries(report.rejectedReasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }
  if (report.unexpected.length) console.log("\n  ⚠️ unexpected results:", JSON.stringify(report.unexpected));
  console.log(`\nreport: ${OPTIONS.out} · explorer: ${API}/#address/${P.token}`);
}

// ============================================================================
//  main
// ============================================================================
async function startServer() {
  const port = await new Promise((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const env = { ...process.env, DEV: process.env.DEV ?? "1", PORT: String(port), RATE_LIMIT: "0", BLOCK_MS: process.env.BLOCK_MS ?? "1000", ...(OPTIONS.data ? { DATA: OPTIONS.data } : {}) };
  const child = spawn(process.execPath, ["server.js"], { cwd: new URL("..", import.meta.url).pathname, env, stdio: ["ignore", "ignore", "inherit"] });
  API = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) { if (await fetch(`${API}/genesis`).then(() => true, () => false)) break; await wait(100); }
  return child;
}

const child = OPTIONS.spawn ? await startServer() : null;
try {
  const info = await get("/genesis");
  CHAIN_ID = info.chainId;
  lastSeen = info.latest ?? 0;
  report.firstBlock = lastSeen + 1;
  console.log(`server ${API} · chain ${CHAIN_ID} · block ${lastSeen} · funder ${funder.address}`);
  planSetup();
  await runAll();
  await verify();
  fs.writeFileSync(OPTIONS.out, JSON.stringify(report, (key, value) => (key === "tracked" ? undefined : value), 2));
  summary();
} finally {
  if (child) child.kill();
}
