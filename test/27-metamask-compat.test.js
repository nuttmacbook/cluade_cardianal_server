import { test } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import * as sign from "../src/crypto/signature.js";

/*
 * cross-check against the standard library (ethers), which uses the same algorithm as MetaMask
 *   - signatures we create → ethers verifies them
 *   - signatures a wallet (ethers) creates → we recover the correct address
 * passing this suite = users can sign with MetaMask directly, no custom wallet needed
 */

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const wallet = new ethers.Wallet(PRIVATE_KEY);

const TX = {
  chainId: 1,
  action: "call",
  from: wallet.address.toLowerCase(),
  to: "0x5fbdb2315678afecb367f032d93f642f64180aa3",
  method: "transfer",
  input: { to: "0xfabb0ac9d68b0b445fb7357272ff202c5651694a", amount: 30 },
  value: 0,
  nonce: 3,
  gasLimit: 50000,
};

/** structure passed to ethers (EIP712Domain removed, as ethers requires) */
function forEthers(tx) {
  const typed = sign.buildTypedData(tx);
  const { EIP712Domain, ...types } = typed.types;
  return { domain: typed.domain, types, message: typed.message };
}

test("address: derived from a private key matches ethers", () => {
  assert.equal(sign.addressOf(PRIVATE_KEY), wallet.address.toLowerCase());
});

test("digest: EIP-712 hash matches what ethers computes", () => {
  const { domain, types, message } = forEthers(TX);
  assert.equal(sign.hashTypedData(TX), ethers.TypedDataEncoder.hash(domain, types, message));
});

test("our signature → ethers verifies and gets the same address", () => {
  const signature = sign.signTransaction(TX, PRIVATE_KEY);
  const { domain, types, message } = forEthers(TX);
  assert.equal(ethers.verifyTypedData(domain, types, message, signature).toLowerCase(), wallet.address.toLowerCase());
});

test("signature from a wallet (same as MetaMask) → we recover the correct address", async () => {
  const { domain, types, message } = forEthers(TX);
  const signature = await wallet.signTypedData(domain, types, message);   // = eth_signTypedData_v4

  assert.equal(sign.recoverSigner(TX, signature), wallet.address.toLowerCase());
  const verified = sign.verifyTransaction({ tx: TX, signature });
  assert.equal(verified.sender, wallet.address.toLowerCase());
  assert.equal(verified.action, "call");
  assert.deepEqual(verified.request.context, { sender: wallet.address.toLowerCase(), origin: wallet.address.toLowerCase() });
});

test("our signature and the wallet's are identical character for character", async () => {
  const { domain, types, message } = forEthers(TX);
  const ours = sign.signTransaction(TX, PRIVATE_KEY);
  const theirs = await wallet.signTypedData(domain, types, message);
  assert.equal(ours, theirs);
});

test("every action signs and recovers consistently with ethers", async () => {
  const variants = [
    TX,
    { ...TX, action: "transfer", to: "0xfabb0ac9d68b0b445fb7357272ff202c5651694a", method: "", input: {}, value: 250 },
    { ...TX, action: "deploy", to: "", method: "", input: { start: 1 }, code: "function program() {\n  function a() {}\n  return { a }\n}" },
  ];

  for (const tx of variants) {
    const { domain, types, message } = forEthers(tx);
    const signature = await wallet.signTypedData(domain, types, message);
    assert.equal(sign.recoverSigner(tx, signature), wallet.address.toLowerCase(), tx.action);
    assert.equal(sign.hashTypedData(tx), ethers.TypedDataEncoder.hash(domain, types, message), tx.action);
  }
});

test("tampering with a tx after signing → ethers also recovers someone else (matches our result)", async () => {
  const { domain, types, message } = forEthers(TX);
  const signature = await wallet.signTypedData(domain, types, message);
  const tampered = { ...TX, input: { ...TX.input, amount: 999 } };

  const theirs = ethers.verifyTypedData(...Object.values(forEthers(tampered)), signature).toLowerCase();
  assert.notEqual(theirs, wallet.address.toLowerCase());
  assert.equal(sign.recoverSigner(tampered, signature), theirs);
  assert.throws(() => sign.verifyTransaction({ tx: tampered, signature }), /signature does not match from/);
});

test("what the user sees in MetaMask", () => {
  const typed = sign.buildTypedData(TX);
  assert.deepEqual(typed.domain, { name: "Bluewolfchain", version: "2" });
  assert.deepEqual(typed.message, {
    chainId: 1,
    action: "call",
    from: TX.from,
    to: TX.to,
    method: "transfer",
    input: JSON.stringify({ code: null, input: { amount: 30, to: TX.input.to } }),
    value: 0,
    nonce: 3,
    gasLimit: 50000,
    gasPrice: 0,
    signedOnChainId: 1,
  });
});
