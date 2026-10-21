import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM, MemoryDB } from "./helpers.js";
import { Mempool } from "../src/node/mempool.js";
import { TxLog } from "../src/node/txlog.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN } from "./programs.js";

/* server: GET /tx ตอบ rejected · /rejected แบ่งหน้า · /evm เห็นเป็น tx ที่ล้ม · /groups นับครบ · cursor ของ interactions / events · replaced อยู่รอด restart */

const ALICE_KEY = sign.randomPrivateKey();
const BOB_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const bob = sign.addressOf(BOB_KEY);
const signed = (tx, key = ALICE_KEY) => ({ tx, signature: sign.signTransaction(tx, key) });

let server, vm, mempool, url, chainId, token;
let clock = Date.now();

before(async () => {
  let miner;
  ({ server, vm, mempool, miner } = await import("../server.js"));
  clearInterval(miner);                                           // ปิด block เองในเทสต์
  vm.db.load({ [`${alice}:native:received`]: "1000000000000000000n", [`${bob}:native:received`]: "1000000000000000000n" });
  chainId = vm.chainId;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (p, body) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (p) => fetch(url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
const rpc = (method, params = []) => post("/evm", { jsonrpc: "2.0", id: 1, method, params }).then((r) => r.result);
const mine = () => {
  clock += 1000;
  const block = vm.createBlock({ timestamp: clock, feeRecipient: "0x1111111111111111111111111111111111111111" });
  mempool.take(block);
  block.commit();
  return vm.getBlock(block.number);
};
const tx = (fields) => ({ chainId, from: alice, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, gasPrice: "1000000000", ...fields });

test("ตั้งต้น: deploy + init token ผ่าน /sendtx", async () => {
  const deploy = await post("/sendtx", signed(tx({ action: "deploy", code: TOKEN, input: { supply: 1_000_000 }, nonce: 0 })));
  assert.equal(deploy.queued, true, JSON.stringify(deploy));
  mine();
  token = vm.getTransaction(deploy.hash).record?.result?.programUuid ?? (await get(`/tx/${deploy.hash}/receipt`)).body.result.programUuid;
  const init = await post("/sendtx", signed(tx({ action: "init", to: token, nonce: 1 })));
  assert.equal(init.queued, true, JSON.stringify(init));
  mine();
  assert.ok((await get(`/program/${token}`)).body.code);
});

let rejectedHash, header;
test("/tx: ถูกปฏิเสธที่ /sendtx → rejected (block: null) ทันที → เข้า block ถัดไปแล้วตอบเลข block + เหตุผล", async () => {
  const bad = await post("/sendtx", signed(tx({ action: "call", to: token, method: "transfer", input: { to: bob, amount: "1n" }, nonce: 9 })));
  assert.equal(bad.queued, false);
  assert.equal(bad.reason, "nonce ต้องเป็น 2");
  rejectedHash = sign.verifyTransaction(signed(tx({ action: "call", to: token, method: "transfer", input: { to: bob, amount: "1n" }, nonce: 9 }))).hash;
  assert.equal(bad.hash, rejectedHash);
  const waiting = (await get(`/tx/${rejectedHash}`)).body;
  assert.deepEqual([waiting.status, waiting.block, waiting.stage, waiting.reason, waiting.sender, waiting.nonce], ["rejected", null, "sendtx", "nonce ต้องเป็น 2", alice, 9]);
  assert.equal((await get("/pending")).body.rejectedPending, 1);

  // ใบลายเซ็นผิด → ไม่ถูกบันทึก
  const forged = await post("/sendtx", { tx: tx({ action: "transfer", to: bob, value: 1, nonce: 2 }), signature: sign.signTransaction(tx({ action: "transfer", to: bob, value: 2, nonce: 2 }), BOB_KEY) });
  assert.equal(forged.queued, false);
  assert.equal((await get("/pending")).body.rejectedPending, 1);

  // tx จริง 1 ใบ + ใบที่ถูกปฏิเสธ
  const good = await post("/sendtx", signed(tx({ action: "call", to: token, method: "transfer", input: { to: bob, amount: "5n" }, nonce: 2 })));
  assert.equal(good.queued, true);
  header = mine();
  assert.deepEqual([header.txCount, header.rejectedCount], [1, 1]);
  const found = (await get(`/tx/${rejectedHash}`)).body;
  assert.deepEqual([found.status, found.block, found.blockNumber, found.index, found.reason, found.to], ["rejected", header.number, header.number, 0, "nonce ต้องเป็น 2", token]);
  assert.equal((await get(`/tx/${rejectedHash}/receipt`)).status, 404);   // ไม่ได้รัน = ไม่มี receipt
  assert.equal((await get(`/nonce/${alice}`)).body.nonce, 3);              // ไม่กิน nonce
  const full = (await get(`/block/${header.number}?full=1`)).body;
  assert.equal(full.hash, header.hash);                                     // replay ตรวจ hash รวมรายการที่ถูกปฏิเสธ
  assert.deepEqual(full.rejected.map((item) => item.hash), [rejectedHash]);
  const synced = (await get(`/sync?from=${header.number}`)).body[0];
  assert.deepEqual(synced.rejected.map((item) => item.hash), [rejectedHash]);
});

test("/rejected และ /address/:a/rejected: ใหม่ไปเก่า แบ่งหน้าด้วย cursor · กรองตามผู้ส่ง", async () => {
  // bob ถูกปฏิเสธ 3 ใบ (nonce ผิด) + alice อีก 1 ใบ
  const bobs = [];
  for (const nonce of [7, 8, 9]) bobs.push((await post("/sendtx", signed(tx({ from: bob, action: "transfer", to: alice, value: 1, nonce }), BOB_KEY))).hash);
  const aliceAgain = (await post("/sendtx", signed(tx({ action: "transfer", to: bob, value: 1, nonce: 50 })))).hash;
  mine();
  const page1 = (await get(`/rejected?address=${bob}&limit=2`)).body;
  assert.deepEqual(page1.items.map((item) => item.hash), [bobs[2], bobs[1]]);
  assert.ok(page1.next);
  const page2 = (await get(`/rejected?address=${bob}&limit=2&cursor=${encodeURIComponent(page1.next)}`)).body;
  assert.deepEqual(page2.items.map((item) => item.hash), [bobs[0]]);
  assert.equal(page2.next, null);
  assert.deepEqual((await get(`/address/${bob.toUpperCase().replace("0X", "0x")}/rejected?limit=5`)).body.items.length, 3);

  const all = (await get("/rejected?limit=3")).body;
  assert.deepEqual(all.items.map((item) => item.hash), [aliceAgain, bobs[2], bobs[1]]);
  const rest = (await get(`/rejected?limit=3&cursor=${encodeURIComponent(all.next)}`)).body;
  assert.deepEqual(rest.items.map((item) => item.hash), [bobs[0], rejectedHash]);
  assert.ok(rest.items.every((item) => Number.isInteger(item.blockNumber) && item.timestamp));
});

test("/evm: tx ที่ถูกปฏิเสธต่อท้าย tx จริงของ block เป็น tx ที่ล้ม (status 0x0, gasUsed 0) · index / log / gas สะสมสอดคล้อง · nonce ไม่เปลี่ยน", async () => {
  const number = `0x${header.number.toString(16)}`;
  const block = await rpc("eth_getBlockByNumber", [number, false]);
  assert.deepEqual(block.transactions, [...header.txHashes, rejectedHash]);
  assert.equal(await rpc("eth_getBlockTransactionCountByNumber", [number]), "0x2");
  const full = await rpc("eth_getBlockByNumber", [number, true]);
  assert.deepEqual(full.transactions.map((t) => t.transactionIndex), ["0x0", "0x1"]);

  const view = await rpc("eth_getTransactionByHash", [rejectedHash]);
  assert.deepEqual([view.hash, view.nonce, view.blockNumber, view.transactionIndex, view.from, view.to, view.gasPrice],
    [rejectedHash, "0x9", number, "0x1", alice, token, "0x3b9aca00"]);
  assert.equal((await rpc("eth_getTransactionByBlockNumberAndIndex", [number, "0x1"])).hash, rejectedHash);

  const receipts = await rpc("eth_getBlockReceipts", [number]);
  assert.equal(receipts.length, 2);
  const [real, rejected] = receipts;
  assert.equal(real.status, "0x1");
  assert.deepEqual([rejected.status, rejected.gasUsed, rejected.cumulativeGasUsed, rejected.transactionIndex, rejected.logs.length, rejected.effectiveGasPrice],
    ["0x0", "0x0", real.cumulativeGasUsed, "0x1", 0, "0x3b9aca00"]);
  assert.deepEqual(await rpc("eth_getTransactionReceipt", [rejectedHash]), rejected);
  assert.ok(real.logs.every((log, i) => log.logIndex === `0x${i.toString(16)}`));
  const trace = await rpc("debug_traceTransaction", [rejectedHash, { tracer: "callTracer" }]);
  assert.equal(trace.error, "nonce ต้องเป็น 2");
  assert.equal((await rpc("debug_traceBlockByNumber", [number, { tracer: "callTracer" }])).length, 2);
  assert.equal(await rpc("eth_getTransactionCount", [alice, "latest"]), "0x3");
});

test("/evm: hash ที่ถูกปฏิเสธแล้วภายหลังเข้า block จริง → เห็นเป็น tx จริงอันเดียว (ไม่ซ้ำใน block เก่า)", async () => {
  const later = signed(tx({ action: "transfer", to: bob, value: 0, nonce: 4 }));   // nonce ยังไม่ถึง → ถูกปฏิเสธ
  const first = await post("/sendtx", later);
  assert.equal(first.queued, false);
  const oldBlock = mine();
  assert.equal(oldBlock.rejectedCount, 1);
  await post("/sendtx", signed(tx({ action: "transfer", to: bob, value: 0, nonce: 3 })));
  assert.equal((await post("/sendtx", later)).queued, true);                    // ส่งใบเดิมอีกครั้ง ตอนนี้ nonce ถึงแล้ว
  const newBlock = mine();
  assert.equal(newBlock.txCount, 2);
  assert.equal((await get(`/tx/${first.hash}`)).body.blockNumber, newBlock.number);
  assert.equal((await get(`/tx/${first.hash}`)).body.status, "success");
  assert.deepEqual((await rpc("eth_getBlockByNumber", [`0x${oldBlock.number.toString(16)}`, false])).transactions, []);
  assert.equal((await rpc("eth_getTransactionByHash", [first.hash])).blockNumber, `0x${newBlock.number.toString(16)}`);
});

test("/program/:a/groups: นับครบเกิน 5,000 key ทีละช่วง (scan ต่อ request มีเพดาน)", async () => {
  const program = "0x" + "77".repeat(20);
  const data = {};
  for (let i = 0; i < 7000; i += 1) data[`${program}:storage:balances:${String(i).padStart(5, "0")}`] = `${i}n`;
  for (let i = 0; i < 5500; i += 1) data[`${program}:storage:items:${String(i).padStart(5, "0")}`] = i;
  data[`${program}:storage:owner`] = alice;
  vm.db.load(data);

  const totals = new Map();
  let cursor, requests = 0, scanned = 0;
  do {
    const res = (await get(`/program/${program}/groups?scan=5000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`)).body;
    assert.ok(res.scanned <= 5000);
    for (const { name, count } of res.groups) totals.set(name, (totals.get(name) ?? 0) + count);
    scanned += res.scanned;
    cursor = res.next;
    requests += 1;
    assert.equal(res.complete, cursor === null);
  } while (cursor);
  assert.equal(requests, 3);
  assert.equal(scanned, 12_501);
  assert.deepEqual(Object.fromEntries(totals), { balances: 7000, items: 5500, owner: 1 });
  const once = (await get(`/program/${program}/groups`)).body;                  // ค่าตั้งต้น 20,000 key → ครบในครั้งเดียว
  assert.deepEqual([once.total, once.complete, once.groups[0]], [12_501, true, { name: "balances", count: 7000 }]);
  assert.equal((await get(`/program/${program}/groups?scan=999999`)).body.scanned, 12_501);   // เพดาน 50,000
});

test("interactions / events แบบ cursor: ใหม่ไปเก่า ต่อหน้าได้จนครบ ตรงกับแบบเลขหน้า", async () => {
  for (let i = 0; i < 5; i += 1) {
    await post("/sendtx", signed(tx({ action: "call", to: token, method: "transfer", input: { to: bob, amount: "1n" }, nonce: 5 + i })));
  }
  mine();
  const walk = async (base) => {
    const items = [];
    let cursor = "";
    do {
      const res = (await get(`${base}${base.includes("?") ? "&" : "?"}limit=2&cursor=${encodeURIComponent(cursor)}`)).body;
      assert.ok(res.items.length <= 2);
      items.push(...res.items);
      cursor = res.next;
    } while (cursor);
    return items;
  };
  const calls = await walk(`/program/${token}/interactions`);
  const paged = (await get(`/address/${token}/incoming?limit=100`)).body.items;
  assert.deepEqual(calls.map((t) => `${t.hash}:${t.depth ?? 0}`), paged.map((t) => `${t.hash}:${t.depth ?? 0}`));
  assert.ok(calls.length >= 7);
  assert.deepEqual((await walk(`/address/${token}/incoming`)).length, calls.length);
  const events = await walk(`/program/${token}/events`);
  assert.deepEqual(events.map((e) => e.txHash), (await get(`/program/${token}/events?limit=100`)).body.items.map((e) => e.txHash));
  assert.deepEqual((await walk(`/program/${token}/events?name=Transfer`)).length, events.filter((e) => e.name === "Transfer").length);
});

// ---------------------------------------------------------------------------
//  replaced: off-chain มีเพดาน · มีไฟล์ = อยู่รอด restart
// ---------------------------------------------------------------------------

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "txlog-"));

test("replaced: เปิด Mempool ใหม่ (restart) ด้วยไฟล์เดิม → ยังตอบ replacedBy ได้ แม้พ้น ttlMs ของ mempool", () => {
  const dir = tmp();
  const file = path.join(dir, "replaced-tx.jsonl");
  const chain = new VM.VirtualMachine(new MemoryDB(), { requireNonce: true, chargeGas: true });
  chain.db.load({ [`${alice}:native:received`]: "1000000000000n" });
  const T = Date.now();
  const pool = new Mempool(chain, { ttlMs: 1000, replacedLog: new TxLog({ file }) });
  const cancel = (gasPrice) => signed({ chainId: 1, action: "transfer", from: alice, to: alice, value: 0, nonce: 0, gasLimit: 0, gasPrice });
  const old = pool.add(cancel(10), { now: T });
  const next = pool.add(cancel(11), { now: T });
  assert.equal(next.replaced, old.hash);

  const restarted = new Mempool(chain, { ttlMs: 1000, replacedLog: new TxLog({ file }) });
  assert.equal(restarted.replacedBy(old.hash, { now: T + 60_000 }), next.hash);
  assert.equal(new Mempool(chain).replacedBy(old.hash), null);                 // ไม่มี log = จำแค่ในหน่วยความจำ
  const saved = new TxLog({ file }).get(old.hash);
  assert.deepEqual([saved.replacedBy, saved.sender, saved.nonce, saved.action], [next.hash, alice, 0, "transfer"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("TxLog: เพดานจำนวน / อายุ · บรรทัดเสียถูกข้าม · ไฟล์ถูก compact ไม่โตไม่รู้จบ · list ตามผู้ส่งแบบ cursor", () => {
  const dir = tmp();
  const file = path.join(dir, "log.jsonl");
  const h = (n) => `0x${n.toString(16).padStart(64, "0")}`;
  const log = new TxLog({ file, maxEntries: 600, maxAgeMs: 10_000 });
  const T = Date.now();
  for (let n = 0; n < 2000; n += 1) log.record({ hash: h(n), sender: n % 2 ? alice : bob, n }, { now: T });
  assert.equal(log.size, 600);
  assert.equal(log.get(h(1399), { now: T }), null);                           // เก่าเกินเพดานจำนวน
  assert.equal(log.get(h(1400), { now: T }).n, 1400);
  assert.ok(fs.readFileSync(file, "utf8").trim().split("\n").length <= 1200);  // compact เมื่อเกิน 2 เท่า
  assert.equal(log.get(h(1999), { now: T + 10_001 }), null);                   // พ้นอายุ

  const page = log.list({ address: alice, limit: 100, now: T });
  assert.equal(page.items[0].n, 1999);
  assert.ok(page.items.every((item) => item.sender === alice));
  let total = page.items.length, cursor = page.next;
  while (cursor) { const res = log.list({ address: alice, limit: 100, cursor, now: T }); total += res.items.length; cursor = res.next; }
  assert.equal(total, 300);

  log.record({ hash: h(1999), sender: alice, n: "ใหม่" }, { now: T });         // hash เดิม = แทนที่
  fs.appendFileSync(file, "{เสีย\n");
  const reopened = new TxLog({ file, maxEntries: 600, maxAgeMs: 10_000 });
  assert.equal(reopened.size, 600);
  assert.equal(reopened.get(h(1999)).n, "ใหม่");
  assert.equal(reopened.list({ limit: 1 }).items[0].hash, h(1999));
  fs.rmSync(dir, { recursive: true, force: true });
});
