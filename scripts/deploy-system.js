/**
 * deploy ชุดโปรแกรมกลาง (src/standards/system.js) ตามลำดับ nonce ของกระเป๋า deployer → address รู้ล่วงหน้า
 *
 *   ดู address ก่อน (ไม่ส่ง tx):   DEPLOYER_KEY=0x… node scripts/deploy-system.js http://localhost:3000 --plan
 *                                  (หรือ --deployer 0x… --chain-id 272727 โดยไม่ต้องมี key / ไม่ต้องต่อ node)
 *   deploy จริง:                  DEPLOYER_KEY=0x… ADMIN_KEY=0x… node scripts/deploy-system.js http://localhost:3000
 *     DEPLOYER_KEY  กระเป๋าใหม่ที่ไม่เคยส่ง tx (nonce 0) ต้องมีเงินพอจ่ายแก๊ส · ใช้ deploy ชุดนี้อย่างเดียว
 *     ADMIN_KEY     (ไม่บังคับ) key ที่อยู่ใน ADMINS → อนุมัติให้ทันที · ไม่ส่ง = ค้างรอ admin อนุมัติเอง (หน้า Programs ของ explorer)
 *     SYMBOL        สัญลักษณ์เหรียญหลัก (ไม่ส่ง = nativeCurrency.symbol จาก GET /evm → EVM_SYMBOL ของ server) → WCARD / WBNB …
 *     --out <ไฟล์>  ที่เขียนผล (ค่าเริ่ม deploy/system-programs.json)
 *   รันซ้ำได้: ข้ามตัวที่ deploy / อนุมัติแล้ว · ถ้า nonce ของ deployer ถูกใช้กับอย่างอื่นไป address จะไม่ตรงแผน → หยุด
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

const deployer = (option("--deployer") ?? (DEPLOYER_KEY ? sign.addressOf(DEPLOYER_KEY) : die("ต้องตั้ง DEPLOYER_KEY (หรือ --deployer 0x… กับ --plan)"))).toLowerCase();
const chainId = offline ? Number(option("--chain-id")) : (await get("/genesis")).chainId;
const symbol = process.env.SYMBOL ?? (offline ? "CARD" : (await get("/evm").catch(() => null))?.nativeCurrency?.symbol ?? "CARD");
const predictor = new VirtualMachine(new MemoryDB(), { chainId });
const plan = systemPrograms({ addressAt: (nonce) => predictor.programAddressFor(deployer, nonce), symbol });

console.log(`เชน ${chainId} · deployer ${deployer} · เหรียญหลัก ${symbol}\n`);
for (const item of plan) console.log(`  nonce ${item.nonce}  ${item.address}  ${item.namespace.padEnd(20)} ${item.title}`);
console.log();
if (flag("--plan")) process.exit(0);
if (!DEPLOYER_KEY) die("ต้องตั้ง DEPLOYER_KEY เพื่อ deploy จริง");

const { baseFee } = await get("/genesis");
const gasPrice = String([BigInt(String(baseFee ?? 0).replace(/n$/, "")) * 2n, 10n ** 9n].reduce((a, b) => (a > b ? a : b)));

async function send(key, fields) {
  const from = sign.addressOf(key);
  const { nonce } = await get(`/nonce/${from}`);
  const tx = { chainId, from, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, gasPrice, nonce, ...fields };
  const body = { tx, signature: sign.signTransaction(tx, key) };
  let result = await post("/sendtx", body);
  // mempool จำกัดจำนวน tx ต่อผู้ส่งต่อช่วงเวลา (ส่งถี่เกินกำหนด) → รอแล้วส่งใบเดิมซ้ำ
  for (let i = 0; i < 30 && !result.queued && /ถี่/.test(result.reason ?? ""); i += 1) {
    await wait(1000);
    result = await post("/sendtx", body);
  }
  if (!result.queued) die(`${tx.action} ไม่เข้าคิว: ${JSON.stringify(result).slice(0, 300)}`);
  return { hash: result.hash, nonce };
}

async function confirm(hash, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = await get(`/tx/${hash}`);
    if (found?.status === "rejected") die(`tx ${hash} ถูกปฏิเสธ: ${JSON.stringify(found.error ?? found.reason ?? found).slice(0, 300)}`);
    if (found?.blockNumber) {
      const receipt = await get(`/tx/${hash}/receipt`);
      if (receipt.status !== "success") die(`tx ${hash} ล้ม: ${JSON.stringify(receipt.error).slice(0, 300)}`);
      return receipt;
    }
    await wait(500);
  }
  return die(`รอ tx ${hash} นานเกินไป (server ปิด block อยู่หรือเปล่า)`);
}

/** approved = มีโค้ดแล้ว · pending = รอ admin · missing = ยังไม่ deploy */
async function stateOf(address) {
  const program = await fetch(`${API}/program/${address}`);
  if (program.ok) return "approved";
  const pending = await get("/programs/pending?limit=200");
  return pending.items?.some((item) => item.address === address) ? "pending" : "missing";
}

// ชื่อต้องว่าง (หรือเป็นของ address ตามแผนอยู่แล้ว) ไม่งั้น initialization ล้ม
for (const item of plan) {
  const { address } = await get(`/name/${item.namespace}`);
  if (address && address !== item.address) die(`ชื่อ '${item.namespace}' ถูก ${address} ใช้ไปแล้ว`);
}

const { nonce: firstNonce } = await get(`/nonce/${deployer}`);
const states = {};
for (const item of plan) {
  states[item.key] = await stateOf(item.address);
  if (item.nonce < firstNonce && states[item.key] === "missing") {
    die(`nonce ${item.nonce} ของ deployer ถูกใช้กับอย่างอื่นไปแล้ว (ไม่มีโปรแกรมที่ ${item.address}) · ใช้กระเป๋า deployer ใหม่ที่ไม่เคยส่ง tx`);
  }
}
const native = (await get(`/address/${deployer}`)).native?.balance;
if (firstNonce < plan.length && (native === undefined || BigInt(String(native).replace(/n$/, "")) === 0n)) {
  die(`deployer ${deployer} ไม่มีเงินจ่ายแก๊ส · โอนเหรียญหลักให้ก่อน (ใช้ราว 0.0005 ${symbol} ที่ราคาแก๊ส 1 gwei)`);
}

for (const item of plan.filter((p) => p.nonce >= firstNonce)) {
  const { hash, nonce } = await send(DEPLOYER_KEY, { action: "deploy", code: item.code, input: item.input });
  if (nonce !== item.nonce) die(`nonce ไม่ตรงแผน (ได้ ${nonce} ต้องเป็น ${item.nonce})`);
  const receipt = await confirm(hash);
  const address = receipt.result?.programUuid ?? receipt.result;
  if (address !== item.address) die(`${item.key} ได้ address ${address} ไม่ตรงแผน ${item.address}`);
  states[item.key] = "pending";
  console.log(`deploy  ${item.namespace.padEnd(20)} ${address}`);
}

if (ADMIN_KEY) {
  for (const item of plan.filter((p) => states[p.key] === "pending")) {
    await confirm((await send(ADMIN_KEY, { action: "init", to: item.address })).hash);
    states[item.key] = "approved";
    console.log(`อนุมัติ  ${item.namespace.padEnd(20)} ${item.address}`);
  }
}

const result = {
  chainId, deployer, symbol, updatedAt: new Date().toISOString(),
  programs: Object.fromEntries(plan.map((item) => [item.key, { address: item.address, namespace: item.namespace, title: item.title, nonce: item.nonce, status: states[item.key] }])),
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
const waiting = plan.filter((item) => states[item.key] !== "approved");
console.log(`\nเขียน ${OUT} แล้ว`);
if (waiting.length) console.log(`รอ admin อนุมัติ ${waiting.length} ตัว: ${waiting.map((item) => item.namespace).join(", ")} (รันซ้ำพร้อม ADMIN_KEY หรืออนุมัติในหน้า Programs)`);
else console.log("ครบทุกตัว · explorer หน้า System programs แสดงชื่อให้เอง");
