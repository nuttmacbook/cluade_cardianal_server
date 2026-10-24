import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonRpcProvider, Wallet, Contract, Transaction } from "ethers";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { createClient, keySigner } from "../client-sdk/index.js";
import { decodeRawTransaction, rlpEncode } from "../src/node/evm-raw.js";

/*
 * ระยะ 3.5: eth_sendRawTransaction — ethers (แบบเดียวกับ Hardhat / dApp) ส่ง tx ผ่าน /evm ได้จริง
 *   โอน native · ERC-20 transfer ของ token มาตรฐาน · ฟังก์ชันตาม metadata.abi · eth_estimateGas จำลองจริง
 *   hash = keccak(raw) · ไม่มี chainId / chainId ผิด / deploy bytecode / type 1 → ปฏิเสธ
 */

const FUNDER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";   // มียอดใน genesis.json
const BOB = "0x00000000000000000000000000000000000000b0";
const COUNTER = `function program() {
  function initialization() {
    writeDB("count", 0n)
    setMetadata("abi", { functions: [
      { name: "bump", inputs: [{ name: "by", type: "uint" }] },
      { name: "count", outputs: [{ type: "uint" }], readonly: true },
    ] })
  }
  function bump(params) { writeDB("count", readDB("count") + params.input.by) }
  function count() { return readDB("count") }
  return { bump, count }
}`;

test("ethers ส่ง tx ผ่าน /evm: native / ERC-20 / metadata.abi · receipt หาได้ด้วย hash ของ ethers", async () => {
  const { server, vm, miner, mempool } = await import("../server.js");
  clearInterval(miner);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const mine = () => { if (mempool.size) { const block = vm.createBlock({ timestamp: Date.now() }); mempool.take(block); block.commit(); } };
  const ticker = setInterval(mine, 25);
  const provider = new JsonRpcProvider(`${url}/evm`, undefined, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 });
  provider.pollingInterval = 25;
  const wallet = new Wallet(FUNDER_KEY, provider);
  const client = createClient({ url });
  const signer = keySigner(FUNDER_KEY);
  try {
    // native (ethers เลือก type 2 เอง จาก eth_feeHistory / baseFee)
    const sent = await wallet.sendTransaction({ to: BOB, value: 5n });
    const receipt = await sent.wait();
    assert.equal(receipt.status, 1);
    assert.equal(receipt.hash, sent.hash);
    assert.equal(sent.type, 2);
    assert.equal(await provider.getBalance(BOB), 5n);
    assert.equal((await client.transaction(sent.hash)).blockNumber, receipt.blockNumber);   // /tx/:hash ด้วย keccak(raw)

    // legacy EIP-155
    const legacy = await wallet.sendTransaction({ to: BOB, value: 1n, type: 0, gasPrice: (await provider.getFeeData()).gasPrice });
    assert.equal((await legacy.wait()).status, 1);
    assert.equal(await provider.getBalance(BOB), 6n);

    // token มาตรฐาน + โปรแกรมที่มี ABI (deploy ผ่าน /sendtx ด้วย SDK)
    const deployed = async (code, input) => {
      const tx = await client.send({ action: "deploy", code, input }, signer);
      await client.wait(tx.hash, { intervalMs: 20 });
      const address = (await client.receipt(tx.hash)).result.programUuid;
      await client.wait((await client.send({ action: "init", to: address }, signer)).hash, { intervalMs: 20 });
      return address;
    };
    const token = await deployed(TOKEN_PROGRAM, { name: "Coin", ticker: "C", decimals: "0n", supply: "100n" });
    const erc20 = new Contract(token, ["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"], wallet);
    assert.equal((await (await erc20.transfer(BOB, 30n)).wait()).status, 1);
    assert.equal(await erc20.balanceOf(BOB), 30n);

    const counter = await deployed(COUNTER, {});
    const abi = await provider.send("cardianal_getAbi", [counter]);
    const contract = new Contract(counter, abi, wallet);
    const gas = await contract.bump.estimateGas(5n);
    assert.ok(gas > 1000n && gas < 1_000_000n, `estimateGas ${gas}`);
    const bumped = await (await contract.bump(5n)).wait();
    assert.equal(bumped.status, 1);
    assert.equal(await contract.count(), 5n);
  } finally {
    clearInterval(ticker);
    provider.destroy();
    server.close();
  }
});

test("eth_sendRawTransaction ปฏิเสธ: ไม่มี chainId · chainId ผิด · deploy bytecode · type 1 · RLP เสีย", async () => {
  const { evmRpc, vm } = await import("../server.js");
  const wallet = new Wallet(FUNDER_KEY);
  const send = async (raw) => evmRpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }).error?.message;
  const base = { to: BOB, value: 1n, nonce: 999, gasLimit: 21_000n };
  assert.match(await send(await wallet.signTransaction({ ...base, type: 0, gasPrice: 1n })), /ไม่มี chainId/);
  assert.match(await send(await wallet.signTransaction({ ...base, type: 2, chainId: 5n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })), /chainId ของ tx \(5\) ไม่ตรงกับเชน \(1\)/);
  assert.match(await send(await wallet.signTransaction({ ...base, to: null, data: "0x6000", type: 2, chainId: BigInt(vm.chainId), maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })), /deploy bytecode/);
  assert.match(await send(await wallet.signTransaction({ ...base, type: 1, chainId: BigInt(vm.chainId), gasPrice: 1n })), /ไม่รองรับ tx type 1/);
  assert.match(await send(await wallet.signTransaction({ ...base, data: "0x1234", type: 2, chainId: BigInt(vm.chainId), maxFeePerGas: 2n, maxPriorityFeePerGas: 1n })), /ไม่ใช่โปรแกรม/);
  assert.match(await send("0x02c0"), /12 ฟิลด์/);
  assert.match(await send("0xzz"), /hex/);

  // ถอดได้ตรงกับ ethers (ผู้ส่ง / hash / ค่า)
  const raw = await wallet.signTransaction({ ...base, type: 2, chainId: 1n, maxFeePerGas: 7n, maxPriorityFeePerGas: 3n, data: "0xabcdef" });
  const ours = decodeRawTransaction(raw);
  const theirs = Transaction.from(raw);
  assert.equal(ours.sender, theirs.from.toLowerCase());
  assert.equal(ours.hash, theirs.hash);
  assert.deepEqual([ours.nonce, ours.value, ours.data, ours.fees.maxFeePerGas], [999, 1n, "0xabcdef", 7n]);
  assert.deepEqual(rlpEncode([new Uint8Array([1]), [new Uint8Array(60).fill(0x80)]]).slice(0, 3), new Uint8Array([0xf8, 0x41, 0x01]));
});
