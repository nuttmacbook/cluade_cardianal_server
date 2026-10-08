/** สร้างข้อมูลตัวอย่างบน server ที่รันอยู่: node scripts/seed.js [http://localhost:3000] */
import * as sign from "../src/crypto/signature.js";

const API = process.argv[2] ?? "http://localhost:3000";
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const me = sign.addressOf(KEY);
const BOB = "0xfabb0ac9d68b0b445fb7357272ff202c5651694a";

const CODE = `function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
    setMetadata("namespace", "mytoken")
    writeDB(map("balances", params.context.sender), params.input.supply)
  }

  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }

  function transfer(params) {
    const from = params.context.sender
    const balance = readDB(map("balances", from)) || 0n
    if (balance < params.input.amount) throw new Error("ยอดไม่พอ")
    writeDB(map("balances", from), balance - params.input.amount)
    writeDB(map("balances", params.input.to), (readDB(map("balances", params.input.to)) || 0n) + params.input.amount)
    emit("Transfer", { from: from, to: params.input.to, amount: params.input.amount })
    return true
  }

  return { balanceOf, transfer }
}`;

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

const deployHash = await send({ action: "deploy", code: CODE, input: { supply: 1000000 } });
const deployed = await confirm(deployHash);
const receipt = await get(`/tx/${deployHash}/receipt`);
const address = receipt.result?.programUuid ?? receipt.result;
console.log(`โปรแกรมอยู่ที่ ${address} (block ${deployed.blockNumber})`);

await confirm(await send({ action: "init", to: address }));
await confirm(await send({ action: "transfer", to: BOB, value: 50_000 }));
await confirm(await send({ action: "call", to: address, method: "transfer", input: { to: BOB, amount: 1200 } }));
await confirm(await send({ action: "metadata", input: { namespace: "alice", description: "ผู้ใช้คนแรก" } }));
await confirm(await send({ action: "call", to: address, method: "transfer", input: { to: "0x1234567890123456789012345678901234567890", amount: 7 } }));

console.log("\nยอดของ bob:", JSON.stringify((await post("/query", { programUuid: address, functionName: "balanceOf", input: { who: BOB } })).result));
console.log("event:", JSON.stringify((await get(`/events?program=${address}`)).map((e) => e.name)));
console.log("block ล่าสุด:", (await get("/block/latest")).number);
console.log(`\nเปิด explorer ที่ ${API}`);
