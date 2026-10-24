import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Wallet } from "ethers";
import { createClient, keySigner, walletSigner, fromChainValue, toChainValue, ChainError, hashTypedData } from "../client-sdk/index.js";

/*
 * ระยะ 3.3: SDK ฝั่ง client (client-sdk/index.js)
 *   ไม่ดึง VM / sandbox มาด้วย (ใช้ใน browser ได้) · send เติม chainId / nonce / แก๊สเอง · wait ตามจนถึง block
 *   walletSigner เซ็นด้วย eth_signTypedData_v4 → ลายเซ็นจากกระเป๋าแบบ EIP-712 มาตรฐาน (ethers แทน MetaMask) ผ่าน /sendtx
 */

const FUNDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // มียอดใน genesis.json
const BOB = "0x00000000000000000000000000000000000000b0";

test("sdk ไม่ import VM / sandbox / storage / node:* (ใช้ใน browser ได้)", () => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, "utf8");
    for (const [, spec] of source.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/gm)) {
      assert.ok(!spec.startsWith("node:"), `${path.relative(".", file)} import ${spec}`);
      if (spec.startsWith(".")) walk(path.resolve(path.dirname(file), spec));
    }
  };
  walk(path.resolve("client-sdk/index.js"));
  const files = [...seen].map((file) => path.relative(".", file)).sort();
  assert.deepEqual(files.filter((file) => /virtualmachine|sandbox|gasmeter|storage|src\/node/.test(file)), []);
  assert.ok(files.includes("src/crypto/signature.js"));
});

test("sdk: send (key / กระเป๋า EIP-1193) → wait ถึง block · nonce ผิด = ChainError พร้อม body", async () => {
  const { server, vm, miner, mempool } = await import("../server.js");
  clearInterval(miner);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = createClient({ url: `http://127.0.0.1:${server.address().port}/` });
  const mine = () => { const block = vm.createBlock({ timestamp: Date.now() }); mempool.take(block); block.commit(); };
  try {
    const signer = keySigner(FUNDER_KEY);
    const sent = await client.send({ action: "transfer", to: BOB, value: "7n", gasLimit: 21_000 }, signer);
    assert.equal(sent.queued, true);
    assert.equal(sent.hash, hashTypedData(sent.tx));
    assert.equal(sent.tx.nonce, 0);
    assert.ok(sent.tx.maxFeePerGas);
    const waiting = client.wait(sent.hash, { intervalMs: 20, timeoutMs: 5000 });
    setTimeout(mine, 50);
    const done = await waiting;
    assert.equal(done.blockNumber, 1);
    assert.equal(await client.balance(BOB), 7n);

    // กระเป๋า EIP-1193 (ethers Wallet เซ็น typed data แบบเดียวกับ MetaMask)
    const wallet = new Wallet(FUNDER_KEY);
    const provider = { request: async ({ method, params }) => {
      if (method === "eth_requestAccounts") return [wallet.address];
      assert.equal(method, "eth_signTypedData_v4");
      const { domain, types, message } = JSON.parse(params[1]);
      const { EIP712Domain, ...rest } = types;
      return wallet.signTypedData(domain, rest, message);
    } };
    const browser = await walletSigner(provider);
    assert.equal(browser.address, signer.address);
    const second = await client.send({ action: "transfer", to: BOB, value: 3n, gasLimit: 21_000 }, browser);   // BigInt → "3n" เอง
    assert.equal(second.queued, true);
    assert.equal(second.tx.nonce, 1);
    mine();
    assert.equal((await client.wait(second.hash, { intervalMs: 10 })).blockNumber, 2);

    const stale = await client.send({ action: "transfer", to: BOB, value: "1n", gasLimit: 21_000, nonce: 0 }, signer).catch((error) => error);
    assert.ok(stale instanceof ChainError);
    assert.equal(stale.status, 400);
    assert.equal(stale.body.queued, false);
    await assert.rejects(client.wait("0x" + "ab".repeat(32), { intervalMs: 10, timeoutMs: 50 }), { status: 408 });
    await assert.rejects(client.send({ action: "transfer" }), /signer/);
  } finally {
    server.close();
  }
});

test("fromChainValue / toChainValue", () => {
  assert.deepEqual(fromChainValue({ a: "5n", b: ["-2n", "x", 1], c: { d: "7" } }), { a: 5n, b: [-2n, "x", 1], c: { d: "7" } });
  assert.deepEqual(toChainValue({ a: 5n, b: [1n] }), { a: "5n", b: ["1n"] });
  assert.throws(() => createClient({}), /url/);
});
