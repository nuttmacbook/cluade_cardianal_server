import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import * as sign from "../src/crypto/signature.js";

/*
 * chainlist (ethereum-lists) registration uses explorer = https://<host>/evm/explorer · standard EIP3091
 *   ethereum-lists CI really opens this URL → must get 2xx (fetch / okhttp follow redirects)
 *   wallets append paths per EIP-3091: /tx/<hash> · /address/<addr> · /token/<addr> · /block/<number or hash>
 */

let server, vm, mempool, mineOnce, url;
before(async () => {
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  ({ server, vm, mempool, mineOnce } = await import("../server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const location = async (path) => {
  const res = await fetch(url + path, { redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") };
};

test("/evm/explorer: explorer home page (redirect, then 200 HTML)", async () => {
  for (const path of ["/evm/explorer", "/evm/explorer/"]) assert.deepEqual(await location(path), { status: 302, location: "/" });
  const res = await fetch(`${url}/evm/explorer`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
});

test("EIP-3091: tx / address / token / block (number and hash) → existing explorer pages", async () => {
  const key = sign.randomPrivateKey();
  const from = sign.addressOf(key);
  vm.db.load({ [`${from}:native:received`]: "1000000000000000000n" });
  const tx = { chainId: vm.chainId, action: "transfer", from, to: "0x00000000000000000000000000000000000000b1", value: "1n", nonce: 0, gasLimit: 21_000, gasPrice: "1000000000" };
  const added = mempool.add({ tx, signature: sign.signTransaction(tx, key) });
  assert.equal(added.ok, true, JSON.stringify(added));
  const block = mineOnce(Date.now() + 1000);
  assert.ok(block);
  const header = vm.getBlock(block.number);

  assert.equal((await location(`/evm/explorer/tx/${added.hash}`)).location, `/#tx/${added.hash}`);
  assert.equal((await location(`/evm/explorer/address/${from}`)).location, `/#address/${from}`);
  assert.equal((await location(`/evm/explorer/token/${from}`)).location, `/#address/${from}`);
  assert.equal((await location(`/evm/explorer/block/${header.number}`)).location, `/#block/${header.number}`);
  assert.equal((await location(`/evm/explorer/block/${header.hash}`)).location, `/#block/${header.number}`);
  assert.equal((await location(`/evm/explorer/block/${header.hash.toUpperCase().replace("0X", "0x")}`)).location, `/#block/${header.number}`);
  assert.equal((await location(`/evm/explorer/block/0x${"0".repeat(64)}`)).location, `/#block/0x${"0".repeat(64)}`);   // unknown → block page shows not found
  assert.equal((await location("/evm/explorer/nope/1")).status, 404);
});
