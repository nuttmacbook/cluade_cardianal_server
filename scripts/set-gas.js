/**
 * เจ้าของเชน (key ที่อยู่ใน admins ของ genesis) ปรับขั้นต่ำของ gas price กลางทาง — ไม่ต้อง fork / ล้างเชน / restart · มีผลตั้งแต่ block ถัดไป
 *
 *   ดูค่าปัจจุบัน:          node scripts/set-gas.js http://localhost:3000
 *   ลดขั้นต่ำ:              ADMIN_KEY=0x… node scripts/set-gas.js http://localhost:3000 --min-base-fee 0.1gwei
 *   กลับไปใช้ค่าใน genesis:  ADMIN_KEY=0x… node scripts/set-gas.js http://localhost:3000 --reset
 *
 *   --min-base-fee  หน่วย wei ต่อแก๊ส: 100000000 · 0.1gwei · 1gwei   (≥ 1 wei)
 *     ค่า tx ทุกแบบ = แก๊ส × base fee → ลดขั้นต่ำ = ค่า tx ถูกลงตามสัดส่วน โดยแก๊สต่อ tx / ความจุ block เท่าเดิม
 *     base fee ยังขึ้นลงตามความเต็มของ block · ลงหาขั้นต่ำใหม่ทีละไม่เกิน 12.5% ต่อ block · ขึ้น = ใช้ทันทีที่ block ถัดไป
 *   ราคาต่อหน่วย (call / write …) ปรับที่นี่ไม่ได้ → fork (FORKS ใน src/core/virtualmachine.js)
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
  if (!match || (!match[1] && !match[2])) die(`--min-base-fee อ่านไม่ออก: ${text} (เช่น 0.1gwei หรือ 100000000)`);
  const unit = match[3] ?? (match[2] ? "gwei" : "wei");
  if (unit === "wei") {
    if (match[2]) die("wei ต้องเป็นจำนวนเต็ม");
    return BigInt(match[1]).toString();
  }
  if ((match[2] ?? "").length > 9) die("gwei มีทศนิยมได้ไม่เกิน 9 หลัก");
  return (BigInt(match[1] || "0") * 10n ** 9n + BigInt((match[2] ?? "").padEnd(9, "0"))).toString();
}

function show(info) {
  const config = info.gasConfig;
  console.log(`เชน ${info.chainId} · block ล่าสุด ${info.latest ?? 0}`);
  console.log(`  ขั้นต่ำของ gas price ${gweiText(info.minBaseFee ?? info.gasPrice)}${config?.minBaseFee ? `  (admin ตั้ง · genesis ${gweiText(info.genesisMinBaseFee)})` : "  (จาก genesis)"}`);
  console.log(`  base fee ถัดไป    ${gweiText(info.baseFee)}`);
  const gas = info.gas ?? {};
  const transfer = big(gas.call) + 2n * big(gas.read) + 2n * big(gas.write);
  console.log(`  โอนเหรียญหลัก     ${transfer} แก๊ส × ${gweiText(info.baseFee)} = ${Number(transfer * big(info.baseFee)) / 1e18} เหรียญ`);
  if (config) console.log(`  แก้ล่าสุด         block ${config.block} โดย ${config.by}`);
}

const info = await get("/genesis");
show(info);

if (flag("--gas")) die("ราคาต่อหน่วย (call / write …) ปรับบนเชนไม่ได้ · ใช้ fork");
const input = {};
if (option("--min-base-fee") !== undefined) input.minBaseFee = parseWei(option("--min-base-fee"));
if (flag("--reset")) input.minBaseFee = null;
if (!Object.keys(input).length) process.exit(0);   // ดูอย่างเดียว

if (!ADMIN_KEY) die("ต้องตั้ง ADMIN_KEY (key ที่อยู่ใน admins ของ genesis)");
const from = sign.addressOf(ADMIN_KEY);
if (Array.isArray(info.admins) && !info.admins.includes(from.toLowerCase())) die(`${from} ไม่อยู่ใน admins ของเชนนี้`);
console.log(`\nส่ง setGasConfig จาก ${from}: ${JSON.stringify(input)}`);

const { nonce } = await get(`/nonce/${from}`);
const tx = { chainId: info.chainId, from, to: "", action: "setGasConfig", method: "", input, value: 0, gasLimit: 100_000,
  maxFeePerGas: String(big(info.baseFee) * 2n), maxPriorityFeePerGas: "0", nonce };
const sent = await post("/sendtx", { tx, signature: sign.signTransaction(tx, ADMIN_KEY) });
if (!sent.queued) die(`ไม่เข้าคิว: ${JSON.stringify(sent).slice(0, 300)}`);

for (let i = 0; i < 120; i += 1) {
  await wait(500);
  const found = await get(`/tx/${sent.hash}`);
  if (found?.status === "rejected") die(`ถูกปฏิเสธ: ${JSON.stringify(found.error ?? found.reason ?? found).slice(0, 300)}`);
  if (!found?.blockNumber) continue;
  const receipt = await get(`/tx/${sent.hash}/receipt`);
  if (receipt.status !== "success") die(`ล้ม: ${JSON.stringify(receipt.error).slice(0, 300)}`);
  console.log(`✓ อยู่ใน block ${found.blockNumber} · มีผลตั้งแต่ block ${found.blockNumber + 1}\n`);
  await wait(1500);
  show(await get("/genesis"));
  process.exit(0);
}
die(`รอ tx ${sent.hash} นานเกินไป`);
