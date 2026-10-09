/**
 * จำลองผู้ใช้จริง 200 กระเป๋าบน server ที่รันอยู่ — ส่ง tx ทีละ block ตามจังหวะที่ server ปิด block
 *
 *   # เปิด server (ต้องปิด rate limit ต่อ IP เพราะยิงจากเครื่องเดียว)
 *   RATE_LIMIT=0 BLOCK_MS=3000 npm start
 *   # อีก terminal
 *   node scripts/simulate-users.js                     # http://localhost:3000
 *   node scripts/simulate-users.js --spawn             # เปิด server ให้เองแล้วจำลอง (MemoryDB)
 *
 * เฟส 1  กระจายเหรียญ: กระเป๋าตั้งต้น (genesis) → 10 กระเป๋าแจก → อีก 190 กระเป๋า  (~10 block, ~20 tx/block)
 * เฟส 2  ใช้งานจริง: deploy โทเคน / ตลาด / โพลล์ แล้วใช้งาน — โอน, approve, ประกาศขาย, ซื้อ, ฝาก-ถอน, โหวต, ตั้งชื่อ
 *        15–25 tx/block สุ่มจาก 200 กระเป๋า (กระเป๋าละไม่เกิน 1 tx/block เหมือนคนจริง)
 *
 * ตัวเลือก
 *   --url <url>          server (ค่าเริ่ม http://localhost:3000)
 *   --wallets <n>        จำนวนกระเป๋า (200)
 *   --blocks <n>         จำนวน block ของเฟส 2 (100 ≈ 5 นาที)
 *   --min <n> --max <n>  tx ต่อ block ในเฟส 2 (15–25) · ไม่เกิน 100
 *   --seed <text>        เปลี่ยนชุดกระเป๋า/การสุ่ม (ค่าเดิม = ได้กระเป๋าชุดเดิมทุกครั้ง)
 *   --funder-key <hex>   กระเป๋าที่มีเงินใน genesis (ค่าเริ่ม: key ทดสอบ Hardhat #1 ตาม genesis.json)
 *   --admin-key <hex>    กระเป๋าที่มีสิทธิ์ init โปรแกรม (ค่าเริ่ม = funder · ต้องอยู่ใน ADMINS ถ้า server ตั้งไว้)
 *   --spawn              เปิด server.js ให้เอง (PORT สุ่ม, RATE_LIMIT=0, BLOCK_MS=3000) · ใส่ --data <dir> ถ้าจะใช้ LMDB
 *   --out <file>         ที่เก็บรายงาน JSON (ค่าเริ่ม simulate-report.json)
 *
 * ⚠️ สคริปต์นี้เซ็น tx ด้วย private key ในเครื่องเพราะเป็นการทดสอบ — key ถูกสร้างจาก --seed ห้ามใช้กับเงินจริง
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

const UNIT = 10n ** 6n;   // token 6 decimals: 1 เหรียญ = 1,000,000 หน่วย

// ============================================================================
//  ตัวเลือก
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
if (OPTIONS.max > 100 || OPTIONS.min > OPTIONS.max) throw new Error("ต้องเป็น --min ≤ --max ≤ 100");
if (OPTIONS.wallets < 20) throw new Error("--wallets ต้องมีอย่างน้อย 20");

// ============================================================================
//  ค่าที่ใช้จำลอง
// ============================================================================

const SEEDERS = 10;               // กระเป๋าที่ช่วยแจกเหรียญในเฟส 1
const WALLET_FUND = 30_000;       // เหรียญหลักที่แต่ละกระเป๋าได้
const SEEDER_EXTRA = 150_000;     // เผื่อค่า deploy ให้กระเป๋าแจก (คนกลุ่มนี้เป็นคน deploy โปรแกรมในเฟส 2)
const GAS = { gasLimit: 1_000_000, gasPrice: 1 };   // VM ลด gasLimit ให้ไม่เกินยอดเงินเอง
const TREASURY = "0x9999999999999999999999999999999999999999";

/** โปรแกรมที่จะถูก deploy ในเฟส 2: [ชนิด, block ที่ deploy (นับจากต้นเฟส 2)] */
const DEPLOY_PLAN = [
  ["token", 0], ["token", 1], ["market", 4], ["poll", 5], ["token", 8],
  ["market", 10], ["poll", 14], ["token", 20], ["market", 30], ["poll", 40],
];

const PROGRAMS = {
  token: TOKEN_PROGRAM,   // มาตรฐาน token (src/standards/token.js) · 6 decimals

  market: `function program() {
  function initialization(params) {
    writeDB("token", params.input.token)
    writeDB("treasury", params.input.treasury)
    writeDB("feeBps", params.input.feeBps)
    writeDB("nextId", 1n)
    setMetadata("namespace", params.input.name)
  }
  function list(params) {
    if (params.input.price <= 0n) throw new Error("ราคาต้องมากกว่า 0")
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
    if (!price) throw new Error("ไม่พบประกาศนี้")
    if (readDB(map("items", id, "buyer"))) throw new Error("ขายไปแล้ว")
    const seller = readDB(map("items", id, "seller"))
    if (seller === params.context.sender) throw new Error("ซื้อของตัวเองไม่ได้")
    const fee = (price * readDB("feeBps")) / 10000n
    runProgram(readDB("token"), "transferFrom", { from: params.context.sender, to: seller, amount: price - fee })
    runProgram(readDB("token"), "transferFrom", { from: params.context.sender, to: readDB("treasury"), amount: fee })
    writeDB(map("items", id, "buyer"), params.context.sender)
    writeDB("volume", (readDB("volume") || 0n) + price)
    emit("Sold", { id: id, buyer: params.context.sender, seller: seller, price: price, fee: fee })
    return { id: id, paid: price, fee: fee }
  }
  function deposit(params) {
    if (params.value <= 0n) throw new Error("ต้องแนบเงินมาด้วย")
    const total = (readDB(map("deposits", params.context.sender)) || 0n) + params.value
    writeDB(map("deposits", params.context.sender), total)
    emit("Deposited", { who: params.context.sender, amount: params.value })
    return total
  }
  function withdraw(params) {
    const balance = readDB(map("deposits", params.context.sender)) || 0n
    if (balance <= 0n) throw new Error("ไม่มีเงินฝาก")
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
    if (params.input.option < 0n || params.input.option >= params.input.count) throw new Error("ไม่มีตัวเลือกนี้")
    if (readDB(map("voted", params.context.sender))) throw new Error("โหวตไปแล้ว")
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
//  ตัวช่วย
// ============================================================================

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

/** ตัวสุ่มที่ผูกกับ --seed → รันซ้ำได้ลำดับเดิม */
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
  if (response.status === 429) throw new Error("server ตอบ 429 (rate limit ต่อ IP) — เปิด server ด้วย RATE_LIMIT=0 หรือใช้ --spawn");
  return response.json();
};
const amountOf = (value) => (typeof value === "string" && value.endsWith("n") ? BigInt(value.slice(0, -1)) : BigInt(value ?? 0));

// ============================================================================
//  บันทึกผล
// ============================================================================

const report = {
  options: { ...OPTIONS, funderKey: undefined, adminKey: undefined },
  startedAt: new Date().toISOString(),
  phases: {},
  sent: 0, queued: 0, rejected: 0,
  rejectedReasons: {},
  byAction: {},
  perBlock: [],          // [{ slot, phase, sent, queued }]
  tracked: [],           // [{ hash, label }] → ตรวจตอนจบว่าเข้า block ครบไหม
  programs: [],
};

/** ส่ง tx หนึ่งใบ: ดึง nonce ล่าสุด (รวมใบที่รอในคิว) → เซ็น → POST /sendtx */
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
  const reason = String(result.simulation?.error ?? result.error ?? result.reason ?? "ไม่ทราบสาเหตุ").replace(/0x[0-9a-f]{40}/gi, "0x…").slice(0, 80);
  report.rejectedReasons[reason] = (report.rejectedReasons[reason] ?? 0) + 1;
  return null;
}

// ============================================================================
//  จังหวะ block
// ============================================================================

let CHAIN_ID = 1;
let lastSeen = 0;

/** รอจน server ปิด block ถัดไป → คืนเลข block ล่าสุด */
async function nextBlock() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { latest } = await get("/genesis");
    if ((latest ?? 0) > lastSeen) return (lastSeen = latest ?? 0);
    await wait(150);
  }
  throw new Error("ไม่มี block ใหม่ใน 60 วินาที — server ปิด block อยู่หรือเปล่า (block จะปิดเมื่อมี tx ในคิวเท่านั้น)");
}

/** ส่งชุด tx ของ slot นี้ แล้วรอ block ถัดไป */
async function slot(phase, index, jobs) {
  const before = report.queued;
  const started = Date.now();
  for (const job of jobs) await job();
  report.perBlock.push({ phase, slot: index, sent: jobs.length, queued: report.queued - before, ms: Date.now() - started });
  console.log(`${phase} block ${String(index + 1).padStart(3)}  ส่ง ${String(jobs.length).padStart(3)}  เข้าคิว ${String(report.queued - before).padStart(3)}  (chain block ${lastSeen})`);
  if (jobs.length) await nextBlock();
}

// ============================================================================
//  เฟส 1: กระจายเหรียญ
// ============================================================================

async function phase1() {
  const started = Date.now();
  const firstBlock = lastSeen + 1;
  const perSeeder = Math.ceil((wallets.length - SEEDERS) / SEEDERS);

  // block 1: กระเป๋าตั้งต้น → กระเป๋าแจก 10 ใบ (ได้เงินพอแจกต่อ + ค่า deploy)
  const seederFund = perSeeder * (WALLET_FUND + 1_000) + WALLET_FUND + SEEDER_EXTRA;
  await slot("เฟส 1", 0, seeders.map((s) => () => send(funder, { action: "transfer", to: s.address, value: seederFund }, `fund seeder funder→${s.name}`)));

  // block 2–10: กระเป๋าแจกโอนต่อให้คนที่เหลือ ~2 ใบต่อคนต่อ block (≈ 20 tx/block)
  const queue = wallets.slice(SEEDERS).map((to, i) => ({ from: seeders[i % SEEDERS], to }));
  const rounds = 9;
  const perRound = Math.ceil(queue.length / rounds);
  for (let round = 0; round < rounds && queue.length; round += 1) {
    const batch = queue.splice(0, perRound);
    await slot("เฟส 1", round + 1, batch.map(({ from, to }) => () => send(from, { action: "transfer", to: to.address, value: WALLET_FUND }, `fund wallet ${from.name}→${to.name}`)));
  }
  report.phases.phase1 = { blocks: [firstBlock, lastSeen], seconds: (Date.now() - started) / 1000 };
}

// ============================================================================
//  เฟส 2: ใช้งานจริง
// ============================================================================

const state = {
  pendingDeploys: [],   // { hash, kind, owner, input }
  pendingInits: [],     // { hash, program }
  programs: [],         // { kind, address, owner, name, token? }
  tokens: new Map(),    // token address → Map(wallet address → balance โดยประมาณ)
  allowances: new Set(),// `${owner}:${market}`
  listings: [],         // { market, id, seller, price, sold }
  pendingListings: [],  // { hash, market, seller, price }
  deposits: new Map(),  // `${who}:${market}` → true
  voted: new Set(),     // `${who}:${poll}`
  named: new Set(),
};
let programCount = 0;

/** ติดตาม deploy / init / list ที่ส่งไปแล้ว → อัปเดต state เมื่อเข้า block */
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

/** โอนโทเคน: เจ้าของโทเคนแจกทีละ 500–5,000 · คนอื่นโอนต่อไม่เกิน 1,000 */
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

/** สร้าง tx หนึ่งใบให้กระเป๋านี้ตามสถานการณ์ปัจจุบัน (เลือกแบบมีน้ำหนักเหมือนพฤติกรรมคน) */
function actionFor(wallet) {
  const options = [];
  const add = (weight, job) => { if (weight > 0) options.push([weight, job]); };

  // โอนเหรียญหลักให้เพื่อน
  add(6, () => send(wallet, { action: "transfer", to: other(wallet).address, value: randomInt(10, 500) }, "transfer native"));

  // ตั้งชื่อให้กระเป๋าตัวเอง (ครั้งเดียว)
  if (!state.named.has(wallet.address)) add(2, () => {
    state.named.add(wallet.address);
    return send(wallet, { action: "metadata", input: { namespace: `${OPTIONS.seed}-${wallet.name}`, description: `ผู้ใช้จำลอง ${wallet.name}` } }, "metadata");
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
      const hash = await send(wallet, { action: "call", to: market.address, method: "list", input: { price: `${price}n`, name: pick(["เก้าอี้", "โคมไฟ", "หนังสือ", "รองเท้า", "กระเป๋า", "นาฬิกา"]) } }, "call market.list");
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
      return send(wallet, { action: "call", to: market.address, method: "deposit", input: {}, value: randomInt(100, 1_000) }, "call market.deposit");
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

  // ความผิดพลาดแบบคนจริงเล็กน้อย (โดนปฏิเสธที่ /sendtx ไม่เข้า block)
  add(0.3, () => send(wallet, { action: "transfer", to: other(wallet).address, value: 10_000_000 }, "mistake overspend"));

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
    : { name, question: `คำถามที่ ${programCount}`, options: ["ใช่", "ไม่ใช่", "ไม่แน่ใจ"] };
  if (kind === "market" && !input.token) return null;     // ยังไม่มีโทเคนให้ตลาดใช้ → เลื่อนไปก่อน
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
    // เจ้าของโทเคนแจกโทเคนบ่อย ๆ (เหมือน airdrop) เพื่อให้มีคนถือไปใช้กับตลาด
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
    await slot("เฟส 2", index, jobs);
  }
  report.phases.phase2 = { blocks: [firstBlock, lastSeen], seconds: (Date.now() - started) / 1000 };
}

// ============================================================================
//  ตรวจผลและสรุป
// ============================================================================

async function verify() {
  console.log("\n\nรอ tx ชุดสุดท้ายเข้า block แล้วตรวจทุกใบ…");
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
  console.log("\n================ สรุป ================");
  line("เฟส 1 (กระจายเหรียญ)", `block ${report.phases.phase1.blocks.join("–")} · ${report.phases.phase1.seconds.toFixed(0)} วินาที`);
  line("เฟส 2 (ใช้งานจริง)", `block ${report.phases.phase2.blocks.join("–")} · ${report.phases.phase2.seconds.toFixed(0)} วินาที`);
  line("tx ที่ส่ง", report.sent);
  line("เข้าคิว", report.queued);
  line("ถูกปฏิเสธที่ /sendtx", report.rejected);
  line("เข้าคิวแต่ไม่เข้า block", report.missing.length);
  line("เข้า block แต่โปรแกรม throw", Object.values(report.failedInBlock).reduce((a, b) => a + b, 0));
  line("tx ต่อ block (min/avg/max)", `${report.blocks.txPerBlock.min} / ${report.blocks.txPerBlock.avg} / ${report.blocks.txPerBlock.max}`);
  if (report.blocks.secondsBetweenBlocks) line("วินาทีระหว่าง block", `${report.blocks.secondsBetweenBlocks.min} / ${report.blocks.secondsBetweenBlocks.avg} / ${report.blocks.secondsBetweenBlocks.max}`);
  line("โปรแกรมที่ใช้งานได้", report.programs.map((p) => `${p.kind}`).join(", ") || "—");

  console.log("\n  แยกตามประเภท (ส่ง → เข้าคิว)");
  for (const [action, { sent, queued }] of Object.entries(report.byAction).sort()) console.log(`    ${action.padEnd(24)} ${sent} → ${queued}`);
  if (report.rejected) {
    console.log("\n  สาเหตุที่ถูกปฏิเสธ");
    for (const [reason, count] of Object.entries(report.rejectedReasons).sort((a, b) => b[1] - a[1])) console.log(`    ${String(count).padStart(4)}  ${reason}`);
  }
  if (report.missing.length) console.log(`\n  ⚠️ ${report.missing.length} ใบเข้าคิวแล้วแต่ไม่เข้า block — ดู "missing" ในรายงาน`);
  console.log(`\nรายงานเต็ม: ${OPTIONS.out}`);
  console.log(`explorer: ${API}`);
}

// ============================================================================
//  เริ่ม
// ============================================================================

let child = null;

async function startServer() {
  const port = await new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
  API = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["server.js"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(port), RATE_LIMIT: "0", BLOCK_MS: "3000", ...(OPTIONS.data ? { DATA: OPTIONS.data } : {}) },
    stdio: "ignore",
  });
  for (let i = 0; i < 50; i += 1) {
    if (await fetch(`${API}/genesis`).then(() => true, () => false)) return;
    await wait(100);
  }
  throw new Error("เปิด server ไม่สำเร็จ");
}

try {
  if (OPTIONS.spawn) await startServer();
  const info = await get("/genesis");
  CHAIN_ID = info.chainId;
  lastSeen = info.latest ?? 0;
  const { balance } = (await get(`/address/${funder.address}`)).native;
  const needed = SEEDERS * (Math.ceil((wallets.length - SEEDERS) / SEEDERS) * (WALLET_FUND + 1_000) + WALLET_FUND + SEEDER_EXTRA);
  console.log(`server ${API} · chain ${CHAIN_ID} · block ล่าสุด ${lastSeen}`);
  console.log(`กระเป๋าตั้งต้น ${funder.address} ยอด ${balance} (ต้องใช้ประมาณ ${needed})`);
  if (balance < needed) throw new Error("กระเป๋าตั้งต้นมีเงินไม่พอ (รอบก่อนใช้ไปแล้ว?) — เริ่ม chain ใหม่ (ลบโฟลเดอร์ DATA หรือรีสตาร์ท server ที่ไม่มี DATA) หรือใช้ --funder-key ที่มียอดพอ");
  fs.writeFileSync(OPTIONS.out.replace(/\.json$/, "") + "-wallets.json", JSON.stringify(wallets.map(({ name, address, key }) => ({ name, address, key })), null, 2));

  await phase1();
  await phase2();
  await verify();
  fs.writeFileSync(OPTIONS.out, JSON.stringify(report, null, 2));
  summary();
  if (OPTIONS.spawn) console.log("\nserver ที่เปิดด้วย --spawn จะปิดตอนจบ (ใช้ --data <dir> ถ้าอยากเก็บข้อมูลไว้เปิดดูต่อ)");
} catch (error) {
  console.error(`\n\nหยุด: ${error.message}`);
  process.exitCode = 1;
} finally {
  child?.kill();
}
