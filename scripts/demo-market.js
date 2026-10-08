/** รันสถานการณ์ตลาดจริงบน chain ผ่าน HTTP: node scripts/demo-market.js [url] */
import * as sign from "../src/crypto/signature.js";
import fs from "node:fs";

const API = process.argv[2] ?? "http://localhost:3000";
const KEYS = [
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
];
const [alice, bob, carol, dave] = KEYS.map((key, i) => ({ key, address: sign.addressOf(key), name: ["alice", "bob", "carol", "dave"][i] }));
const TREASURY = "0x9999999999999999999999999999999999999999";

/** โปรแกรมเดียวกับที่ใช้ใน test/44-complex-scenario.test.js */
const source = fs.readFileSync(new URL("../test/44-complex-scenario.test.js", import.meta.url), "utf8");
const pick = (name) => source.slice(source.indexOf(`const ${name} = \``) + `const ${name} = \``.length, source.indexOf("`;", source.indexOf(`const ${name} = \``)));
const TOKEN = pick("TOKEN");
const MARKET = pick("MARKET");

const post = (p, b) => fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(API + p).then((r) => r.json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(user, fields, { expectFail = false } = {}) {
  const { nonce } = await get(`/nonce/${user.address}`);
  const tx = { chainId: 1, from: user.address, to: "", method: "", input: {}, value: 0, gasLimit: 800_000, gasPrice: 1, nonce, ...fields };
  const result = await post("/sendtx", { tx, signature: sign.signTransaction(tx, user.key) });
  const label = `${user.name.padEnd(5)} ${(fields.method || fields.action).padEnd(12)}`;
  if (result.queued) { console.log(`${label} ✓`); return result.hash; }
  console.log(`${label} ✗ ${expectFail ? "(คาดไว้)" : "(ไม่คาดคิด)"} ${result.simulation?.error ?? result.error ?? ""}`);
  return null;
}
async function confirm(hash) {
  for (let i = 0; i < 80 && hash; i += 1) { const t = await get(`/tx/${hash}`); if (t?.blockNumber) return t; await wait(300); }
}
const query = (program, functionName, input = {}) => post("/query", { programUuid: program, functionName, input }).then((r) => r.result);

// ---------- deploy ----------
const coinHash = await confirm(await send(alice, { action: "deploy", code: TOKEN, input: { supply: 1_000_000 } })).then(async (t) => t);
const coin = (await get(`/tx/${(await get(`/block/${coinHash.blockNumber}`)).txHashes[coinHash.index]}/receipt`)).result.programUuid;
await confirm(await send(alice, { action: "init", to: coin }));

const marketHash = await confirm(await send(alice, { action: "deploy", code: MARKET, input: { token: coin, treasury: TREASURY, feeBps: 250 } }));
const market = (await get(`/tx/${(await get(`/block/${marketHash.blockNumber}`)).txHashes[marketHash.index]}/receipt`)).result.programUuid;
await confirm(await send(alice, { action: "init", to: market }));
console.log(`\ncoin   ${coin}\nmarket ${market}\n`);

// ---------- แจกเหรียญและ native ----------
for (const who of [bob, carol, dave]) {
  await send(alice, { action: "call", to: coin, method: "transfer", input: { to: who.address, amount: 50_000 } });
  await send(alice, { action: "transfer", to: who.address, value: 200_000 });
}
await wait(2000);

// ---------- ประกาศขาย ----------
const listings = [];
for (const [seller, price, name] of [[bob, 10_000, "เก้าอี้"], [bob, 3_000, "โคมไฟ"], [dave, 25_000, "โต๊ะไม้"]]) {
  const hash = await send(seller, { action: "call", to: market, method: "list", input: { price, name } });
  listings.push(await confirm(hash));
}
const ids = [];
for (const entry of listings) {
  const header = await get(`/block/${entry.blockNumber}`);
  ids.push((await get(`/tx/${header.txHashes[entry.index]}/receipt`)).result);
}
console.log("ประกาศขาย:", ids.join(", "));

// ---------- ซื้อขายจริง ----------
await confirm(await send(carol, { action: "call", to: coin, method: "approve", input: { spender: market, amount: 20_000 } }));
await confirm(await send(carol, { action: "call", to: market, method: "buy", input: { id: ids[0] } }));
await send(dave, { action: "call", to: market, method: "buy", input: { id: ids[1] } }, { expectFail: true });   // ยังไม่ approve
await confirm(await send(dave, { action: "call", to: coin, method: "approve", input: { spender: market, amount: 50_000 } }));
await confirm(await send(dave, { action: "call", to: market, method: "buy", input: { id: ids[1] } }));
await send(carol, { action: "call", to: market, method: "buy", input: { id: ids[0] } }, { expectFail: true });  // ขายไปแล้ว
await send(bob, { action: "call", to: market, method: "cancel", input: { id: ids[2] } }, { expectFail: true }); // ไม่ใช่เจ้าของ

// ---------- ฝาก-ถอน native ----------
await confirm(await send(bob, { action: "call", to: market, method: "deposit", input: {}, value: 30_000 }));
await confirm(await send(carol, { action: "call", to: market, method: "deposit", input: {}, value: 12_000 }));
await send(dave, { action: "call", to: market, method: "withdraw", input: {} }, { expectFail: true });          // ไม่มีเงินฝาก
await confirm(await send(bob, { action: "call", to: market, method: "withdraw", input: {} }));

// ---------- ตั้งชื่อให้ address ----------
for (const [who, namespace] of [[alice, "alice"], [bob, "bob"], [carol, "carol"]]) {
  await send(who, { action: "metadata", input: { namespace, description: `ผู้ใช้ ${namespace}` } });
}
await wait(2500);

// ---------- สรุป ----------
const stats = await query(market, "stats");
const holders = await Promise.all([alice, bob, carol, dave].map(async (u) => `${u.name} ${await query(coin, "balanceOf", { who: u.address })}`));
const marketInfo = await get(`/program/${market}?limit=200`);
const latest = await get("/block/latest");

console.log(`\nstats ตลาด: ${JSON.stringify(stats)}`);
console.log(`เหรียญ: ${holders.join(" · ")} · คลัง ${await query(coin, "balanceOf", { who: TREASURY })}`);
console.log(`native ในตลาด: ${marketInfo.native.balance} · storage ${marketInfo.storage.length} key · event ${marketInfo.events.length}`);
console.log(`ผู้ที่เรียกใช้ตลาด: ${marketInfo.interactions.length} ครั้ง · block ทั้งหมด ${latest.number}`);
console.log(`\nเปิด ${API}  →  โปรแกรม: ${API}/#address/${market}`);
