import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN, COUNTER } from "./programs.js";

/*
 * blockbody:<number> stores the raw tx of every tx in the block
 * → another node fetches the blocks, replays them, and gets byte-identical state (including deployed program code)
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const OPTIONS = { requireNonce: true, chargeGas: true, recordTransactions: true, recordBlocks: true, deriveProgramAddress: true, gas: { call: 100, read: 10, write: 50, byte: 1, price: 1 } };

const newVm = () => new VM.VirtualMachine(new MemoryDB(), OPTIONS);

/** builds a block chain: block 1 deploy+init, block 2 transfers */
function buildChain(vm) {
  vm.db.load({ "alice:native:received": "1000000n" });

  const first = vm.createBlock({ timestamp: T, number: 1, parentHash: null, feeRecipient: "miner", burnPercent: 50 });
  first.deploy({ code: TOKEN, context: user("alice"), initInput: { supply: 1000 }, metadata: { namespace: "coin" }, nonce: 0 });
  const token = first.results()[0].result.programUuid;
  first.init({ programUuid: token });
  first.setMetadata({ metadata: { namespace: "alice" }, context: user("alice"), nonce: 1 });
  first.commit();

  const second = vm.createBlock({ timestamp: T + 5000, number: 2, parentHash: vm.getBlock(1).hash, feeRecipient: "miner", burnPercent: 50 });
  second.call({ programUuid: token, functionName: "transfer", input: { to: "bob", amount: 300 }, context: user("alice"), nonce: 2 });
  second.call({ programUuid: token, functionName: "transfer", input: { to: "bob", amount: 99999 }, context: user("alice"), nonce: 3 }); // fails
  second.transfer({ from: "alice", to: "carol", amount: 250, nonce: 4 });
  second.commit();

  return token;
}

/** another node: re-runs all fetched blocks */
function replay(source, target) {
  for (let number = 1; number <= source.latestBlockNumber(); number += 1) {
    const header = source.getBlock(number);
    const body = source.getBlockBody(number);

    const block = target.createBlock({
      number: header.number,
      parentHash: header.parentHash,
      timestamp: header.timestamp,
      feeRecipient: header.feeRecipient,
      burnPercent: header.burnPercent,
    });
    for (const { method, request } of body) block[method](request);

    assert.equal(block.header().hash, header.hash, `block ${number} hash mismatch`);
    block.commit();
  }
}

test("body: stored in blockbody:<number> along with program code", () => {
  const vm = newVm();
  buildChain(vm);

  const body = vm.getBlockBody(1);
  assert.deepEqual(body.map((entry) => entry.action), ["deploy", "init", "metadata"]);
  assert.deepEqual(body.map((entry) => entry.method), ["deploy", "init", "setMetadata"]);
  assert.equal(body[0].request.code, TOKEN);                   // full code is in the block
  assert.deepEqual(body[0].request.metadata, { namespace: "coin" });
  assert.equal(vm.getBlockBody(2).length, 3);
  assert.equal(vm.getBlockBody(99), null);
});

test("replay: a new node runs the fetched blocks and gets identical state", () => {
  const source = newVm();
  const token = buildChain(source);

  const target = newVm();
  target.db.load({ "alice:native:received": "1000000n" }); // initial (genesis) balances must match
  replay(source, target);

  assert.deepEqual(target.db.snapshot(), source.db.snapshot());
  assert.equal(target.getBlock(2).stateRoot, source.getBlock(2).stateRoot);
  assert.equal(target.db.readKeys([`${token}:code`])[0], source.db.readKeys([`${token}:code`])[0]);
  assert.deepEqual(target.getMetadata(token), source.getMetadata(token));
  assert.deepEqual(target.nativeBalanceOf("alice"), source.nativeBalanceOf("alice"));
  assert.equal(target.resolveNamespace("alice"), "alice");
});

test("replay: program addresses computed by the VM are the same on both nodes", () => {
  const source = newVm();
  const token = buildChain(source);

  const target = newVm();
  target.db.load({ "alice:native:received": "1000000n" });
  replay(source, target);

  assert.match(token, /^0x[0-9a-f]{40}$/);
  assert.equal(target.getBlockBody(1)[1].request.programUuid, token); // init references the same address
  assert.equal(target.db.readKeys([`${token}:this`])[0], token);
});

test("replay: different initial data → hash mismatch and stop immediately", () => {
  const source = newVm();
  buildChain(source);

  const target = newVm();
  target.db.load({ "alice:native:received": "999n" }); // wrong genesis
  // stateRoot is derived from the block's writes, so it is caught when balances start to change the result (block 2)
  assert.throws(() => replay(source, target), /hash mismatch/);
});

test("replay: block bodies are enough to rebuild the explorer entirely", () => {
  const source = newVm();
  buildChain(source);
  const target = newVm();
  target.db.load({ "alice:native:received": "1000000n" });
  replay(source, target);

  assert.deepEqual(target.listTransactionsOf("alice").map((tx) => tx.nonce), [4, 3, 2, 1, 0]);
  assert.deepEqual(
    target.getBlock(2).txHashes.map((hash) => target.getTransaction(hash).status),
    source.getBlock(2).txHashes.map((hash) => source.getTransaction(hash).status),
  );
});

test("a deploy run outside a block is absent from blockbody (always go through a block)", () => {
  const vm = newVm();
  vm.db.load({ "alice:native:received": "1000000n" });

  vm.commit(vm.deploy({ code: COUNTER, context: user("alice"), nonce: 0 }, { timestamp: T }).writes); // outside a block
  const block = vm.createBlock({ timestamp: T, number: 1, feeRecipient: "miner" });
  block.commit();

  assert.deepEqual(vm.getBlockBody(1), []);      // empty block
  assert.equal(vm.latestBlockNumber(), 1);
  assert.equal(vm.listTransactionsOf("alice").length, 1); // only present in <addr>:txn
});
