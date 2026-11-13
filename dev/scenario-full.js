/**
 * A scenario covering every chain feature — sends real txs to the server and checks every result on chain (not just "queued")
 * The results can be viewed both in our explorer (REST) and in Blockscout (via /evm JSON-RPC)
 *
 *   RATE_LIMIT=0 GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run dev   # server (sends from one machine, so the per-IP rate limit must be off · prices / gas budget based on 1 gwei + DEFAULT_GAS · see HANDOFF.md item 10)
 *   npm run scenario:full                      # in another terminal · http://localhost:3000
 *   npm run scenario:full -- --spawn           # starts the server itself (MemoryDB · random PORT · BLOCK_MS 1000 · UPGRADE_DELAY_BLOCKS 2 · GAS_PRICE 1 gwei · genesis without forks · MAX_BLOCK_GAS 3M)
 *   npm run scenario:full -- --spawn --quick   # faster blocks (BLOCK_MS 300) for tests
 *
 * Sections checked (every check prints ✅ / ❌ · a single failure = exit code 1)
 *    0 wallet setup            genesis · coin distribution (legacy gasPrice txs and EIP-1559 txs)
 *    1 deploy / init / reject  team approves / rejects (refund) · namespace · metadata.abi · GET /program/:a/abi
 *    2 native + gas fees       transfer 0 · legacy / 1559 · burnedFee / producerFee · base fee rises when blocks are full, then falls
 *    3 mempool                 replace-by-fee (+10%) · replaced · price too low · rejected txs recorded in a block · /pending
 *    4 token (ERC-20)          transfer · approve / transferFrom · multiTransfer · permit ERC-2612 / EIP-712 (signed by a person + by a program wallet · expiry)
 *    5 NFT (ERC-721)           mint · safeTransferFrom to a person / to a program wallet · approve / operator · tokenURI
 *    6 multi-token (ERC-1155)  mint / mintBatch · single / batch transfer · operator · uri
 *    7 ERC-1271 wallet         isValidSignature · execute
 *    8 multicall               aggregate / tryAggregate / readonly · a tx bundling several calls
 *    9 program calls program   nested runProgram · STATICCALL forbids writes (FORBIDDEN) · catch a failing inner call
 *   10 program APIs            BlockHash … Math.random, each compared with the chain's real values
 *   11 program upgrades        upgrade → reject → upgrade → approve (+ timelock) · migrate · versions · setUpgrader / renounce
 *   12 cloneProgram            a program factory (address predictable in advance, CREATE2-style)
 *   13 gas / sandbox           infinite loop → OUT_OF_GAS · OUT_OF_MEMORY · both "in the block" (gas charged, status 0x0)
 *   14 indexed events          GET /program/:a/events?name=&field= · eth_getLogs by topic
 *   15 /evm (Blockscout)       block / tx / receipt / log ERC-20 · ERC-721 · ERC-1155 / eth_call / fee history / failed txs
 *   16 explorer REST           address · tokens · nfts · program · pagination · holders · versions
 *   17 sync                    a reader node (in this process, configured like the server) replays every block and gets the same head hash
 *
 * Options
 *   --url <url>          server (http://localhost:3000)
 *   --spawn              start server.js itself · --data <dir> to use LMDB
 *   --quick              (with --spawn) BLOCK_MS 300
 *   --tag <text>         run name, used as the seed for wallets and namespaces (default = random → can re-run on the same chain)
 *   --admin-key <key>    team key (the server sets ADMINS) · omitted = use the funder
 *   --funder-key <key>   wallet funded by genesis (Hardhat #1)
 *   --sync / --no-sync   check sync with a reader node (default: on with --spawn · with a server you started yourself, env must match)
 *   --blockscout <url>   print Blockscout links at the end of the report (http://localhost)
 *   --out <file>         JSON report (scenario-full-report.json)
 *
 * ⚠️ wallet keys are derived from --tag for testing only · never use them with real funds
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
import { signPermit, permitDigest, permitDomainSeparator, signWalletHash, signProgramMessage, signTypedDataDigest } from "../src/crypto/program-signature.js";
import { eip712Digest, eip712DomainSeparator } from "../src/crypto/eip712.js";
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

// ---------- units / helpers ----------
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

// EVM-style ABI (for eth_call / logs) — hand-written to avoid depending on ethers
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

// ---------- wallets ----------
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
  if (response.status === 429) throw new Error("server returned 429 (per-IP rate limit) — start the server with RATE_LIMIT=0 or use --spawn");
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
  if (result.status !== "success") throw new Error(`query ${functionName} failed: ${result.error?.message ?? JSON.stringify(result)}`);
  return result.result;
};

// ---------- report ----------
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
const eq = (name, actual, expected) => check(name, String(actual) === String(expected), `got ${json(actual)}, expected ${json(expected)}`);
async function section(title, body) {
  current = title;
  console.log(`\n▶ ${title}`);
  const started = Date.now();
  try { await body(); } catch (error) { check("run this step to completion", false, error.stack?.split("\n").slice(0, 3).join(" | ") ?? error); }
  console.log(`   (${((Date.now() - started) / 1000).toFixed(1)} seconds)`);
}

// ---------- send txs / wait for blocks ----------
let CHAIN_ID = 1;
const DEFAULT_FEES = { maxFeePerGas: gwei(20), maxPriorityFeePerGas: "0" };

/** Signs and sends a tx → { queued, hash, …response } (fields with gasPrice = legacy · without = EIP-1559) */
async function send(wallet, fields, { nonce } = {}) {
  const n = nonce ?? (await get(`/nonce/${wallet.address}`)).nonce;
  const legacy = fields.gasPrice !== undefined;
  const tx = { chainId: CHAIN_ID, from: wallet.address, to: "", method: "", input: {}, value: 0, nonce: n, gasLimit: 1_000_000,
    ...(legacy ? {} : DEFAULT_FEES), ...fields };
  const signature = sign.signTransaction(tx, wallet.key);
  const response = await post("/sendtx", { tx, signature });
  return { ...response, hash: response.hash ?? sign.verifyTransaction({ tx, signature }).hash, tx };
}
/** Sends and requires it to be queued → hash */
async function sendOk(wallet, fields, label, options) {
  const response = await send(wallet, fields, options);
  if (!response.queued) throw new Error(`${label} not queued: ${JSON.stringify(response.simulation?.error ?? response.error ?? response.reason ?? response).slice(0, 300)}`);
  if (label) report.txs[label] = response.hash;
  return response.hash;
}
/** Waits for every hash to land in a block → { hash: /tx record } */
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
  throw new Error(`tx not in a block within ${timeoutMs / 1000} seconds: ${list.filter((h) => !found[h]).join(", ")}`);
}
/** Sends a batch of txs (each entry [wallet, fields, label]) in order, then waits for all to land in a block → [{ hash, tx, receipt }] */
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
 * Starts at the beginning of a new block: the server only closes a block when txs are queued → send a 0 transfer to self and wait for it to land
 * (after this there is nearly a full BLOCK_MS before the next block — use it for txs that must be in the queue together)
 */
async function freshBlock() {
  await mined(await sendOk(funder, { action: "transfer", to: funder.address, value: "0" }));
}
/** Sends small txs to produce blocks up to the target number (used to wait out the timelock) */
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
  const T = {};   // txs re-checked in later sections (e.g. /evm)

  await section("0 wallet setup (genesis + coin distribution)", async () => {
    check("GET /genesis has hash + baseFee + maxBlockGas", genesis.hash && genesis.baseFee && genesis.maxBlockGas, JSON.stringify(genesis));
    check("funder has funds from genesis", big((await get(`/address/${funder.address}?limit=1`)).native.balance) > 10_000n * COIN, funder.address);
    const sent = await batch([
      [funder, { action: "transfer", to: alice.address, value: coins(1000), gasPrice: gwei(2) }, "fund alice (legacy gasPrice)"],
      [funder, { action: "transfer", to: bob.address, value: coins(1000), gasPrice: gwei(2) }, "fund bob (legacy gasPrice)"],
      [funder, { action: "transfer", to: carol.address, value: coins(1000), maxPriorityFeePerGas: gwei(1) }, "fund carol (EIP-1559)"],
      [funder, { action: "transfer", to: dave.address, value: coins(1000), maxPriorityFeePerGas: gwei(1) }, "fund dave (EIP-1559)"],
      [funder, { action: "transfer", to: erin.address, value: coins(1000) }, "fund erin (EIP-1559 tip 0)"],
      ...(admin !== funder ? [[funder, { action: "transfer", to: admin.address, value: coins(100) }, "fund admin"]] : []),
    ]);
    sent.forEach((item, i) => success(`coin distribution tx ${i + 1} succeeded`, item));
    for (const wallet of Object.values(W)) eq(`${wallet.name} received 1000 coins`, (await get(`/address/${wallet.address}?limit=1`)).native.balance, `${1000n * COIN}n`);
    T.legacy = sent[0];
    T.fee1559 = sent[2];
  });

  await section("1 deploy → team init / reject · namespace · metadata.abi", async () => {
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
    check("pending list (/programs/pending) has every program", plan.every(([name]) => pending.items?.some((p) => p.address === program(name))), JSON.stringify(pending).slice(0, 200));
    eq("before init: GET /program/:a returns 404", (await get(`/program/${program("token")}`)).httpStatus, 404);
    const carolBefore = big((await get(`/address/${carol.address}?limit=1`)).native.received);

    const reviewed = await batch(plan.map(([name]) => [admin, { action: name === "rejectable" ? "reject" : "init", to: program(name) }, `${name === "rejectable" ? "reject" : "init"} ${name}`]));
    reviewed.forEach((item, i) => success(`${plan[i][0] === "rejectable" ? "reject" : "init"} ${plan[i][0]}`, item));
    for (const [name] of plan.filter(([n]) => n !== "rejectable")) check(`${name}: has code after init`, (await get(`/program/${program(name)}`)).code, program(name));
    eq("reject: GET /program/:a is still 404", (await get(`/program/${program("rejectable")}`)).httpStatus, 404);
    eq("reject: 1 coin value refunded to the deployer", big((await get(`/address/${carol.address}?limit=1`)).native.received) - carolBefore, COIN);
    check("reject: no longer in the pending list", !(await get("/programs/pending?limit=100")).items?.some((p) => p.address === program("rejectable")));

    eq("namespace → address (GET /name/:ns)", (await get(`/name/${ns("counter")}`)).address, program("counter"));
    eq("metadata.creator = the deployer", (await get(`/address/${program("counter")}?limit=1`)).metadata.creator, bob.address);
    eq("metadata.upgrader (set at deploy)", (await get(`/address/${program("counter")}?limit=1`)).metadata.upgrader, alice.address);
    const abi = await get(`/program/${program("counter")}/abi`);
    check("metadata.abi + GET /program/:a/abi", abi.abi?.functions?.some((f) => f.name === "increment") && abi.evmAbi?.some((f) => f.name === "increment"), JSON.stringify(abi).slice(0, 200));
    const evmAbi = await rpc("cardianal_getAbi", [program("lab")]);
    check("/evm cardianal_getAbi → Ethereum-style JSON ABI", Array.isArray(evmAbi) && evmAbi.some((f) => f.name === "probe" && f.type === "function"), JSON.stringify(evmAbi).slice(0, 200));
    check("deploy receipt has contractAddress (/evm)", lower((await rpc("eth_getTransactionReceipt", [T.deployToken.hash])).contractAddress) === program("token"));
  });

  await section("2 native + gas fees (transfer 0 · legacy / EIP-1559 · burn / block producer · base fee)", async () => {
    const before = { bob: big((await get(`/address/${bob.address}?limit=1`)).native.balance), dave: big((await get(`/address/${dave.address}?limit=1`)).native.balance),
      burned: big((await get("/genesis")).burned) };
    const [zero, legacy, tipped] = await batch([
      [alice, { action: "transfer", to: bob.address, value: "0" }, "native transfer value 0"],
      [bob, { action: "transfer", to: carol.address, value: `${15n * COIN / 10n}`, gasPrice: gwei(3) }, "native transfer legacy gasPrice 3 gwei"],
      [carol, { action: "transfer", to: dave.address, value: `${COIN / 4n}`, maxFeePerGas: gwei(20), maxPriorityFeePerGas: gwei(2) }, "native transfer EIP-1559 tip 2 gwei"],
    ]);
    success("native transfer of 0 succeeds (charges gas + uses a nonce)", zero);
    check("transfer 0: the sender pays gas", big(zero.receipt.fee) > 0n, JSON.stringify(zero.receipt.fee));
    success("legacy gasPrice transfer", legacy);
    success("EIP-1559 transfer", tipped);
    const header = await get(`/block/${tipped.tx.blockNumber}`);
    const baseFee = big(header.baseFeePerGas);
    eq("legacy: effectiveGasPrice = gasPrice", big(legacy.receipt.effectiveGasPrice), 3n * GWEI);
    eq("1559: effectiveGasPrice = baseFee + tip", big(tipped.receipt.effectiveGasPrice), baseFee + 2n * GWEI);
    eq("1559: receipt.type = 2", tipped.receipt.type, 2);
    eq("1559: burnedFee = gasUsed × baseFee", big(tipped.receipt.burnedFee), BigInt(tipped.receipt.gasUsed) * baseFee);
    eq("1559: producerFee = gasUsed × tip", big(tipped.receipt.producerFee), BigInt(tipped.receipt.gasUsed) * 2n * GWEI);
    eq("fee = burnedFee + producerFee", big(tipped.receipt.fee), big(tipped.receipt.burnedFee) + big(tipped.receipt.producerFee));
    eq("recipient gets the full value", big((await get(`/address/${dave.address}?limit=1`)).native.balance) - before.dave, COIN / 4n);
    eq("transfer 0: recipient balance unchanged (except the legacy one bob paid)", before.bob - big((await get(`/address/${bob.address}?limit=1`)).native.balance), 15n * COIN / 10n + big(legacy.receipt.fee));
    check("header has burnedFee / producerFee", big(header.burnedFee) > 0n && big(header.producerFee) > 0n, JSON.stringify([header.burnedFee, header.producerFee]));
    check("burned amount (zero address) increases", big((await get("/genesis")).burned) > before.burned);
    check("feeRecipient (miner) receives the tip", big((await get(`/address/${header.feeRecipient ?? MINER_DEFAULT}?limit=1`)).native.balance) > 0n);
    T.tipped = tipped;
    T.legacy2 = legacy;

    // base fee rises: one tx uses more gas than gasTarget (1.5M) → the next block's base fee is higher
    await freshBlock();
    const [burn] = await batch([[erin, { action: "call", to: program("gasLab"), method: "burn", input: { rounds: "100000n" }, gasLimit: 2_500_000 }, "gasLab.burn (full block)"]]);
    success("burn uses lots of gas", burn);
    const heavy = await get(`/block/${burn.tx.blockNumber}`);
    check("the full block uses more gas than gasTarget", heavy.gasUsed > heavy.gasTarget, `${heavy.gasUsed} / ${heavy.gasTarget}`);
    await fillUntil(heavy.number + 1);
    const after = await get(`/block/${heavy.number + 1}`);
    check("the next block's base fee rises (EIP-1559)", big(after.baseFeePerGas) > big(heavy.baseFeePerGas), `${heavy.baseFeePerGas} → ${after.baseFeePerGas}`);
    T.heavyBlock = heavy.number;
  });

  await section("3 mempool: replace-by-fee · replaced · rejected txs recorded in a block · /pending", async () => {
    let original, replacement, done = false;
    for (let attempt = 1; attempt <= 3 && !done; attempt += 1) {
      await freshBlock();
      const { nonce } = await get(`/nonce/${dave.address}`);
      original = await send(dave, { action: "transfer", to: erin.address, value: "1000", maxFeePerGas: gwei(10), maxPriorityFeePerGas: gwei(1) }, { nonce });
      replacement = await send(dave, { action: "transfer", to: erin.address, value: "2000", maxFeePerGas: gwei(11), maxPriorityFeePerGas: "1100000000" }, { nonce });
      if (!original.queued || !replacement.queued) continue;   // block closed between the two → retry
      const pending = await get("/pending");
      const low = await send(dave, { action: "transfer", to: erin.address, value: "3000", maxFeePerGas: "11500000000", maxPriorityFeePerGas: "1150000000" }, { nonce });
      const replaced = await get(`/tx/${original.hash}`);
      if (replaced.status !== "replaced") continue;
      done = true;
      check("the original is queued", original.queued);
      check("the replacement (+10% on both maxFee and tip) is queued", replacement.queued, JSON.stringify(replacement).slice(0, 200));
      eq("GET /tx of the original → replaced", replaced.status, "replaced");
      eq("replacedBy = the new one", replaced.replacedBy, replacement.hash);
      check("/pending shows the new one, not the original", pending.transactions.some((t) => t.hash === replacement.hash) && !pending.transactions.some((t) => t.hash === original.hash), JSON.stringify(pending).slice(0, 300));
      check("replacing with less than a 10% bump → rejected", !low.queued && /too low|ต่ำเกินไป/.test(String(low.reason ?? low.error ?? "")), JSON.stringify(low).slice(0, 200));
      const found = await mined(replacement.hash);
      eq("the new one lands in a block successfully", found[replacement.hash].status, "success");
      eq("the original is still replaced after the block closes", (await get(`/tx/${original.hash}`)).status, "replaced");
      eq("/evm eth_getTransactionByHash of the original = null (like geth)", await rpc("eth_getTransactionByHash", [original.hash]), null);
      report.txs["replaced (original)"] = original.hash;
      report.txs["replace-by-fee (new)"] = replacement.hash;
    }
    if (!done) check("replace-by-fee", false, `did not succeed in 3 tries: ${JSON.stringify({ original, replacement }).slice(0, 300)}`);

    // nonce gap → rejected at /sendtx and recorded in the next block
    const { nonce } = await get(`/nonce/${erin.address}`);
    const bad = await send(erin, { action: "transfer", to: alice.address, value: "1" }, { nonce: nonce + 7 });
    check("nonce gap → not queued", !bad.queued && /nonce/.test(bad.reason ?? ""), JSON.stringify(bad).slice(0, 200));
    const waiting = await get(`/tx/${bad.hash}`);
    check("GET /tx → rejected (waiting for a block)", waiting.status === "rejected", JSON.stringify(waiting).slice(0, 200));
    // the server holds rejected txs (REJECTED_HOLD_MS, default 60 s) → it doesn't close an empty block for them, they ride along with the next block that has a real tx
    const { rejectedHoldMs } = await get("/pending");
    if (rejectedHoldMs >= 5000) {
      await wait(2500);
      check("a rejected tx alone does not close a block yet (waits for a real tx)", (await get(`/tx/${bad.hash}`)).blockNumber == null);
    } else skip("a rejected tx alone does not close a block yet", `server sets REJECTED_HOLD_MS = ${rejectedHoldMs}`);
    const ride = await send(alice, { action: "transfer", to: erin.address, value: "1" });
    check("the next real tx is queued", ride.queued, JSON.stringify(ride).slice(0, 200));
    const rideBlock = (await mined(ride.hash))[ride.hash]?.blockNumber;
    let recorded = await get(`/tx/${bad.hash}`);
    for (let i = 0; i < 50 && !Number.isInteger(recorded.blockNumber); i += 1) { await wait(100); recorded = await get(`/tx/${bad.hash}`); }
    check("the rejected tx is recorded in a block (blockNumber)", Number.isInteger(recorded.blockNumber), JSON.stringify(recorded).slice(0, 200));
    eq("rides along in the same block as the real tx", recorded.blockNumber, rideBlock);
    const header = await get(`/block/${recorded.blockNumber}`);
    check("header.rejectedCount ≥ 1 + rejectedRoot", header.rejectedCount >= 1 && header.rejectedRoot, JSON.stringify(header).slice(0, 200));
    const full = await get(`/block/${recorded.blockNumber}?full=1`);
    check("GET /block/:n?full=1 lists it as rejected (blockrejected)", full.rejected?.some((r) => r.hash === bad.hash), JSON.stringify(full.rejected).slice(0, 200));
    check("GET /rejected?address= includes this tx", (await get(`/rejected?address=${erin.address}`)).items?.some((r) => r.hash === bad.hash));
    const evmReceipt = await rpc("eth_getTransactionReceipt", [bad.hash]);
    check("/evm: a rejected tx has status 0x0 gasUsed 0", evmReceipt?.status === "0x0" && evmReceipt.gasUsed === "0x0", JSON.stringify(evmReceipt).slice(0, 200));
    eq("on-chain nonce unchanged", (await get(`/nonce/${erin.address}`)).nonce, nonce);
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
    eq("bob received 1000 FULL", await balanceOf(bob.address), 1000n * UNIT);
    eq("allowance(alice, bob) = 500", big(await read(token, "allowance", { owner: alice.address, spender: bob.address })), 500n * UNIT);
    eq("multiTransfer: the program wallet received 5000", await balanceOf(wallet), 5000n * UNIT);
    eq("multiTransfer returns the entry count", first[2].receipt.result, "3n");
    eq("metadata action: the wallet's /name/ → alice", (await get(`/name/${ns("alice")}`)).address, alice.address);
    T.tokenTransfer = first[0];

    // ERC-2612: deadline in seconds · signature = eth_signTypedData_v4 of { domain: name / "1" / chainId / token, Permit }
    const deadline = `${BigInt(Math.floor(Date.now() / 1000) + 3600)}`;
    const name = await read(token, "name");
    const permitFields = (owner, spender, value, nonce, end = deadline) => ({ name, chainId: CHAIN_ID, verifyingContract: token, owner, spender, value, nonce, deadline: end });
    eq("DOMAIN_SEPARATOR() = the token's EIP-712 domainSeparator", await read(token, "DOMAIN_SEPARATOR"), permitDomainSeparator({ name, chainId: CHAIN_ID, verifyingContract: token }));
    const aliceNonce = big(await read(token, "nonces", { owner: alice.address }));
    const alicePermit = permitFields(alice.address, dave.address, 300n * UNIT, aliceNonce);
    const walletPermit = permitFields(wallet, erin.address, 50n * UNIT, big(await read(token, "nonces", { owner: wallet })));
    const permitInput = (f, signature) => ({ owner: f.owner, spender: f.spender, value: `${f.value}n`, deadline: `${f.deadline}n`, signature });
    const signedAlice = permitInput(alicePermit, signPermit(alicePermit, alice.key));
    // the program wallet's owner signs the permit typed data (owner = the wallet), same as MetaMask = signing the digest directly
    const walletSignature = signPermit(walletPermit, alice.key);
    eq("program wallet permit signature = signWalletHash(permitDigest)", walletSignature, signWalletHash(permitDigest(walletPermit), alice.key));
    const expiredPermit = permitFields(alice.address, dave.address, 1n, aliceNonce, `${BigInt(Math.floor(Date.now() / 1000) - 60)}`);
    const expired = await send(dave, { action: "call", to: token, method: "permit", input: permitInput(expiredPermit, signPermit(expiredPermit, alice.key)) });
    check("expired permit (deadline in seconds already passed) → permit expired", !expired.queued && /permit expired/.test(JSON.stringify(expired)), JSON.stringify(expired).slice(0, 200));
    const second = await batch([
      [bob, { action: "call", to: token, method: "transferFrom", input: { from: alice.address, to: carol.address, amount: units(200) } }, "token.transferFrom (bob uses the allowance)"],
      [dave, { action: "call", to: token, method: "permit", input: signedAlice }, "token.permit (alice signs EIP-712 · dave submits)"],
      [dave, { action: "call", to: token, method: "permit", input: permitInput(walletPermit, walletSignature) }, "token.permit (ERC-1271 program wallet)"],
    ]);
    second.forEach((item, i) => success(["transferFrom", "permit signed by a person", "permit by a program wallet (readonly isValidSignature)"][i], item));
    eq("transferFrom lowers the allowance to 300", big(await read(token, "allowance", { owner: alice.address, spender: bob.address })), 300n * UNIT);
    eq("permit sets allowance(alice, dave) = 300", big(await read(token, "allowance", { owner: alice.address, spender: dave.address })), 300n * UNIT);
    eq("permit bumps nonces(alice) to 1", await read(token, "nonces", { owner: alice.address }), "1n");
    eq("ERC-1271 permit sets allowance(wallet, erin) = 50", big(await read(token, "allowance", { owner: wallet, spender: erin.address })), 50n * UNIT);
    const replay = await send(dave, { action: "call", to: token, method: "permit", input: signedAlice });
    check("reusing a permit signature → rejected", !replay.queued && /invalid permit signature/.test(JSON.stringify(replay)), JSON.stringify(replay).slice(0, 200));

    const third = await batch([
      [dave, { action: "call", to: token, method: "transferFrom", input: { from: alice.address, to: erin.address, amount: units(300) } }, "token.transferFrom (uses the permit allowance)"],
      [erin, { action: "call", to: token, method: "transferFrom", input: { from: wallet, to: erin.address, amount: units(50) } }, "token.transferFrom (from the program wallet)"],
    ]);
    third.forEach((item, i) => success(["transferFrom with the permit allowance", "transferFrom from the program wallet"][i], item));
    eq("erin received 350 FULL", await balanceOf(erin.address), 350n * UNIT);
    eq("totalSupply unchanged", await read(token, "totalSupply"), units(1_000_000));
  });

  const nft = program("nft");
  await section("5 NFT (ERC-721): mint · safeTransferFrom (person / program wallet) · approve / operator · tokenURI", async () => {
    const wallet = program("wallet");
    const mints = await batch([
      [alice, { action: "call", to: nft, method: "mint", input: { to: alice.address, uri: "https://example.com/scenario-full/nft/genesis.json" } }, "nft.mint #1 (its own uri)"],
      [alice, { action: "call", to: nft, method: "mint", input: { to: alice.address } }, "nft.mint #2"],
      [alice, { action: "call", to: nft, method: "mint", input: { to: alice.address } }, "nft.mint #3"],
      [alice, { action: "call", to: nft, method: "mint", input: { to: bob.address, tokenId: "10n" } }, "nft.mint #10 → bob"],
    ]);
    mints.forEach((item, i) => success(`mint #${[1, 2, 3, 10][i]}`, item));
    eq("mint returns the next tokenId", mints.map((m) => m.receipt.result).join(","), "1n,2n,3n,10n");
    const moves = await batch([
      [alice, { action: "call", to: nft, method: "safeTransferFrom", input: { from: alice.address, to: bob.address, tokenId: "1n" } }, "nft.safeTransferFrom #1 → bob"],
      [alice, { action: "call", to: nft, method: "safeTransferFrom", input: { from: alice.address, to: wallet, tokenId: "2n" } }, "nft.safeTransferFrom #2 → WALLET_PROGRAM"],
      [alice, { action: "call", to: nft, method: "approve", input: { to: bob.address, tokenId: "3n" } }, "nft.approve #3 → bob"],
      [alice, { action: "call", to: nft, method: "setApprovalForAll", input: { operator: dave.address, approved: true } }, "nft.setApprovalForAll dave"],
    ]);
    moves.forEach((item, i) => success(["safeTransferFrom to a person", "safeTransferFrom to a program wallet (onERC721Received)", "approve", "setApprovalForAll"][i], item));
    check("safe transfer to a program: trace has onERC721Received", moves[1].receipt.trace?.some((t) => t.method === "onERC721Received" && t.status === "success"), JSON.stringify(moves[1].receipt.trace).slice(0, 300));
    eq("getApproved(#3) = bob", await read(nft, "getApproved", { tokenId: "3n" }), bob.address);
    eq("isApprovedForAll(alice, dave)", await read(nft, "isApprovedForAll", { owner: alice.address, operator: dave.address }), true);
    const bad = await send(alice, { action: "call", to: nft, method: "safeTransferFrom", input: { from: alice.address, to: program("counter"), tokenId: "3n" } });
    check("safeTransferFrom to a program that doesn't accept NFTs → rejected", !bad.queued, JSON.stringify(bad).slice(0, 200));
    const [approved] = await batch([[bob, { action: "call", to: nft, method: "transferFrom", input: { from: alice.address, to: carol.address, tokenId: "3n" } }, "nft.transferFrom #3 (bob is approved) → carol"]]);
    success("transferFrom with approve rights", approved);
    eq("ownerOf(#1) = bob", await read(nft, "ownerOf", { tokenId: "1n" }), bob.address);
    eq("ownerOf(#2) = the program wallet", await read(nft, "ownerOf", { tokenId: "2n" }), wallet);
    eq("ownerOf(#3) = carol", await read(nft, "ownerOf", { tokenId: "3n" }), carol.address);
    eq("getApproved(#3) cleared after the transfer", await read(nft, "getApproved", { tokenId: "3n" }), null);
    eq("balanceOf(bob) = 2", await read(nft, "balanceOf", { owner: bob.address }), "2n");
    eq("tokenURI(#1) = the item's uri", await read(nft, "tokenURI", { tokenId: "1n" }), "https://example.com/scenario-full/nft/genesis.json");
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
    moves.forEach((item, i) => success(["safeTransferFrom", "safeBatchTransferFrom to a program wallet (onERC1155BatchReceived)", "setApprovalForAll"][i], item));
    const [operator] = await batch([[dave, { action: "call", to: multi, method: "safeTransferFrom", input: { from: alice.address, to: carol.address, id: "1n", amount: "7n" } }, "multi.safeTransferFrom by operator dave"]]);
    success("operator transfers on the owner's behalf", operator);
    const balances = await read(multi, "balanceOfBatch", { accounts: [alice.address, bob.address, carol.address, wallet, wallet], ids: ["1n", "1n", "1n", "2n", "3n"] });
    eq("balanceOfBatch [alice#1, bob#1, carol#1, wallet#2, wallet#3]", balances.join(","), "83n,10n,7n,5n,1n");
    eq("totalSupply(id 1) = 100", await read(multi, "totalSupply", { id: "1n" }), "100n");
    eq("uri(1) = template {id}", await read(multi, "uri", { id: "1n" }), "https://example.com/scenario-full/items/{id}.json");
    eq("uri(3) = the one from setURI", await read(multi, "uri", { id: "3n" }), "https://example.com/scenario-full/items/legendary.json");
    eq("isApprovedForAll(alice, dave)", await read(multi, "isApprovedForAll", { account: alice.address, operator: dave.address }), true);
    T.single = moves[0];
    T.batch = moves[1];
  });

  await section("7 ERC-1271 program wallet: isValidSignature · execute", async () => {
    const wallet = program("wallet");
    const hash = keccakText(`scenario-full ${OPTIONS.tag}`);
    eq("isValidSignature (signed by the owner) = magic", await read(wallet, "isValidSignature", { hash, signature: signWalletHash(hash, alice.key) }), ERC1271_MAGIC_VALUE);
    eq("isValidSignature (signed by someone else) = 0xffffffff", await read(wallet, "isValidSignature", { hash, signature: signWalletHash(hash, bob.key) }), ERC1271_INVALID_VALUE);
    eq("owner() = alice", await read(wallet, "owner"), alice.address);
    const carolBefore = await balanceOf(carol.address);
    const [executed] = await batch([[alice, { action: "call", to: wallet, method: "execute", input: { target: token, fn: "transfer", input: { to: carol.address, amount: units(25) } } }, "wallet.execute → token.transfer"]]);
    success("execute (the owner has the wallet call another program)", executed);
    eq("carol received 25 FULL from the program wallet", (await balanceOf(carol.address)) - carolBefore, 25n * UNIT);
    check("trace: wallet → token.transfer (depth 1, sender = wallet)", executed.receipt.trace?.some((t) => t.depth === 1 && t.program === token && t.from === wallet), JSON.stringify(executed.receipt.trace).slice(0, 300));
    const stranger = await send(bob, { action: "call", to: wallet, method: "execute", input: { target: token, fn: "transfer", input: { to: bob.address, amount: units(1) } } });
    check("execute by a non-owner → rejected (only owner)", !stranger.queued && /only owner/.test(JSON.stringify(stranger)), JSON.stringify(stranger).slice(0, 200));
  });

  await section("8 multicall: aggregate / tryAggregate / readonly · a tx bundling several calls", async () => {
    const mc = program("multicall");
    const counter = program("counter");
    const reads = await read(mc, "aggregate", { readonly: true, calls: [
      { target: token, fn: "balanceOf", input: { who: bob.address } },
      { target: nft, fn: "ownerOf", input: { tokenId: "1n" } },
      { target: multi, fn: "balanceOf", input: { account: bob.address, id: "1n" } },
      { target: mc, fn: "getChainId", input: {} },
    ] });
    eq("readonly aggregate reads 4 values in one round", reads.join(","), `${1000n * UNIT}n,${bob.address},10n,${CHAIN_ID}n`);
    const tried = await read(mc, "tryAggregate", { calls: [{ target: nft, fn: "ownerOf", input: { tokenId: "999n" } }, { target: token, fn: "ticker", input: {} }] });
    check("tryAggregate: the failing call gets success false, the rest continue", tried[0]?.success === false && /does not exist/.test(tried[0].error) && tried[1]?.success === true && tried[1].result === "FULL", JSON.stringify(tried));
    const forbidden = await read(mc, "tryAggregate", { readonly: true, calls: [{ target: counter, fn: "increment", input: { by: "1n" } }] });
    eq("readonly tryAggregate with a writing function → FORBIDDEN", forbidden[0]?.code, "FORBIDDEN");
    const all = await query(mc, "aggregate", { calls: [{ target: token, fn: "ticker", input: {} }, { target: nft, fn: "ownerOf", input: { tokenId: "999n" } }] });
    check("aggregate: one failure = everything fails", all.status === "throw", JSON.stringify(all).slice(0, 200));
    const before = big(await read(counter, "get"));
    const [agg] = await batch([[bob, { action: "call", to: mc, method: "aggregate", input: { calls: [{ target: counter, fn: "increment", input: { by: "1n" } }, { target: counter, fn: "increment", input: { by: "2n" } }] } }, "multicall.aggregate (tx: counter +1 +2)"]]);
    success("aggregate tx succeeds", agg);
    eq("counter increased by 3", big(await read(counter, "get")) - before, 3n);
    eq("trace has 2 nested calls to counter", agg.receipt.trace?.filter((t) => t.depth === 1 && t.program === counter).length, 2);
    T.aggregate = agg;
  });

  await section("9 program calls program: nested runProgram · STATICCALL (FORBIDDEN) · catch a failing inner call", async () => {
    const lab = program("lab");
    const counter = program("counter");
    const [nested, staticCall, caught] = await batch([
      [carol, { action: "call", to: lab, method: "callCounter", input: { counter, by: "5n" } }, "lab.callCounter (nested)"],
      [carol, { action: "call", to: lab, method: "staticWrite", input: { counter } }, "lab.staticWrite (STATICCALL)"],
      [carol, { action: "call", to: lab, method: "catchFailure", input: { counter } }, "lab.catchFailure (inner fails, caught)"],
    ]);
    success("callCounter succeeds", nested);
    check("trace: lab → counter.increment depth 1", nested.receipt.trace?.some((t) => t.depth === 1 && t.program === counter && t.method === "increment" && t.from === lab), JSON.stringify(nested.receipt.trace).slice(0, 300));
    check("Incremented event has caller = lab (called through a program)", nested.receipt.events?.some((e) => e.name === "Incremented" && e.data.caller === lab), JSON.stringify(nested.receipt.events).slice(0, 300));
    success("staticWrite succeeds (the caller can catch)", staticCall);
    eq("STATICCALL that writes → FORBIDDEN", staticCall.receipt.result?.blocked?.code, "FORBIDDEN");
    check("trace has type staticcall", staticCall.receipt.trace?.some((t) => t.type === "staticcall"), JSON.stringify(staticCall.receipt.trace).slice(0, 300));
    success("catchFailure: tx succeeds even though the inner call failed", caught);
    eq("the inner call's error message was caught", caught.receipt.result?.message, "intentional failure from the counter");
    check("trace: the inner call has a failed status", caught.receipt.trace?.some((t) => t.depth === 1 && t.method === "fail" && t.status !== "success"), JSON.stringify(caught.receipt.trace).slice(0, 300));
    T.nested = nested;
    T.caught = caught;
  });

  await section("10 program APIs (BlockHash … Math.random) compared with the chain's real values", async () => {
    const lab = program("lab");
    const message = `scenario-full probe ${OPTIONS.tag}`;
    const probeDigest = keccakText(`digest ${message}`);
    const [probe] = await batch([[carol, { action: "call", to: lab, method: "probe", value: gwei(1_000_000),
      input: { message, signature: signProgramMessage(message, carol.key), digest: probeDigest, digestSignature: signTypedDataDigest(probeDigest, carol.key) } }, "lab.probe (every API)"]]);
    success("probe succeeds", probe);
    const s = probe.receipt.result ?? {};
    const header = await get(`/block/${probe.tx.blockNumber}`);
    const parent = await get(`/block/${probe.tx.blockNumber - 1}`);
    const code = (await get(`/program/${lab}`)).code;
    const g = await get("/genesis");
    const digest = (fn) => `0x${bytesToHex(fn(utf8ToBytes("abc")))}`;
    let expectedModexp = 1n;
    for (let i = 0; i < 200; i += 1) expectedModexp = (expectedModexp * 3n) % 1000007n;
    eq("BlockNumber()", s.blockNumber, `${probe.tx.blockNumber}n`);
    eq("BlockHash(n - 1) = hash of the previous block", s.blockHash, parent.hash);
    eq("ChainId()", s.chainId, `${CHAIN_ID}n`);
    eq("Coinbase() = feeRecipient", s.coinbase, header.feeRecipient);
    eq("BlockGasLimit() = maxBlockGas", s.blockGasLimit, `${g.maxBlockGas}n`);
    eq("BaseFee() = the block's baseFeePerGas", s.baseFee, header.baseFeePerGas);
    eq("GasPrice() = effectiveGasPrice", s.gasPrice, probe.receipt.effectiveGasPrice);
    check("GasLeft() is between 0 and gasLimit", big(s.gasLeft) > 0n && big(s.gasLeft) < 1_000_000n, s.gasLeft);
    eq("CodeHashOf(this) = keccak256(code)", s.codeHash, keccakText(code));
    eq("CodeSizeOf(this) = code bytes", s.codeSize, `${Buffer.byteLength(code, "utf8")}n`);
    eq("sha256('abc')", s.sha256, digest(sha256));
    eq("ripemd160('abc')", s.ripemd160, digest(ripemd160));
    eq("blake2b('abc') (512 bit)", s.blake2b, digest(blake2b));
    eq("keccak256('abc')", s.keccak256, keccakText("abc"));
    eq("modexp(3, 200, 1000007)", s.modexp, `${expectedModexp}n`);
    eq("ecrecover(message, signature) = the signer", s.signer, carol.address);
    eq("keccak256Bytes('0x616263') = keccak256('abc')", s.keccakBytes, keccakText("abc"));
    eq("ecrecoverDigest(32-byte digest, signature) = the signer", s.digestSigner, carol.address);
    const labDomain = { name: "Lab", version: "1", chainId: BigInt(CHAIN_ID), verifyingContract: lab };
    eq("eip712DomainSeparator() = the JS helper's value", s.domainSeparator, eip712DomainSeparator(labDomain));
    eq("eip712Digest() = the eth_signTypedData_v4 digest", s.typedDigest, eip712Digest(labDomain,
      { Ping: [{ name: "from", type: "address" }, { name: "block", type: "uint256" }] }, "Ping", { from: carol.address, block: BigInt(probe.tx.blockNumber) }));
    check("BalanceOf(sender) > 0", big(s.senderBalance) > 0n, s.senderBalance);
    eq("ThisBalance() = the attached value", s.thisBalance, `${1_000_000n * GWEI}n`);
    eq("IsProgram(this) = true", s.thisIsProgram, true);
    eq("IsProgram(sender) = false", s.senderIsProgram, false);
    eq("MetadataOf(this, 'namespace')", s.namespace, ns("lab"));
    eq("Date.now() = the block timestamp", s.now, `${header.timestamp}n`);
    eq("params.block.timestamp = the block timestamp", s.timestamp, `${header.timestamp}n`);
    check("Math.random() is in [0, 1)", Number(s.random) >= 0 && Number(s.random) < 1, s.random);
    const stored = await read(lab, "lastProbe");
    check("replay gives the same values (receipt from replay = values stored during the real run, including Math.random)", JSON.stringify(stored) === JSON.stringify(s), `${JSON.stringify(stored).slice(0, 150)} ≠ ${JSON.stringify(s).slice(0, 150)}`);
    T.probe = probe;
  });

  await section("11 program upgrades: upgrade → reject → upgrade → approve (+ timelock) · migrate · versions · setUpgrader", async () => {
    const counter = program("counter");
    const countBefore = big(await read(counter, "get"));
    const [first] = await batch([[alice, { action: "upgrade", to: counter, code: COUNTER_V2, input: { tag: "rejected", bonus: "1n" } }, "upgrade #1 (will be rejected)"]]);
    success("upgrader submits new code", first);
    check("GET /program → pendingUpgrade", (await get(`/program/${counter}`)).pendingUpgrade, "no pendingUpgrade");
    const [rejected] = await batch([[admin, { action: "rejectUpgrade", to: counter }, "rejectUpgrade"]]);
    success("team rejectUpgrade", rejected);
    eq("after reject: pendingUpgrade = null", (await get(`/program/${counter}`)).pendingUpgrade, null);
    eq("after reject: version() is still 1", await read(counter, "version"), "1n");
    const stranger = await send(bob, { action: "upgrade", to: counter, code: COUNTER_V2, input: {} });
    check("code submitted by a non-upgrader → rejected", !stranger.queued, JSON.stringify(stranger).slice(0, 200));

    const [second] = await batch([[alice, { action: "upgrade", to: counter, code: COUNTER_V2, input: { tag: "v2", bonus: "100n" } }, "upgrade #2"]]);
    success("new code submitted a second time", second);
    const [approved] = await batch([[admin, { action: "initUpgrade", to: counter }, "initUpgrade"]]);
    success("team initUpgrade", approved);
    const state = approved.receipt.result?.state;
    if (state === "scheduled") {
      const activateAt = approved.receipt.result.activateAt;
      check("timelock: state scheduled + activateAt", activateAt > approved.tx.blockNumber, JSON.stringify(approved.receipt.result));
      check("timelock: GET /program → scheduledUpgrade", (await get(`/program/${counter}`)).scheduledUpgrade?.activateAt === activateAt);
      eq("timelock: before activation version() is still 1", await read(counter, "version"), "1n");
      await fillUntil(activateAt);
      const header = await get(`/block/${activateAt}`);
      check(`timelock: header.upgrades of block ${activateAt} shows the activation`, header.upgrades?.some((u) => u.program === counter), JSON.stringify(header.upgrades));
    } else {
      eq("no timelock (UPGRADE_DELAY_BLOCKS=0): new code used immediately", state, "active");
    }
    eq("version() = 2", await read(counter, "version"), "2n");
    eq("metadata.version = 2", (await get(`/address/${counter}?limit=1`)).metadata.version, 2);
    eq("migrate ran once (migratedTag)", await read(counter, "migratedTag"), "v2");
    eq("existing storage intact + bonus from migrate", big(await read(counter, "get")), countBefore + 100n);
    const versions = await get(`/program/${counter}/versions`);
    eq("GET /program/:a/versions has 2 versions", versions.map?.((v) => v.version).join(","), "1,2");
    check("new ABI (setMetadata in migrate) has decrement", (await get(`/program/${counter}/abi`)).abi?.functions?.some((f) => f.name === "decrement"));
    const migrateCall = await query(counter, "migrate", { tag: "x" });
    check("migrate cannot be called from outside", migrateCall.status !== "success", JSON.stringify(migrateCall).slice(0, 150));
    const [dec] = await batch([[bob, { action: "call", to: counter, method: "decrement", input: { by: "1n" } }, "counter.decrement (new v2 function)"]]);
    success("v2's new function works", dec);

    const [handover] = await batch([[alice, { action: "setUpgrader", to: counter, input: { upgrader: bob.address } }, "setUpgrader → bob"]]);
    success("setUpgrader transfers the rights", handover);
    eq("metadata.upgrader = bob", (await get(`/address/${counter}?limit=1`)).metadata.upgrader, bob.address);
    const [renounce] = await batch([[bob, { action: "setUpgrader", to: counter, input: { upgrader: null } }, "setUpgrader → null (renounce)"]]);
    success("upgrade rights renounced", renounce);
    check("metadata.upgrader removed (can no longer be changed)", !(await get(`/address/${counter}?limit=1`)).metadata.upgrader);
    const after = await send(bob, { action: "upgrade", to: counter, code: COUNTER_V1, input: {} });
    check("upgrade after renouncing → rejected", !after.queued, JSON.stringify(after).slice(0, 200));
  });

  await section("12 cloneProgram: a program factory (CREATE2-style address predictable in advance)", async () => {
    const factory = program("factory");
    const template = program("note");
    const salt = `${OPTIONS.tag}-note-1`;
    const templateCode = (await get(`/program/${template}`)).code;
    const predicted = new VirtualMachine(new MemoryDB(), { chainId: CHAIN_ID }).cloneAddressFor(factory, salt, templateCode);
    const [created] = await batch([[dave, { action: "call", to: factory, method: "create", input: { template, salt, label: "Dave's note", namespace: ns("note-1") } }, "factory.create (cloneProgram)"]]);
    success("create succeeds", created);
    eq("the clone's address = the predicted one", created.receipt.result, predicted);
    report.programs.clone = predicted;
    const meta = (await get(`/address/${predicted}?limit=1`)).metadata;
    eq("metadata.template = the template", meta.template, template);
    eq("metadata.creator = factory", meta.creator, factory);
    eq("the clone's namespace", (await get(`/name/${ns("note-1")}`)).address, predicted);
    check("trace has an entry of type create", created.receipt.trace?.some((t) => t.type === "create"), JSON.stringify(created.receipt.trace).slice(0, 300));
    const frame = await rpc("debug_traceTransaction", [created.hash, { tracer: "callTracer" }]);
    check("/evm callTracer has a CREATE frame", JSON.stringify(frame).includes('"type":"CREATE"'), JSON.stringify(frame).slice(0, 300));
    const [written] = await batch([[dave, { action: "call", to: predicted, method: "write", input: { text: "hello from a clone" } }, "clone.write"]]);
    success("the clone works (owner = the factory caller)", written);
    eq("clone.note().text", (await read(predicted, "note")).text, "hello from a clone");
    const again = await send(dave, { action: "call", to: factory, method: "create", input: { template, salt, label: "again" } });
    check("duplicate salt → rejected", !again.queued, JSON.stringify(again).slice(0, 200));
    T.clone = created;
  });

  await section("13 gas / sandbox: OUT_OF_GAS · OUT_OF_MEMORY (at query, at /sendtx and in the block)", async () => {
    const gasLab = program("gasLab");
    const spin = await query(gasLab, "spin");
    eq("query infinite loop → OUT_OF_GAS", spin.error?.code, "OUT_OF_GAS");
    const sent = await send(erin, { action: "call", to: gasLab, method: "spin", gasLimit: 300_000 });
    check("/sendtx infinite loop → simulation fails, not queued", !sent.queued && sent.simulation?.errorCode === "OUT_OF_GAS", JSON.stringify(sent).slice(0, 200));
    report.txs["rejected (spin OUT_OF_GAS at /sendtx)"] = sent.hash;

    // trap: arm, then loop / memory in the same block (the simulation at send time sees the state before arm, so it passes)
    // 32 MB of memory ≈ 1.05M gas → needs maxBlockGas ≥ 2M (loop 400k + memory 1.5M in one block) · server default 1M = skip
    if (Number((await get("/genesis")).maxBlockGas) < 2_000_000) return skip("OUT_OF_GAS / OUT_OF_MEMORY trap in a block", "server maxBlockGas < 2M (use --spawn or MAX_BLOCK_GAS=3000000)");
    let items = null;
    for (let attempt = 1; attempt <= 3 && !items; attempt += 1) {
      await freshBlock();
      const { nonce } = await get(`/nonce/${erin.address}`);
      const arm = await send(erin, { action: "call", to: gasLab, method: "arm" }, { nonce });
      const loop = await send(erin, { action: "call", to: gasLab, method: "loopIfArmed", gasLimit: 400_000 }, { nonce: nonce + 1 });
      // 32 MB of memory ≈ 1.05M gas (data is charged by size) → gasLimit must be enough to reach the memory cap first
      const memory = await send(erin, { action: "call", to: gasLab, method: "memoryIfArmed", gasLimit: 1_500_000 }, { nonce: nonce + 2 });
      if (arm.queued && loop.queued && memory.queued) items = { arm, loop, memory };
      else if (arm.queued) await mined(arm.hash);
    }
    if (!items) return check("all 3 trap txs queued", false, "a block closed during all 3 attempts");
    const found = await mined([items.arm.hash, items.loop.hash, items.memory.hash]);
    const loopReceipt = await get(`/tx/${items.loop.hash}/receipt`);
    const memoryReceipt = await get(`/tx/${items.memory.hash}/receipt`);
    eq("arm succeeds", found[items.arm.hash].status, "success");
    eq("loop in a block → OUT_OF_GAS", loopReceipt.error?.code, "OUT_OF_GAS");
    check("OUT_OF_GAS: in a block · uses the full gasLimit · gas charged", found[items.loop.hash].blockNumber && loopReceipt.gasUsed >= 400_000 && big(loopReceipt.fee) > 0n, JSON.stringify([loopReceipt.gasUsed, loopReceipt.fee]));
    eq("memory in a block → OUT_OF_MEMORY", memoryReceipt.error?.code, "OUT_OF_MEMORY");
    // gas is charged for the data actually allocated (~1M for 32 MB), not just a few hundred as before size-based data gas
    check("OUT_OF_MEMORY: in a block · gas charged for the allocated data (≥ 500,000)", found[items.memory.hash].blockNumber && memoryReceipt.gasUsed >= 500_000 && memoryReceipt.gasUsed <= 1_500_000 && big(memoryReceipt.fee) > 0n, JSON.stringify([memoryReceipt.gasUsed, memoryReceipt.fee]));
    const evmLoop = await rpc("eth_getTransactionReceipt", [items.loop.hash]);
    check("/evm: tx failed in a block → status 0x0 + gasUsed > 0", evmLoop.status === "0x0" && BigInt(evmLoop.gasUsed) > 0n, JSON.stringify(evmLoop).slice(0, 200));
    report.txs["failed in block (OUT_OF_GAS)"] = items.loop.hash;
    report.txs["failed in block (OUT_OF_MEMORY)"] = items.memory.hash;
    T.oog = items.loop.hash;
    skip("TIMEOUT_MS (time limit)", "gas always runs out first: maxTxGas 1–3M ≈ 20–60 ms in the sandbox · the timeout (5 s) is a last line of defense that can't be tested without lowering the server's TIMEOUT_MS (covered by tests 08 / 58)");
  });

  await section("14 indexed events: REST + eth_getLogs by topic", async () => {
    const latest = (await get("/genesis")).latest;
    const byTo = await get(`/program/${token}/events?name=Transfer&to=${bob.address}`);
    check("GET /program/:a/events?name=Transfer&to=bob → only bob's", byTo.items?.length >= 1 && byTo.items.every((e) => e.data?.to === bob.address), JSON.stringify(byTo).slice(0, 300));
    const both = await get(`/program/${token}/events?name=Transfer&from=${alice.address}&to=${carol.address}`);
    check("multiple fields (AND): from=alice & to=carol", both.items?.length >= 1 && both.items.every((e) => e.data?.from === alice.address && e.data?.to === carol.address), JSON.stringify(both).slice(0, 300));
    const byCaller = await get(`/program/${program("counter")}/events?name=Incremented&caller=${program("lab")}`);
    check("sample program's event (Incremented caller = lab)", byCaller.items?.length >= 1, JSON.stringify(byCaller).slice(0, 200));
    const logs = await rpc("eth_getLogs", [{ fromBlock: hex(report.firstBlock), toBlock: hex(latest), address: token, topics: [SIG.transfer, null, `0x${addressWord(bob.address)}`] }]);
    check("eth_getLogs topic0 Transfer + topic2 = bob", logs.length >= 1 && logs.every((l) => l.topics[2] === `0x${addressWord(bob.address)}`), JSON.stringify(logs).slice(0, 200));
    const nftLogs = await rpc("eth_getLogs", [{ fromBlock: hex(report.firstBlock), toBlock: hex(latest), address: nft, topics: [SIG.transfer, null, null, `0x${word(1)}`] }]);
    check("eth_getLogs NFT tokenId (topic3) = 1 → mint + transfer", nftLogs.length === 2, JSON.stringify(nftLogs).slice(0, 200));
    const singles = await rpc("eth_getLogs", [{ fromBlock: hex(report.firstBlock), toBlock: hex(latest), topics: [SIG.transferSingle] }]);
    check("eth_getLogs topic0 TransferSingle (all programs)", singles.length >= 3 && singles.every((l) => l.address === multi), JSON.stringify(singles).slice(0, 200));
  });

  await section("15 /evm for Blockscout: block · tx · receipt · log · eth_call · fee", async () => {
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
    check("block.transactions has the block's txs (VM hashes)", block.transactions.includes(T.tokenTransfer.tx.hash), JSON.stringify(block.transactions));
    const fullBlock = await rpc("eth_getBlockByNumber", [hex(n), true]);
    check("eth_getBlockByNumber(full) returns tx objects", fullBlock.transactions.every((t) => typeof t === "object" && t.hash));
    const t1559 = await rpc("eth_getTransactionByHash", [T.tipped.hash]);
    check("1559 tx: type 0x2 + maxFeePerGas + maxPriorityFeePerGas", t1559.type === "0x2" && t1559.maxFeePerGas === hex(gwei(20)) && t1559.maxPriorityFeePerGas === hex(gwei(2)), JSON.stringify(t1559).slice(0, 300));
    const tLegacy = await rpc("eth_getTransactionByHash", [T.legacy2.hash]);
    check("legacy tx: type 0x0 + gasPrice", tLegacy.type === "0x0" && tLegacy.gasPrice === hex(gwei(3)), JSON.stringify(tLegacy).slice(0, 300));
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
    eq("tx failed in a block → status 0x0", failed.status, "0x0");
    eq("rejected tx → status 0x0", (await rpc("eth_getTransactionReceipt", [T.rejected])).status, "0x0");
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
    check("eth_feeHistory: baseFeePerGas 6 entries · gasUsedRatio 5 · reward 5", history.baseFeePerGas.length === 6 && history.gasUsedRatio.length === 5 && history.reward.length === 5, JSON.stringify(history).slice(0, 300));
    const genesisNow = await get("/genesis");
    check("eth_gasPrice ≥ the next block's base fee", BigInt(await rpc("eth_gasPrice")) >= big(genesisNow.baseFee));
    eq("eth_getBalance(alice) = the chain's balance", BigInt(await rpc("eth_getBalance", [alice.address, "latest"])), big((await get(`/address/${alice.address}?limit=1`)).native.balance));
    eq("eth_getTransactionCount(alice) = nonce", BigInt(await rpc("eth_getTransactionCount", [alice.address, "latest"])), BigInt((await get(`/nonce/${alice.address}`)).nonce));
    check("eth_getCode(token) = the program source", (await rpc("eth_getCode", [token, "latest"])).length > 100);
    const trace = await rpc("debug_traceTransaction", [T.aggregate.hash, { tracer: "callTracer" }]);
    eq("debug_traceTransaction (callTracer) of aggregate: 2 sub-calls", trace.calls?.length, 2);
    const receipts = await rpc("eth_getBlockReceipts", [hex(n)]);
    check("eth_getBlockReceipts covers every tx", receipts.length === block.transactions.length, `${receipts.length} / ${block.transactions.length}`);
    const tokenBefore = BigInt(await rpc("eth_call", [{ to: token, data: callData("balanceOf(address)", addressWord(bob.address)) }, hex(T.tokenTransfer.tx.blockNumber - 1)]));
    eq("historical eth_call (block before the transfer) bob = 0", tokenBefore, 0n);
  });

  await section("16 REST used by the explorer (address · tokens · nfts · program · pagination)", async () => {
    const wallet = program("wallet");
    const aliceView = await get(`/address/${alice.address}`);
    check("GET /address/alice: namespace + nonce + tx", aliceView.metadata?.namespace === ns("alice") && aliceView.nonce > 10 && aliceView.transactions?.length > 0, JSON.stringify(aliceView).slice(0, 200));
    const tokens = await get(`/address/${alice.address}/tokens`);
    check("GET /address/alice/tokens has FULL", tokens.some?.((t) => t.address === token && t.ticker === "FULL" && big(t.balance) > 0n), JSON.stringify(tokens).slice(0, 200));
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
    check("GET /programs/approved has this run's programs (including the clone)", ["token", "nft", "multi", "counter", "lab", "factory", "clone"].every((name) => approved.items?.some((p) => p.address === program(name)))
      || approved.total >= 12, `total ${approved.total}`);
    const blocks = await get("/blocks/page?page=1&limit=5");
    check("GET /blocks/page", blocks.items?.length === 5 && blocks.total >= blocks.items[0].number, JSON.stringify(blocks).slice(0, 150));
    const txs = await get(`/address/${alice.address}/txs?page=1&limit=5`);
    check("GET /address/alice/txs (sorted by nonce, paginated)", txs.items?.length === 5 && txs.total >= 20 && txs.pages >= 4, JSON.stringify({ total: txs.total, pages: txs.pages }));
    const incoming = await get(`/address/${token}/incoming?page=1&limit=10`);
    check("GET /address/token/incoming (including nested calls)", incoming.total >= 10 && incoming.items?.some((i) => i.depth >= 1), JSON.stringify({ total: incoming.total }));
    const interactions = await get(`/program/${token}/interactions?limit=5&cursor=`);
    check("GET /program/:a/interactions (cursor)", interactions.items?.length === 5 && interactions.next, JSON.stringify(interactions).slice(0, 150));
    const events = await get(`/program/${token}/events?page=1&limit=5`);
    check("GET /program/:a/events (paginated)", events.items?.length === 5 && events.total >= 10, JSON.stringify({ total: events.total }));
    const holders = await get(`/token/${token}/holders?page=1&limit=25`);
    check("GET /token/:a/holders (≥ 6 holders, largest first)", holders.total >= 6 && big(holders.items[0].balance) >= big(holders.items.at(-1).balance), JSON.stringify({ total: holders.total }));
    const entries = await get(`/program/${token}/entries?name=balances&page=1&limit=25`);
    check("GET /program/:a/entries?name=balances", entries.items?.length >= 6, JSON.stringify({ total: entries.total }));
    const layout = await get(`/program/${program("lab")}/layout`);
    check("GET /program/:a/layout (Variables has lastProbe)", JSON.stringify(layout).includes("lastProbe"), JSON.stringify(layout).slice(0, 150));
    // /sendtx returns the digest (the EIP-712 the user signed) · the VM hash is in the record — both are searchable
    const byVmHash = await get(`/tx/${T.tokenTransfer.tx.hash}`);
    check("GET /tx/:hash finds both the VM hash and the user-signed digest", byVmHash.digest === T.tokenTransfer.hash && byVmHash.hash === T.tokenTransfer.tx.hash, json(byVmHash).slice(0, 200));
    const full = await get(`/block/${T.probe.tx.blockNumber}?full=1`);
    check("GET /block/:n?full=1 (replay) matches the header", full.hash === (await get(`/block/${T.probe.tx.blockNumber}`)).hash && full.transactions?.length >= 1);
    const state = await get(`/state/${token}?block=${T.tokenTransfer.tx.blockNumber - 1}`);
    check("GET /state/:a?block= (historical state) before the transfer bob has no balance", !JSON.stringify(state).includes(bob.address), JSON.stringify(state).slice(0, 150));
    // base fee falls after the full block (seen in later headers)
    const latest = (await get("/genesis")).latest;
    const raised = big((await get(`/block/${T.heavyBlock + 1}`)).baseFeePerGas);
    let lowered = null;
    for (let n = T.heavyBlock + 2; n <= latest && lowered === null; n += 1) { const h = await get(`/block/${n}`); if (big(h.baseFeePerGas) < raised) lowered = n; }
    check("base fee falls when a block uses less gas than the target", lowered !== null, `no block after ${T.heavyBlock + 1} with a base fee below ${raised}`);
  });

  if (OPTIONS.sync) {
    await section("17 sync: a reader node replays every block and gets the same head hash", async () => {
      // reader node = a second server.js in this process (same settings from env · MemoryDB · no port, doesn't close blocks itself)
      delete process.env.DATA;
      const cwd = process.cwd();
      process.chdir(ROOT);   // server.js reads genesis.json from cwd
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
      eq("genesis hash matches", reader.vm.genesisHash(), (await get("/genesis")).hash);
      eq(`synced all ${added} blocks (latest block number)`, reader.vm.latestBlockNumber(), head.number);
      eq("head hash matches the producer", local?.hash, head.hash);
      eq("stateRoot matches the producer", local?.stateRoot, head.stateRoot);
      console.log(`      (replayed ${added} blocks in ${((Date.now() - started) / 1000).toFixed(1)} seconds)`);
    });
  } else {
    current = "17 sync";
    skip("sync with a reader node", "start with --spawn or --sync (the server's env must match this process)");
  }
}

async function summary() {
  const failed = report.checks.filter((c) => !c.ok);
  const skipped = report.checks.filter((c) => c.skipped);
  const passed = report.checks.length - failed.length - skipped.length;
  report.summary = { passed, failed: failed.length, skipped: skipped.length, total: report.checks.length };
  report.finishedAt = new Date().toISOString();
  console.log("\n================ scenario-full ================");
  console.log(`  passed ${passed} · failed ${failed.length} · skipped ${skipped.length} (total ${report.checks.length} checks)`);
  for (const c of failed) console.log(`  ❌ [${c.section}] ${c.name} — ${c.detail ?? ""}`.slice(0, 400));
  console.log("\n  sample programs (our explorer · Blockscout)");
  const kind = { token: "ERC-20", nft: "ERC-721", multi: "ERC-1155", wallet: "ERC-1271 wallet", counter: "upgradeable", lab: "nested / API",
    gasLab: "gas / sandbox", multicall: "multicall", note: "clone template", factory: "factory", clone: "clone", rejectable: "rejected" };
  for (const [name, address] of Object.entries(report.programs)) {
    if (!address) continue;
    console.log(`  ${name.padEnd(11)} ${(kind[name] ?? "").padEnd(16)} ${address}  ${API}/#address/${address}  ·  ${OPTIONS.blockscout}/${name === "token" || name === "nft" || name === "multi" ? "token" : "address"}/${address}`);
  }
  console.log("\n  txs worth a look (VM hash = the hash Blockscout uses · our explorer finds both the VM hash and the signed digest)");
  report.vmHashes = {};
  for (const [label, digest] of Object.entries(report.txs).filter(([label]) => /permit|safeTransfer|Batch|aggregate|nested|STATICCALL|caught|probe|cloneProgram|initUpgrade|replace|rejected|failed|legacy|EIP-1559|value 0/.test(label))) {
    const found = await get(`/tx/${digest}`).catch(() => null);
    const hash = found?.hash ?? digest;
    report.vmHashes[label] = hash;
    report.gasByTx ??= {};
    if (typeof found?.gasUsed === "number") report.gasByTx[label] = found.gasUsed;
    console.log(`  ${label.padEnd(48)} ${String(found?.gasUsed ?? "-").padStart(9)} gas  ${API}/#tx/${hash}  ·  ${OPTIONS.blockscout}/tx/${hash}`);
  }
  const latest = await get("/block/latest").catch(() => null);
  if (latest?.number >= report.firstBlock) {
    let gasUsed = 0;
    for (let n = report.firstBlock; n <= latest.number; n += 1) gasUsed += (await get(`/block/${n}`).catch(() => null))?.gasUsed ?? 0;
    report.gasUsed = gasUsed;
    console.log(`  total gas over all blocks of this run: ${gasUsed}`);
  }
  console.log(`\n  wallets: ${Object.entries(report.wallets).map(([n, a]) => `${n} ${short(a)}`).join(" · ")}`);
  console.log(`  Blockscout: set ETHEREUM_JSONRPC_HTTP_URL=${API}/evm (see docs/blockscout.md) · report: ${OPTIONS.out}`);
}

// ============================================================================
async function startServer() {
  const port = await new Promise((resolve) => { const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  // this same env is also used for the reader node in the sync section (server.js is imported in this process) → set in process.env
  process.env.BLOCK_MS ??= OPTIONS.quick ? "300" : "1000";
  process.env.GAS_PRICE ??= "1000000000";   // the script's steps set prices in ETH-level gwei (1–20 gwei) · the real chain starts at 10,000 gwei
  // gas numbers in this script follow the base gas table (DEFAULT_GAS) → use a genesis.json without forks (the "bluewolf" fork off)
  if (!process.env.GENESIS) {
    const base = JSON.parse(fs.readFileSync(path.join(ROOT, "genesis.json"), "utf8"));
    delete base.forks;
    const file = path.join(fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "scenario-genesis-")), "genesis.json");
    fs.writeFileSync(file, JSON.stringify(base));
    process.env.GENESIS = file;
  }
  process.env.UPGRADE_DELAY_BLOCKS ??= "2";
  process.env.MAX_BLOCK_GAS ??= "3000000";   // the OUT_OF_MEMORY trap needs ~1.05M gas in one tx (server default = 1M)
  process.env.RATE_LIMIT = "0";
  process.env.EVM_RATE_LIMIT = "0";
  const env = { ...process.env, DEV: process.env.DEV ?? "1", PORT: String(port), ...(OPTIONS.data ? { DATA: OPTIONS.data } : {}) };
  if (!OPTIONS.data) delete env.DATA;
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: ["ignore", "ignore", "inherit"] });
  API = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i += 1) { if (await fetch(`${API}/genesis`).then(() => true, () => false)) break; await wait(100); }
  console.log(`starting the server itself: ${API} (BLOCK_MS ${process.env.BLOCK_MS} · UPGRADE_DELAY_BLOCKS ${process.env.UPGRADE_DELAY_BLOCKS})`);
  return child;
}

const child = OPTIONS.spawn ? await startServer() : null;
try {
  await main();
} catch (error) {
  check("scenario runs to completion", false, error.stack ?? error);
} finally {
  await summary().catch((error) => console.error("summary failed:", error.message));
  fs.writeFileSync(OPTIONS.out, JSON.stringify(report, null, 2));
  if (child) child.kill();
}
process.exitCode = report.summary.failed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200).unref();
