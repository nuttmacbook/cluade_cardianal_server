import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider, Wallet, Contract } from "ethers";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { createClient, keySigner } from "../client-sdk/index.js";

/*
 * ethers ผ่าน HTTP (JsonRpcProvider) ฟัง event ด้วย filter ของ node จริง:
 *   contract.on("Transfer") → eth_newFilter + eth_getFilterChanges
 *   provider.on("pending") → eth_newPendingTransactionFilter (ethers อ่านตอนมี block ใหม่) · provider.on("block") ยังใช้ eth_blockNumber ตามเดิม
 */

const FUNDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // มียอดใน genesis.json
const BOB = "0x00000000000000000000000000000000000000b0";
const within = (promise, ms, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms))]);

test("ethers HTTP: contract.on / provider.on(pending) ได้ event จริง", async () => {
  process.env.GAS_PRICE ??= "1000000000";
  const { server, vm, miner, mempool } = await import("../server.js");
  clearInterval(miner);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  let mining = true;
  const mine = () => { if (mining && mempool.size) { const block = vm.createBlock({ timestamp: Date.now() }); mempool.take(block); block.commit(); } };
  const ticker = setInterval(mine, 25);
  const provider = new JsonRpcProvider(`${url}/evm`, undefined, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1, polling: false });
  provider.pollingInterval = 50;
  const wallet = new Wallet(FUNDER_KEY, provider);
  const client = createClient({ url });
  const signer = keySigner(FUNDER_KEY);
  const methods = [];
  const original = provider.send.bind(provider);
  provider.send = (method, params) => { methods.push(method); return original(method, params); };
  try {
    const tx = await client.send({ action: "deploy", code: TOKEN_PROGRAM, input: { name: "Coin", ticker: "C", decimals: "0n", supply: "100n" } }, signer);
    await client.wait(tx.hash, { intervalMs: 20 });
    const token = (await client.receipt(tx.hash)).result.programUuid;
    await client.wait((await client.send({ action: "init", to: token }, signer)).hash, { intervalMs: 20 });
    const erc20 = new Contract(token, ["event Transfer(address indexed from, address indexed to, uint256 value)",
      "function transfer(address to, uint256 amount) returns (bool)"], wallet);

    const transfer = new Promise((resolve) => erc20.on("Transfer", (from, to, value, event) => resolve({ from, to, value, hash: event.log.transactionHash })));
    const block = new Promise((resolve) => provider.on("block", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));   // ให้ ethers สร้าง filter ก่อนส่ง tx

    mining = false;   // ค้างไว้ใน mempool ให้ pending filter เห็นก่อน
    const pending = new Promise((resolve) => provider.on("pending", resolve));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sent = await erc20.transfer(BOB, 7n);
    assert.ok(mempool.has(sent.hash));
    mining = true;   // ethers อ่าน filter ทุกครั้งที่มี block ใหม่ → hash ที่ค้างใน filter ตั้งแต่ตอนเข้าคิวถูกส่งออกมา
    assert.equal(await within(pending, 5000, "pending"), sent.hash);

    const got = await within(transfer, 5000, "Transfer");
    assert.deepEqual([got.from, got.to.toLowerCase(), got.value, got.hash], [wallet.address, BOB, 7n, sent.hash]);
    assert.ok(Number(await within(block, 5000, "block")) > 0);
    // eth_simulateV1 บนเชนที่บังคับ nonce + หักแก๊ส: ใบที่ 2 ของคนเดิมได้ nonce ถัดไปเอง · ERC-20 transfer คืน true
    const iface = erc20.interface;
    const [simulated] = await provider.send("eth_simulateV1", [{ blockStateCalls: [{ calls: [
      { from: wallet.address, to: token, data: iface.encodeFunctionData("transfer", [BOB, 1n]) },
      { from: wallet.address, to: BOB, value: "0x1" },
    ] }] }, "latest"]);
    assert.deepEqual(simulated.calls.map((call) => [call.status, call.error?.message]), [["0x1", undefined], ["0x1", undefined]]);
    assert.equal(iface.decodeFunctionResult("transfer", simulated.calls[0].returnData)[0], true);
    assert.equal(iface.parseLog(simulated.calls[0].logs[0]).args.value, 1n);
    for (const method of ["eth_newFilter", "eth_newPendingTransactionFilter", "eth_getFilterChanges"]) {
      assert.ok(methods.includes(method), `ethers ควรเรียก ${method}`);
    }
  } finally {
    await provider.removeAllListeners();
    await new Promise((resolve) => setTimeout(resolve, 300));   // ethers ส่ง eth_uninstallFilter ตามหลัง
    clearInterval(ticker);
    provider.destroy();
    server.close();
  }
});
