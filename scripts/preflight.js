/**
 * ตรวจ genesis + env ก่อนเปิดเชนจริง (ไม่เปิด server · ไม่แตะ DATA)
 *
 *   node --env-file=deploy/producer.env scripts/preflight.js      # เครื่องผู้ผลิต
 *   node --env-file=deploy/follower.env scripts/preflight.js      # เครื่องสำรอง (FOLLOW)
 *
 * exit 0 = เปิดได้ · 1 = มีปัญหา (server จะไม่ยอมเริ่ม หรือเริ่มได้แต่ตั้งค่าผิดแบบที่แก้ทีหลังต้องล้างเชน)
 * ตรวจเหมือนตอน server เริ่ม (startupProblems) + ข้อที่ server ยอมให้ผ่านแต่ไม่ควรใช้กับเชนสาธารณะ
 */
import fs from "node:fs";
import { resolveSettings, startupProblems, startupWarnings } from "../src/node/genesis.js";
import { addressOf } from "../src/crypto/signature.js";

const env = process.env;
const problems = [];
const warnings = [];
const file = env.GENESIS ?? "genesis.json";
if (!fs.existsSync(file)) {
  console.error(`ไม่มีไฟล์ genesis: ${file} (ตั้ง GENESIS=<ไฟล์>)`);
  process.exit(1);
}
const genesis = JSON.parse(fs.readFileSync(file, "utf8"));
const { settings, errors } = resolveSettings(genesis, env);
const dev = ["1", "true", "yes", "on"].includes(String(env.DEV ?? "").toLowerCase());
let producer = null;
try { producer = env.PRODUCER_KEY ? addressOf(env.PRODUCER_KEY) : null; } catch (error) { problems.push(`PRODUCER_KEY ใช้ไม่ได้: ${error.message}`); }
const follow = Boolean(env.FOLLOW);

// ---- เหมือนตอน server เริ่ม
problems.push(...startupProblems({ settings, errors, dev: false, producer, follow }));
warnings.push(...startupWarnings({ settings, dev: false }));

// ---- server ยอมให้ผ่าน แต่ไม่ควรใช้กับเชนสาธารณะ
if (dev) problems.push("ตั้ง DEV=1 อยู่ — ปิดการบังคับ admin / key ห้ามใช้กับเชนจริง");
if (!genesis.config) problems.push(`${file} ไม่มี config — ค่าของเชนไม่ถูกล็อกใน genesis (ไฟล์ของช่วงพัฒนา) · ใช้ deploy/genesis.mainnet.example.json`);
if (settings.chainId === 1) problems.push("chainId = 1 ชนกับ Ethereum mainnet · ใช้เลขที่ไม่ซ้ำ (เช็คที่ chainlist.org)");
for (const [address, amount] of Object.entries(genesis.balances ?? {})) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) problems.push(`balances มีค่าที่ไม่ใช่ address: ${address}`);
  if (!/^\d+n?$/.test(String(amount))) problems.push(`balances ของ ${address} ต้องเป็นจำนวนเต็ม wei (เช่น "1000000000000000000n"): ${amount}`);
}
if (!Object.keys(genesis.balances ?? {}).length) warnings.push("balances ว่าง — ไม่มีใครมีเหรียญจ่ายค่าแก๊สตอนเริ่ม");
if (!settings.upgradeDelayBlocks) warnings.push("upgradeDelayBlocks = 0 — อนุมัติอัปเกรดแล้วโค้ดใหม่ใช้ทันที ผู้ใช้ไม่มีเวลาเห็นก่อน (แนะนำ 3600 = 1 ชม. ที่ block 1 วิ)");
if (settings.admins?.length === 1) warnings.push("config.admins มีคนเดียว — กระเป๋านั้นหาย = อนุมัติ deploy / upgrade ไม่ได้อีก");
if (!Number(env.TRUST_PROXY)) warnings.push("TRUST_PROXY ไม่ได้ตั้ง — ถ้าอยู่หลัง nginx ทุกคนจะได้ IP เดียวกัน (rate limit บล็อกทุกคนพร้อมกัน)");
if (env.HOST !== "127.0.0.1" && env.HOST !== "localhost") warnings.push("HOST ไม่ใช่ 127.0.0.1 — server ฟังทุก interface · ต้องปิดพอร์ตด้วย firewall ไม่ให้คนนอกเข้าตรง (ข้าม HTTPS / rate limit)");
if (!env.DATA) warnings.push("DATA ไม่ได้ตั้ง — ข้อมูลเชนอยู่ใน ./data ข้าง server.js");

console.log(`genesis: ${file}`);
console.log(`chainId ${settings.chainId} · block ${settings.blockMs} ms · maxBlockGas ${settings.maxBlockGas} · gasTarget ${settings.gasTarget ?? settings.maxBlockGas / 2} · upgradeDelayBlocks ${settings.upgradeDelayBlocks}`);
console.log(`admins: ${(settings.admins ?? []).join(", ") || "-"}`);
console.log(`producers: ${(settings.producers ?? []).join(", ") || "-"}`);
console.log(`เครื่องนี้: ${follow ? `เครื่องสำรอง ตาม ${env.FOLLOW}` : producer ? `ผู้ผลิต ${producer}` : "-"}`);
for (const warning of warnings) console.log(`เตือน: ${warning}`);
if (problems.length) {
  console.log(`\nยังเปิดไม่ได้ (${problems.length}):`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exit(1);
}
console.log("\nผ่าน · เปิดได้");
