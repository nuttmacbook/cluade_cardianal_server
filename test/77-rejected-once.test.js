import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as sign from "../src/crypto/signature.js";

/* tx เดิมเป๊ะ (hash เดิม) ที่ถูกปฏิเสธซ้ำ ๆ ถูกบันทึกลง block ครั้งเดียว → explorer กับ /evm (Blockscout) เห็นตรงกัน และไม่เกิด block ว่างต่อกัน */

const KEY = sign.randomPrivateKey();   // กระเป๋าไม่มีเหรียญเลย
const me = sign.addressOf(KEY);
const CODE = "function program() {\n  function ping(params) { return 1n }\n  return { ping };\n}";

let server, vm, mempool, url, chainId;
let clock = Date.now();

before(async () => {
  let miner;
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

test("ส่ง deploy เดิมซ้ำจากกระเป๋าที่ไม่มีแก๊ส: บันทึกใน block เดียว · ครั้งต่อไปไม่มีอะไรรอปิด block", async () => {
  const first = await deploy();
  assert.equal(first.queued, false);
  assert.equal(mempool.rejectedPending, 1);
  const block = mine();
  assert.equal(block.rejectedCount, 1);
  assert.equal(vm.getRejectedTransaction(first.hash).blockNumber, block.number);

  for (let i = 0; i < 3; i += 1) {
    const again = await deploy();
    assert.equal(again.queued, false, "ผู้ส่งยังได้ error เหมือนเดิม");
    assert.equal(again.hash, first.hash, "ลายเซ็นแบบ deterministic → hash เดิม");
    assert.equal(mempool.rejectedPending, 0, "ไม่ต้องบันทึกซ้ำ → server ไม่ปิด block ใหม่");
  }
  assert.equal(vm.getRejectedTransaction(first.hash).blockNumber, block.number, "ยังชี้ block แรก");
});

test("/evm: tx ที่ถูกปฏิเสธอยู่ใน block แรกที่บันทึก และ block นั้นไม่เปลี่ยนภายหลัง", async () => {
  const { hash, blockNumber } = vm.getRejectedTransaction((await deploy()).hash);
  const hex = `0x${blockNumber.toString(16)}`;
  const before = await rpc("eth_getBlockByNumber", [hex, false]);
  assert.ok(before.transactions.includes(hash));
  await deploy();
  mine();   // block ถัดไป: ไม่มีอะไรให้บันทึก
  const after = await rpc("eth_getBlockByNumber", [hex, false]);
  assert.deepEqual(after.transactions, before.transactions);
  assert.equal((await rpc("eth_getTransactionReceipt", [hash])).status, "0x0");
});

test("tx ต่างใบ (nonce / ราคาเปลี่ยน) ยังถูกบันทึกเป็นใบใหม่ตามปกติ", async () => {
  const other = await deploy({ maxFeePerGas: "3000000000" });
  assert.equal(other.queued, false);
  assert.equal(mempool.rejectedPending, 1);
  assert.equal(mine().rejectedCount, 1);
});
