/** สร้างข้อมูลตัวอย่างบน server ที่รันอยู่: node scripts/seed.js [http://localhost:3000] */
import * as sign from "../src/crypto/signature.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";

const API = process.argv[2] ?? "http://localhost:3000";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const me = sign.addressOf(KEY);
const BOB = "0xfabb0ac9d68b0b445fb7357272ff202c5651694a";

const CODE = TOKEN_PROGRAM;   // มาตรฐาน token: name / ticker / decimals + event Transfer / Approval

const post = (path, body) => fetch(API + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path) => fetch(API + path).then((r) => r.json());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function send(fields) {
  const { nonce } = await get(`/nonce/${me}`);
  const tx = { chainId: 1, from: me, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, gasPrice: 1, nonce, ...fields };
  const result = await post("/sendtx", { tx, signature: sign.signTransaction(tx, KEY) });
  if (!result.queued) {
    console.error(`${tx.action} ไม่เข้าคิว:`, JSON.stringify(result).slice(0, 200));
    process.exit(1);
  }
  console.log(`${tx.action.padEnd(9)} nonce ${nonce} → เข้าคิว`);
  return result.hash;
}

/** รอจนกว่า tx จะเข้า block จริง (block ปิดตาม BLOCK_MS ของ server) */
async function confirm(hash, timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const found = await get(`/tx/${hash}`);
    if (found?.blockNumber) return found;
    await wait(500);
  }
  throw new Error(`รอ tx ${hash} นานเกินไป (server ปิด block อยู่หรือเปล่า)`);
}

// ไอคอน + links ของโปรแกรมตั้งจากโค้ดตอน init (ผู้ใช้ตั้ง metadata ได้เฉพาะ address ของตัวเอง)
const ICON = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b5bdb"/><stop offset="1" stop-color="#7c3aed"/></linearGradient></defs><rect width="64" height="64" rx="14" fill="url(#g)"/><text x="32" y="42" font-size="28" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#fff">M</text></svg>');
const deployHash = await send({ action: "deploy", code: CODE, input: { name: "My Token", ticker: "MTK", decimals: "6n", supply: "1000000000000n", namespace: "mytoken",
  icon: ICON, url: "https://mytoken.example", contact: "mailto:team@mytoken.example", description: "เหรียญตัวอย่าง 6 decimals" } });   // 1,000,000 MTK
const deployed = await confirm(deployHash);
const receipt = await get(`/tx/${deployHash}/receipt`);
const address = receipt.result?.programUuid ?? receipt.result;
console.log(`โปรแกรมอยู่ที่ ${address} (block ${deployed.blockNumber})`);

await confirm(await send({ action: "init", to: address }));
await confirm(await send({ action: "transfer", to: BOB, value: 50_000 }));
await confirm(await send({ action: "call", to: address, method: "transfer", input: { to: BOB, amount: "1200500000n" } }));
await confirm(await send({ action: "metadata", input: { namespace: "alice", description: "ผู้ใช้คนแรก" } }));
await confirm(await send({ action: "call", to: address, method: "transfer", input: { to: "0x1234567890123456789012345678901234567890", amount: "7n" } }));
await confirm(await send({ action: "call", to: address, method: "approve", input: { spender: BOB, amount: "300000000n" } }));

console.log("\nยอดของ bob:", JSON.stringify((await post("/query", { programUuid: address, functionName: "balanceOf", input: { who: BOB } })).result));
console.log("event:", JSON.stringify((await get(`/events?program=${address}`)).map((e) => e.name)));
console.log("block ล่าสุด:", (await get("/block/latest")).number);
console.log(`\nเปิด explorer ที่ ${API}`);
