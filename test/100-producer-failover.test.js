import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { signTypedDataDigest } from "../src/crypto/program-signature.js";
import { resolveSettings, startupProblems, startupWarnings, parseProducerSchedule, producersAt, producerSetOf } from "../src/node/genesis.js";
import { applyBlock, syncOnce } from "../src/node/sync.js";
import { probeNode, prepareFailover } from "../src/node/failover.js";
import { createClient } from "../client-sdk/index.js";

/*
 * single producer: machine failure / lost key / leaked key
 *   case 1 machine failure → a standby with FOLLOW=<url> syncs along · switch to producing with FAILOVER_FROM (old machine still producing = refuses to start)
 *   case 2 lost key     → a spare key in config.producers keeps producing immediately (blocks from both keys sync)
 *   case 3 leaked key   → genesis.producerSchedule removes the old key from block N (not part of the genesis hash) → blocks the old key produces after N = rejected
 */

const T = Date.parse("2026-01-01T00:00:00Z");
const ROOT = new URL("..", import.meta.url).pathname;
const KEY = sign.randomPrivateKey();
const SPARE_KEY = sign.randomPrivateKey();
const NEW_KEY = sign.randomPrivateKey();
const [P, SPARE, NEW] = [KEY, SPARE_KEY, NEW_KEY].map((key) => sign.addressOf(key));
const producerOf = (key) => ({ address: sign.addressOf(key), sign: (hash) => signTypedDataDigest(hash, key) });
const OPTIONS = { recordBlocks: true, recordHistory: true, recordTransactions: true };
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";

const fresh = (key = null) => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { ...OPTIONS, producer: key ? producerOf(key) : null });
  vm.db.load({ [`${ALICE}:native:received`]: "1000n" });
  return vm;
};
/** produces blocks on top of vm, one per key (keys in block order) */
function produce(vm, keys) {
  for (const key of keys) {
    vm.producer = producerOf(key);
    const block = vm.createBlock({ timestamp: T + ((vm.latestBlockNumber() ?? 0) + 1) * 1000 });
    assert.equal(block.transfer({ from: ALICE, to: BOB, amount: "1n" }).status, "success");
    block.commit();
  }
  return vm;
}
const itemsOf = (vm, from = 1) => {
  const items = [];
  for (let n = from; n <= vm.latestBlockNumber(); n += 1) items.push({ header: vm.getBlock(n), body: vm.getBlockBody(n), rejected: vm.getBlockRejected(n) });
  return items;
};

test("producerSchedule: format checks · sorted by block · producersAt uses the list already in effect", () => {
  assert.deepEqual(parseProducerSchedule(undefined, [P]), { entries: [] });
  const { entries } = parseProducerSchedule([{ fromBlock: 20, producers: [SPARE] }, { fromBlock: 10, producers: [NEW.toUpperCase().replace("0X", "0x"), SPARE] }], [P]);
  assert.deepEqual(entries, [{ fromBlock: 10, producers: [NEW, SPARE] }, { fromBlock: 20, producers: [SPARE] }]);
  const settings = { producers: [P], producerSchedule: entries };
  assert.deepEqual([1, 9, 10, 19, 20, 999].map((n) => producersAt(settings, n)), [[P], [P], [NEW, SPARE], [NEW, SPARE], [SPARE], [SPARE]]);
  assert.equal(producersAt({ producers: null }, 5), null);

  for (const [raw, pattern] of [
    [{}, /must be \[/],
    [[{ fromBlock: 1, producers: [NEW] }], /≥ 2/],
    [[{ fromBlock: "5", producers: [NEW] }], /≥ 2/],
    [[{ fromBlock: 5, producers: [] }], /at least 1/],
    [[{ fromBlock: 5, producers: ["0xabc"] }], /at least 1/],
    [[{ fromBlock: 5, producers: [NEW] }, { fromBlock: 5, producers: [P] }], /duplicate/],
  ]) assert.match(parseProducerSchedule(raw, [P]).error, pattern);
  assert.match(parseProducerSchedule([{ fromBlock: 5, producers: [NEW] }], null).error, /config.producers \(the list from block 1\) is required/);

  const genesis = { chainId: 3, config: { producers: [P] }, producerSchedule: [{ fromBlock: 4, producers: [NEW] }] };
  assert.deepEqual(resolveSettings(genesis, {}).settings.producerSchedule, [{ fromBlock: 4, producers: [NEW] }]);
  assert.match(resolveSettings({ ...genesis, producerSchedule: [{ fromBlock: 0, producers: [NEW] }] }, {}).errors.join(), /genesis producerSchedule/);
  assert.deepEqual([3, 4].map(producerSetOf(genesis)), [[P], [NEW]]);
  assert.equal(producerSetOf({ chainId: 3 }), null);
  assert.throws(() => producerSetOf({ ...genesis, producerSchedule: 5 }), /producerSchedule/);
});

test("producerSchedule is not in the genesis hash: a schedule can be added later without existing nodes resetting the chain", () => {
  const genesis = { chainId: 3, balances: { [ALICE]: "10n" }, config: { producers: [P] } };
  const vm = new VM.VirtualMachine(new MemoryDB());
  const { hash } = vm.applyGenesis(genesis);
  assert.equal(vm.checkGenesis({ ...genesis, producerSchedule: [{ fromBlock: 100, producers: [NEW] }] }), hash);
  assert.throws(() => vm.checkGenesis({ ...genesis, config: { producers: [NEW] } }), /genesis ไม่ตรงกัน/);   // changing config.producers = a new chain
});

test("case 3 leaked key: from block N the old key cannot produce (rejected even with a valid signature) · blocks before N still sync · the new key carries on", async () => {
  const genesis = { config: { producers: [P] }, producerSchedule: [{ fromBlock: 3, producers: [NEW] }] };
  const producers = producerSetOf(genesis);
  const source = produce(fresh(), [KEY, KEY, NEW_KEY, NEW_KEY]);
  const reader = fresh();
  assert.equal(await syncOnce(reader, async (from) => itemsOf(source, from), { producers }), 4);
  assert.equal(reader.getBlock(4).hash, source.getBlock(4).hash);

  // a thief with the old key produces block 3 → nodes using the same schedule reject it
  const thief = produce(fresh(), [KEY, KEY, KEY]);
  const victim = fresh();
  for (const item of itemsOf(thief).slice(0, 2)) applyBlock(victim, item, { producers });
  assert.throws(() => applyBlock(victim, itemsOf(thief)[2], { producers }), /who is not in the producer list/);
  // the new key producing before its block = rejected too
  assert.throws(() => applyBlock(fresh(), itemsOf(produce(fresh(), [NEW_KEY]))[0], { producers }), /who is not in the producer list/);

  // client-sdk (verifiedState) takes the same list function: block 4 produced by the new key → passes · a fixed old list → fails
  const client = createClient({ url: "http://source", fetch: async (target) => {
    const { pathname, searchParams } = new URL(target);
    const body = pathname === "/proof" ? source.getProof(searchParams.getAll("key"))
      : pathname === "/genesis" ? { chainId: source.chainId } : source.getBlock(Number(pathname.split("/")[2]));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const key = `${BOB}:native:received`;
  assert.equal((await client.verifiedState([key], { producers })).values[key], "4n");
  await assert.rejects(client.verifiedState([key], { producers: [P] }), /invalid producer signature/);
});

test("case 2 lost key: a spare key in config.producers keeps producing immediately · blocks from both keys sync · warns when there is only one key", async () => {
  const producers = producerSetOf({ config: { producers: [P, SPARE] } });
  const source = produce(fresh(), [KEY, KEY, SPARE_KEY, SPARE_KEY]);   // the main key is lost after block 2 → the spare key is used
  const reader = fresh();
  assert.equal(await syncOnce(reader, async (from) => itemsOf(source, from), { producers }), 4);
  assert.deepEqual([1, 2, 3, 4].map((n) => reader.getBlock(n).producer), [P, P, SPARE, SPARE]);

  const one = resolveSettings({ config: { admins: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], producers: [P] } }, {}).settings;
  assert.match(startupWarnings({ settings: one }).join(), /a single key/);
  assert.deepEqual(startupWarnings({ settings: one, dev: true }), []);
  assert.deepEqual(startupWarnings({ settings: resolveSettings({ config: { producers: [P, SPARE] } }, {}).settings }), []);
});

test("startupProblems: FOLLOW needs no PRODUCER_KEY · checks the key against the next block's list · nextBlock null = check later", () => {
  const settings = resolveSettings({ config: { admins: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], producers: [P] }, producerSchedule: [{ fromBlock: 5, producers: [NEW] }] }, {}).settings;
  assert.match(startupProblems({ settings }).join(), /PRODUCER_KEY must be set/);
  assert.deepEqual(startupProblems({ settings, follow: true }), []);
  assert.deepEqual(startupProblems({ settings, producer: P, nextBlock: 4 }), []);
  assert.match(startupProblems({ settings, producer: P, nextBlock: 5 }).join(), /is not in the producer list for block 5/);
  assert.deepEqual(startupProblems({ settings, producer: NEW, nextBlock: 5 }), []);
  assert.deepEqual(startupProblems({ settings, producer: NEW, nextBlock: null }), []);
});

/** fake fetch backed by vm (like the server's /health + /sync) */
const fakeNode = (vm, role) => async (url) => {
  const { pathname, searchParams } = new URL(url);
  if (pathname === "/health") return { ok: true, json: async () => ({ role, latest: vm.latestBlockNumber() }) };
  const from = Number(searchParams.get("from"));
  const limit = Number(searchParams.get("limit"));
  return { ok: true, json: async () => itemsOf(vm, from).slice(0, limit) };
};

test("case 1 failover: old machine still producing = refuses to start · no longer producing = syncs the gap first · unreachable = starts + warns", async () => {
  const producers = [P];
  const primary = produce(fresh(), [KEY, KEY, KEY, KEY, KEY]);
  const standby = fresh(KEY);
  for (const item of itemsOf(primary).slice(0, 2)) applyBlock(standby, item, { producers });   // 3 blocks behind

  await assert.rejects(prepareFailover(standby, { url: "http://old", producers, fetch: fakeNode(primary, "producer") }), /is still producing blocks/);
  await assert.rejects(prepareFailover(standby, { url: "http://old", producers, fetch: async () => ({ ok: true, json: async () => ({ latest: 5 }) }) }), /still producing/);   // older versions don't report role
  assert.equal(standby.latestBlockNumber(), 2);

  const done = await prepareFailover(standby, { url: "http://old", producers, fetch: fakeNode(primary, "follower"), limit: 2 });
  assert.deepEqual(done, { reachable: true, synced: 3 });
  assert.equal(standby.getBlock(5).hash, primary.getBlock(5).hash);
  // keep producing with the old key → block 6 follows the old machine exactly (other nodes can sync)
  produce(standby, [KEY]);
  const reader = fresh();
  assert.equal(await syncOnce(reader, async (from) => itemsOf(standby, from), { producers }), 6);

  const offline = await prepareFailover(fresh(KEY), { url: "http://old", fetch: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(offline.reachable, false);
  assert.match(offline.warning, /cannot reach the old machine .* \(ECONNREFUSED\)/);
  assert.deepEqual(await probeNode("http://x", { fetch: fakeNode(primary, "retired") }), { reachable: true, role: "retired", latest: 5 });
  // the old machine reports more blocks than it sent = incomplete sync, do not start
  const short = async (url) => (url.endsWith("/health") ? { ok: true, json: async () => ({ role: "follower", latest: 9 }) } : { ok: true, json: async () => [] });
  await assert.rejects(prepareFailover(fresh(KEY), { url: "http://old", fetch: short }), /incomplete sync from the old machine/);
});

// ---------- real server.js (multiple processes) ----------

const ALICE_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});

/** starts server.js → { url, output(), stop(), exited } · waits until the ready line is printed or the process exits */
async function startNode(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { PATH: process.env.PATH, PORT: String(port), BLOCK_MS: "100", VERIFY_WORKERS: "0", GAS_PRICE: "1000000000", ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const ready = new Promise((resolve) => {
    const onData = (chunk) => { output += chunk; if (output.includes("chain running at")) resolve("ready"); };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
  });
  const state = await Promise.race([ready, exited.then((code) => ({ code }))]);
  return { url: `http://127.0.0.1:${port}`, state, output: () => output, exited,
    stop: () => { child.kill("SIGKILL"); return exited; } };
}
const get = (url) => fetch(url).then(async (response) => ({ status: response.status, body: await response.json() }));
async function waitFor(check, label, ms = 15_000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
let nonce = 0;
const sendTransfer = async (url) => {
  const tx = { chainId: 9, action: "transfer", from: alice, to: BOB, value: 1, nonce: nonce++, gasLimit: 0, gasPrice: 2_000_000_000 };
  const response = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx, signature: sign.signTransaction(tx, ALICE_KEY) }) });
  return { status: response.status, body: await response.json() };
};
const latestOf = async (url) => (await get(`${url}/health`)).body.latest;

test("server.js: FOLLOW syncs along + accepts no txs · FAILOVER_FROM while the old machine still produces = no start · old machine down → the standby keeps producing with the same DATA", { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "failover-"));
  const genesisFile = path.join(dir, "genesis.json");
  fs.writeFileSync(genesisFile, JSON.stringify({ chainId: 9, balances: { [alice]: "1000000000000000000n" }, config: { admins: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], producers: [P, SPARE] } }));
  const base = { GENESIS: genesisFile, RATE_LIMIT: "0" };
  const nodes = [];
  try {
    const primary = await startNode({ ...base, PRODUCER_KEY: KEY });
    nodes.push(primary);
    assert.equal(primary.state, "ready", primary.output());
    assert.equal((await get(`${primary.url}/health`)).body.role, "producer");
    assert.equal((await sendTransfer(primary.url)).body.queued, true);
    await waitFor(async () => (await latestOf(primary.url)) === 1, "block 1");

    const standby = await startNode({ ...base, FOLLOW: primary.url, DATA: path.join(dir, "standby") });
    nodes.push(standby);
    assert.equal(standby.state, "ready", standby.output());
    assert.match(standby.output(), /standby: syncing from/);
    await waitFor(async () => (await latestOf(standby.url)) === 1, "standby synced block 1");
    const health = (await get(`${standby.url}/health`)).body;
    assert.equal(health.role, "follower");
    assert.equal(health.follow.url, primary.url);
    assert.equal((await sendTransfer(standby.url)).status, 503);
    nonce -= 1;
    assert.equal((await get(`${standby.url}/genesis`)).body.role, "follower");

    // old machine still producing → never start a second producer with the same key
    const twin = await startNode({ ...base, PRODUCER_KEY: KEY, FAILOVER_FROM: primary.url });
    assert.equal(twin.state.code, 1, twin.output());
    assert.match(twin.output(), /is still producing blocks/);

    assert.equal((await sendTransfer(primary.url)).body.queued, true);
    await waitFor(async () => (await latestOf(standby.url)) === 2, "standby synced block 2");

    // main machine down → restart the standby as producer (same DATA · same key)
    await primary.stop();
    await standby.stop();
    const promoted = await startNode({ ...base, PRODUCER_KEY: KEY, FAILOVER_FROM: primary.url, DATA: path.join(dir, "standby") });
    nodes.push(promoted);
    assert.equal(promoted.state, "ready", promoted.output());
    assert.match(promoted.output(), /cannot reach the old machine .*/);
    assert.equal((await get(`${promoted.url}/health`)).body.role, "producer");
    assert.equal((await sendTransfer(promoted.url)).body.queued, true);
    await waitFor(async () => (await latestOf(promoted.url)) === 3, "block 3 from the promoted machine");
    const block3 = (await get(`${promoted.url}/block/3`)).body;
    assert.equal(block3.producer, P);
    assert.equal(block3.parentHash, (await get(`${promoted.url}/block/2`)).body.hash);
  } finally {
    await Promise.all(nodes.map((node) => node.stop()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("server.js: producerSchedule removes the key → the old machine stops producing (role retired) · the new-key machine syncs via FAILOVER_FROM and carries on", { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-"));
  const genesisFile = path.join(dir, "genesis.json");
  fs.writeFileSync(genesisFile, JSON.stringify({ chainId: 9, balances: { [alice]: "1000000000000000000n" },
    config: { admins: ["0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"], producers: [P] }, producerSchedule: [{ fromBlock: 2, producers: [NEW] }] }));
  const base = { GENESIS: genesisFile, RATE_LIMIT: "0" };
  nonce = 0;
  const nodes = [];
  try {
    const old = await startNode({ ...base, PRODUCER_KEY: KEY });
    nodes.push(old);
    assert.equal(old.state, "ready", old.output());
    assert.match(old.output(), /a single key/);   // warning: no spare key
    assert.equal((await sendTransfer(old.url)).body.queued, true);
    await waitFor(async () => (await latestOf(old.url)) === 1, "block 1");
    const genesisInfo = (await get(`${old.url}/genesis`)).body;
    assert.deepEqual(genesisInfo.producers, [NEW]);   // the next block's list
    assert.deepEqual(genesisInfo.producerSchedule, [{ fromBlock: 2, producers: [NEW] }]);

    assert.equal((await sendTransfer(old.url)).body.queued, true);
    const health = await waitFor(async () => {
      const response = await get(`${old.url}/health`);
      return response.status === 503 && response.body;
    }, "the old machine reports it cannot produce");
    assert.equal(health.role, "retired");
    assert.equal(health.latest, 1);
    assert.match(health.problems.join(), /is not in the producer list for block 2/);

    const next = await startNode({ ...base, PRODUCER_KEY: NEW_KEY, FAILOVER_FROM: old.url });
    nodes.push(next);
    assert.equal(next.state, "ready", next.output());
    assert.match(next.output(), /failover: synced 1 blocks from /);
    nonce = 1;   // the 2nd tx is stuck in the old machine's mempool → resend to the new machine
    assert.equal((await sendTransfer(next.url)).body.queued, true);
    await waitFor(async () => (await latestOf(next.url)) === 2, "block 2 from the new key");
    assert.equal((await get(`${next.url}/block/2`)).body.producer, NEW);
  } finally {
    await Promise.all(nodes.map((node) => node.stop()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
