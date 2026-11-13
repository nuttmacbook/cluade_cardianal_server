/**
 * Simulates 200 real user wallets against a running server — sends txs block by block, paced by when the server closes blocks
 *
 *   # start the server (the per-IP rate limit must be off because everything is sent from one machine)
 *   RATE_LIMIT=0 GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run dev   # prices / gas budgets in this script are based on 1 gwei + DEFAULT_GAS (genesis-nofork.json = genesis.json with forks removed · see HANDOFF.md item 10)
 *   # in another terminal
 *   node dev/simulate-users.js                     # http://localhost:3000
 *   GAS_PRICE=1000000000 GENESIS=genesis-nofork.json node dev/simulate-users.js --spawn   # starts the server itself, then simulates (MemoryDB · env is passed to the server)
 *
 * Phase 1  distribute coins: the funding wallet (genesis) → 10 distributor wallets → the other 190 wallets  (~10 blocks, ~20 tx/block)
 * Phase 2  real usage: deploy tokens / markets / polls, then use them — transfer, approve, list for sale, buy, deposit / withdraw, vote, naming
 *          15–25 tx/block picked at random from 200 wallets (at most 1 tx/block per wallet, like real people)
 *
 * Options
 *   --url <url>          server (default http://localhost:3000)
 *   --wallets <n>        number of wallets (200)
 *   --blocks <n>         number of blocks in phase 2 (100 ≈ 5 minutes)
 *   --min <n> --max <n>  txs per block in phase 2 (15–25) · at most 100
 *   --seed <text>        changes the wallet set / randomness (same value = same wallets every time)
 *   --funder-key <hex>   wallet funded in genesis (default: Hardhat test key #1, per genesis.json)
 *   --admin-key <hex>    wallet allowed to init programs (default = funder · must be in ADMINS if the server sets it)
 *   --spawn              start server.js itself (random PORT, RATE_LIMIT=0, BLOCK_MS=1000) · add --data <dir> to use LMDB
 *   --out <file>         where to save the JSON report (default simulate-report.json)
 *
 * ⚠️ this script signs txs with local private keys because it is a test — keys are derived from --seed · never use them with real funds
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

const UNIT = 10n ** 6n;   // token has 6 decimals: 1 coin = 1,000,000 units

// ============================================================================
//  Options
// ============================================================================

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);

const OPTIONS = {
  url: option("url", "http://localhost:3000"),
  wallets: Number(option("wallets", 200)),
  blocks: Number(option("blocks", 100)),
  min: Number(option("min", 15)),
  max: Number(option("max", 25)),
  seed: option("seed", "cardianal"),
  funderKey: option("funder-key", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
  adminKey: option("admin-key", null),
  spawn: flag("spawn"),
  data: option("data", null),
  out: option("out", "simulate-report.json"),
};
OPTIONS.adminKey ??= OPTIONS.funderKey;
if (OPTIONS.max > 100 || OPTIONS.min > OPTIONS.max) throw new Error("must be --min ≤ --max ≤ 100");
if (OPTIONS.wallets < 20) throw new Error("--wallets must be at least 20");

// ============================================================================
//  Simulation values
// ============================================================================

const SEEDERS = 10;               // wallets that help distribute coins in phase 1
const WALLET_FUND = 100_000;      // native coins each wallet receives · one call costs ~800–1,900 gas (counted per node) → plenty for 100 blocks
const SEEDER_EXTRA = 150_000;     // extra for deploy costs for distributor wallets (this group deploys the programs in phase 2)
// native has 18 decimals (wei) and the gas price is 1 gwei → amounts in this script are counted in gwei, so the numbers equal the gas they can buy
const GWEI = 10n ** 9n;
const gwei = (amount) => `${BigInt(amount) * GWEI}`;   // amount sent in a tx (string because it can exceed 2^53)
// EIP-1559: pay at most 10 gwei per gas · no tip (pay only the base fee) · the VM lowers gasLimit to fit the balance itself
const GAS = { gasLimit: 1_000_000, maxFeePerGas: gwei(10), maxPriorityFeePerGas: "0" };
const TREASURY = "0x9999999999999999999999999999999999999999";

/** Programs to deploy in phase 2: [kind, deploy block (counted from the start of phase 2)] */
const DEPLOY_PLAN = [
  ["token", 0], ["token", 1], ["market", 4], ["poll", 5], ["token", 8],
  ["market", 10], ["poll", 14], ["token", 20], ["market", 30], ["poll", 40],
];

const PROGRAMS = {
  token: TOKEN_PROGRAM,   // standard token (src/standards/token.js) · 6 decimals

  market: `function program() {
  function initialization(params) {
    writeDB("token", params.input.token)
    writeDB("treasury", params.input.treasury)
    writeDB("feeBps", params.input.feeBps)
    writeDB("nextId", 1n)
    setMetadata("namespace", params.input.name)
  }
  function list(params) {
    if (params.input.price <= 0n) throw new Error("price must be greater than 0")
    const id = readDB("nextId")
    writeDB("nextId", id + 1n)
    writeDB(map("items", id, "seller"), params.context.sender)
    writeDB(map("items", id, "price"), params.input.price)
    writeDB(map("items", id, "name"), params.input.name)
    emit("Listed", { id: id, seller: params.context.sender, price: params.input.price })
    return id
  }
  function buy(params) {
    const id = params.input.id
    const price = readDB(map("items", id, "price"))
    if (!price) throw new Error("listing not found")
    if (readDB(map("items", id, "buyer"))) throw new Error("already sold")
    const seller = readDB(map("items", id, "seller"))
    if (seller === params.context.sender) throw new Error("cannot buy your own item")
    const fee = (price * readDB("feeBps")) / 10000n
    runProgram(readDB("token"), "transferFrom", { from: params.context.sender, to: seller, amount: price - fee })
    runProgram(readDB("token"), "transferFrom", { from: params.context.sender, to: readDB("treasury"), amount: fee })
    writeDB(map("items", id, "buyer"), params.context.sender)
    writeDB("volume", (readDB("volume") || 0n) + price)
    emit("Sold", { id: id, buyer: params.context.sender, seller: seller, price: price, fee: fee })
    return { id: id, paid: price, fee: fee }
  }
  function deposit(params) {
    if (params.value <= 0n) throw new Error("must attach funds")
    const total = (readDB(map("deposits", params.context.sender)) || 0n) + params.value
    writeDB(map("deposits", params.context.sender), total)
    emit("Deposited", { who: params.context.sender, amount: params.value })
    return total
  }
  function withdraw(params) {
    const balance = readDB(map("deposits", params.context.sender)) || 0n
    if (balance <= 0n) throw new Error("no deposit")
    writeDB(map("deposits", params.context.sender), 0n)
    transferNative(params.context.sender, balance)
    emit("Withdrawn", { who: params.context.sender, amount: balance })
    return balance
  }
  function stats() { return { volume: readDB("volume") || 0n, listings: readDB("nextId") - 1n, balance: ThisBalance() } }
  return { list, buy, deposit, withdraw, stats }
}`,

  poll: `function program() {
  function initialization(params) {
    writeDB("question", params.input.question)
    writeDB("options", params.input.options)
    setMetadata("namespace", params.input.name)
  }
  function vote(params) {
    if (params.input.option < 0n || params.input.option >= params.input.count) throw new Error("no such option")
    if (readDB(map("voted", params.context.sender))) throw new Error("already voted")
    writeDB(map("voted", params.context.sender), params.input.option + 1n)
    writeDB(map("tally", params.input.option), (readDB(map("tally", params.input.option)) || 0n) + 1n)
    emit("Voted", { who: params.context.sender, option: params.input.option })
    return true
  }
  function result() { return { question: readDB("question"), options: readDB("options") } }
  return { vote, result }
}`,
};

// ============================================================================
//  Helpers
// ============================================================================

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

/** Random generator tied to --seed → re-runs give the same sequence */
let rngState = parseInt(keyOf(`rng:${OPTIONS.seed}`).slice(2, 10), 16);
const random = () => {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const pick = (list) => list[Math.floor(random() * list.length)];
const shuffle = (list) => {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

const makeWallet = (key, name) => ({ key, name, address: sign.addressOf(key) });
const funder = makeWallet(OPTIONS.funderKey, "funder");
const admin = makeWallet(OPTIONS.adminKey, "admin");
const wallets = Array.from({ length: OPTIONS.wallets }, (_, i) => makeWallet(keyOf(`wallet:${OPTIONS.seed}:${i}`), `w${String(i).padStart(3, "0")}`));
const seeders = wallets.slice(0, SEEDERS);

let API = OPTIONS.url.replace(/\/$/, "");
const get = (path) => fetch(API + path).then((r) => r.json());
const post = async (path, body) => {
  const response = await fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 429) throw new Error("server returned 429 (per-IP rate limit) — start the server with RATE_LIMIT=0 or use --spawn");
  return response.json();
};
const amountOf = (value) => (typeof value === "string" && value.endsWith("n") ? BigInt(value.slice(0, -1)) : BigInt(value ?? 0));

// ============================================================================
//  Result log
// ============================================================================

const report = {
  options: { ...OPTIONS, funderKey: undefined, adminKey: undefined },
  startedAt: new Date().toISOString(),
  phases: {},
  sent: 0, queued: 0, rejected: 0,
  rejectedReasons: {},
  byAction: {},
  perBlock: [],          // [{ slot, phase, sent, queued }]
  tracked: [],           // [{ hash, label }] → checked at the end that all landed in a block
  programs: [],
};

/** Sends one tx: fetch the latest nonce (including txs waiting in the queue) → sign → POST /sendtx */
async function send(wallet, fields, label) {
  const { nonce } = await get(`/nonce/${wallet.address}`);
  const tx = { chainId: CHAIN_ID, from: wallet.address, to: "", method: "", input: {}, value: 0, nonce, ...GAS, ...fields };
  const result = await post("/sendtx", { tx, signature: sign.signTransaction(tx, wallet.key) });

  report.sent += 1;
  const action = label.split(" ").slice(0, 2).join(" ");   // "call token.transfer", "fund wallet", ...
  report.byAction[action] ??= { sent: 0, queued: 0 };
  report.byAction[action].sent += 1;
  if (result.queued) {
    report.queued += 1;
    report.byAction[action].queued += 1;
    report.tracked.push({ hash: result.hash, label });
    return result.hash;
  }
  report.rejected += 1;
  const reason = String(result.simulation?.error ?? result.error ?? result.reason ?? "unknown reason").replace(/0x[0-9a-f]{40}/gi, "0x…").slice(0, 80);
  report.rejectedReasons[reason] = (report.rejectedReasons[reason] ?? 0) + 1;
  return null;
}

// ============================================================================
//  Block pacing
// ============================================================================

let CHAIN_ID = 1;
let lastSeen = 0;

/** Waits until the server closes the next block → returns the latest block number */
async function nextBlock() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { latest } = await get("/genesis");
    if ((latest ?? 0) > lastSeen) return (lastSeen = latest ?? 0);
    await wait(150);
  }
  throw new Error("no new block in 60 seconds — is the server closing blocks? (blocks only close when txs are queued)");
}

/** Sends this slot's txs, then waits for the next block */
async function slot(phase, index, jobs) {
  const before = report.queued;
  const started = Date.now();
  for (const job of jobs) await job();
  report.perBlock.push({ phase, slot: index, sent: jobs.length, queued: report.queued - before, ms: Date.now() - started });
  console.log(`${phase} block ${String(index + 1).padStart(3)}  sent ${String(jobs.length).padStart(3)}  queued ${String(report.queued - before).padStart(3)}  (chain block ${lastSeen})`);
  if (jobs.length) await nextBlock();
}

// ============================================================================
//  Phase 1: distribute coins
// ============================================================================

async function phase1() {
  const started = Date.now();
  const firstBlock = lastSeen + 1;
  const perSeeder = Math.ceil((wallets.length - SEEDERS) / SEEDERS);

  // block 1: funding wallet → 10 distributor wallets (enough to distribute further + deploy costs)
  const seederFund = perSeeder * (WALLET_FUND + 1_000) + WALLET_FUND + SEEDER_EXTRA;
  await slot("phase 1", 0, seeders.map((s) => () => send(funder, { action: "transfer", to: s.address, value: gwei(seederFund) }, `fund seeder funder→${s.name}`)));

  // blocks 2–10: distributors transfer on to the rest, ~2 txs each per block (≈ 20 tx/block)
  const queue = wallets.slice(SEEDERS).map((to, i) => ({ from: seeders[i % SEEDERS], to }));
  const rounds = 9;
  const perRound = Math.ceil(queue.length / rounds);
  for (let round = 0; round < rounds && queue.length; round += 1) {
    const batch = queue.splice(0, perRound);
    await slot("phase 1", round + 1, batch.map(({ from, to }) => () => send(from, { action: "transfer", to: to.address, value: gwei(WALLET_FUND) }, `fund wallet ${from.name}→${to.name}`)));
  }
  report.phases.phase1 = { blocks: [firstBlock, lastSeen], seconds: (Date.now() - started) / 1000 };
}

// ============================================================================
//  Phase 2: real usage
// ============================================================================

const state = {
  pendingDeploys: [],   // { hash, kind, owner, input }
  pendingInits: [],     // { hash, program }
  programs: [],         // { kind, address, owner, name, token? }
  tokens: new Map(),    // token address → Map(wallet address → approximate balance)
  allowances: new Set(),// `${owner}:${market}`
  listings: [],         // { market, id, seller, price, sold }
  pendingListings: [],  // { hash, market, seller, price }
  deposits: new Map(),  // `${who}:${market}` → true
  voted: new Set(),     // `${who}:${poll}`
  named: new Set(),
};
let programCount = 0;

/** Tracks deploy / init / list txs already sent → updates state when they land in a block */
async function settle(adminJobs) {
  for (const item of [...state.pendingDeploys]) {
    const found = await get(`/tx/${item.hash}`);
    if (!found?.blockNumber) continue;
    state.pendingDeploys.splice(state.pendingDeploys.indexOf(item), 1);
    const receipt = await get(`/tx/${item.hash}/receipt`);
    if (receipt.status !== "success") continue;
    const program = { ...item, address: receipt.result.programUuid };
    adminJobs.push(async () => {
      const hash = await send(admin, { action: "init", to: program.address }, `init ${program.kind} ${program.name}`);
      if (hash) state.pendingInits.push({ hash, program });
    });
  }
  for (const item of [...state.pendingInits]) {
    const found = await get(`/tx/${item.hash}`);
    if (!found?.blockNumber) continue;
    state.pendingInits.splice(state.pendingInits.indexOf(item), 1);
    if (found.status !== "success") continue;
    const { program } = item;
    state.programs.push(program);
    report.programs.push({ kind: program.kind, name: program.name, address: program.address, owner: program.owner.name, block: found.blockNumber });
    if (program.kind === "token") state.tokens.set(program.address, new Map([[program.owner.address, amountOf(program.input.supply)]]));
  }
  for (const item of [...state.pendingListings]) {
    const found = await get(`/tx/${item.hash}`);
    if (!found?.blockNumber) continue;
    state.pendingListings.splice(state.pendingListings.indexOf(item), 1);
    if (found.status !== "success") continue;
    const receipt = await get(`/tx/${item.hash}/receipt`);
    state.listings.push({ ...item, id: amountOf(receipt.result), sold: false });
  }
}

const tokenBalance = (token, who) => state.tokens.get(token)?.get(who) ?? 0n;
const addToken = (token, who, delta) => state.tokens.get(token)?.set(who, tokenBalance(token, who) + delta);
const programsOf = (kind) => state.programs.filter((p) => p.kind === kind);
const other = (wallet) => { let to; do { to = pick(wallets); } while (to === wallet); return to; };

/** Token transfers: the token owner hands out 500–5,000 at a time · others pass on at most 1,000 */
function tokenTransferJob(wallet, token) {
  return () => {
    const balance = tokenBalance(token.address, wallet.address);
    const to = other(wallet);
    const wanted = token.owner === wallet ? BigInt(randomInt(500, 5_000)) * UNIT : BigInt(randomInt(1, 1_000)) * UNIT / 10n;
    const amount = wanted < balance ? wanted : balance;
    addToken(token.address, wallet.address, -amount);
    addToken(token.address, to.address, amount);
    return send(wallet, { action: "call", to: token.address, method: "transfer", input: { to: to.address, amount: `${amount}n` } }, "call token.transfer");
  };
}

/** Builds one tx for this wallet based on the current situation (weighted choice, like human behavior) */
function actionFor(wallet) {
  const options = [];
  const add = (weight, job) => { if (weight > 0) options.push([weight, job]); };

  // transfer the native coin to a friend
  add(6, () => send(wallet, { action: "transfer", to: other(wallet).address, value: gwei(randomInt(10, 500)) }, "transfer native"));

  // name your own wallet (once)
  if (!state.named.has(wallet.address)) add(2, () => {
    state.named.add(wallet.address);
    return send(wallet, { action: "metadata", input: { namespace: `${OPTIONS.seed}-${wallet.name}`, description: `simulated user ${wallet.name}` } }, "metadata");
  });

  for (const token of programsOf("token")) {
    if (tokenBalance(token.address, wallet.address) > 0n) add(token.owner === wallet ? 12 : 5, tokenTransferJob(wallet, token));
  }

  for (const market of programsOf("market")) {
    const balance = tokenBalance(market.token, wallet.address);
    const approved = state.allowances.has(`${wallet.address}:${market.address}`);

    if (balance > 0n && !approved) add(4, () => {
      state.allowances.add(`${wallet.address}:${market.address}`);
      return send(wallet, { action: "call", to: market.token, method: "approve", input: { spender: market.address, amount: `${1_000_000_000n * UNIT}n` } }, "call token.approve");
    });
    add(2, async () => {
      const price = BigInt(randomInt(50, 2_000)) * UNIT;
      const hash = await send(wallet, { action: "call", to: market.address, method: "list", input: { price: `${price}n`, name: pick(["chair", "lamp", "book", "shoes", "bag", "watch"]) } }, "call market.list");
      if (hash) state.pendingListings.push({ hash, market: market.address, seller: wallet.address, price });
    });
    const buyable = state.listings.filter((l) => l.market === market.address && !l.sold && l.seller !== wallet.address && l.price <= balance);
    if (approved && buyable.length) add(6, () => {
      const listing = pick(buyable);
      listing.sold = true;
      addToken(market.token, wallet.address, -listing.price);
      addToken(market.token, listing.seller, listing.price);
      return send(wallet, { action: "call", to: market.address, method: "buy", input: { id: `${listing.id}n` } }, "call market.buy");
    });
    const depositKey = `${wallet.address}:${market.address}`;
    add(1, () => {
      state.deposits.set(depositKey, true);
      return send(wallet, { action: "call", to: market.address, method: "deposit", input: {}, value: gwei(randomInt(100, 1_000)) }, "call market.deposit");
    });
    if (state.deposits.get(depositKey)) add(2, () => {
      state.deposits.delete(depositKey);
      return send(wallet, { action: "call", to: market.address, method: "withdraw", input: {} }, "call market.withdraw");
    });
  }

  for (const poll of programsOf("poll")) {
    if (!state.voted.has(`${wallet.address}:${poll.address}`)) add(3, () => {
      state.voted.add(`${wallet.address}:${poll.address}`);
      return send(wallet, { action: "call", to: poll.address, method: "vote", input: { option: `${randomInt(0, 2)}n`, count: "3n" } }, "call poll.vote");
    });
  }

  // a few human-like mistakes (rejected at /sendtx, never land in a block)
  add(0.3, () => send(wallet, { action: "transfer", to: other(wallet).address, value: gwei(10n ** 18n) }, "mistake overspend"));

  const total = options.reduce((sum, [weight]) => sum + weight, 0);
  let roll = random() * total;
  for (const [weight, job] of options) if ((roll -= weight) <= 0) return job;
  return options[0][1];
}

function deployJob(kind, owner, slotIndex) {
  programCount += 1;
  const name = `${OPTIONS.seed}-${kind}-${programCount}`;
  const tokens = programsOf("token");
  const input = kind === "token" ? { name: `Token ${programCount}`, ticker: `TK${programCount}`, decimals: "6n", supply: `${1_000_000n * UNIT}n`, namespace: name }
    : kind === "market" ? { name, token: tokens.length ? pick(tokens).address : null, treasury: TREASURY, feeBps: "250n" }
    : { name, question: `Question ${programCount}`, options: ["yes", "no", "not sure"] };
  if (kind === "market" && !input.token) return null;     // no token for the market yet → postpone
  return async () => {
    const hash = await send(owner, { action: "deploy", code: PROGRAMS[kind], input }, `deploy ${kind}`);
    if (hash) state.pendingDeploys.push({ hash, kind, owner, name, input, token: input.token, slot: slotIndex });
  };
}

async function phase2() {
  const started = Date.now();
  const firstBlock = lastSeen + 1;
  const plan = DEPLOY_PLAN.map(([kind, at], i) => ({ kind, at, owner: seeders[i % SEEDERS] }));

  for (let index = 0; index < OPTIONS.blocks; index += 1) {
    const adminJobs = [];
    await settle(adminJobs);

    const target = randomInt(OPTIONS.min, OPTIONS.max);
    const busy = new Set();
    const jobs = [...adminJobs];

    for (const item of plan.filter((p) => p.at <= index && !p.done)) {
      const job = deployJob(item.kind, item.owner, index);
      if (!job) { programCount -= 1; continue; }
      item.done = true;
      busy.add(item.owner);
      jobs.push(job);
    }
    // token owners hand out tokens often (like an airdrop) so people hold some to use with markets
    for (const token of programsOf("token")) {
      if (jobs.length >= target || busy.has(token.owner) || random() > 0.6) continue;
      busy.add(token.owner);
      jobs.push(tokenTransferJob(token.owner, token));
    }
    for (const wallet of shuffle(wallets)) {
      if (jobs.length >= target) break;
      if (busy.has(wallet)) continue;
      busy.add(wallet);
      jobs.push(actionFor(wallet));
    }
    await slot("phase 2", index, jobs);
  }
  report.phases.phase2 = { blocks: [firstBlock, lastSeen], seconds: (Date.now() - started) / 1000 };
}

// ============================================================================
//  Check results and summarize
// ============================================================================

async function verify() {
  console.log("\n\nwaiting for the last txs to land in a block, then checking every one…");
  await wait(7_000);
  const missing = [];
  const failed = {};
  for (const { hash, label } of report.tracked) {
    const found = await get(`/tx/${hash}`);
    if (!found?.blockNumber) { missing.push({ hash, label }); continue; }
    if (found.status !== "success") failed[label] = (failed[label] ?? 0) + 1;
  }
  report.missing = missing;
  report.failedInBlock = failed;

  const headers = [];
  const [from, to] = [report.phases.phase1?.blocks?.[0] ?? 1, (await get("/block/latest")).number];
  for (let n = from; n <= to; n += 1) headers.push(await get(`/block/${n}`));
  const counts = headers.map((h) => h.txCount);
  const gaps = headers.slice(1).map((h, i) => h.timestamp - headers[i].timestamp);
  report.blocks = {
    range: [from, to],
    txPerBlock: { min: Math.min(...counts), max: Math.max(...counts), avg: +(counts.reduce((a, b) => a + b, 0) / counts.length).toFixed(1) },
    secondsBetweenBlocks: gaps.length ? { min: Math.min(...gaps) / 1000, max: Math.max(...gaps) / 1000, avg: +(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000).toFixed(2) } : null,
    gasUsed: headers.reduce((sum, h) => sum + (h.gasUsed ?? 0), 0),
  };
  report.finishedAt = new Date().toISOString();
}

function summary() {
  const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);
  console.log("\n================ summary ================");
  line("phase 1 (distribute coins)", `block ${report.phases.phase1.blocks.join("–")} · ${report.phases.phase1.seconds.toFixed(0)} seconds`);
  line("phase 2 (real usage)", `block ${report.phases.phase2.blocks.join("–")} · ${report.phases.phase2.seconds.toFixed(0)} seconds`);
  line("txs sent", report.sent);
  line("queued", report.queued);
  line("rejected at /sendtx", report.rejected);
  line("queued but not in a block", report.missing.length);
  line("in a block but program threw", Object.values(report.failedInBlock).reduce((a, b) => a + b, 0));
  line("txs per block (min/avg/max)", `${report.blocks.txPerBlock.min} / ${report.blocks.txPerBlock.avg} / ${report.blocks.txPerBlock.max}`);
  if (report.blocks.secondsBetweenBlocks) line("seconds between blocks", `${report.blocks.secondsBetweenBlocks.min} / ${report.blocks.secondsBetweenBlocks.avg} / ${report.blocks.secondsBetweenBlocks.max}`);
  line("usable programs", report.programs.map((p) => `${p.kind}`).join(", ") || "—");

  console.log("\n  by type (sent → queued)");
  for (const [action, { sent, queued }] of Object.entries(report.byAction).sort()) console.log(`    ${action.padEnd(24)} ${sent} → ${queued}`);
  if (report.rejected) {
    console.log("\n  rejection reasons");
    for (const [reason, count] of Object.entries(report.rejectedReasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }
  if (report.missing.length) console.log(`\n  ⚠️ ${report.missing.length} txs were queued but never landed in a block — see "missing" in the report`);
  console.log(`\nfull report: ${OPTIONS.out}`);
  console.log(`explorer: ${API}`);
}

// ============================================================================
//  Start
// ============================================================================

let child = null;

async function startServer() {
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  API = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, DEV: process.env.DEV ?? "1", PORT: String(port), RATE_LIMIT: "0", BLOCK_MS: "1000", ...(OPTIONS.data ? { DATA: OPTIONS.data } : {}) },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i += 1) {
    if (await fetch(`${API}/genesis`).then(() => true, () => false)) return;
    await wait(100);
  }
  throw new Error("failed to start the server");
}

try {
  if (OPTIONS.spawn) await startServer();
  const info = await get("/genesis");
  CHAIN_ID = info.chainId;
  lastSeen = info.latest ?? 0;
  const { balance } = (await get(`/address/${funder.address}`)).native;
  const needed = SEEDERS * (Math.ceil((wallets.length - SEEDERS) / SEEDERS) * (WALLET_FUND + 1_000) + WALLET_FUND + SEEDER_EXTRA);
  console.log(`server ${API} · chain ${CHAIN_ID} · latest block ${lastSeen}`);
  console.log(`funding wallet ${funder.address} balance ${balance} (needs about ${needed})`);
  if (amountOf(balance) < BigInt(needed) * GWEI) throw new Error("the funding wallet doesn't have enough (used up by a previous run?) — start a fresh chain (delete the DATA folder or restart a server without DATA) or use a --funder-key with enough balance");
  fs.writeFileSync(OPTIONS.out.replace(/\.json$/, "") + "-wallets.json", JSON.stringify(wallets.map(({ name, address, key }) => ({ name, address, key })), null, 2));

  await phase1();
  await phase2();
  await verify();
  fs.writeFileSync(OPTIONS.out, JSON.stringify(report, null, 2));
  summary();
  if (OPTIONS.spawn) console.log("\nthe server started with --spawn will shut down at the end (use --data <dir> to keep the data for viewing later)");
} catch (error) {
  console.error(`\n\nstopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  child?.kill();
}
