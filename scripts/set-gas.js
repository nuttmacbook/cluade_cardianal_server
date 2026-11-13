/**
 * The chain owner (a key in genesis admins) adjusts the minimum gas price on the fly — no fork / chain wipe / restart · takes effect from the next block
 *
 *   show current values:          node scripts/set-gas.js http://localhost:3000
 *   lower the minimum:              ADMIN_KEY=0x… node scripts/set-gas.js http://localhost:3000 --min-base-fee 1000gwei
 *   revert to the genesis value:  ADMIN_KEY=0x… node scripts/set-gas.js http://localhost:3000 --reset
 *
 *   --min-base-fee  in wei per gas: 100000000 · 0.1gwei · 1gwei   (≥ 1 wei)
 *     every tx fee = gas × base fee → lowering the minimum makes txs proportionally cheaper; gas per tx / block capacity stay the same
 *     the base fee still moves with block fullness · it falls toward the new minimum by at most 12.5% per block · raising it applies from the next block
 *   per-unit prices (call / write …) can't be changed here → fork (FORKS in src/core/virtualmachine.js)
 */
import * as sign from "../src/crypto/signature.js";

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const flag = (name) => args.includes(name);
const API = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--")) ?? "http://localhost:3000";
const ADMIN_KEY = process.env.ADMIN_KEY;

const get = (path) => fetch(API + path).then((r) => r.json());
const post = (path, body) => fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const big = (value) => BigInt(String(value ?? 0).replace(/n$/, ""));
const die = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const gweiText = (wei) => {
  const value = big(wei);
  const whole = value / 10n ** 9n;
  const fraction = (value % 10n ** 9n).toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} gwei`;
};

/** "0.1gwei" / "1 gwei" / "100000000" → wei (string) */
export function parseWei(text) {
  const match = String(text).trim().toLowerCase().match(/^(\d*)(?:\.(\d+))?\s*(gwei|wei)?$/);
  if (!match || (!match[1] && !match[2])) die(`cannot parse --min-base-fee: ${text} (e.g. 0.1gwei or 100000000)`);
  const unit = match[3] ?? (match[2] ? "gwei" : "wei");
  if (unit === "wei") {
    if (match[2]) die("wei must be an integer");
    return BigInt(match[1]).toString();
  }
  if ((match[2] ?? "").length > 9) die("gwei allows at most 9 decimal places");
  return (BigInt(match[1] || "0") * 10n ** 9n + BigInt((match[2] ?? "").padEnd(9, "0"))).toString();
}

function show(info) {
  const config = info.gasConfig;
  console.log(`chain ${info.chainId} · latest block ${info.latest ?? 0}`);
  console.log(`  minimum gas price ${gweiText(info.minBaseFee ?? info.gasPrice)}${config?.minBaseFee ? `  (set by admin · genesis ${gweiText(info.genesisMinBaseFee)})` : "  (from genesis)"}`);
  console.log(`  next base fee     ${gweiText(info.baseFee)}`);
  const gas = info.gas ?? {};
  const transfer = big(gas.call) + 2n * big(gas.read) + 2n * big(gas.write);
  console.log(`  native transfer   ${transfer} gas × ${gweiText(info.baseFee)} = ${Number(transfer * big(info.baseFee)) / 1e18} coins`);
  if (config) console.log(`  last changed      block ${config.block} by ${config.by}`);
}

const info = await get("/genesis");
show(info);

if (flag("--gas")) die("per-unit prices (call / write …) can't be changed on-chain · use a fork");
const input = {};
if (option("--min-base-fee") !== undefined) input.minBaseFee = parseWei(option("--min-base-fee"));
if (flag("--reset")) input.minBaseFee = null;
if (!Object.keys(input).length) process.exit(0);   // view only

if (!ADMIN_KEY) die("ADMIN_KEY must be set (a key in genesis admins)");
const from = sign.addressOf(ADMIN_KEY);
if (Array.isArray(info.admins) && !info.admins.includes(from.toLowerCase())) die(`${from} is not in this chain's admins`);
console.log(`\nsending setGasConfig from ${from}: ${JSON.stringify(input)}`);

const { nonce } = await get(`/nonce/${from}`);
const tx = { chainId: info.chainId, from, to: "", action: "setGasConfig", method: "", input, value: 0, gasLimit: 100_000,
  maxFeePerGas: String(big(info.baseFee) * 2n), maxPriorityFeePerGas: "0", nonce };
const sent = await post("/sendtx", { tx, signature: sign.signTransaction(tx, ADMIN_KEY) });
if (!sent.queued) die(`not queued: ${JSON.stringify(sent).slice(0, 300)}`);

for (let i = 0; i < 120; i += 1) {
  await wait(500);
  const found = await get(`/tx/${sent.hash}`);
  if (found?.status === "rejected") die(`rejected: ${JSON.stringify(found.error ?? found.reason ?? found).slice(0, 300)}`);
  if (!found?.blockNumber) continue;
  const receipt = await get(`/tx/${sent.hash}/receipt`);
  if (receipt.status !== "success") die(`failed: ${JSON.stringify(receipt.error).slice(0, 300)}`);
  console.log(`✓ included in block ${found.blockNumber} · takes effect from block ${found.blockNumber + 1}\n`);
  await wait(1500);
  show(await get("/genesis"));
  process.exit(0);
}
die(`waited too long for tx ${sent.hash}`);
