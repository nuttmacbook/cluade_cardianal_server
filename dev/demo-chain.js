/** Creates varied real data on the chain: node dev/demo-chain.js [url] */
import * as sign from "../src/crypto/signature.js";

// native has 18 decimals (wei) and the gas price is 1 gwei → native amounts in this script are counted in gwei
const gwei = (amount) => `${BigInt(amount) * 10n ** 9n}`;
const API = process.argv[2] ?? "http://localhost:3000";
const KEYS = ["0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"];
const users = KEYS.map((key) => ({ key, address: sign.addressOf(key) }));

const post = (p, b) => fetch(API + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const get = (p) => fetch(API + p).then((r) => r.json());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const TOKEN = `function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
    setMetadata("namespace", params.input.name)
    setMetadata("description", "Test coin on the Program VM")
    writeDB(map("balances", params.context.sender), params.input.supply)
    emit("Minted", { to: params.context.sender, amount: params.input.supply })
  }
  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }
  function transfer(params) {
    const from = params.context.sender
    const balance = readDB(map("balances", from)) || 0n
    if (balance < params.input.amount) throw new Error("insufficient balance")
    writeDB(map("balances", from), balance - params.input.amount)
    writeDB(map("balances", params.input.to), (readDB(map("balances", params.input.to)) || 0n) + params.input.amount)
    emit("Transfer", { from: from, to: params.input.to, amount: params.input.amount })
    return true
  }
  return { balanceOf, transfer }
}`;

const SHOP = `function program() {
  function initialization(params) {
    writeDB("token", params.input.token)
    writeDB("price", params.input.price)
    setMetadata("namespace", "shop")
  }
  function price() { return readDB("price") }
  function buy(params) {
    const paid = params.value
    if (paid < readDB("price")) throw new Error("underpaid")
    writeDB(map("orders", params.context.sender), (readDB(map("orders", params.context.sender)) || 0n) + 1n)
    emit("Purchased", { buyer: params.context.sender, paid: paid })
    return readDB(map("orders", params.context.sender))
  }
  function withdraw(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("not the owner")
    transferNative(params.context.sender, ThisBalance())
    return 0n
  }
  return { price, buy, withdraw }
}`;

async function send(user, fields) {
  const { nonce } = await get(`/nonce/${user.address}`);
  const tx = { chainId: (await get("/genesis")).chainId, from: user.address, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, gasPrice: gwei(1), nonce, ...fields };
  const result = await post("/sendtx", { tx, signature: sign.signTransaction(tx, user.key) });
  console.log(`${(fields.method || fields.action).padEnd(10)} ${user.address.slice(0, 8)} →`, result.queued ? "ok" : (result.simulation?.error ?? result.error ?? "").slice(0, 50));
  return result.hash;
}
async function confirm(hash) {
  for (let i = 0; i < 60 && hash; i += 1) { const t = await get(`/tx/${hash}`); if (t?.blockNumber) return t; await wait(400); }
}

const [alice, bob, carol] = users;
console.log("users:", users.map((u) => u.address.slice(0, 10)).join(", "));

// 1) token
const tokenHash = await send(alice, { action: "deploy", code: TOKEN, input: { supply: 1_000_000, name: "demo" } });
await confirm(tokenHash);
const token = (await get(`/tx/${tokenHash}/receipt`)).result.programUuid;
await confirm(await send(alice, { action: "init", to: token }));

// 2) a shop that accepts payment
const shopHash = await send(alice, { action: "deploy", code: SHOP, input: { token, price: `${gwei(500)}n` } });
await confirm(shopHash);
const shop = (await get(`/tx/${shopHash}/receipt`)).result.programUuid;
await confirm(await send(alice, { action: "init", to: shop }));

// 3) transfer the native coin to others
for (const user of [bob, carol]) await confirm(await send(alice, { action: "transfer", to: user.address, value: gwei(100_000) }));

// 4) various txs: success / failure / with value / metadata
await send(alice, { action: "call", to: token, method: "transfer", input: { to: bob.address, amount: 25_000 } });
await send(alice, { action: "call", to: token, method: "transfer", input: { to: carol.address, amount: 10_000 } });
await send(alice, { action: "metadata", input: { namespace: "alice", description: "chain creator" } });
await confirm(await send(bob, { action: "metadata", input: { namespace: "bob" } }));
await send(bob, { action: "call", to: token, method: "transfer", input: { to: carol.address, amount: 5_000 } });
await confirm(await send(bob, { action: "call", to: shop, method: "buy", input: {}, value: gwei(800) }));
await send(carol, { action: "call", to: shop, method: "buy", input: {}, value: gwei(100) });        // underpaid → fails
await send(carol, { action: "call", to: token, method: "transfer", input: { to: bob.address, amount: 9_999_999 } }); // insufficient balance → fails
await confirm(await send(bob, { action: "call", to: shop, method: "withdraw", input: {} }));   // not the owner → fails

// 5) many txs, to see pagination
for (let i = 0; i < 25; i += 1) {
  await send(alice, { action: "call", to: token, method: "transfer", input: { to: `0x${String(i).padStart(40, "0")}`, amount: 3 } });
  if (i % 5 === 4) await wait(1200);
}
await wait(4000);

const latest = await get("/block/latest");
console.log(`\ntotal blocks ${latest.number}`);
console.log("token:", token, "| shop:", shop);
console.log("token storage:", (await get(`/program/${token}?limit=200`)).storage.length, "entries");
console.log("event:", (await get(`/events?program=${token}&limit=100`)).length);
console.log(`\nopen ${API}`);
