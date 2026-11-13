import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as sign from "../src/crypto/signature.js";

/* an identical tx (same hash) rejected repeatedly is recorded in a block only once → the explorer and /evm (Blockscout) agree, and no run of empty blocks appears */

const KEY = sign.randomPrivateKey();   // wallet with no coins at all
const me = sign.addressOf(KEY);
const CODE = "function program() {\n  function ping(params) { return 1n }\n  return { ping };\n}";

let server, vm, mempool, url, chainId;
let clock = Date.now();

before(async () => {
  let miner;
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  ({ server, vm, mempool, miner } = await import("../server.js"));
  clearInterval(miner);
  chainId = vm.chainId;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const post = (p, body) => fetch(url + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const rpc = (method, params = []) => post("/evm", { jsonrpc: "2.0", id: 1, method, params }).then((r) => r.result);
const mine = () => {
  clock += 1000;
  const block = vm.createBlock({ timestamp: clock, feeRecipient: "0x1111111111111111111111111111111111111111" });
  mempool.take(block);
  block.commit();
  return vm.getBlock(block.number);
};
const deploy = (fields = {}) => {
  const tx = { chainId, from: me, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, maxFeePerGas: "2000000000",
    maxPriorityFeePerGas: "0", nonce: 0, action: "deploy", code: CODE, ...fields };
  return post("/sendtx", { tx, signature: sign.signTransaction(tx, KEY) });
};

test("resending the same deploy from a wallet with no gas: recorded in one block · afterwards nothing is waiting for a block", async () => {
  const first = await deploy();
  assert.equal(first.queued, false);
  assert.equal(mempool.rejectedPending, 1);
  const block = mine();
  assert.equal(block.rejectedCount, 1);
  assert.equal(vm.getRejectedTransaction(first.hash).blockNumber, block.number);

  for (let i = 0; i < 3; i += 1) {
    const again = await deploy();
    assert.equal(again.queued, false, "the sender still gets the same error");
    assert.equal(again.hash, first.hash, "deterministic signature → same hash");
    assert.equal(mempool.rejectedPending, 0, "no need to record again → the server does not close a new block");
  }
  assert.equal(vm.getRejectedTransaction(first.hash).blockNumber, block.number, "still points to the first block");
});

test("/evm: a rejected tx stays in the first block that recorded it, and that block never changes later", async () => {
  const { hash, blockNumber } = vm.getRejectedTransaction((await deploy()).hash);
  const hex = `0x${blockNumber.toString(16)}`;
  const before = await rpc("eth_getBlockByNumber", [hex, false]);
  assert.ok(before.transactions.includes(hash));
  await deploy();
  mine();   // next block: nothing to record
  const after = await rpc("eth_getBlockByNumber", [hex, false]);
  assert.deepEqual(after.transactions, before.transactions);
  assert.equal((await rpc("eth_getTransactionReceipt", [hash])).status, "0x0");
});

test("a different tx (changed nonce / price) is still recorded as a new one as usual", async () => {
  const other = await deploy({ maxFeePerGas: "3000000000" });
  assert.equal(other.queued, false);
  assert.equal(mempool.rejectedPending, 1);
  assert.equal(mine().rejectedCount, 1);
});
