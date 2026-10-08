import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";

/* keccak256 / ecrecover ที่โปรแกรมเรียกได้ */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const KEY = sign.randomPrivateKey();
const signer = sign.addressOf(KEY);

const CRYPTO = `
function program() {
  function hash(params) { return keccak256(params.input.value) }

  function recover(params) { return ecrecover(params.input.message, params.input.signature) }

  function claim(params) {
    const who = ecrecover(params.input.message, params.input.signature)
    if (who !== readDB("admin")) throw new Error("ลายเซ็นไม่ใช่ของ admin")
    if (readDB(map("used", params.input.message.nonce))) throw new Error("ใช้ไปแล้ว")
    writeDB(map("used", params.input.message.nonce), true)
    emit("Claimed", { by: params.context.sender, amount: params.input.message.amount })
    return params.input.message.amount
  }

  function initialization(params) { writeDB("admin", params.input.admin) }

  return { hash, recover, claim }
}
`;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, ...options });
  vm.commit(vm.deploy({ programUuid: "crypto", code: CRYPTO, context: user("owner"), initInput: { admin: signer } }, { timestamp: T }).writes);
  vm.commit(vm.init({ programUuid: "crypto" }, { timestamp: T }).writes);
  return vm;
}

const call = (vm, functionName, input, sender = "alice") =>
  vm.call({ programUuid: "crypto", functionName, input, context: user(sender) }, { timestamp: T + 1000 });

/** เซ็นข้อความแบบเดียวกับที่โปรแกรมจะ hash (canonical JSON → keccak256) */
const signMessage = (message, key = KEY) => {
  const digest = VM.keccak256Hex(VM.canonicalJson(message));
  const bytes = Buffer.from(digest.slice(2), "hex");
  return signRaw(bytes, key);
};

function signRaw(digest, key) {
  const signed = secp256k1.sign(digest, Buffer.from(key.slice(2), "hex"), { format: "recovered", prehash: false });
  return `0x${Buffer.from(signed.slice(1)).toString("hex")}${(27 + signed[0]).toString(16).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------

test("keccak256: string และ object", () => {
  const vm = setup();
  assert.equal(call(vm, "hash", { value: "hello" }).result, VM.keccak256Hex("hello"));
  assert.equal(call(vm, "hash", { value: "" }).result, VM.keccak256Hex(""));

  // object ถูกแปลงแบบ canonical ก่อน ลำดับ key จึงไม่มีผล
  const first = call(vm, "hash", { value: { a: 1, b: 2 } }).result;
  const second = call(vm, "hash", { value: { b: 2, a: 1 } }).result;
  assert.equal(first, second);
  assert.equal(first, VM.keccak256Hex(VM.canonicalJson({ a: 1, b: 2 })));
});

test("keccak256: ค่าต่างกัน → hash ต่างกัน", () => {
  const vm = setup();
  const values = ["a", "b", { x: 1 }, [1, 2], 123, true, null];
  const hashes = values.map((value) => call(vm, "hash", { value }).result);
  assert.equal(new Set(hashes).size, values.length);
});

test("ecrecover: กู้ address ของผู้เซ็นได้", () => {
  const vm = setup();
  const message = { to: "0xbob", amount: 100, nonce: 1 };
  const signature = signMessage(message);

  assert.equal(call(vm, "recover", { message, signature }).result, signer);
  assert.notEqual(call(vm, "recover", { message: { ...message, amount: 999 }, signature }).result, signer); // แก้ข้อความ = คนละคน
});

test("ecrecover: ลายเซ็นผิดรูปแบบ → INVALID_REQUEST, ลายเซ็นเสีย → null", () => {
  const vm = setup();
  const message = { a: 1 };
  assert.equal(call(vm, "recover", { message, signature: "0x1234" }).error.code, "INVALID_REQUEST");
  assert.equal(call(vm, "recover", { message, signature: `0x${"0".repeat(130)}` }).result, null);
});

test("flow: คูปองที่ admin เซ็นไว้ล่วงหน้า ใช้ได้ครั้งเดียว", () => {
  const vm = setup();
  const message = { to: "alice", amount: 50, nonce: 7 };
  const signature = signMessage(message);

  const first = call(vm, "claim", { message, signature });
  assert.equal(first.result, 50);
  assert.deepEqual(first.events[0].data, { by: "alice", amount: 50 });
  vm.commit(first.writes);

  assert.equal(call(vm, "claim", { message, signature }).error.message, "ใช้ไปแล้ว");
  const forged = signMessage(message, sign.randomPrivateKey());
  assert.equal(call(vm, "claim", { message: { ...message, nonce: 8 }, signature: forged }).error.message, "ลายเซ็นไม่ใช่ของ admin");
});

test("ค่าแก๊ส: keccak256 และ ecrecover คิดตามที่ตั้งไว้", () => {
  const gas = { call: 0, read: 0, write: 0, byte: 1, event: 0, hash: 100, recover: 3000, code: 0, price: 1 };
  const vm = setup({ chargeGas: true, gas });
  vm.db.load({ "alice:native:received": 1_000_000 });

  const hashed = call(vm, "hash", { value: "abc" });
  assert.equal(hashed.gasUsed, gas.hash + 3);

  const message = { a: 1 };
  const recovered = call(vm, "recover", { message, signature: signMessage(message) });
  assert.equal(recovered.gasUsed, gas.recover + Buffer.byteLength(VM.canonicalJson(message)));
});

test("ค่าเริ่มต้นของค่าแก๊ส", () => {
  assert.equal(VM.DEFAULT_GAS.hash, 100);
  assert.equal(VM.DEFAULT_GAS.recover, 3000);
});
