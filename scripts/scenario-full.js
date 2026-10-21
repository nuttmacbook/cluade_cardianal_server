/**
 * scenario ครบทุกฟังก์ชันของเชน — ส่ง tx จริงเข้า server แล้วตรวจผลบนเชนทุกข้อ (ไม่ใช่แค่ "เข้าคิวแล้ว")
 * ผลที่ได้ดูได้ทั้งใน explorer ของเรา (REST) และใน Blockscout (ผ่าน /evm JSON-RPC)
 *
 *   RATE_LIMIT=0 npm start                     # server (ยิงจากเครื่องเดียว จึงต้องปิด rate limit ต่อ IP)
 *   npm run scenario:full                      # อีก terminal · http://localhost:3000
 *   npm run scenario:full -- --spawn           # เปิด server ให้เอง (MemoryDB · PORT สุ่ม · BLOCK_MS 1000 · UPGRADE_DELAY_BLOCKS 2)
 *   npm run scenario:full -- --spawn --quick   # block เร็วขึ้น (BLOCK_MS 300) สำหรับเทสต์
 *
 * หัวข้อที่ตรวจ (ทุกข้อพิมพ์ ✅ / ❌ · ล้มข้อเดียว = exit code 1)
 *    0 เตรียมกระเป๋า           genesis · แจกเหรียญ (tx แบบเดิม gasPrice และแบบ EIP-1559)
 *    1 deploy / init / reject  ทีมงานอนุมัติ / ปฏิเสธ (คืนเงิน) · namespace · metadata.abi · GET /program/:a/abi
 *    2 native + ค่าแก๊ส        โอน 0 · legacy / 1559 · burnedFee / producerFee · base fee ขึ้นเมื่อ block แน่น แล้วลง
 *    3 mempool                 replace-by-fee (+10%) · replaced · ราคาไม่พอ · tx ที่ถูกปฏิเสธถูกบันทึกใน block · /pending
 *    4 token (ERC-20)          transfer · approve / transferFrom · multiTransfer · permit (คนเซ็น + กระเป๋าโปรแกรมเซ็น)
 *    5 NFT (ERC-721)           mint · safeTransferFrom ไปคน / ไปกระเป๋าโปรแกรม · approve / operator · tokenURI
 *    6 multi-token (ERC-1155)  mint / mintBatch · single / batch transfer · operator · uri
 *    7 กระเป๋า ERC-1271         isValidSignature · execute
 *    8 multicall               aggregate / tryAggregate / readonly · tx ที่รวมหลาย call
 *    9 โปรแกรมเรียกโปรแกรม     runProgram ซ้อน · STATICCALL ห้ามเขียน (FORBIDDEN) · catch call ชั้นในที่ล้ม
 *   10 API ในโปรแกรม           BlockHash … Math.random เทียบกับค่าจริงของเชนทุกตัว
 *   11 อัปเกรดโปรแกรม          upgrade → reject → upgrade → approve (+ timelock) · migrate · versions · setUpgrader / สละสิทธิ์
 *   12 cloneProgram            โรงงานสร้างโปรแกรม (address ทำนายได้ก่อนแบบ CREATE2)
 *   13 แก๊ส / sandbox          ลูปไม่รู้จบ → OUT_OF_GAS · OUT_OF_MEMORY · ทั้งสองแบบ "ใน block" (เสียค่าแก๊ส status 0x0)
 *   14 event แบบ indexed       GET /program/:a/events?name=&field= · eth_getLogs ตาม topic
 *   15 /evm (Blockscout)       block / tx / receipt / log ERC-20 · ERC-721 · ERC-1155 / eth_call / fee history / tx ที่ล้ม
 *   16 REST ของ explorer       address · tokens · nfts · program · แบ่งหน้า · holders · versions
 *   17 sync                    node ผู้อ่าน (ในโปรเซสนี้ ตั้งค่าเหมือน server) replay ทุก block แล้วได้ head hash เดียวกัน
 *
 * ตัวเลือก
 *   --url <url>          server (http://localhost:3000)
 *   --spawn              เปิด server.js ให้เอง · --data <dir> ใช้ LMDB
 *   --quick              (กับ --spawn) BLOCK_MS 300
 *   --tag <text>         ชื่อรอบ ใช้เป็น seed ของกระเป๋าและ namespace (ค่าเริ่ม = สุ่ม → รันซ้ำบนเชนเดิมได้)
 *   --admin-key <key>    key ของทีมงาน (server ตั้ง ADMINS) · ไม่ใส่ = ใช้ funder
 *   --funder-key <key>   กระเป๋าที่มีเงินจาก genesis (Hardhat #1)
 *   --sync / --no-sync   ตรวจ sync ด้วย node ผู้อ่าน (ค่าเริ่ม: เปิดเมื่อ --spawn · ถ้าใช้กับ server ที่เปิดเอง env ต้องตรงกัน)
 *   --blockscout <url>   พิมพ์ลิงก์ Blockscout ท้ายรายงาน (http://localhost)
 *   --out <file>         รายงาน JSON (scenario-full-report.json)
 *
 * ⚠️ key ของกระเป๋าสร้างจาก --tag เพื่อทดสอบเท่านั้น ห้ามใช้กับเงินจริง
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import * as sign from "../src/crypto/signature.js";
import { signPermit, permitDigest, signWalletHash, signProgramMessage } from "../src/crypto/program-signature.js";
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";
import { syncOnce } from "../src/node/sync.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { NFT_PROGRAM } from "../src/standards/nft.js";
import { MULTITOKEN_PROGRAM } from "../src/standards/multitoken.js";
import { WALLET_PROGRAM, ERC1271_MAGIC_VALUE, ERC1271_INVALID_VALUE } from "../src/standards/wallet.js";
import { MULTICALL_PROGRAM } from "../src/standards/multicall.js";
import { COUNTER_V1, COUNTER_V2, LAB_PROGRAM, GAS_LAB_PROGRAM, NOTE_TEMPLATE, FACTORY_PROGRAM, REJECTABLE_PROGRAM } from "./scenario-full-programs.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };
const OPTIONS = {
  url: option("url", "http://localhost:3000"),
  spawn: args.includes("--spawn"),
  quick: args.includes("--quick"),
  data: option("data", null),
  tag: option("tag", `full-${Date.now().toString(36)}`),
  funderKey: option("funder-key", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"),
  adminKey: option("admin-key", null),
  blockscout: option("blockscout", "http://localhost").replace(/\/$/, ""),
  out: option("out", "scenario-full-report.json"),
};
OPTIONS.sync = args.includes("--no-sync") ? false : args.includes("--sync") || OPTIONS.spawn;

// ---------- หน่วย / ตัวช่วย ----------
const GWEI = 10n ** 9n;
const COIN = 10n ** 18n;
const gwei = (n) => `${BigInt(n) * GWEI}`;
const coins = (n) => `${BigInt(n) * COIN}`;
const UNIT = 10n ** 6n;   // FULL token 6 decimals
const units = (n) => `${BigInt(n) * UNIT}n`;
const big = (value) => (typeof value === "bigint" ? value : BigInt(String(value ?? 0).replace(/n$/, "")));
const hex = (value) => `0x${big(value).toString(16)}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keccakText = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;
const keyOf = (text) => keccakText(text);
const short = (address) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : String(address));
const lower = (value) => String(value ?? "").toLowerCase();
const ZERO = `0x${"0".repeat(40)}`;
const MINER_DEFAULT = "0x1111111111111111111111111111111111111111";

// ABI แบบ EVM (สำหรับ eth_call / log) — เขียนเองเพื่อไม่พึ่ง ethers
const selector = (signature) => keccakText(signature).slice(0, 10);
const word = (value) => big(value).toString(16).padStart(64, "0");
const addressWord = (address) => lower(address).replace(/^0x/, "").padStart(64, "0");
const callData = (signature, ...words) => `${selector(signature)}${words.join("")}`;
const decodeUint = (data) => BigInt(data);
const decodeAddress = (data) => `0x${String(data).slice(-40)}`;
const decodeString = (data) => {
  const body = String(data).replace(/^0x/, "");
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2;
  const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`)) * 2;
  return Buffer.from(body.slice(offset + 64, offset + 64 + length), "hex").toString("utf8");
};
const SIG = {
  transfer: keccakText("Transfer(address,address,uint256)"),
  approval: keccakText("Approval(address,address,uint256)"),
  transferSingle: keccakText("TransferSingle(address,address,address,uint256,uint256)"),
  transferBatch: keccakText("TransferBatch(address,address,address,uint256[],uint256[])"),
  approvalForAll: keccakText("ApprovalForAll(address,address,bool)"),
};

// ---------- กระเป๋า ----------
const makeWallet = (key, name) => ({ key, name, address: sign.addressOf(key) });
const funder = makeWallet(OPTIONS.funderKey, "funder");
const admin = OPTIONS.adminKey ? makeWallet(OPTIONS.adminKey, "admin") : funder;
const W = Object.fromEntries(["alice", "bob", "carol", "dave", "erin"].map((name) => [name, makeWallet(keyOf(`scenario-full:${OPTIONS.tag}:${name}`), name)]));
const { alice, bob, carol, dave, erin } = W;

// ---------- HTTP ----------
let API = OPTIONS.url.replace(/\/$/, "");
const get = async (p) => {
  const response = await fetch(API + p);
  const body = await response.json();
  return response.status >= 400 && body && typeof body === "object" ? { ...body, httpStatus: response.status } : body;
};
const post = async (p, body) => {
  const response = await fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (response.status === 429) throw new Error("server ตอบ 429 (rate limit ต่อ IP) — เปิด server ด้วย RATE_LIMIT=0 หรือใช้ --spawn");
  return response.json();
};
let rpcId = 0;
async function rpc(method, params = []) {
  const reply = await post("/evm", { jsonrpc: "2.0", id: ++rpcId, method, params });
  if (reply.error) throw new Error(`${method}: ${reply.error.message}`);
  return reply.result;
}
const query = (programUuid, functionName, input = {}, context) => post("/query", { programUuid, functionName, input, ...(context ? { context } : {}) });
const read = async (programUuid, functionName, input = {}) => {
  const result = await query(programUuid, functionName, input);
  if (result.status !== "success") throw new Error(`query ${functionName} ล้ม: ${result.error?.message ?? JSON.stringify(result)}`);
  return result.result;
};

// ---------- รายงาน ----------
const report = { options: { ...OPTIONS, funderKey: undefined, adminKey: undefined }, startedAt: new Date().toISOString(),
  wallets: Object.fromEntries(Object.entries(W).map(([n, w]) => [n, w.address])), programs: {}, txs: {}, checks: [] };
let current = "";
function check(name, ok, detail = "") {
  const passed = Boolean(ok);
  report.checks.push({ section: current, name, ok: passed, ...(passed ? {} : { detail: String(detail).slice(0, 500) }) });
  console.log(`   ${passed ? "✅" : "❌"} ${name}${passed ? "" : `  — ${String(detail).slice(0, 300)}`}`);
  return passed;
}
function skip(name, reason) {
  report.checks.push({ section: current, name, ok: true, skipped: true, detail: reason });
  console.log(`   ⏭️  ${name}  — ${reason}`);
}
const json = (value) => JSON.stringify(value, (key, v) => (typeof v === "bigint" ? `${v}n` : v));
const eq = (name, actual, expected) => check(name, String(actual) === String(expected), `ได้ ${json(actual)} ควรเป็น ${json(expected)}`);
async function section(title, body) {
  current = title;
  console.log(`\n▶ ${title}`);
  const started = Date.now();
  try { await body(); } catch (error) { check("ทำขั้นตอนนี้จนจบ", false, error.stack?.split("\n").slice(0, 3).join(" | ") ?? error); }
  console.log(`   (${((Date.now() - started) / 1000).toFixed(1)} วินาที)`);
}

// ---------- ส่ง tx / รอ block ----------
let CHAIN_ID = 1;
const DEFAULT_FEES = { maxFeePerGas: gwei(20), maxPriorityFeePerGas: "0" };

/** เซ็นและส่ง tx → { queued, hash, …response } (fields มี gasPrice = แบบเดิม · ไม่มี = EIP-1559) */
async function send(wallet, fields, { nonce } = {}) {
  const n = nonce ?? (await get(`/nonce/${wallet.address}`)).nonce;
  const legacy = fields.gasPrice !== undefined;
  const tx = { chainId: CHAIN_ID, from: wallet.address, to: "", method: "", input: {}, value: 0, nonce: n, gasLimit: 1_000_000,
    ...(legacy ? {} : DEFAULT_FEES), ...fields };
  const signature = sign.signTransaction(tx, wallet.key);
  const response = await post("/sendtx", { tx, signature });
  return { ...response, hash: response.hash ?? sign.verifyTransaction({ tx, signature }).hash, tx };
}
/** ส่งแล้วต้องเข้าคิว → hash */
async function sendOk(wallet, fields, label, options) {
  const response = await send(wallet, fields, options);
  if (!response.queued) throw new Error(`${label} ไม่เข้าคิว: ${JSON.stringify(response.simulation?.error ?? response.error ?? response.reason ?? response).slice(0, 300)}`);
  if (label) report.txs[label] = response.hash;
  return response.hash;
}
/** รอทุก hash เข้า block → { hash: record ของ /tx } */
async function mined(hashes, timeoutMs = 90_000) {
  const list = [hashes].flat().filter(Boolean);
  const found = {};
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const hash of list) {
      if (found[hash]) continue;
      const tx = await get(`/tx/${hash}`);
      if (Number.isInteger(tx?.blockNumber)) found[hash] = tx;
    }
    if (list.every((hash) => found[hash])) return found;
    await wait(100);
  }
  throw new Error(`tx ไม่เข้า block ภายใน ${timeoutMs / 1000} วินาที: ${list.filter((h) => !found[h]).join(", ")}`);
}
/** ส่งชุด tx (แต่ละรายการ [wallet, fields, label]) ตามลำดับ แล้วรอทุกใบเข้า block → [{ hash, tx, receipt }] */
async function batch(items) {
  const hashes = [];
  for (const [wallet, fields, label] of items) hashes.push(await sendOk(wallet, fields, label));
  const found = await mined(hashes);
  const out = [];
  for (const hash of hashes) out.push({ hash, tx: found[hash], receipt: await get(`/tx/${hash}/receipt`) });
  return out;
}
const success = (name, item) => check(name, item.tx.status === "success", `${item.tx.status}: ${JSON.stringify(item.receipt.error ?? item.tx.error ?? "")}`);
/**
 * เริ่มที่ต้น block ใหม่: server ปิด block เมื่อมี tx ในคิวเท่านั้น → ส่งโอน 0 ให้ตัวเองแล้วรอเข้า block
 * (หลังจากนี้มีเวลาเกือบเต็ม BLOCK_MS ก่อน block ถัดไป — ใช้กับ tx ที่ต้องอยู่ในคิวพร้อมกัน)
 */
async function freshBlock() {
  await mined(await sendOk(funder, { action: "transfer", to: funder.address, value: "0" }));
}
/** ส่ง tx เล็ก ๆ ให้เกิด block จนถึงเลขที่ต้องการ (ใช้รอ timelock) */
async function fillUntil(number) {
  while (((await get("/genesis")).latest ?? 0) < number) {
    await mined(await sendOk(erin, { action: "transfer", to: erin.address, value: "0" }));
  }
}
const program = (name) => report.programs[name];

// ============================================================================
async function main() {
  const genesis = await get("/genesis");
  CHAIN_ID = genesis.chainId;
  report.firstBlock = (genesis.latest ?? 0) + 1;
  console.log(`server ${API} · chain ${CHAIN_ID} · block ${genesis.latest} · tag ${OPTIONS.tag}`);
  const ns = (name) => `${OPTIONS.tag}-${name}`;
  const T = {};   // tx ที่ใช้ตรวจซ้ำในหัวข้อหลัง ๆ (เช่น /evm)

  await section("0 เตรียมกระเป๋า (genesis + แจกเหรียญ)", async () => {
    check("GET /genesis มี hash + baseFee + maxBlockGas", genesis.hash && genesis.baseFee && genesis.maxBlockGas, JSON.stringify(genesis));
    check("funder มีเงินจาก genesis", big((await get(`/address/${funder.address}?limit=1`)).native.balance) > 10_000n * COIN, funder.address);
    const sent = await batch([
      [funder, { action: "transfer", to: alice.address, value: coins(1000), gasPrice: gwei(2) }, "fund alice (legacy gasPrice)"],
      [funder, { action: "transfer", to: bob.address, value: coins(1000), gasPrice: gwei(2) }, "fund bob (legacy gasPrice)"],
      [funder, { action: "transfer", to: carol.address, value: coins(1000), maxPriorityFeePerGas: gwei(1) }, "fund carol (EIP-1559)"],
      [funder, { action: "transfer", to: dave.address, value: coins(1000), maxPriorityFeePerGas: gwei(1) }, "fund dave (EIP-1559)"],
      [funder, { action: "transfer", to: erin.address, value: coins(1000) }, "fund erin (EIP-1559 tip 0)"],
      ...(admin !== funder ? [[funder, { action: "transfer", to: admin.address, value: coins(100) }, "fund admin"]] : []),
    ]);
    sent.forEach((item, i) => success(`แจกเหรียญใบที่ ${i + 1} สำเร็จ`, item));
    for (const wallet of Object.values(W)) eq(`${wallet.name} ได้ 1000 เหรียญ`, (await get(`/address/${wallet.address}?limit=1`)).native.balance, `${1000n * COIN}n`);
    T.legacy = sent[0];
    T.fee1559 = sent[2];
  });

  await section("1 deploy → ทีมงาน init / reject · namespace · metadata.abi", async () => {
    const ICON = (letter, a, b) => "data:image/svg+xml;utf8," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="43" font-size="30" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`);
    const plan = [
      ["token", alice, TOKEN_PROGRAM, { name: "Scenario Full Token", ticker: "FULL", decimals: "6n", supply: units(1_000_000), namespace: ns("token"),
        icon: ICON("F", "#0ea5e9", "#6366f1"), url: "https://example.com/scenario-full", description: "ERC-20 style token of scenario-full" }],
      ["nft", alice, NFT_PROGRAM, { name: "Scenario Full NFT", symbol: "SFN", baseURI: "https://example.com/scenario-full/nft/", namespace: ns("nft"),
        icon: ICON("N", "#f59e0b", "#ef4444"), description: "ERC-721 collection of scenario-full" }],
      ["multi", alice, MULTITOKEN_PROGRAM, { name: "Scenario Full Items", symbol: "SFI", uri: "https://example.com/scenario-full/items/{id}.json", namespace: ns("items"),
        icon: ICON("I", "#10b981", "#0ea5e9"), description: "ERC-1155 items of scenario-full" }],
      ["wallet", alice, WALLET_PROGRAM, { owner: alice.address }],
      ["counter", bob, COUNTER_V1, { namespace: ns("counter") }, { upgrader: alice.address }],
      ["lab", bob, LAB_PROGRAM, { namespace: ns("lab") }],
      ["gasLab", bob, GAS_LAB_PROGRAM, { namespace: ns("gas-lab") }],
      ["multicall", bob, MULTICALL_PROGRAM, {}],
      ["note", carol, NOTE_TEMPLATE, { label: "template", namespace: ns("note-template") }],
      ["factory", carol, FACTORY_PROGRAM, { namespace: ns("factory") }],
      ["rejectable", carol, REJECTABLE_PROGRAM, {}, { value: coins(1) }],
    ];
    const deployed = await batch(plan.map(([name, wallet, code, input, extra = {}]) => [wallet, { action: "deploy", code, input, ...extra }, `deploy ${name}`]));
    deployed.forEach((item, i) => {
      success(`deploy ${plan[i][0]}`, item);
      report.programs[plan[i][0]] = item.receipt.result?.programUuid;
    });
    T.deployToken = deployed[0];
    const pending = await get("/programs/pending?limit=100");
    check("รายการรออนุมัติ (/programs/pending) มีทุกตัว", plan.every(([name]) => pending.items?.some((p) => p.address === program(name))), JSON.stringify(pending).slice(0, 200));
    eq("ก่อน init: GET /program/:a ตอบ 404", (await get(`/program/${program("token")}`)).httpStatus, 404);
    const carolBefore = big((await get(`/address/${carol.address}?limit=1`)).native.received);

    const reviewed = await batch(plan.map(([name]) => [admin, { action: name === "rejectable" ? "reject" : "init", to: program(name) }, `${name === "rejectable" ? "reject" : "init"} ${name}`]));
    reviewed.forEach((item, i) => success(`${plan[i][0] === "rejectable" ? "reject" : "init"} ${plan[i][0]}`, item));
    for (const [name] of plan.filter(([n]) => n !== "rejectable")) check(`${name}: มีโค้ดหลัง init`, (await get(`/program/${program(name)}`)).code, program(name));
    eq("reject: GET /program/:a ยังเป็น 404", (await get(`/program/${program("rejectable")}`)).httpStatus, 404);
    eq("reject: คืน value 1 เหรียญให้ผู้ deploy", big((await get(`/address/${carol.address}?limit=1`)).native.received) - carolBefore, COIN);
    check("reject: ไม่อยู่ในรายการรออนุมัติแล้ว", !(await get("/programs/pending?limit=100")).items?.some((p) => p.address === program("rejectable")));

    eq("namespace → address (GET /name/:ns)", (await get(`/name/${ns("counter")}`)).address, program("counter"));
    eq("metadata.creator = ผู้ deploy", (await get(`/address/${program("counter")}?limit=1`)).metadata.creator, bob.address);
    eq("metadata.upgrader (ตั้งตอน deploy)", (await get(`/address/${program("counter")}?limit=1`)).metadata.upgrader, alice.address);
    const abi = await get(`/program/${program("counter")}/abi`);
    check("metadata.abi + GET /program/:a/abi", abi.abi?.functions?.some((f) => f.name === "increment") && abi.evmAbi?.some((f) => f.name === "increment"), JSON.stringify(abi).slice(0, 200));
    const evmAbi = await rpc("cardianal_getAbi", [program("lab")]);
    check("/evm cardianal_getAbi → JSON ABI แบบ Ethereum", Array.isArray(evmAbi) && evmAbi.some((f) => f.name === "probe" && f.type === "function"), JSON.stringify(evmAbi).slice(0, 200));
    check("deploy receipt มี contractAddress (/evm)", lower((await rpc("eth_getTransactionReceipt", [T.deployToken.hash])).contractAddress) === program("token"));
  });

  await section("2 native + ค่าแก๊ส (โอน 0 · legacy / EIP-1559 · เผา / ผู้ปิด block · base fee)", async () => {
    const before = { bob: big((await get(`/address/${bob.address}?limit=1`)).native.balance), dave: big((await get(`/address/${dave.address}?limit=1`)).native.balance),
      burned: big((await get("/genesis")).burned) };
    const [zero, legacy, tipped] = await batch([
      [alice, { action: "transfer", to: bob.address, value: "0" }, "native transfer value 0"],
      [bob, { action: "transfer", to: carol.address, value: `${15n * COIN / 10n}`, gasPrice: gwei(3) }, "native transfer legacy gasPrice 3 gwei"],
      [carol, { action: "transfer", to: dave.address, value: `${COIN / 4n}`, maxFeePerGas: gwei(20), maxPriorityFeePerGas: gwei(2) }, "native transfer EIP-1559 tip 2 gwei"],
    ]);
    success("โอน native 0 สำเร็จ (คิดค่าแก๊ส + กิน nonce)", zero);
    check("โอน 0: ผู้ส่งเสียค่าแก๊ส", big(zero.receipt.fee) > 0n, JSON.stringify(zero.receipt.fee));
    success("โอนแบบ legacy gasPrice", legacy);
    success("โอนแบบ EIP-1559", tipped);
    const header = await get(`/block/${tipped.tx.blockNumber}`);
    const baseFee = big(header.baseFeePerGas);
    eq("legacy: effectiveGasPrice = gasPrice", big(legacy.receipt.effectiveGasPrice), 3n * GWEI);
    eq("1559: effectiveGasPrice = baseFee + tip", big(tipped.receipt.effectiveGasPrice), baseFee + 2n * GWEI);
    eq("1559: receipt.type = 2", tipped.receipt.type, 2);
    eq("1559: burnedFee = gasUsed × baseFee", big(tipped.receipt.burnedFee), BigInt(tipped.receipt.gasUsed) * baseFee);
    eq("1559: producerFee = gasUsed × tip", big(tipped.receipt.producerFee), BigInt(tipped.receipt.gasUsed) * 2n * GWEI);
    eq("fee = burnedFee + producerFee", big(tipped.receipt.fee), big(tipped.receipt.burnedFee) + big(tipped.receipt.producerFee));
    eq("ผู้รับได้ value ครบ", big((await get(`/address/${dave.address}?limit=1`)).native.balance) - before.dave, COIN / 4n);
    eq("โอน 0: ยอดผู้รับไม่เปลี่ยน (นอกจาก legacy ที่ bob จ่าย)", before.bob - big((await get(`/address/${bob.address}?limit=1`)).native.balance), 15n * COIN / 10n + big(legacy.receipt.fee));
    check("header มี burnedFee / producerFee", big(header.burnedFee) > 0n && big(header.producerFee) > 0n, JSON.stringify([header.burnedFee, header.producerFee]));
    check("ยอดที่เผา (address ศูนย์) เพิ่มขึ้น", big((await get("/genesis")).burned) > before.burned);
    check("feeRecipient (miner) ได้ tip", big((await get(`/address/${header.feeRecipient ?? MINER_DEFAULT}?limit=1`)).native.balance) > 0n);
    T.tipped = tipped;
    T.legacy2 = legacy;

    // base fee ขึ้น: tx เดียวใช้แก๊สเกิน gasTarget (1.5M) → block ถัดไป base fee สูงขึ้น
    await freshBlock();
    const [burn] = await batch([[erin, { action: "call", to: program("gasLab"), method: "burn", input: { rounds: "100000n" }, gasLimit: 2_500_000 }, "gasLab.burn (block แน่น)"]]);
    success("burn ใช้แก๊สมาก", burn);
    const heavy = await get(`/block/${burn.tx.blockNumber}`);
    check("block ที่แน่นใช้แก๊สเกิน gasTarget", heavy.gasUsed > heavy.gasTarget, `${heavy.gasUsed} / ${heavy.gasTarget}`);
    await fillUntil(heavy.number + 1);
    const after = await get(`/block/${heavy.number + 1}`);
    check("base fee ของ block ถัดไปขึ้น (EIP-1559)", big(after.baseFeePerGas) > big(heavy.baseFeePerGas), `${heavy.baseFeePerGas} → ${after.baseFeePerGas}`);
    T.heavyBlock = heavy.number;
  });

  await section("3 mempool: replace-by-fee · replaced · tx ที่ถูกปฏิเสธถูกบันทึกใน block · /pending", async () => {
    let original, replacement, done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
      await freshBlock();
      const { nonce } = await get(`/nonce/${dave.address}`);
      original = await send(dave, { action: "transfer", to: erin.address, value: "1000", maxFeePerGas: gwei(10), maxPriorityFeePerGas: gwei(1) }, { nonce });
      replacement = await send(dave, { action: "transfer", to: erin.address, value: "2000", maxFeePerGas: gwei(11), maxPriorityFeePerGas: "1100000000" }, { nonce });
      if (!original.queued || !replacement.queued) continue;   // block ปิดระหว่างสองใบ → ลองใหม่
      const pending = await get("/pending");
      const low = await send(dave, { action: "transfer", to: erin.address, value: "3000", maxFeePerGas: "11500000000", maxPriorityFeePerGas: "1150000000" }, { nonce });
      const replaced = await get(`/tx/${original.hash}`);
      if (replaced.status !== "replaced") continue;
      done = true;
      check("ใบเดิมเข้าคิว", original.queued);
      check("ใบแทน (+10% ทั้ง maxFee และ tip) เข้าคิว", replacement.queued, JSON.stringify(replacement).slice(0, 200));
      eq("GET /tx ของใบเดิม → replaced", replaced.status, "replaced");
      eq("replacedBy = ใบใหม่", replaced.replacedBy, replacement.hash);
      check("/pending เห็นใบใหม่ ไม่เห็นใบเดิม", pending.transactions.some((t) => t.hash === replacement.hash) && !pending.transactions.some((t) => t.hash === original.hash), JSON.stringify(pending).slice(0, 300));
      check("แทนด้วยราคาเพิ่มไม่ถึง 10% → ถูกปฏิเสธ", !low.queued && /ต่ำเกินไป/.test(String(low.reason ?? low.error ?? "")), JSON.stringify(low).slice(0, 200));
      const found = await mined(replacement.hash);
      eq("ใบใหม่เข้า block สำเร็จ", found[replacement.hash].status, "success");
      eq("ใบเดิมยังเป็น replaced หลังปิด block", (await get(`/tx/${original.hash}`)).status, "replaced");
      eq("/evm eth_getTransactionByHash ของใบเดิม = null (แบบ geth)", await rpc("eth_getTransactionByHash", [original.hash]), null);
      report.txs["replaced (original)"] = original.hash;
      report.txs["replace-by-fee (new)"] = replacement.hash;
    }
    if (!done) check("replace-by-fee", false, `ไม่สำเร็จใน 3 รอบ: ${JSON.stringify({ original, replacement }).slice(0, 300)}`);

    // nonce ข้ามเลข → ถูกปฏิเสธที่ /sendtx และถูกบันทึกใน block ถัดไป
    const { nonce } = await get(`/nonce/${erin.address}`);
    const bad = await send(erin, { action: "transfer", to: alice.address, value: "1" }, { nonce: nonce + 7 });
    check("nonce ข้ามเลข → ไม่เข้าคิว", !bad.queued && /nonce/.test(bad.reason ?? ""), JSON.stringify(bad).slice(0, 200));
    const waiting = await get(`/tx/${bad.hash}`);
    check("GET /tx → rejected (รอ block)", waiting.status === "rejected", JSON.stringify(waiting).slice(0, 200));
    let recorded = waiting;
    for (let i = 0; i < 300 && !Number.isInteger(recorded.blockNumber); i += 1) { await wait(100); recorded = await get(`/tx/${bad.hash}`); }
    check("tx ที่ถูกปฏิเสธถูกบันทึกลง block (blockNumber)", Number.isInteger(recorded.blockNumber), JSON.stringify(recorded).slice(0, 200));
    const header = await get(`/block/${recorded.blockNumber}`);
    check("header.rejectedCount ≥ 1 + rejectedRoot", header.rejectedCount >= 1 && header.rejectedRoot, JSON.stringify(header).slice(0, 200));
    const full = await get(`/block/${recorded.blockNumber}?full=1`);
    check("GET /block/:n?full=1 มีรายการ rejected (blockrejected)", full.rejected?.some((r) => r.hash === bad.hash), JSON.stringify(full.rejected).slice(0, 200));
    check("GET /rejected?address= มีใบนี้", (await get(`/rejected?address=${erin.address}`)).items?.some((r) => r.hash === bad.hash));
    const evmReceipt = await rpc("eth_getTransactionReceipt", [bad.hash]);
    check("/evm: tx ที่ถูกปฏิเสธเป็น status 0x0 gasUsed 0", evmReceipt?.status === "0x0" && evmReceipt.gasUsed === "0x0", JSON.stringify(evmReceipt).slice(0, 200));
    eq("nonce บนเชนไม่ขยับ", (await get(`/nonce/${erin.address}`)).nonce, nonce);
    report.txs["rejected (nonce gap)"] = bad.hash;
    T.rejected = bad.hash;
  });

  const token = program("token");
  const balanceOf = async (who) => big(await read(token, "balanceOf", { who }));
  await section("4 token (ERC-20): transfer · approve / transferFrom · multiTransfer · permit", async () => {
    const wallet = program("wallet");
    const first = await batch([
      [alice, { action: "call", to: token, method: "transfer", input: { to: bob.address, amount: units(1000) } }, "token.transfer alice → bob"],
      [alice, { action: "call", to: token, method: "approve", input: { spender: bob.address, amount: units(500) } }, "token.approve bob"],
      [alice, { action: "call", to: token, method: "multiTransfer", input: { transfers: [{ to: carol.address, amount: units(100) }, { to: dave.address, amount: units(100) }, { to: wallet, amount: units(5000) }] } }, "token.multiTransfer"],
      [alice, { action: "metadata", input: { namespace: ns("alice"), description: "scenario-full wallet alice" } }, "metadata (alice namespace)"],
    ]);
    first.forEach((item) => success(`${Object.entries(report.txs).find(([, h]) => h === item.hash)?.[0]}`, item));
    eq("bob ได้ 1000 FULL", await balanceOf(bob.address), 1000n * UNIT);
    eq("allowance(alice, bob) = 500", big(await read(token, "allowance", { owner: alice.address, spender: bob.address })), 500n * UNIT);
    eq("multiTransfer: กระเป๋าโปรแกรมได้ 5000", await balanceOf(wallet), 5000n * UNIT);
    eq("multiTransfer คืนจำนวนรายการ", first[2].receipt.result, "3n");
    eq("metadata action: /name/ ของกระเป๋า → alice", (await get(`/name/${ns("alice")}`)).address, alice.address);
    T.tokenTransfer = first[0];

    const deadline = `${BigInt(Date.now() + 3_600_000)}`;
    const name = await read(token, "name");
    const permitFields = (owner, spender, value, nonce) => ({ name, chainId: CHAIN_ID, verifyingContract: token, owner, spender, value, nonce, deadline });
    const alicePermit = permitFields(alice.address, dave.address, 300n * UNIT, big(await read(token, "nonces", { owner: alice.address })));
    const walletPermit = permitFields(wallet, erin.address, 50n * UNIT, big(await read(token, "nonces", { owner: wallet })));
    const permitInput = (f, signature) => ({ owner: f.owner, spender: f.spender, value: `${f.value}n`, deadline: `${deadline}n`, signature });
    const signedAlice = permitInput(alicePermit, signPermit(alicePermit, alice.key));
    const second = await batch([
      [bob, { action: "call", to: token, method: "transferFrom", input: { from: alice.address, to: carol.address, amount: units(200) } }, "token.transferFrom (bob ใช้วงเงิน)"],
      [dave, { action: "call", to: token, method: "permit", input: signedAlice }, "token.permit (alice เซ็น · dave ส่งแทน)"],
      [dave, { action: "call", to: token, method: "permit", input: permitInput(walletPermit, signWalletHash(permitDigest(walletPermit), alice.key)) }, "token.permit (กระเป๋าโปรแกรม ERC-1271)"],
    ]);
    second.forEach((item, i) => success(["transferFrom", "permit ลายเซ็นคน", "permit กระเป๋าโปรแกรม (isValidSignature แบบ readonly)"][i], item));
    eq("transferFrom ลดวงเงินเหลือ 300", big(await read(token, "allowance", { owner: alice.address, spender: bob.address })), 300n * UNIT);
    eq("permit ตั้ง allowance(alice, dave) = 300", big(await read(token, "allowance", { owner: alice.address, spender: dave.address })), 300n * UNIT);
    eq("permit เพิ่ม nonces(alice) เป็น 1", await read(token, "nonces", { owner: alice.address }), "1n");
    eq("permit ERC-1271 ตั้ง allowance(wallet, erin) = 50", big(await read(token, "allowance", { owner: wallet, spender: erin.address })), 50n * UNIT);
    const replay = await send(dave, { action: "call", to: token, method: "permit", input: signedAlice });
    check("ใช้ลายเซ็น permit ซ้ำ → ถูกปฏิเสธ", !replay.queued && /invalid permit signature/.test(JSON.stringify(replay)), JSON.stringify(replay).slice(0, 200));

    const third = await batch([
      [dave, { action: "call", to: token, method: "transferFrom", input: { from: alice.address, to: erin.address, amount: units(300) } }, "token.transferFrom (ใช้วงเงินจาก permit)"],
      [erin, { action: "call", to: token, method: "transferFrom", input: { from: wallet, to: erin.address, amount: units(50) } }, "token.transferFrom (จากกระเป๋าโปรแกรม)"],
    ]);
    third.forEach((item, i) => success(["transferFrom ด้วยวงเงิน permit", "transferFrom จากกระเป๋าโปรแกรม"][i], item));
    eq("erin ได้ 350 FULL", await balanceOf(erin.address), 350n * UNIT);
    eq("totalSupply คงเดิม", await read(token, "totalSupply"), units(1_000_000));
  });

  const nft = program("nft");
  await section("5 NFT (ERC-721): mint · safeTransferFrom (คน / กระเป๋าโปรแกรม) · approve / operator · tokenURI", async () => {
    const wallet = program("wallet");
    const mints = await batch([
      [alice, { action: "call", to: nft, method: "mint", input: { to: alice.address, uri: "https://example.com/scenario-full/nft/genesis.json" } }, "nft.mint #1 (uri ของตัวเอง)"],
      [alice, { action: "call", to: nft, method: "mint", input: { to: alice.address } }, "nft.mint #2"],
      [alice, { action: "call", to: nft, method: "mint", input: { to: alice.address } }, "nft.mint #3"],
      [alice, { action: "call", to: nft, method: "mint", input: { to: bob.address, tokenId: "10n" } }, "nft.mint #10 → bob"],
    ]);
    mints.forEach((item, i) => success(`mint #${[1, 2, 3, 10][i]}`, item));
    eq("mint คืน tokenId ถัดไป", mints.map((m) => m.receipt.result).join(","), "1n,2n,3n,10n");
    const moves = await batch([
      [alice, { action: "call", to: nft, method: "safeTransferFrom", input: { from: alice.address, to: bob.address, tokenId: "1n" } }, "nft.safeTransferFrom #1 → bob"],
      [alice, { action: "call", to: nft, method: "safeTransferFrom", input: { from: alice.address, to: wallet, tokenId: "2n" } }, "nft.safeTransferFrom #2 → WALLET_PROGRAM"],
      [alice, { action: "call", to: nft, method: "approve", input: { to: bob.address, tokenId: "3n" } }, "nft.approve #3 → bob"],
      [alice, { action: "call", to: nft, method: "setApprovalForAll", input: { operator: dave.address, approved: true } }, "nft.setApprovalForAll dave"],
    ]);
    moves.forEach((item, i) => success(["safeTransferFrom ไปคน", "safeTransferFrom ไปกระเป๋าโปรแกรม (onERC721Received)", "approve", "setApprovalForAll"][i], item));
    check("safe transfer ไปโปรแกรม: trace มี onERC721Received", moves[1].receipt.trace?.some((t) => t.method === "onERC721Received" && t.status === "success"), JSON.stringify(moves[1].receipt.trace).slice(0, 300));
    eq("getApproved(#3) = bob", await read(nft, "getApproved", { tokenId: "3n" }), bob.address);
    eq("isApprovedForAll(alice, dave)", await read(nft, "isApprovedForAll", { owner: alice.address, operator: dave.address }), true);
    const bad = await send(alice, { action: "call", to: nft, method: "safeTransferFrom", input: { from: alice.address, to: program("counter"), tokenId: "3n" } });
    check("safeTransferFrom ไปโปรแกรมที่ไม่รับ NFT → ถูกปฏิเสธ", !bad.queued, JSON.stringify(bad).slice(0, 200));
    const [approved] = await batch([[bob, { action: "call", to: nft, method: "transferFrom", input: { from: alice.address, to: carol.address, tokenId: "3n" } }, "nft.transferFrom #3 (bob ได้ approve) → carol"]]);
    success("transferFrom ด้วยสิทธิ์ approve", approved);
    eq("ownerOf(#1) = bob", await read(nft, "ownerOf", { tokenId: "1n" }), bob.address);
    eq("ownerOf(#2) = กระเป๋าโปรแกรม", await read(nft, "ownerOf", { tokenId: "2n" }), wallet);
    eq("ownerOf(#3) = carol", await read(nft, "ownerOf", { tokenId: "3n" }), carol.address);
    eq("getApproved(#3) ถูกล้างหลังโอน", await read(nft, "getApproved", { tokenId: "3n" }), null);
    eq("balanceOf(bob) = 2", await read(nft, "balanceOf", { owner: bob.address }), "2n");
    eq("tokenURI(#1) = uri ของชิ้น", await read(nft, "tokenURI", { tokenId: "1n" }), "https://example.com/scenario-full/nft/genesis.json");
    eq("tokenURI(#2) = baseURI + id", await read(nft, "tokenURI", { tokenId: "2n" }), "https://example.com/scenario-full/nft/2");
    eq("totalSupply = 4", await read(nft, "totalSupply"), "4n");
    T.nftTransfer = moves[0];
  });

  const multi = program("multi");
  await section("6 multi-token (ERC-1155): mint / mintBatch · single / batch transfer · operator · uri", async () => {
    const wallet = program("wallet");
    const mints = await batch([
      [alice, { action: "call", to: multi, method: "mint", input: { to: alice.address, id: "1n", amount: "100n" } }, "multi.mint id 1 × 100"],
      [alice, { action: "call", to: multi, method: "mintBatch", input: { to: alice.address, ids: ["2n", "3n"], amounts: ["50n", "5n"] } }, "multi.mintBatch ids 2,3"],
      [alice, { action: "call", to: multi, method: "setURI", input: { id: "3n", uri: "https://example.com/scenario-full/items/legendary.json" } }, "multi.setURI id 3"],
    ]);
    mints.forEach((item, i) => success(["mint", "mintBatch", "setURI"][i], item));
    const moves = await batch([
      [alice, { action: "call", to: multi, method: "safeTransferFrom", input: { from: alice.address, to: bob.address, id: "1n", amount: "10n" } }, "multi.safeTransferFrom id 1 → bob"],
      [alice, { action: "call", to: multi, method: "safeBatchTransferFrom", input: { from: alice.address, to: wallet, ids: ["2n", "3n"], amounts: ["5n", "1n"] } }, "multi.safeBatchTransferFrom → WALLET_PROGRAM"],
      [alice, { action: "call", to: multi, method: "setApprovalForAll", input: { operator: dave.address, approved: true } }, "multi.setApprovalForAll dave"],
    ]);
    moves.forEach((item, i) => success(["safeTransferFrom", "safeBatchTransferFrom ไปกระเป๋าโปรแกรม (onERC1155BatchReceived)", "setApprovalForAll"][i], item));
    const [operator] = await batch([[dave, { action: "call", to: multi, method: "safeTransferFrom", input: { from: alice.address, to: carol.address, id: "1n", amount: "7n" } }, "multi.safeTransferFrom โดย operator dave"]]);
    success("operator โอนแทนเจ้าของ", operator);
    const balances = await read(multi, "balanceOfBatch", { accounts: [alice.address, bob.address, carol.address, wallet, wallet], ids: ["1n", "1n", "1n", "2n", "3n"] });
    eq("balanceOfBatch [alice#1, bob#1, carol#1, wallet#2, wallet#3]", balances.join(","), "83n,10n,7n,5n,1n");
    eq("totalSupply(id 1) = 100", await read(multi, "totalSupply", { id: "1n" }), "100n");
    eq("uri(1) = template {id}", await read(multi, "uri", { id: "1n" }), "https://example.com/scenario-full/items/{id}.json");
    eq("uri(3) = ที่ setURI", await read(multi, "uri", { id: "3n" }), "https://example.com/scenario-full/items/legendary.json");
    eq("isApprovedForAll(alice, dave)", await read(multi, "isApprovedForAll", { account: alice.address, operator: dave.address }), true);
    T.single = moves[0];
    T.batch = moves[1];
  });

  await section("7 กระเป๋าโปรแกรม ERC-1271: isValidSignature · execute", async () => {
    const wallet = program("wallet");
    const hash = keccakText(`scenario-full ${OPTIONS.tag}`);
    eq("isValidSignature (เจ้าของเซ็น) = magic", await read(wallet, "isValidSignature", { hash, signature: signWalletHash(hash, alice.key) }), ERC1271_MAGIC_VALUE);
    eq("isValidSignature (คนอื่นเซ็น) = 0xffffffff", await read(wallet, "isValidSignature", { hash, signature: signWalletHash(hash, bob.key) }), ERC1271_INVALID_VALUE);
    eq("owner() = alice", await read(wallet, "owner"), alice.address);
    const carolBefore = await balanceOf(carol.address);
    const [executed] = await batch([[alice, { action: "call", to: wallet, method: "execute", input: { target: token, fn: "transfer", input: { to: carol.address, amount: units(25) } } }, "wallet.execute → token.transfer"]]);
    success("execute (เจ้าของสั่งกระเป๋าเรียกโปรแกรมอื่น)", executed);
    eq("carol ได้ 25 FULL จากกระเป๋าโปรแกรม", (await balanceOf(carol.address)) - carolBefore, 25n * UNIT);
    check("trace: wallet → token.transfer (depth 1, sender = wallet)", executed.receipt.trace?.some((t) => t.depth === 1 && t.program === token && t.from === wallet), JSON.stringify(executed.receipt.trace).slice(0, 300));
    const stranger = await send(bob, { action: "call", to: wallet, method: "execute", input: { target: token, fn: "transfer", input: { to: bob.address, amount: units(1) } } });
    check("คนที่ไม่ใช่เจ้าของ execute → ถูกปฏิเสธ (only owner)", !stranger.queued && /only owner/.test(JSON.stringify(stranger)), JSON.stringify(stranger).slice(0, 200));
  });

  await section("8 multicall: aggregate / tryAggregate / readonly · tx รวมหลาย call", async () => {
    const mc = program("multicall");
    const counter = program("counter");
    const reads = await read(mc, "aggregate", { readonly: true, calls: [
      { target: token, fn: "balanceOf", input: { who: bob.address } },
      { target: nft, fn: "ownerOf", input: { tokenId: "1n" } },
      { target: multi, fn: "balanceOf", input: { account: bob.address, id: "1n" } },
      { target: mc, fn: "getChainId", input: {} },
    ] });
    eq("aggregate readonly อ่าน 4 ค่าในรอบเดียว", reads.join(","), `${1000n * UNIT}n,${bob.address},10n,${CHAIN_ID}n`);
    const tried = await read(mc, "tryAggregate", { calls: [{ target: nft, fn: "ownerOf", input: { tokenId: "999n" } }, { target: token, fn: "ticker", input: {} }] });
    check("tryAggregate: ตัวที่ล้มได้ success false ที่เหลือทำต่อ", tried[0]?.success === false && /does not exist/.test(tried[0].error) && tried[1]?.success === true && tried[1].result === "FULL", JSON.stringify(tried));
    const forbidden = await read(mc, "tryAggregate", { readonly: true, calls: [{ target: counter, fn: "increment", input: { by: "1n" } }] });
    eq("tryAggregate readonly กับฟังก์ชันที่เขียน → FORBIDDEN", forbidden[0]?.code, "FORBIDDEN");
    const all = await query(mc, "aggregate", { calls: [{ target: token, fn: "ticker", input: {} }, { target: nft, fn: "ownerOf", input: { tokenId: "999n" } }] });
    check("aggregate: ล้มตัวเดียว = ล้มทั้งหมด", all.status === "throw", JSON.stringify(all).slice(0, 200));
    const before = big(await read(counter, "get"));
    const [agg] = await batch([[bob, { action: "call", to: mc, method: "aggregate", input: { calls: [{ target: counter, fn: "increment", input: { by: "1n" } }, { target: counter, fn: "increment", input: { by: "2n" } }] } }, "multicall.aggregate (tx: counter +1 +2)"]]);
    success("tx aggregate สำเร็จ", agg);
    eq("counter เพิ่ม 3", big(await read(counter, "get")) - before, 3n);
    eq("trace มี 2 call ซ้อนไปที่ counter", agg.receipt.trace?.filter((t) => t.depth === 1 && t.program === counter).length, 2);
    T.aggregate = agg;
  });

  await section("9 โปรแกรมเรียกโปรแกรม: runProgram ซ้อน · STATICCALL (FORBIDDEN) · catch call ชั้นในที่ล้ม", async () => {
    const lab = program("lab");
    const counter = program("counter");
    const [nested, staticCall, caught] = await batch([
      [carol, { action: "call", to: lab, method: "callCounter", input: { counter, by: "5n" } }, "lab.callCounter (nested)"],
      [carol, { action: "call", to: lab, method: "staticWrite", input: { counter } }, "lab.staticWrite (STATICCALL)"],
      [carol, { action: "call", to: lab, method: "catchFailure", input: { counter } }, "lab.catchFailure (inner fails, caught)"],
    ]);
    success("callCounter สำเร็จ", nested);
    check("trace: lab → counter.increment depth 1", nested.receipt.trace?.some((t) => t.depth === 1 && t.program === counter && t.method === "increment" && t.from === lab), JSON.stringify(nested.receipt.trace).slice(0, 300));
    check("event Incremented มี caller = lab (เรียกผ่านโปรแกรม)", nested.receipt.events?.some((e) => e.name === "Incremented" && e.data.caller === lab), JSON.stringify(nested.receipt.events).slice(0, 300));
    success("staticWrite สำเร็จ (ผู้เรียก catch ได้)", staticCall);
    eq("STATICCALL ที่เขียน → FORBIDDEN", staticCall.receipt.result?.blocked?.code, "FORBIDDEN");
    check("trace มี type staticcall", staticCall.receipt.trace?.some((t) => t.type === "staticcall"), JSON.stringify(staticCall.receipt.trace).slice(0, 300));
    success("catchFailure: tx สำเร็จแม้ชั้นในล้ม", caught);
    eq("ข้อความ error ของชั้นในถูก catch", caught.receipt.result?.message, "intentional failure from the counter");
    check("trace: call ชั้นในสถานะล้ม", caught.receipt.trace?.some((t) => t.depth === 1 && t.method === "fail" && t.status !== "success"), JSON.stringify(caught.receipt.trace).slice(0, 300));
    T.nested = nested;
    T.caught = caught;
  });

  await section("10 API ในโปรแกรม (BlockHash … Math.random) เทียบกับค่าจริงของเชน", async () => {
    const lab = program("lab");
    const message = `scenario-full probe ${OPTIONS.tag}`;
    const [probe] = await batch([[carol, { action: "call", to: lab, method: "probe", value: gwei(1_000_000), input: { message, signature: signProgramMessage(message, carol.key) } }, "lab.probe (ทุก API)"]]);
    success("probe สำเร็จ", probe);
    const s = probe.receipt.result ?? {};
    const header = await get(`/block/${probe.tx.blockNumber}`);
    const parent = await get(`/block/${probe.tx.blockNumber - 1}`);
    const code = (await get(`/program/${lab}`)).code;
    const g = await get("/genesis");
    const digest = (fn) => `0x${bytesToHex(fn(utf8ToBytes("abc")))}`;
    let expectedModexp = 1n;
    for (let i = 0; i < 200; i += 1) expectedModexp = (expectedModexp * 3n) % 1000007n;
    eq("BlockNumber()", s.blockNumber, `${probe.tx.blockNumber}n`);
    eq("BlockHash(n - 1) = hash ของ block ก่อน", s.blockHash, parent.hash);
    eq("ChainId()", s.chainId, `${CHAIN_ID}n`);
    eq("Coinbase() = feeRecipient", s.coinbase, header.feeRecipient);
    eq("BlockGasLimit() = maxBlockGas", s.blockGasLimit, `${g.maxBlockGas}n`);
    eq("BaseFee() = baseFeePerGas ของ block", s.baseFee, header.baseFeePerGas);
    eq("GasPrice() = effectiveGasPrice", s.gasPrice, probe.receipt.effectiveGasPrice);
    check("GasLeft() อยู่ระหว่าง 0 กับ gasLimit", big(s.gasLeft) > 0n && big(s.gasLeft) < 1_000_000n, s.gasLeft);
    eq("CodeHashOf(this) = keccak256(โค้ด)", s.codeHash, keccakText(code));
    eq("CodeSizeOf(this) = byte ของโค้ด", s.codeSize, `${Buffer.byteLength(code, "utf8")}n`);
    eq("sha256('abc')", s.sha256, digest(sha256));
    eq("ripemd160('abc')", s.ripemd160, digest(ripemd160));
    eq("blake2b('abc') (512 bit)", s.blake2b, digest(blake2b));
    eq("keccak256('abc')", s.keccak256, keccakText("abc"));
    eq("modexp(3, 200, 1000007)", s.modexp, `${expectedModexp}n`);
    eq("ecrecover(ข้อความ, ลายเซ็น) = ผู้เซ็น", s.signer, carol.address);
    check("BalanceOf(sender) > 0", big(s.senderBalance) > 0n, s.senderBalance);
    eq("ThisBalance() = value ที่แนบมา", s.thisBalance, `${1_000_000n * GWEI}n`);
    eq("IsProgram(this) = true", s.thisIsProgram, true);
    eq("IsProgram(sender) = false", s.senderIsProgram, false);
    eq("MetadataOf(this, 'namespace')", s.namespace, ns("lab"));
    eq("Date.now() = timestamp ของ block", s.now, `${header.timestamp}n`);
    eq("params.block.timestamp = timestamp ของ block", s.timestamp, `${header.timestamp}n`);
    check("Math.random() อยู่ใน [0, 1)", Number(s.random) >= 0 && Number(s.random) < 1, s.random);
    const stored = await read(lab, "lastProbe");
    check("replay ได้ค่าเดิมทุกตัว (receipt จาก replay = ค่าที่เก็บตอนรันจริง รวม Math.random)", JSON.stringify(stored) === JSON.stringify(s), `${JSON.stringify(stored).slice(0, 150)} ≠ ${JSON.stringify(s).slice(0, 150)}`);
    T.probe = probe;
  });

  await section("11 อัปเกรดโปรแกรม: upgrade → reject → upgrade → approve (+ timelock) · migrate · versions · setUpgrader", async () => {
    const counter = program("counter");
    const countBefore = big(await read(counter, "get"));
    const [first] = await batch([[alice, { action: "upgrade", to: counter, code: COUNTER_V2, input: { tag: "rejected", bonus: "1n" } }, "upgrade #1 (จะถูก reject)"]]);
    success("upgrader ส่งโค้ดใหม่", first);
    check("GET /program → pendingUpgrade", (await get(`/program/${counter}`)).pendingUpgrade, "ไม่มี pendingUpgrade");
    const [rejected] = await batch([[admin, { action: "rejectUpgrade", to: counter }, "rejectUpgrade"]]);
    success("ทีมงาน rejectUpgrade", rejected);
    eq("หลัง reject: pendingUpgrade = null", (await get(`/program/${counter}`)).pendingUpgrade, null);
    eq("หลัง reject: version() ยังเป็น 1", await read(counter, "version"), "1n");
    const stranger = await send(bob, { action: "upgrade", to: counter, code: COUNTER_V2, input: {} });
    check("คนที่ไม่ใช่ upgrader ส่งโค้ด → ถูกปฏิเสธ", !stranger.queued, JSON.stringify(stranger).slice(0, 200));

    const [second] = await batch([[alice, { action: "upgrade", to: counter, code: COUNTER_V2, input: { tag: "v2", bonus: "100n" } }, "upgrade #2"]]);
    success("ส่งโค้ดใหม่รอบสอง", second);
    const [approved] = await batch([[admin, { action: "initUpgrade", to: counter }, "initUpgrade"]]);
    success("ทีมงาน initUpgrade", approved);
    const state = approved.receipt.result?.state;
    if (state === "scheduled") {
      const activateAt = approved.receipt.result.activateAt;
      check("timelock: ได้ state scheduled + activateAt", activateAt > approved.tx.blockNumber, JSON.stringify(approved.receipt.result));
      check("timelock: GET /program → scheduledUpgrade", (await get(`/program/${counter}`)).scheduledUpgrade?.activateAt === activateAt);
      eq("timelock: ก่อนถึงเวลา version() ยังเป็น 1", await read(counter, "version"), "1n");
      await fillUntil(activateAt);
      const header = await get(`/block/${activateAt}`);
      check(`timelock: header.upgrades ของ block ${activateAt} มีการเปิดใช้`, header.upgrades?.some((u) => u.program === counter), JSON.stringify(header.upgrades));
    } else {
      eq("ไม่มี timelock (UPGRADE_DELAY_BLOCKS=0): ใช้โค้ดใหม่ทันที", state, "active");
    }
    eq("version() = 2", await read(counter, "version"), "2n");
    eq("metadata.version = 2", (await get(`/address/${counter}?limit=1`)).metadata.version, 2);
    eq("migrate รันครั้งเดียว (migratedTag)", await read(counter, "migratedTag"), "v2");
    eq("storage เดิมอยู่ครบ + bonus จาก migrate", big(await read(counter, "get")), countBefore + 100n);
    const versions = await get(`/program/${counter}/versions`);
    eq("GET /program/:a/versions มี 2 เวอร์ชัน", versions.map?.((v) => v.version).join(","), "1,2");
    check("ABI ใหม่ (setMetadata ใน migrate) มี decrement", (await get(`/program/${counter}/abi`)).abi?.functions?.some((f) => f.name === "decrement"));
    const migrateCall = await query(counter, "migrate", { tag: "x" });
    check("migrate เรียกจากภายนอกไม่ได้", migrateCall.status !== "success", JSON.stringify(migrateCall).slice(0, 150));
    const [dec] = await batch([[bob, { action: "call", to: counter, method: "decrement", input: { by: "1n" } }, "counter.decrement (ฟังก์ชันใหม่ v2)"]]);
    success("ฟังก์ชันใหม่ของ v2 ใช้ได้", dec);

    const [handover] = await batch([[alice, { action: "setUpgrader", to: counter, input: { upgrader: bob.address } }, "setUpgrader → bob"]]);
    success("setUpgrader โอนสิทธิ์", handover);
    eq("metadata.upgrader = bob", (await get(`/address/${counter}?limit=1`)).metadata.upgrader, bob.address);
    const [renounce] = await batch([[bob, { action: "setUpgrader", to: counter, input: { upgrader: null } }, "setUpgrader → null (สละสิทธิ์)"]]);
    success("สละสิทธิ์อัปเกรด", renounce);
    check("metadata.upgrader ถูกลบ (แก้ไม่ได้อีก)", !(await get(`/address/${counter}?limit=1`)).metadata.upgrader);
    const after = await send(bob, { action: "upgrade", to: counter, code: COUNTER_V1, input: {} });
    check("หลังสละสิทธิ์ upgrade → ถูกปฏิเสธ", !after.queued, JSON.stringify(after).slice(0, 200));
  });

  await section("12 cloneProgram: โรงงานสร้างโปรแกรม (address แบบ CREATE2 ทำนายได้ก่อน)", async () => {
    const factory = program("factory");
    const template = program("note");
    const salt = `${OPTIONS.tag}-note-1`;
    const templateCode = (await get(`/program/${template}`)).code;
    const predicted = new VirtualMachine(new MemoryDB(), { chainId: CHAIN_ID }).cloneAddressFor(factory, salt, templateCode);
    const [created] = await batch([[dave, { action: "call", to: factory, method: "create", input: { template, salt, label: "Dave's note", namespace: ns("note-1") } }, "factory.create (cloneProgram)"]]);
    success("create สำเร็จ", created);
    eq("address ของ clone = ที่ทำนายไว้", created.receipt.result, predicted);
    report.programs.clone = predicted;
    const meta = (await get(`/address/${predicted}?limit=1`)).metadata;
    eq("metadata.template = ต้นแบบ", meta.template, template);
    eq("metadata.creator = factory", meta.creator, factory);
    eq("namespace ของ clone", (await get(`/name/${ns("note-1")}`)).address, predicted);
    check("trace มีรายการ type create", created.receipt.trace?.some((t) => t.type === "create"), JSON.stringify(created.receipt.trace).slice(0, 300));
    const frame = await rpc("debug_traceTransaction", [created.hash, { tracer: "callTracer" }]);
    check("/evm callTracer มี frame CREATE", JSON.stringify(frame).includes('"type":"CREATE"'), JSON.stringify(frame).slice(0, 300));
    const [written] = await batch([[dave, { action: "call", to: predicted, method: "write", input: { text: "hello from a clone" } }, "clone.write"]]);
    success("ใช้งาน clone ได้ (owner = ผู้เรียก factory)", written);
    eq("clone.note().text", (await read(predicted, "note")).text, "hello from a clone");
    const again = await send(dave, { action: "call", to: factory, method: "create", input: { template, salt, label: "again" } });
    check("salt ซ้ำ → ถูกปฏิเสธ", !again.queued, JSON.stringify(again).slice(0, 200));
    T.clone = created;
  });

  await section("13 แก๊ส / sandbox: OUT_OF_GAS · OUT_OF_MEMORY (ทั้งตอน query, ตอน /sendtx และใน block)", async () => {
    const gasLab = program("gasLab");
    const spin = await query(gasLab, "spin");
    eq("query ลูปไม่รู้จบ → OUT_OF_GAS", spin.error?.code, "OUT_OF_GAS");
    const sent = await send(erin, { action: "call", to: gasLab, method: "spin", gasLimit: 300_000 });
    check("/sendtx ลูปไม่รู้จบ → simulate ไม่ผ่าน ไม่เข้าคิว", !sent.queued && sent.simulation?.errorCode === "OUT_OF_GAS", JSON.stringify(sent).slice(0, 200));
    report.txs["rejected (spin OUT_OF_GAS at /sendtx)"] = sent.hash;

    // กับดัก: arm แล้ว loop / memory ใน block เดียวกัน (simulate ตอนส่งเห็น state ก่อน arm จึงผ่าน)
    let items = null;
    for (let attempt = 1; attempt <= 3 && !items; attempt += 1) {
      await freshBlock();
      const { nonce } = await get(`/nonce/${erin.address}`);
      const arm = await send(erin, { action: "call", to: gasLab, method: "arm" }, { nonce });
      const loop = await send(erin, { action: "call", to: gasLab, method: "loopIfArmed", gasLimit: 400_000 }, { nonce: nonce + 1 });
      const memory = await send(erin, { action: "call", to: gasLab, method: "memoryIfArmed", gasLimit: 400_000 }, { nonce: nonce + 2 });
      if (arm.queued && loop.queued && memory.queued) items = { arm, loop, memory };
      else if (arm.queued) await mined(arm.hash);
    }
    if (!items) return check("ส่งกับดักเข้าคิวครบ 3 ใบ", false, "block ปิดระหว่างส่ง 3 ครั้ง");
    const found = await mined([items.arm.hash, items.loop.hash, items.memory.hash]);
    const loopReceipt = await get(`/tx/${items.loop.hash}/receipt`);
    const memoryReceipt = await get(`/tx/${items.memory.hash}/receipt`);
    eq("arm สำเร็จ", found[items.arm.hash].status, "success");
    eq("ลูปใน block → OUT_OF_GAS", loopReceipt.error?.code, "OUT_OF_GAS");
    check("OUT_OF_GAS: เข้า block · ใช้แก๊สเต็ม gasLimit · เสียค่าแก๊ส", found[items.loop.hash].blockNumber && loopReceipt.gasUsed >= 400_000 && big(loopReceipt.fee) > 0n, JSON.stringify([loopReceipt.gasUsed, loopReceipt.fee]));
    eq("หน่วยความจำใน block → OUT_OF_MEMORY", memoryReceipt.error?.code, "OUT_OF_MEMORY");
    check("OUT_OF_MEMORY: เข้า block · เสียค่าแก๊สเท่าที่ใช้", found[items.memory.hash].blockNumber && memoryReceipt.gasUsed > 0 && big(memoryReceipt.fee) > 0n, JSON.stringify([memoryReceipt.gasUsed, memoryReceipt.fee]));
    const evmLoop = await rpc("eth_getTransactionReceipt", [items.loop.hash]);
    check("/evm: tx ที่ล้มใน block → status 0x0 + gasUsed > 0", evmLoop.status === "0x0" && BigInt(evmLoop.gasUsed) > 0n, JSON.stringify(evmLoop).slice(0, 200));
    report.txs["failed in block (OUT_OF_GAS)"] = items.loop.hash;
    report.txs["failed in block (OUT_OF_MEMORY)"] = items.memory.hash;
    T.oog = items.loop.hash;
    skip("TIMEOUT_MS (หมดเวลา)", "แก๊สหมดก่อนเสมอ: maxTxGas 3M ≈ 60 ms ใน sandbox · timeout (5 วิ) เป็นด่านสุดท้ายที่ทดสอบไม่ได้โดยไม่ลด TIMEOUT_MS ของ server (เทสต์ 08 / 58 คุมอยู่)");
  });

  await section("14 event แบบ indexed: REST + eth_getLogs ตาม topic", async () => {
    const latest = (await get("/genesis")).latest;
    const byTo = await get(`/program/${token}/events?name=Transfer&to=${bob.address}`);
    check("GET /program/:a/events?name=Transfer&to=bob → เฉพาะของ bob", byTo.items?.length >= 1 && byTo.items.every((e) => e.data?.to === bob.address), JSON.stringify(byTo).slice(0, 300));
    const both = await get(`/program/${token}/events?name=Transfer&from=${alice.address}&to=${carol.address}`);
    check("หลาย field (AND): from=alice & to=carol", both.items?.length >= 1 && both.items.every((e) => e.data?.from === alice.address && e.data?.to === carol.address), JSON.stringify(both).slice(0, 300));
    const byCaller = await get(`/program/${program("counter")}/events?name=Incremented&caller=${program("lab")}`);
    check("event ของโปรแกรมตัวอย่าง (Incremented caller = lab)", byCaller.items?.length >= 1, JSON.stringify(byCaller).slice(0, 200));
    const logs = await rpc("eth_getLogs", [{ fromBlock: hex(report.firstBlock), toBlock: hex(latest), address: token, topics: [SIG.transfer, null, `0x${addressWord(bob.address)}`] }]);
    check("eth_getLogs topic0 Transfer + topic2 = bob", logs.length >= 1 && logs.every((l) => l.topics[2] === `0x${addressWord(bob.address)}`), JSON.stringify(logs).slice(0, 200));
    const nftLogs = await rpc("eth_getLogs", [{ fromBlock: hex(report.firstBlock), toBlock: hex(latest), address: nft, topics: [SIG.transfer, null, null, `0x${word(1)}`] }]);
    check("eth_getLogs NFT tokenId (topic3) = 1 → mint + โอน", nftLogs.length === 2, JSON.stringify(nftLogs).slice(0, 200));
    const singles = await rpc("eth_getLogs", [{ fromBlock: hex(report.firstBlock), toBlock: hex(latest), topics: [SIG.transferSingle] }]);
    check("eth_getLogs topic0 TransferSingle (ทุกโปรแกรม)", singles.length >= 3 && singles.every((l) => l.address === multi), JSON.stringify(singles).slice(0, 200));
  });

  await section("15 /evm สำหรับ Blockscout: block · tx · receipt · log · eth_call · fee", async () => {
    const latest = (await get("/genesis")).latest;
    eq("eth_chainId", await rpc("eth_chainId"), hex(CHAIN_ID));
    eq("eth_blockNumber", await rpc("eth_blockNumber"), hex(latest));
    const n = T.tokenTransfer.tx.blockNumber;
    const header = await get(`/block/${n}`);
    const block = await rpc("eth_getBlockByNumber", [hex(n), false]);
    eq("block.hash", block.hash, header.hash);
    eq("block.baseFeePerGas", block.baseFeePerGas, hex(header.baseFeePerGas));
    eq("block.logsBloom = header", block.logsBloom, header.logsBloom);
    eq("block.receiptsRoot = header", block.receiptsRoot, header.receiptsRoot);
    check("block.transactions มี tx ของ block (hash ของ VM)", block.transactions.includes(T.tokenTransfer.tx.hash), JSON.stringify(block.transactions));
    const fullBlock = await rpc("eth_getBlockByNumber", [hex(n), true]);
    check("eth_getBlockByNumber(full) คืน tx object", fullBlock.transactions.every((t) => typeof t === "object" && t.hash));
    const t1559 = await rpc("eth_getTransactionByHash", [T.tipped.hash]);
    check("tx แบบ 1559: type 0x2 + maxFeePerGas + maxPriorityFeePerGas", t1559.type === "0x2" && t1559.maxFeePerGas === hex(gwei(20)) && t1559.maxPriorityFeePerGas === hex(gwei(2)), JSON.stringify(t1559).slice(0, 300));
    const tLegacy = await rpc("eth_getTransactionByHash", [T.legacy2.hash]);
    check("tx แบบเดิม: type 0x0 + gasPrice", tLegacy.type === "0x0" && tLegacy.gasPrice === hex(gwei(3)), JSON.stringify(tLegacy).slice(0, 300));
    const r1559 = await rpc("eth_getTransactionReceipt", [T.tipped.hash]);
    eq("receipt.effectiveGasPrice", r1559.effectiveGasPrice, hex(T.tipped.receipt.effectiveGasPrice));
    const erc20 = await rpc("eth_getTransactionReceipt", [T.tokenTransfer.hash]);
    const log20 = erc20.logs[0];
    check("ERC-20 Transfer log: 3 topics + data = amount", erc20.status === "0x1" && log20.topics.length === 3 && log20.topics[0] === SIG.transfer
      && log20.topics[1] === `0x${addressWord(alice.address)}` && log20.topics[2] === `0x${addressWord(bob.address)}` && BigInt(log20.data) === 1000n * UNIT, JSON.stringify(erc20.logs).slice(0, 300));
    const erc721 = await rpc("eth_getTransactionReceipt", [T.nftTransfer.hash]);
    const log721 = erc721.logs.find((l) => l.topics[0] === SIG.transfer);
    check("ERC-721 Transfer log: 4 topics (tokenId = topic3) + data 0x", log721?.topics.length === 4 && log721.topics[3] === `0x${word(1)}` && log721.data === "0x", JSON.stringify(erc721.logs).slice(0, 300));
    const single = (await rpc("eth_getTransactionReceipt", [T.single.hash])).logs.find((l) => l.topics[0] === SIG.transferSingle);
    check("ERC-1155 TransferSingle log: operator/from/to + data (id, amount)", single?.topics.length === 4 && single.data === `0x${word(1)}${word(10)}`, JSON.stringify(single).slice(0, 300));
    const batchLog = (await rpc("eth_getTransactionReceipt", [T.batch.hash])).logs.find((l) => l.topics[0] === SIG.transferBatch);
    check("ERC-1155 TransferBatch log", batchLog?.topics.length === 4 && batchLog.topics[3] === `0x${addressWord(program("wallet"))}`, JSON.stringify(batchLog).slice(0, 300));
    const failed = await rpc("eth_getTransactionReceipt", [T.oog]);
    eq("tx ที่ล้มใน block → status 0x0", failed.status, "0x0");
    eq("tx ที่ถูกปฏิเสธ → status 0x0", (await rpc("eth_getTransactionReceipt", [T.rejected])).status, "0x0");
    const call = async (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
    eq("eth_call token.name()", decodeString(await call(token, callData("name()"))), "Scenario Full Token");
    eq("eth_call token.symbol()", decodeString(await call(token, callData("symbol()"))), "FULL");
    eq("eth_call token.decimals()", decodeUint(await call(token, callData("decimals()"))), 6n);
    eq("eth_call token.totalSupply()", decodeUint(await call(token, callData("totalSupply()"))), 1_000_000n * UNIT);
    eq("eth_call token.balanceOf(bob)", decodeUint(await call(token, callData("balanceOf(address)", addressWord(bob.address)))), 1000n * UNIT);
    eq("eth_call nft.name()", decodeString(await call(nft, callData("name()"))), "Scenario Full NFT");
    eq("eth_call nft.symbol()", decodeString(await call(nft, callData("symbol()"))), "SFN");
    eq("eth_call nft.ownerOf(1)", decodeAddress(await call(nft, callData("ownerOf(uint256)", word(1)))), bob.address);
    eq("eth_call nft.tokenURI(2)", decodeString(await call(nft, callData("tokenURI(uint256)", word(2)))), "https://example.com/scenario-full/nft/2");
    eq("eth_call nft.balanceOf(bob)", decodeUint(await call(nft, callData("balanceOf(address)", addressWord(bob.address)))), 2n);
    eq("eth_call nft.supportsInterface(ERC-721)", decodeUint(await call(nft, callData("supportsInterface(bytes4)", "80ac58cd".padEnd(64, "0")))), 1n);
    eq("eth_call multi.balanceOf(bob, 1)", decodeUint(await call(multi, callData("balanceOf(address,uint256)", addressWord(bob.address), word(1)))), 10n);
    eq("eth_call multi.uri(3)", decodeString(await call(multi, callData("uri(uint256)", word(3)))), "https://example.com/scenario-full/items/legendary.json");
    eq("eth_call multi.name()", decodeString(await call(multi, callData("name()"))), "Scenario Full Items");
    const history = await rpc("eth_feeHistory", ["0x5", "latest", [25, 75]]);
    check("eth_feeHistory: baseFeePerGas 6 ช่อง · gasUsedRatio 5 · reward 5", history.baseFeePerGas.length === 6 && history.gasUsedRatio.length === 5 && history.reward.length === 5, JSON.stringify(history).slice(0, 300));
    const genesisNow = await get("/genesis");
    check("eth_gasPrice ≥ base fee ของ block ถัดไป", BigInt(await rpc("eth_gasPrice")) >= big(genesisNow.baseFee));
    eq("eth_getBalance(alice) = ยอดของเชน", BigInt(await rpc("eth_getBalance", [alice.address, "latest"])), big((await get(`/address/${alice.address}?limit=1`)).native.balance));
    eq("eth_getTransactionCount(alice) = nonce", BigInt(await rpc("eth_getTransactionCount", [alice.address, "latest"])), BigInt((await get(`/nonce/${alice.address}`)).nonce));
    check("eth_getCode(token) = ซอร์สของโปรแกรม", (await rpc("eth_getCode", [token, "latest"])).length > 100);
    const trace = await rpc("debug_traceTransaction", [T.aggregate.hash, { tracer: "callTracer" }]);
    eq("debug_traceTransaction (callTracer) ของ aggregate: 2 call ย่อย", trace.calls?.length, 2);
    const receipts = await rpc("eth_getBlockReceipts", [hex(n)]);
    check("eth_getBlockReceipts ครบทุก tx", receipts.length === block.transactions.length, `${receipts.length} / ${block.transactions.length}`);
    const tokenBefore = BigInt(await rpc("eth_call", [{ to: token, data: callData("balanceOf(address)", addressWord(bob.address)) }, hex(T.tokenTransfer.tx.blockNumber - 1)]));
    eq("eth_call ย้อนหลัง (block ก่อนโอน) bob = 0", tokenBefore, 0n);
  });

  await section("16 REST ที่ explorer ใช้ (address · tokens · nfts · program · แบ่งหน้า)", async () => {
    const wallet = program("wallet");
    const aliceView = await get(`/address/${alice.address}`);
    check("GET /address/alice: namespace + nonce + tx", aliceView.metadata?.namespace === ns("alice") && aliceView.nonce > 10 && aliceView.transactions?.length > 0, JSON.stringify(aliceView).slice(0, 200));
    const tokens = await get(`/address/${alice.address}/tokens`);
    check("GET /address/alice/tokens มี FULL", tokens.some?.((t) => t.address === token && t.ticker === "FULL" && big(t.balance) > 0n), JSON.stringify(tokens).slice(0, 200));
    const bobNfts = await get(`/address/${bob.address}/nfts`);
    check("GET /address/bob/nfts: ERC-721 #1, #10 + ERC-1155 id 1 × 10", bobNfts.some?.((x) => x.program === nft && x.tokenId === "1n") && bobNfts.some((x) => x.program === nft && x.tokenId === "10n")
      && bobNfts.some((x) => x.program === multi && x.tokenId === "1n" && x.amount === "10n"), JSON.stringify(bobNfts).slice(0, 300));
    const walletNfts = await get(`/address/${wallet}/nfts`);
    check("GET /address/wallet/nfts: NFT #2 + items 2, 3", walletNfts.some?.((x) => x.program === nft && x.tokenId === "2n") && walletNfts.filter((x) => x.program === multi).length === 2, JSON.stringify(walletNfts).slice(0, 300));
    const tokenView = await get(`/program/${token}`);
    check("GET /program/token: token { ticker FULL, decimals 6 }", tokenView.token?.ticker === "FULL" && tokenView.token?.decimals === "6n", JSON.stringify(tokenView.token));
    eq("GET /program/nft: collection ERC-721", (await get(`/program/${nft}`)).collection?.standard, "ERC-721");
    eq("GET /program/multi: collection ERC-1155", (await get(`/program/${multi}`)).collection?.standard, "ERC-1155");
    const approved = await get("/programs/approved?limit=100");
    check("GET /programs/approved มีโปรแกรมของรอบนี้ (รวม clone)", ["token", "nft", "multi", "counter", "lab", "factory", "clone"].every((name) => approved.items?.some((p) => p.address === program(name)))
      || approved.total >= 12, `total ${approved.total}`);
    const blocks = await get("/blocks/page?page=1&limit=5");
    check("GET /blocks/page", blocks.items?.length === 5 && blocks.total >= blocks.items[0].number, JSON.stringify(blocks).slice(0, 150));
    const txs = await get(`/address/${alice.address}/txs?page=1&limit=5`);
    check("GET /address/alice/txs (เรียงตาม nonce, แบ่งหน้า)", txs.items?.length === 5 && txs.total >= 20 && txs.pages >= 4, JSON.stringify({ total: txs.total, pages: txs.pages }));
    const incoming = await get(`/address/${token}/incoming?page=1&limit=10`);
    check("GET /address/token/incoming (รวม call ซ้อนชั้น)", incoming.total >= 10 && incoming.items?.some((i) => i.depth >= 1), JSON.stringify({ total: incoming.total }));
    const interactions = await get(`/program/${token}/interactions?limit=5&cursor=`);
    check("GET /program/:a/interactions (cursor)", interactions.items?.length === 5 && interactions.next, JSON.stringify(interactions).slice(0, 150));
    const events = await get(`/program/${token}/events?page=1&limit=5`);
    check("GET /program/:a/events (แบ่งหน้า)", events.items?.length === 5 && events.total >= 10, JSON.stringify({ total: events.total }));
    const holders = await get(`/token/${token}/holders?page=1&limit=25`);
    check("GET /token/:a/holders (≥ 6 ราย เรียงมากไปน้อย)", holders.total >= 6 && big(holders.items[0].balance) >= big(holders.items.at(-1).balance), JSON.stringify({ total: holders.total }));
    const entries = await get(`/program/${token}/entries?name=balances&page=1&limit=25`);
    check("GET /program/:a/entries?name=balances", entries.items?.length >= 6, JSON.stringify({ total: entries.total }));
    const layout = await get(`/program/${program("lab")}/layout`);
    check("GET /program/:a/layout (Variables มี lastProbe)", JSON.stringify(layout).includes("lastProbe"), JSON.stringify(layout).slice(0, 150));
    // /sendtx คืน digest (EIP-712 ที่ผู้ใช้เซ็น) · VM hash อยู่ใน record — ค้นได้ทั้งคู่
    const byVmHash = await get(`/tx/${T.tokenTransfer.tx.hash}`);
    check("GET /tx/:hash ค้นได้ทั้ง VM hash และ digest ที่ผู้ใช้เซ็น", byVmHash.digest === T.tokenTransfer.hash && byVmHash.hash === T.tokenTransfer.tx.hash, json(byVmHash).slice(0, 200));
    const full = await get(`/block/${T.probe.tx.blockNumber}?full=1`);
    check("GET /block/:n?full=1 (replay) ตรงกับ header", full.hash === (await get(`/block/${T.probe.tx.blockNumber}`)).hash && full.transactions?.length >= 1);
    const state = await get(`/state/${token}?block=${T.tokenTransfer.tx.blockNumber - 1}`);
    check("GET /state/:a?block= (state ย้อนหลัง) ก่อนโอน bob ยังไม่มียอด", !JSON.stringify(state).includes(bob.address), JSON.stringify(state).slice(0, 150));
    // base fee ลงหลัง block ที่แน่น (ดูจาก header ช่วงหลัง)
    const latest = (await get("/genesis")).latest;
    const raised = big((await get(`/block/${T.heavyBlock + 1}`)).baseFeePerGas);
    let lowered = null;
    for (let n = T.heavyBlock + 2; n <= latest && lowered === null; n += 1) { const h = await get(`/block/${n}`); if (big(h.baseFeePerGas) < raised) lowered = n; }
    check("base fee ลงเมื่อ block ใช้แก๊สน้อยกว่า target", lowered !== null, `ไม่มี block หลัง ${T.heavyBlock + 1} ที่ base fee ต่ำกว่า ${raised}`);
  });

  if (OPTIONS.sync) {
    await section("17 sync: node ผู้อ่าน replay ทุก block แล้วได้ head hash เดียวกัน", async () => {
      // node ผู้อ่าน = server.js ตัวที่สองในโปรเซสนี้ (ตั้งค่าเดียวกันทุกอย่างจาก env · MemoryDB · ไม่เปิด port ไม่ปิด block เอง)
      delete process.env.DATA;
      const cwd = process.cwd();
      process.chdir(ROOT);   // server.js อ่าน genesis.json จาก cwd
      const reader = await import("../server.js");
      process.chdir(cwd);
      clearInterval(reader.miner);
      const fetchBlocks = async (from) => get(`/sync?from=${from}`);
      const started = Date.now();
      let added = 0;
      for (let round = 0; round < 1000; round += 1) {
        const count = await syncOnce(reader.vm, fetchBlocks);
        added += count;
        if (!count) break;
      }
      const head = await get("/block/latest");
      const local = reader.vm.getBlock(reader.vm.latestBlockNumber());
      eq("genesis hash ตรงกัน", reader.vm.genesisHash(), (await get("/genesis")).hash);
      eq(`ซิงก์ครบ ${added} block (เลข block ล่าสุด)`, reader.vm.latestBlockNumber(), head.number);
      eq("head hash ตรงกับผู้ผลิต", local?.hash, head.hash);
      eq("stateRoot ตรงกับผู้ผลิต", local?.stateRoot, head.stateRoot);
      console.log(`      (replay ${added} block ใน ${((Date.now() - started) / 1000).toFixed(1)} วินาที)`);
    });
  } else {
    current = "17 sync";
    skip("sync ด้วย node ผู้อ่าน", "เปิดด้วย --spawn หรือ --sync (env ของ server ต้องตรงกับโปรเซสนี้)");
  }
}

async function summary() {
  const failed = report.checks.filter((c) => !c.ok);
  const skipped = report.checks.filter((c) => c.skipped);
  const passed = report.checks.length - failed.length - skipped.length;
  report.summary = { passed, failed: failed.length, skipped: skipped.length, total: report.checks.length };
  report.finishedAt = new Date().toISOString();
  console.log("\n================ scenario-full ================");
  console.log(`  ผ่าน ${passed} · ไม่ผ่าน ${failed.length} · ข้าม ${skipped.length} (รวม ${report.checks.length} ข้อ)`);
  for (const c of failed) console.log(`  ❌ [${c.section}] ${c.name} — ${c.detail ?? ""}`.slice(0, 400));
  console.log("\n  โปรแกรมตัวอย่าง (explorer ของเรา · Blockscout)");
  const kind = { token: "ERC-20", nft: "ERC-721", multi: "ERC-1155", wallet: "ERC-1271 wallet", counter: "upgradeable", lab: "nested / API",
    gasLab: "gas / sandbox", multicall: "multicall", note: "clone template", factory: "factory", clone: "clone", rejectable: "rejected" };
  for (const [name, address] of Object.entries(report.programs)) {
    if (!address) continue;
    console.log(`  ${name.padEnd(11)} ${(kind[name] ?? "").padEnd(16)} ${address}  ${API}/#address/${address}  ·  ${OPTIONS.blockscout}/${name === "token" || name === "nft" || name === "multi" ? "token" : "address"}/${address}`);
  }
  console.log("\n  tx ที่น่าดู (hash ของ VM = hash ที่ Blockscout ใช้ · explorer ของเราค้นได้ทั้ง VM hash และ digest ที่เซ็น)");
  report.vmHashes = {};
  for (const [label, digest] of Object.entries(report.txs).filter(([label]) => /permit|safeTransfer|Batch|aggregate|nested|STATICCALL|caught|probe|cloneProgram|initUpgrade|replace|rejected|failed|legacy|EIP-1559|value 0/.test(label))) {
    const hash = (await get(`/tx/${digest}`).catch(() => null))?.hash ?? digest;
    report.vmHashes[label] = hash;
    console.log(`  ${label.padEnd(48)} ${API}/#tx/${hash}  ·  ${OPTIONS.blockscout}/tx/${hash}`);
  }
  console.log(`\n  กระเป๋า: ${Object.entries(report.wallets).map(([n, a]) => `${n} ${short(a)}`).join(" · ")}`);
  console.log(`  Blockscout: ตั้ง ETHEREUM_JSONRPC_HTTP_URL=${API}/evm (ดู docs/blockscout.md) · รายงาน: ${OPTIONS.out}`);
}

// ============================================================================
async function startServer() {
  const port = await new Promise((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  // env เดียวกันนี้ถูกใช้กับ node ผู้อ่านในหัวข้อ sync ด้วย (import server.js ในโปรเซสนี้) → ตั้งไว้ใน process.env
  process.env.BLOCK_MS ??= OPTIONS.quick ? "300" : "1000";
  process.env.UPGRADE_DELAY_BLOCKS ??= "2";
  process.env.RATE_LIMIT = "0";
  process.env.EVM_RATE_LIMIT = "0";
  const env = { ...process.env, PORT: String(port), ...(OPTIONS.data ? { DATA: OPTIONS.data } : {}) };
  if (!OPTIONS.data) delete env.DATA;
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
  API = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) { if (await fetch(`${API}/genesis`).then(() => true, () => false)) break; await wait(100); }
  console.log(`เปิด server ให้เอง: ${API} (BLOCK_MS ${process.env.BLOCK_MS} · UPGRADE_DELAY_BLOCKS ${process.env.UPGRADE_DELAY_BLOCKS})`);
  return child;
}

const child = OPTIONS.spawn ? await startServer() : null;
try {
  await main();
} catch (error) {
  check("scenario ทำงานจนจบ", false, error.stack ?? error);
} finally {
  await summary().catch((error) => console.error("สรุปผลล้ม:", error.message));
  fs.writeFileSync(OPTIONS.out, JSON.stringify(report, null, 2));
  if (child) child.kill();
}
process.exitCode = report.summary.failed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200).unref();
