import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VM, MemoryDB } from "./helpers.js";
import { createClient, keySigner } from "../client-sdk/index.js";
import { startSync } from "../src/node/sync.js";

/*
 * Phase 4 through the server: GET /proof + client.verifiedState (no need to trust the node) · cardianal_getProof / eth_getProof on /evm
 *   SNAPSHOT_EVERY → GET /snapshot (+ files) · a new node with startSync({ snapshot: true }) starts from a snapshot and keeps syncing
 */

const FUNDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // funded in genesis.json
const BOB = "0x00000000000000000000000000000000000000b0";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phase4-server-"));
process.env.SNAPSHOT_EVERY = "2";
process.env.SNAPSHOT_DIR = dir;

test("server: /proof is self-verifiable · /evm cardianal_getProof · /snapshot → a new node starts from the snapshot and keeps syncing", async () => {
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  const { server, vm, miner, mempool, snapshots, genesis } = await import("../server.js");
  clearInterval(miner);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = createClient({ url });
  const signer = keySigner(FUNDER_KEY);
  const mine = async () => {
    const block = vm.createBlock({ timestamp: Date.now() });
    mempool.take(block);
    block.commit();
    await snapshots.onBlock(block.number);
  };
  try {
    for (let i = 0; i < 3; i += 1) {
      await client.send({ action: "transfer", to: BOB, value: `${i + 1}n`, gasLimit: 21_000 }, signer);
      await mine();
    }
    const keys = [`${BOB}:native:received`, `${signer.address}:nonce`, "0xmissing:native:received"];
    const checked = await client.verifiedState(keys);
    assert.equal(checked.blockNumber, 3);
    assert.equal(checked.stateRoot, vm.getBlock(3).stateRoot);
    assert.deepEqual(Object.values(checked.values), [vm.read(keys[0]), vm.read(keys[1]), undefined]);
    assert.equal(checked.values[keys[0]], "6n");

    // a node that lies about values → verification fails
    const liar = createClient({ url, fetch: async (target, init) => {
      const response = await fetch(target, init);
      if (!String(target).includes("/proof")) return response;
      const body = await response.json();
      body.proofs[0].proof[body.proofs[0].proof.length - 1] = body.proofs[1].proof.at(-1);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    } });
    await assert.rejects(liar.verifiedState(keys), /หลักฐาน/);
    assert.equal((await fetch(`${url}/proof`)).status, 400);

    const rpc = (method, params) => fetch(`${url}/evm`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((response) => response.json());
    const viaRpc = await rpc("cardianal_getProof", [[keys[0], { program: "0xprog", key: ["balances", BOB] }]]);
    assert.equal(viaRpc.result.stateRoot, vm.getBlock(3).stateRoot);
    assert.deepEqual(viaRpc.result.proofs.map((item) => item.dbKey), [keys[0], `0xprog:storage:balances:${BOB}`]);
    assert.match((await rpc("eth_getProof", [BOB, [], "latest"])).error.message, /cardianal_getProof/);

    // snapshot every 2 blocks → block 2 has one
    const info = await (await fetch(`${url}/snapshot`)).json();
    assert.deepEqual([info.number, info.hash, info.stateRoot], [2, vm.getBlock(2).hash, vm.getBlock(2).stateRoot]);
    assert.equal((await fetch(`${url}/snapshot/999`)).status, 404);
    await client.send({ action: "transfer", to: BOB, value: "4n", gasLimit: 21_000 }, signer);
    await mine();   // block 4 → a new snapshot · 2 files kept
    assert.equal((await (await fetch(`${url}/snapshot`)).json()).number, 4);
    assert.equal(fs.readdirSync(dir).length, 2);
    await client.send({ action: "transfer", to: BOB, value: "5n", gasLimit: 21_000 }, signer);
    await mine();

    const reader = new VM.VirtualMachine(new MemoryDB(), { chainId: vm.chainId, requireNonce: true, chargeGas: true, deriveProgramAddress: true,
      recordTransactions: true, recordBlocks: true, recordHistory: true, minBaseFee: vm.minBaseFee, gasTarget: vm.gasTarget, gas: vm.gas, forks: genesis?.forks ?? {} });
    const loaded = await new Promise((resolve, reject) => {
      const stop = startSync(reader, { url, genesis, intervalMs: 20, snapshot: true,
        onSnapshot: (manifest) => resolve(manifest), onError: (error) => { stop(); reject(error); } });
      setTimeout(() => { stop(); reject(new Error("snapshot was not loaded")); }, 5000);
      reader.stopSync = stop;
    });
    assert.equal(loaded.number, 4);
    for (let i = 0; i < 100 && reader.latestBlockNumber() < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    reader.stopSync();
    assert.equal(reader.latestBlockNumber(), 5);
    assert.equal(reader.stateRoot(), vm.getBlock(5).stateRoot);
    assert.equal(reader.read(`${BOB}:native:received`), "15n");
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
