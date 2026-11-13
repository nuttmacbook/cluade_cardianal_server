import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { TOKEN, COUNTER } from "./programs.js";

/* verify signatures before the VM: sender / origin come only from the signature */

let endpointCounter = 0;
const ALICE_KEY = sign.randomPrivateKey();
const BOB_KEY = sign.randomPrivateKey();
const alice = sign.addressOf(ALICE_KEY);
const bob = sign.addressOf(BOB_KEY);

/** server: receives { tx, signature } → verifies → passes to the VM */
function submit(vm, tx, signature) {
  const { method, request } = sign.verifyTransaction({ tx, signature });
  const result = vm[method](request);
  if (result.status === "success") vm.commit(result.writes);
  return result;
}

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    requireNonce: true, recordTransactions: true, deriveProgramAddress: true, ...options,
  });
  const plain = new VM.VirtualMachine(vm.db);
  vm.commit(plain.deploy({ programUuid: "token", code: TOKEN, context: { sender: alice, origin: alice }, initInput: { supply: 1000 } }).writes);
  vm.commit(plain.init({ programUuid: "token" }).writes);
  return vm;
}

const transferTx = (nonce = 0, overrides = {}) => ({
  chainId: 1, action: "call", from: alice, to: "token", method: "transfer",
  input: { to: bob, amount: 30 }, value: 0, nonce, gasLimit: 0, ...overrides,
});

// ---------------------------------------------------------------------------
//  key / address / signature
// ---------------------------------------------------------------------------

test("key: the address is derived from the private key as in EVM", () => {
  assert.match(alice, /^0x[0-9a-f]{40}$/);
  assert.notEqual(alice, bob);
  assert.equal(sign.addressOf(ALICE_KEY), alice); // always the same value
});

test("sign / recover: recovers the signer's address correctly", () => {
  const tx = transferTx();
  const signature = sign.signTransaction(tx, ALICE_KEY);
  assert.match(signature, /^0x[0-9a-f]{130}$/); // r(32) + s(32) + v(1)
  assert.equal(sign.recoverSigner(tx, signature), alice);
  assert.equal(sign.recoverSigner(tx, sign.signTransaction(tx, BOB_KEY)), bob);
});

test("hash: the same tx gives the same digest, any change gives a new digest", () => {
  const base = sign.hashTypedData(transferTx());
  assert.equal(base, sign.hashTypedData(transferTx()));
  assert.match(base, /^0x[0-9a-f]{64}$/);

  const variants = [
    transferTx(1),
    transferTx(0, { input: { to: bob, amount: 31 } }),
    transferTx(0, { to: "other" }),
    transferTx(0, { method: "approve" }),
    transferTx(0, { value: 1 }),
    transferTx(0, { gasLimit: 5000 }),
    transferTx(0, { chainId: 2 }),
    transferTx(0, { from: bob }),
  ];
  assert.equal(new Set([base, ...variants.map(sign.hashTypedData)]).size, variants.length + 1);
});

test("typed data: the EIP-712 structure the wallet shows the user", () => {
  const typed = sign.buildTypedData(transferTx(3));
  // domain has no chainId → MetaMask signs whatever chain is active · chainId is in the message
  assert.deepEqual(typed.domain, { name: "Bluewolfchain", version: "2" });
  assert.deepEqual(typed.types.EIP712Domain.map((field) => field.name), ["name", "version"]);
  assert.equal(typed.primaryType, "Transaction");
  assert.deepEqual(typed.types.Transaction.map((field) => field.name),
    ["chainId", "action", "from", "to", "method", "input", "value", "nonce", "gasLimit", "gasPrice", "signedOnChainId"]);
  assert.deepEqual(
    { ...typed.message, input: JSON.parse(typed.message.input) },
    { chainId: 1, action: "call", from: alice, to: "token", method: "transfer", input: { code: null, input: { to: bob, amount: 30 } }, value: 0, nonce: 3, gasLimit: 0, gasPrice: 0, signedOnChainId: 1 },
  );
});

test("verify: forged signature / tx changed after signing / from mismatch → rejected", () => {
  const tx = transferTx();
  const signature = sign.signTransaction(tx, ALICE_KEY);

  assert.throws(() => sign.verifyTransaction({ tx: transferTx(0, { input: { to: bob, amount: 999 } }), signature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction({ tx: { ...tx, from: bob }, signature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, BOB_KEY) }), /ลายเซ็นไม่ตรงกับ from/);
  assert.throws(() => sign.verifyTransaction({ tx, signature: "0x1234" }), /signature ต้องยาว 65 byte/);
  assert.throws(() => sign.verifyTransaction({ tx, signature: `${signature.slice(0, -2)}05` }), /v ต้องเป็น 27 หรือ 28/);
});

test("verify: a tx signed for another chain cannot be used here", () => {
  const tx = transferTx(0, { chainId: 999 });
  const signature = sign.signTransaction(tx, ALICE_KEY);
  assert.equal(sign.verifyTransaction({ tx, signature }).sender, alice);              // valid on its own chain
  assert.throws(() => sign.verifyTransaction({ tx: { ...tx, chainId: 1 }, signature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.equal(sign.verifyTransaction({ tx, signature }).chainId, 999);   // the mempool compares it with the chain's chainId (test 114)
});

test("signedOnChainId: part of the signature (cannot be changed later) · omitted = chainId · non-numeric = rejected", () => {
  const onBsc = transferTx(0, { signedOnChainId: 56 });
  const signature = sign.signTransaction(onBsc, ALICE_KEY);
  const verified = sign.verifyTransaction({ tx: onBsc, signature });
  assert.equal(verified.sender, alice);
  assert.equal(verified.request.signedOnChainId, 56);
  assert.throws(() => sign.verifyTransaction({ tx: { ...onBsc, signedOnChainId: 1 }, signature }), /ลายเซ็นไม่ตรงกับ from/);
  assert.equal(sign.buildTypedData(transferTx(0)).message.signedOnChainId, 1);
  assert.throws(() => sign.buildTypedData(transferTx(0, { signedOnChainId: "bsc" })), /signedOnChainId/);
});

// ---------------------------------------------------------------------------
//  real use with the VM
// ---------------------------------------------------------------------------

test("flow: a correctly signed tx works, and sender comes from the signature", () => {
  const vm = setup();
  const tx = transferTx(0);
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.equal(res.status, "success");
  assert.equal(res.calls[0].sender, alice);
  assert.equal(vm.db.readKeys([`token:storage:balances:${bob}`])[0], "30n");
});

test("flow: from cannot be forged — bob signs but claims to be alice", () => {
  const vm = setup();
  const tx = transferTx(0, { from: alice });
  assert.throws(() => submit(vm, tx, sign.signTransaction(tx, BOB_KEY)), /ลายเซ็นไม่ตรงกับ from/);
  assert.equal(vm.db.readKeys([`token:storage:balances:${bob}`])[0], undefined);
});

test("flow: the same tx cannot be resent (nonce prevents it)", () => {
  const vm = setup();
  const tx = transferTx(0);
  const signature = sign.signTransaction(tx, ALICE_KEY);
  assert.equal(submit(vm, tx, signature).status, "success");
  assert.equal(submit(vm, tx, signature).error.code, "INVALID_REQUEST"); // nonce already used
});

test("flow: origin = sender always, even if the attached context is bogus", () => {
  const vm = setup();
  const tx = transferTx(0);
  const { request } = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, ALICE_KEY) });
  assert.deepEqual(request.context, { sender: alice, origin: alice });

  const tampered = { ...request, context: { sender: alice, origin: bob } }; // the server mistakenly sends a wrong origin
  const res = vm.call(tampered);
  assert.equal(res.calls[0].origin, alice); // the VM forces it to equal sender
});

test("flow: signed deploy — the program address is derived from the signer", () => {
  const vm = setup();
  const tx = { chainId: 1, action: "deploy", from: alice, to: "", method: "", input: { start: 5 }, code: COUNTER, value: 0, nonce: 0, gasLimit: 0 };
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.equal(res.status, "success");
  assert.equal(res.result.programUuid, vm.programAddressFor(alice, 0));
  assert.equal(vm.init({ programUuid: res.result.programUuid }).status, "success");
});

test("flow: signed native transfer", () => {
  const vm = setup();
  vm.db.load({ [`${alice}:native:received`]: "1000n" });
  const tx = { chainId: 1, action: "transfer", from: alice, to: bob, method: "", input: {}, value: 250, nonce: 0, gasLimit: 0 };
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.deepEqual(res.result, { from: alice, to: bob, amount: "250n" });
  assert.equal(vm.nativeBalanceOf(bob).balance, 250n);   // nativeBalanceOf returns BigInt
});

/** sends a tx through a block (the signature is stored in blockbody) → the system hash */
function submitInBlock(vm, tx, signature) {
  const { method, request } = sign.verifyTransaction({ tx, signature });
  const block = vm.createBlock({ timestamp: 1_700_000_000_000, feeRecipient: "0xminer" });
  block[method](request);
  block.commit();
  return vm.getBlock(vm.latestBlockNumber()).txHashes[0];
}

test("flow: signatures can be verified later (stored only in blockbody · txn does not duplicate it)", () => {
  const vm = setup({ recordBlocks: true });
  const tx = transferTx(0);
  const signature = sign.signTransaction(tx, ALICE_KEY);
  const hash = submitInBlock(vm, tx, signature);

  const [record] = vm.listTransactionsOf(alice);
  assert.equal(record.signature, undefined);
  assert.equal(record.digest, sign.hashTypedData(tx));               // digest filled in from the tx index
  const found = vm.getTransaction(hash, { signature: true });
  assert.equal(found.record.signature, signature);
  assert.equal(found.record.status, "success");
  assert.equal(sign.recoverSigner(tx, found.record.signature), alice); // proves after the fact that alice really signed
});

test("flow: failed txs can also be signature-verified later", () => {
  const vm = setup({ recordBlocks: true });
  const tx = transferTx(0, { input: { to: bob, amount: 99999 } });
  const signature = sign.signTransaction(tx, ALICE_KEY);
  const hash = submitInBlock(vm, tx, signature);

  const found = vm.getTransaction(hash, { signature: true });
  assert.equal(found.status, "throw");
  assert.equal(found.record.signature, signature);
});

test("flow: several txs in one block, each must pass verification first", () => {
  const vm = setup();
  vm.db.load({ [`${alice}:native:received`]: "1000n" });
  const block = vm.createBlock({ timestamp: 1_700_000_000_000, number: 1, feeRecipient: "0xminer" });

  const signed = [transferTx(0), transferTx(1, { input: { to: bob, amount: 10 } })].map((tx) => ({ tx, signature: sign.signTransaction(tx, ALICE_KEY) }));
  for (const { tx, signature } of signed) {
    const { method, request } = sign.verifyTransaction({ tx, signature });
    block[method](request);
  }
  block.commit();

  assert.deepEqual(block.results().map((r) => r.status), ["success", "success"]);
  assert.equal(vm.db.readKeys([`token:storage:balances:${bob}`])[0], "40n");
  assert.deepEqual(vm.listTransactionsOf(alice).map((r) => r.nonce), [1, 0]);
});

test("flow: signed metadata tx — names the sender's own address", () => {
  const vm = setup();
  const tx = { chainId: 1, action: "metadata", from: alice, to: "", method: "", input: { namespace: "Alice", icon: "👩" }, value: 0, nonce: 0, gasLimit: 0 };
  const res = submit(vm, tx, sign.signTransaction(tx, ALICE_KEY));

  assert.equal(res.status, "success");
  assert.equal(vm.resolveNamespace("alice"), alice);
  assert.deepEqual(vm.getMetadata(alice), { namespace: "alice", icon: "👩" });
  assert.throws(() => sign.verifyTransaction({ tx: { ...tx, from: bob }, signature: sign.signTransaction(tx, ALICE_KEY) }), /ลายเซ็นไม่ตรงกับ from/);
});
