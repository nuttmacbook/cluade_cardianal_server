/**
 * Deploy the system program set (src/standards/system.js) in the deployer wallet's nonce order → addresses known in advance
 *
 *   preview addresses (no txs):   DEPLOYER_KEY=0x… node scripts/deploy-system.js http://localhost:3000 --plan
 *                                  (or --deployer 0x… --chain-id 41234, no key / no node connection needed)
 *   real deploy:                  DEPLOYER_KEY=0x… ADMIN_KEY=0x… node scripts/deploy-system.js http://localhost:3000
 *     DEPLOYER_KEY  a fresh wallet that has never sent a tx (nonce 0) with enough funds for gas · used only to deploy this set
 *     ADMIN_KEY     (optional) a key listed in ADMINS → approves immediately · omitted = waits for an admin to approve (explorer's Programs page)
 *     SYMBOL        native coin symbol (omitted = nativeCurrency.symbol from GET /evm → the server's EVM_SYMBOL) → WBWSC / WBNB …
 *     --out <file>  where to write the result (default deploy/system-programs.json)
 *   re-runnable: skips programs already deployed / approved · if a deployer nonce was used for something else the addresses won't match the plan → stops
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as sign from "../src/crypto/signature.js";
import { VirtualMachine } from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";
import { systemPrograms } from "../src/standards/system.js";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const API = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "http://localhost:3000";
const OUT = option("--out") ?? "deploy/system-programs.json";
const DEPLOYER_KEY = process.env.DEPLOYER_KEY;
const ADMIN_KEY = process.env.ADMIN_KEY;
const offline = option("--deployer") !== undefined && option("--chain-id") !== undefined;

const get = (path) => fetch(API + path).then((r) => r.json());
const post = (path, body) => fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const die = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const deployer = (option("--deployer") ?? (DEPLOYER_KEY ? sign.addressOf(DEPLOYER_KEY) : die("DEPLOYER_KEY must be set (or --deployer 0x… with --plan)"))).toLowerCase();
const chainId = offline ? Number(option("--chain-id")) : (await get("/genesis")).chainId;
const symbol = process.env.SYMBOL ?? (offline ? "BWSC" : (await get("/evm").catch(() => null))?.nativeCurrency?.symbol ?? "BWSC");
const predictor = new VirtualMachine(new MemoryDB(), { chainId });
const plan = systemPrograms({ addressAt: (nonce) => predictor.programAddressFor(deployer, nonce), symbol });

console.log(`chain ${chainId} · deployer ${deployer} · native coin ${symbol}\n`);
for (const item of plan) console.log(`  nonce ${item.nonce}  ${item.address}  ${item.namespace.padEnd(20)} ${item.title}`);
console.log();
if (flag("--plan")) process.exit(0);
if (!DEPLOYER_KEY) die("DEPLOYER_KEY must be set for a real deploy");

const { baseFee } = await get("/genesis");
// 2× the next base fee (headroom in case it rises while waiting) · no value = 1 gwei · no 1 gwei floor (admins can lower the base fee via setGasConfig)
const gasPrice = String(baseFee === undefined || baseFee === null ? 10n ** 9n : BigInt(String(baseFee).replace(/n$/, "")) * 2n);

async function send(key, fields) {
  const from = sign.addressOf(key);
  const { nonce } = await get(`/nonce/${from}`);
  const tx = { chainId, from, to: "", method: "", input: {}, value: 0, gasLimit: 1_500_000, gasPrice, nonce, ...fields };
  const body = { tx, signature: sign.signTransaction(tx, key) };
  let result = await post("/sendtx", body);
  // the mempool limits txs per sender per window ("sending too frequently") → wait and resend the same tx
  for (let i = 0; i < 30 && !result.queued && /too frequently/.test(result.reason ?? ""); i += 1) {
    await wait(1000);
    result = await post("/sendtx", body);
  }
  if (!result.queued) die(`${tx.action} not queued: ${JSON.stringify(result).slice(0, 300)}`);
  return { hash: result.hash, nonce };
}

async function confirm(hash, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = await get(`/tx/${hash}`);
    if (found?.status === "rejected") die(`tx ${hash} rejected: ${JSON.stringify(found.error ?? found.reason ?? found).slice(0, 300)}`);
    if (found?.blockNumber) {
      const receipt = await get(`/tx/${hash}/receipt`);
      if (receipt.status !== "success") die(`tx ${hash} failed: ${JSON.stringify(receipt.error).slice(0, 300)}`);
      return receipt;
    }
    await wait(500);
  }
  return die(`waited too long for tx ${hash} (is the server sealing blocks?)`);
}

/** approved = has code · pending = waiting for an admin · missing = not deployed yet */
async function stateOf(address) {
  const program = await fetch(`${API}/program/${address}`);
  if (program.ok) return "approved";
  const pending = await get("/programs/pending?limit=200");
  return pending.items?.some((item) => item.address === address) ? "pending" : "missing";
}

// the name must be free (or already belong to the planned address), otherwise initialization fails
for (const item of plan) {
  const { address } = await get(`/name/${item.namespace}`);
  if (address && address !== item.address) die(`name '${item.namespace}' is already used by ${address}`);
}

const { nonce: firstNonce } = await get(`/nonce/${deployer}`);
const states = {};
for (const item of plan) {
  states[item.key] = await stateOf(item.address);
  if (item.nonce < firstNonce && states[item.key] === "missing") {
    die(`deployer nonce ${item.nonce} was already used for something else (no program at ${item.address}) · use a fresh deployer wallet that has never sent a tx`);
  }
}
const native = (await get(`/address/${deployer}`)).native?.balance;
if (firstNonce < plan.length && (native === undefined || BigInt(String(native).replace(/n$/, "")) === 0n)) {
  die(`deployer ${deployer} has no funds for gas · send it native coin first (all 14 take about 120 ${symbol} at a 10,000 gwei base fee · the script bids 2× · ~130 ${symbol} recommended)`);
}

for (const item of plan.filter((p) => p.nonce >= firstNonce)) {
  const { hash, nonce } = await send(DEPLOYER_KEY, { action: "deploy", code: item.code, input: item.input });
  if (nonce !== item.nonce) die(`nonce does not match the plan (got ${nonce}, expected ${item.nonce})`);
  const receipt = await confirm(hash);
  const address = receipt.result?.programUuid ?? receipt.result;
  if (address !== item.address) die(`${item.key} got address ${address}, not the planned ${item.address}`);
  states[item.key] = "pending";
  console.log(`deploy  ${item.namespace.padEnd(20)} ${address}`);
}

if (ADMIN_KEY) {
  for (const item of plan.filter((p) => states[p.key] === "pending")) {
    await confirm((await send(ADMIN_KEY, { action: "init", to: item.address })).hash);
    states[item.key] = "approved";
    console.log(`approve  ${item.namespace.padEnd(20)} ${item.address}`);
  }
}

const result = {
  chainId, deployer, symbol, updatedAt: new Date().toISOString(),
  programs: Object.fromEntries(plan.map((item) => [item.key, { address: item.address, namespace: item.namespace, title: item.title, nonce: item.nonce, status: states[item.key] }])),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
const waiting = plan.filter((item) => states[item.key] !== "approved");
console.log(`\nwrote ${OUT}`);
if (waiting.length) console.log(`${waiting.length} waiting for admin approval: ${waiting.map((item) => item.namespace).join(", ")} (re-run with ADMIN_KEY or approve on the Programs page)`);
else console.log("all done · the explorer's System programs page shows the names automatically");
