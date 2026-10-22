import { test } from "node:test";
import assert from "node:assert/strict";
import { Wallet, TypedDataEncoder, keccak256, getBytes, Signature } from "ethers";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { reviewProgram, PROGRAM_API } from "../src/core/autoreview.js";
import { API_OPS } from "../src/core/sandbox.js";
import { eip712Digest, eip712DomainSeparator, eip712EncodeType, eip712HashStruct, keccak256Bytes, recoverAddress } from "../src/crypto/eip712.js";
import { TOKEN_PROGRAM, PERMIT_TYPES } from "../src/standards/token.js";
import { WALLET_PROGRAM, ERC1271_MAGIC_VALUE, ERC1271_INVALID_VALUE } from "../src/standards/wallet.js";
import { permitTypedData, permitDigest, signPermit, signWalletHash, signTypedDataDigest, recoverTypedDataDigest,
  typedDataDigest } from "../src/crypto/program-signature.js";

/*
 * EIP-712 จริง (eth_signTypedData_v4 / ethers TypedDataEncoder) ในโปรแกรม:
 *   keccak256Bytes(hex) · ecrecoverDigest(digest, sig) · eip712Digest(domain, types, primaryType, message) · eip712DomainSeparator(domain, types?)
 *   permit ของ TOKEN_PROGRAM = ERC-2612 (deadline วินาที) · ERC-1271 isValidSignature รับ digest 32 byte
 */

const T0 = Date.parse("2025-06-01T00:00:00Z");
const user = (name) => ({ sender: name.toLowerCase(), origin: name.toLowerCase() });

// ---------------------------------------------------------------------------
//  ชุด type หลายแบบ เทียบกับ ethers
// ---------------------------------------------------------------------------

const MAIL_TYPES = {
  Person: [{ name: "name", type: "string" }, { name: "wallet", type: "address" }],
  Mail: [{ name: "from", type: "Person" }, { name: "to", type: "Person" }, { name: "contents", type: "string" }],
};
const MAIL = {
  from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
  to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" },
  contents: "Hello, Bob!",
};
const MAIL_DOMAIN = { name: "Ether Mail", version: "1", chainId: 1n, verifyingContract: "0xcccccccccccccccccccccccccccccccccccccccc" };

const CASES = [
  // ตัวอย่างใน EIP-712 เอง (digest ที่รู้ค่าแน่นอน)
  { label: "EIP-712 Mail", domain: MAIL_DOMAIN, types: MAIL_TYPES, primaryType: "Mail", message: MAIL,
    known: "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2" },
  { label: "atomic ทุกชนิด", domain: { name: "Atoms", chainId: 31337n },
    types: { Atoms: [
      { name: "a", type: "address" }, { name: "u8", type: "uint8" }, { name: "u256", type: "uint256" }, { name: "i8", type: "int8" },
      { name: "i256", type: "int256" }, { name: "flag", type: "bool" }, { name: "b1", type: "bytes1" }, { name: "b32", type: "bytes32" },
      { name: "data", type: "bytes" }, { name: "text", type: "string" }, { name: "empty", type: "bytes" }, { name: "blank", type: "string" },
    ] },
    primaryType: "Atoms",
    message: { a: "0x00000000000000000000000000000000000000aa", u8: 255n, u256: (1n << 256n) - 1n, i8: -128n, i256: -1n, flag: true,
      b1: "0xff", b32: `0x${"ab".repeat(32)}`, data: "0xdeadbeef", text: "สวัสดี 🌏", empty: "0x", blank: "" } },
  { label: "array (dynamic / fixed / ซ้อน) + struct ซ้อนหลายชั้น", domain: { name: "Nested", version: "2", chainId: 7777n,
    verifyingContract: "0x00000000000000000000000000000000000000f1", salt: `0x${"01".repeat(32)}` },
    types: {
      Order: [{ name: "maker", type: "Party" }, { name: "items", type: "Item[]" }, { name: "grid", type: "uint16[2][]" }, { name: "tags", type: "string[3]" }],
      Party: [{ name: "who", type: "address" }, { name: "zone", type: "Zone" }],
      Item: [{ name: "id", type: "uint256" }, { name: "amount", type: "int64" }, { name: "zone", type: "Zone" }],
      Zone: [{ name: "code", type: "bytes4" }, { name: "open", type: "bool" }],
    },
    primaryType: "Order",
    message: {
      maker: { who: "0x00000000000000000000000000000000000000b2", zone: { code: "0x01020304", open: false } },
      items: [{ id: 1n, amount: -5n, zone: { code: "0xaabbccdd", open: true } }, { id: 2n, amount: 9n, zone: { code: "0x00000000", open: false } }],
      grid: [[1n, 2n], [3n, 65535n]],
      tags: ["a", "", "ค"],
    } },
  { label: "array ว่าง + domain มีแค่ chainId", domain: { chainId: 1n }, types: { Batch: [{ name: "ids", type: "uint256[]" }, { name: "who", type: "address[]" }] },
    primaryType: "Batch", message: { ids: [], who: [] } },
];

/** ค่าในโปรแกรม (bigint) → แบบที่ ethers รับ (bigint ก็รับ) — ส่งตรง ๆ ได้ */
const ethersDigest = ({ domain, types, message }) => TypedDataEncoder.hash(domain, types, message);

test("eip712Digest / eip712DomainSeparator / eip712EncodeType / eip712HashStruct (ฝั่ง host) = ethers TypedDataEncoder ทุกชุด", () => {
  for (const c of CASES) {
    const digest = eip712Digest(c.domain, c.types, c.primaryType, c.message);
    assert.equal(digest, ethersDigest(c), c.label);
    if (c.known) assert.equal(digest, c.known, c.label);
    assert.equal(eip712DomainSeparator(c.domain), TypedDataEncoder.hashDomain(c.domain), c.label);
    const encoder = TypedDataEncoder.from(c.types);
    assert.equal(eip712EncodeType(c.primaryType, c.types), encoder.encodeType(c.primaryType), c.label);
    assert.equal(eip712HashStruct(c.primaryType, c.types, c.message), encoder.hashStruct(c.primaryType, c.message), c.label);
    // types แบบ MetaMask (มี EIP712Domain) ได้ค่าเดียวกัน
    const withDomain = { EIP712Domain: TypedDataEncoder.getPayload(c.domain, c.types, c.message).types.EIP712Domain, ...c.types };
    assert.equal(eip712Digest(c.domain, withDomain, c.primaryType, c.message), digest, c.label);
  }
  // primaryType = EIP712Domain → keccak256(0x1901 ‖ domainSeparator) แบบ MetaMask
  assert.equal(eip712Digest(MAIL_DOMAIN, MAIL_TYPES, "EIP712Domain", {}),
    keccak256(`0x1901${eip712DomainSeparator(MAIL_DOMAIN).slice(2)}`));
  assert.equal(keccak256Bytes("0x"), keccak256("0x"));
  assert.equal(keccak256Bytes("0xDEADbeef"), keccak256("0xdeadbeef"));
});

test("eip712Digest: ข้อมูลผิดรูปแบบ → error ชัดเจน (ไม่เงียบ)", () => {
  const bad = [
    [MAIL_DOMAIN, MAIL_TYPES, "Nope", MAIL, /primaryType 'Nope'/],
    [MAIL_DOMAIN, MAIL_TYPES, "Mail", { ...MAIL, contents: undefined }, /Mail.contents: ไม่มีค่า/],
    [MAIL_DOMAIN, MAIL_TYPES, "Mail", { ...MAIL, from: { ...MAIL.from, wallet: "0x1234" } }, /ต้องเป็น address/],
    [{ ...MAIL_DOMAIN, foo: 1 }, MAIL_TYPES, "Mail", MAIL, /ไม่รู้จัก field 'foo'/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: "uint7" }] }, "A", { x: 1n }, /ไม่รู้จักชนิด/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: "uint8" }] }, "A", { x: 256n }, /เกินช่วง/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: "int8" }] }, "A", { x: -129n }, /เกินช่วง/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: "bytes2" }] }, "A", { x: "0x01" }, /ยาว 2 byte/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: "bool" }] }, "A", { x: 1n }, /true \/ false/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: "uint8[2]" }] }, "A", { x: [1n] }, /ต้องมี 2 ช่อง/],
    [MAIL_DOMAIN, { A: [{ name: "b", type: "B" }], B: [{ name: "a", type: "A" }] }, "A", {}, /เป็นวง/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: "uint8" }, { name: "x", type: "uint8" }] }, "A", { x: 1n }, /ซ้ำ/],
    // เพดานกัน stack ของ host (ทุกเครื่องล้มที่จุดเดียวกัน)
    [MAIL_DOMAIN, Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`T${i}`, [{ name: "x", type: "uint8" }]])), "T0", { x: 1n }, /ไม่เกิน 64 ชนิด/],
    [MAIL_DOMAIN, { A: [{ name: "x", type: `uint8${"[]".repeat(40)}` }] }, "A", { x: [] }, /ซ้อนลึกเกิน 32/],
  ];
  for (const [domain, types, primaryType, message, pattern] of bad) {
    assert.throws(() => eip712Digest(domain, types, primaryType, message), pattern);
  }
});

// ---------------------------------------------------------------------------
//  ในโปรแกรม (VM จริง)
// ---------------------------------------------------------------------------

const PROBE = `function program() {
  function digest(params) { return eip712Digest(params.input.domain, params.input.types, params.input.primaryType, params.input.message) }
  function separator(params) { return eip712DomainSeparator(params.input.domain, params.input.types) }
  function rawHash(params) { return keccak256Bytes(params.input.hex) }
  function recover(params) { return ecrecoverDigest(params.input.digest, params.input.signature) }
  function textHash(params) { return keccak256(params.input.text) }
  function textRecover(params) { return ecrecover(params.input.text, params.input.signature) }
  function catchBad(params) {
    try { eip712Digest(params.input.domain, params.input.types, "Mail", params.input.message); return "no error" }
    catch (e) { return e.code + ": " + e.message }
  }
  function catchBytes(params) { try { return keccak256Bytes(params.input.hex) } catch (e) { return e.code } }
  function catchRecover(params) { try { return ecrecoverDigest(params.input.digest, params.input.signature) } catch (e) { return e.code } }
  function numberValue() { return eip712Digest({ chainId: 1 }, { A: [{ name: "x", type: "uint8" }] }, "A", { x: 1n }) }
  return { digest, separator, rawHash, recover, textHash, textRecover, catchBad, catchBytes, catchRecover, numberValue }
}`;

function probeChain(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 77, timeoutMs: 5000, ...options });
  const block = vm.createBlock({ timestamp: T0 });
  block.deploy({ programUuid: "0x00000000000000000000000000000000000000a1", code: PROBE, context: user("owner") });
  block.init({ programUuid: "0x00000000000000000000000000000000000000a1" });
  block.commit();
  const call = (functionName, input = {}) => vm.call({ programUuid: "0x00000000000000000000000000000000000000a1", functionName, input,
    context: user("alice") }, { timestamp: T0 + 1000 });
  return { vm, call };
}

/** ค่าที่ส่งเข้า VM: bigint → "123n" (VM แปลงกลับเป็น BigInt ให้โปรแกรม) */
const toInput = (value) => {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(toInput);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toInput(v)]));
  return value;
};

test("API ใหม่ถูกต่อครบ: PROGRAM_API_NAMES / sandbox / autoreview · โปรแกรมที่ใช้ผ่าน autoreview", () => {
  for (const name of ["keccak256Bytes", "ecrecoverDigest", "eip712Digest", "eip712DomainSeparator"]) {
    assert.ok(PROGRAM_API.includes(name), name);
    assert.ok(API_OPS.some(([op]) => op === name), name);
  }
  assert.deepEqual(reviewProgram(PROBE).issues, []);
  assert.deepEqual(reviewProgram(TOKEN_PROGRAM).issues, []);
});

test("eip712Digest / eip712DomainSeparator ในโปรแกรม = ethers TypedDataEncoder ทุกชุด", () => {
  const { call } = probeChain();
  for (const c of CASES) {
    const res = call("digest", toInput({ domain: c.domain, types: c.types, primaryType: c.primaryType, message: c.message }));
    assert.equal(res.status, "success", `${c.label}: ${JSON.stringify(res.error)}`);
    assert.equal(res.result, ethersDigest(c), c.label);
    assert.equal(call("separator", toInput({ domain: c.domain })).result, TypedDataEncoder.hashDomain(c.domain), c.label);
  }
  // ข้อมูลผิด → INVALID_REQUEST ที่ catch ได้ · number ของ JS ใช้ไม่ได้ (ตัวเลขในโปรแกรมเป็น BigInt)
  const bad = call("catchBad", toInput({ domain: MAIL_DOMAIN, types: MAIL_TYPES, message: { ...MAIL, to: null } }));
  assert.match(bad.result, /^INVALID_REQUEST: EIP-712: Mail.to: ไม่มีค่า/);
  const number = call("numberValue");
  assert.equal(number.status, "throw");
  assert.equal(number.error.code, "INVALID_REQUEST");
  assert.match(number.error.message, /BigInt/);
});

test("keccak256Bytes / ecrecoverDigest ในโปรแกรม · keccak256 / ecrecover แบบเดิมไม่เปลี่ยน", () => {
  const { call } = probeChain();
  assert.equal(call("rawHash", { hex: "0x" }).result, keccak256("0x"));
  assert.equal(call("rawHash", { hex: "0x00ff10" }).result, keccak256("0x00ff10"));
  assert.equal(call("catchBytes", { hex: "0x123" }).result, "INVALID_REQUEST");
  assert.equal(call("catchBytes", { hex: "abcd" }).result, "INVALID_REQUEST");
  // ข้อความ: keccak256(UTF-8) เหมือนเดิม (ไม่ใช่ byte ของ hex)
  assert.equal(call("textHash", { text: "0x00ff10" }).result, VM.keccak256Hex("0x00ff10"));

  const wallet = new Wallet(`0x${"44".repeat(32)}`);
  const digest = keccak256("0x1234");
  const signature = wallet.signingKey.sign(digest).serialized;
  assert.equal(call("recover", { digest, signature }).result, wallet.address.toLowerCase());
  assert.equal(signTypedDataDigest(digest, wallet.privateKey), signature);   // ตัวช่วยฝั่ง JS = ethers ทุกไบต์
  assert.equal(recoverTypedDataDigest(digest, signature), wallet.address.toLowerCase());
  // v ไม่ใช่ 27 / 28 → null · digest อื่น → address อื่น · รูปแบบผิด → INVALID_REQUEST (catch ได้)
  assert.equal(call("recover", { digest, signature: `${signature.slice(0, -2)}1d` }).result, null);
  assert.notEqual(call("recover", { digest: keccak256("0x99"), signature }).result, wallet.address.toLowerCase());
  assert.equal(call("catchRecover", { digest: "0x1234", signature }).result, "INVALID_REQUEST");
  assert.equal(call("catchRecover", { digest, signature: "0x1234" }).result, "INVALID_REQUEST");
  // s สูง (ไม่ใช่ low-s): พฤติกรรมเดียวกับ ecrecover เดิม (ใช้ตัวกู้ตัวเดียวกัน)
  const sig = Signature.from(signature);
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const highS = `${sig.r}${(N - BigInt(sig.s)).toString(16).padStart(64, "0")}${sig.v === 27 ? "1c" : "1b"}`;
  assert.equal(call("recover", { digest, signature: highS }).result, recoverAddress(digest, highS));
  // ecrecover(ข้อความ) แบบเดิม
  const textDigest = VM.keccak256Hex("hello");
  assert.equal(call("textRecover", { text: "hello", signature: wallet.signingKey.sign(textDigest).serialized }).result, wallet.address.toLowerCase());
});

test("แก๊ส: keccak256Bytes = hash + byte × n · ecrecoverDigest = recover · eip712Digest ตามจำนวน hash + byte ที่ถูก hash · ของเดิมเท่าเดิม", () => {
  const { call } = probeChain({ gas: API_GAS_ONLY });
  const base = (fn, input) => call(fn, input).gasUsed;
  const g = VM.DEFAULT_GAS;
  const raw = (hex) => base("rawHash", { hex });
  assert.equal(raw("0x" + "00".repeat(64)) - raw("0x" + "00".repeat(32)), 32 * g.byte);
  assert.equal(raw("0x" + "00".repeat(32)) - raw("0x"), 32 * g.byte);
  // keccak256(ข้อความ) เดิม: hash + byte × ความยาว (เท่ากับ keccak256Bytes ของ byte จำนวนเท่ากัน)
  assert.equal(base("textHash", { text: "a".repeat(32) }) - base("rawHash", { hex: "0x" + "61".repeat(32) }), 0);

  const wallet = new Wallet(`0x${"45".repeat(32)}`);
  const digest = keccak256("0x01");
  const recoverGas = base("recover", { digest, signature: wallet.signingKey.sign(digest).serialized });
  const callOnly = base("textHash", { text: "" }) - g.hash;   // call + ค่าส่งข้อมูล (ไม่มี hash)
  assert.equal(recoverGas - callOnly, g.recover);

  // eip712Digest: Mail = typeHash(Mail) + typeHash(Person) + 2 Person + 3 string + struct Mail + domain (typeHash + 2 string + struct) + digest
  const mail = base("digest", toInput({ domain: MAIL_DOMAIN, types: MAIL_TYPES, primaryType: "Mail", message: MAIL }));
  const encodeMail = "Mail(Person from,Person to,string contents)Person(string name,address wallet)";
  const encodePerson = "Person(string name,address wallet)";
  const encodeDomain = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";
  const hashes = 1 + 1 + 2 + 2 + 1 + 1 + 1 + 2 + 1 + 1;   // typeHash ×2, ชื่อ ×2, struct Person ×2, contents, Mail · domain: typeHash, name+version, struct · digest
  const bytes = encodeMail.length + encodePerson.length + "Cow".length + "Bob".length + 3 * 32 * 2 + "Hello, Bob!".length + 4 * 32
    + encodeDomain.length + "Ether Mail".length + 1 + 5 * 32 + 66;
  const viaRaw = base("rawHash", { hex: "0x" });   // call + ค่า hash 1 ครั้ง
  assert.equal(mail - (viaRaw - g.hash), hashes * g.hash + bytes * g.byte);
});

// ---------------------------------------------------------------------------
//  permit (ERC-2612) ที่เซ็นด้วย ethers signTypedData + ERC-1271
// ---------------------------------------------------------------------------

const TOKEN = "0x00000000000000000000000000000000000000f1";
const OTHER_TOKEN = "0x00000000000000000000000000000000000000f2";
const WALLET = "0x00000000000000000000000000000000000000e1";
const SPENDER = "0x00000000000000000000000000000000000000b2";
const RELAYER = "0x00000000000000000000000000000000000000c3";
const ownerWallet = new Wallet(`0x${"11".repeat(32)}`);
const walletOwner = new Wallet(`0x${"22".repeat(32)}`);
const OWNER = ownerWallet.address.toLowerCase();

function tokenChain({ chainId = 7777 } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId, recordBlocks: true });
  let number = 0;
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: T0 + number * 1500, feeRecipient: RELAYER });   // 1.5 วิ ต่อ block → วินาทีปัดลง
    const results = fn(b);
    b.commit();
    return results;
  };
  block((b) => [
    b.deploy({ programUuid: TOKEN, code: TOKEN_PROGRAM, context: user(OWNER), initInput: { name: "Permit Coin", ticker: "PMC", decimals: "6n", supply: "1000000n" } }),
    b.init({ programUuid: TOKEN }),
    b.deploy({ programUuid: OTHER_TOKEN, code: TOKEN_PROGRAM, context: user(OWNER), initInput: { name: "Permit Coin", ticker: "PMC", decimals: "6n", supply: "1000000n" } }),
    b.init({ programUuid: OTHER_TOKEN }),
    b.deploy({ programUuid: WALLET, code: WALLET_PROGRAM, context: user(RELAYER), initInput: { owner: walletOwner.address.toLowerCase() } }),
    b.init({ programUuid: WALLET }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  const call = (who, programUuid, functionName, input) => block((b) => [b.call({ programUuid, functionName, input, context: user(who) })])[0];
  const read = (programUuid, functionName, input = {}) => vm.query({ programUuid, functionName, input }).result;
  /** วินาทีของ block ถัดไป (ที่ permit จะเทียบ) */
  const nextSecond = () => Math.floor((T0 + (number + 1) * 1500) / 1000);
  return { vm, call, read, nextSecond, chainId };
}

/** เซ็นด้วย ethers Wallet.signTypedData — ตัวเดียวกับที่ MetaMask eth_signTypedData_v4 ทำ */
async function ethersPermit(c, signer, { owner = signer.address, token = TOKEN, chainId = c.chainId, value = 500n, deadline, nonce } = {}) {
  const domain = { name: "Permit Coin", version: "1", chainId, verifyingContract: token };
  const message = {
    owner, spender: SPENDER, value,
    nonce: nonce ?? BigInt(String(c.read(TOKEN, "nonces", { owner: owner.toLowerCase() })).replace(/n$/, "")),
    deadline: deadline ?? BigInt(c.nextSecond() + 60),
  };
  const signature = await signer.signTypedData(domain, PERMIT_TYPES, message);
  return { input: { owner: owner.toLowerCase(), spender: SPENDER, value: `${value}n`, deadline: `${message.deadline}n`, signature }, domain, message };
}

test("permit: ลายเซ็นจาก ethers signTypedData (= MetaMask v4) ใช้ได้ · DOMAIN_SEPARATOR = hashDomain · ตัวช่วยฝั่ง JS ได้ลายเซ็นเดียวกัน", async () => {
  const c = tokenChain();
  const { input, domain, message } = await ethersPermit(c, ownerWallet);
  assert.equal(c.read(TOKEN, "DOMAIN_SEPARATOR"), TypedDataEncoder.hashDomain(domain));
  const fields = { name: "Permit Coin", chainId: c.chainId, verifyingContract: TOKEN, ...message };
  assert.equal(permitDigest(fields), TypedDataEncoder.hash(domain, PERMIT_TYPES, message));
  assert.equal(signPermit(fields, ownerWallet.privateKey), input.signature);
  // typed data ของตัวช่วย = payload ที่ส่งให้ eth_signTypedData_v4 ได้ (มี EIP712Domain) และได้ digest เดียวกัน
  const typed = permitTypedData(fields);
  assert.equal(typedDataDigest(typed.domain, typed.types, typed.primaryType, typed.message), permitDigest(fields));
  assert.deepEqual(JSON.parse(JSON.stringify(typed)), typed);

  const res = c.call(RELAYER, TOKEN, "permit", input);
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.equal(c.read(TOKEN, "allowance", { owner: OWNER, spender: SPENDER }), "500n");
  assert.equal(c.read(TOKEN, "nonces", { owner: OWNER }), "1n");
  // replay ไม่ได้
  assert.match(c.call(RELAYER, TOKEN, "permit", input).error.message, /invalid permit signature/);
  // spender ใช้วงเงินได้ · approve / transfer เดิมยังทำงาน
  assert.equal(c.call(SPENDER, TOKEN, "transferFrom", { from: OWNER, to: SPENDER, amount: "200n" }).status, "success");
  assert.equal(c.read(TOKEN, "balanceOf", { who: SPENDER }), "200n");
  assert.equal(c.call(OWNER, TOKEN, "approve", { spender: SPENDER, amount: "1n" }).status, "success");
  assert.equal(c.read(TOKEN, "allowance", { owner: OWNER, spender: SPENDER }), "1n");
});

test("permit: หมดเวลา (วินาที) · chain อื่น · verifyingContract อื่น · nonce ผิด · ผู้เซ็นอื่น → ปฏิเสธ", async () => {
  const c = tokenChain();
  const now = c.nextSecond();
  const expired = await ethersPermit(c, ownerWallet, { deadline: BigInt(now - 1) });
  assert.match(c.call(RELAYER, TOKEN, "permit", expired.input).error.message, /permit expired/);
  // deadline เป็นมิลลิวินาทีโดยไม่ตั้งใจ = อนาคตไกลมาก (ไม่หมดอายุ) — ระบบใช้วินาทีแบบ EIP-2612
  const rejected = [
    await ethersPermit(c, ownerWallet, { chainId: 1 }),
    await ethersPermit(c, ownerWallet, { token: OTHER_TOKEN }),
    await ethersPermit(c, ownerWallet, { nonce: 5n }),
    await ethersPermit(c, new Wallet(`0x${"33".repeat(32)}`), { owner: ownerWallet.address }),
  ];
  for (const { input } of rejected) assert.match(c.call(RELAYER, TOKEN, "permit", input).error.message, /invalid permit signature/);
  assert.equal(c.read(TOKEN, "nonces", { owner: OWNER }), "0n");
  // deadline = วินาทีของ block พอดี → ยังใช้ได้
  const exact = await ethersPermit(c, ownerWallet, { deadline: BigInt(c.nextSecond()) });
  assert.equal(c.call(RELAYER, TOKEN, "permit", exact.input).status, "success");
});

test("ERC-1271: isValidSignature รับ digest 32 byte · permit ของกระเป๋าโปรแกรมที่เจ้าของเซ็นด้วย signTypedData", async () => {
  const c = tokenChain();
  const digest = keccak256("0xabcdef");
  assert.equal(c.read(WALLET, "isValidSignature", { hash: digest, signature: walletOwner.signingKey.sign(digest).serialized }), ERC1271_MAGIC_VALUE);
  assert.equal(c.read(WALLET, "isValidSignature", { hash: digest, signature: signWalletHash(digest, walletOwner.privateKey) }), ERC1271_MAGIC_VALUE);
  assert.equal(c.read(WALLET, "isValidSignature", { hash: digest, signature: ownerWallet.signingKey.sign(digest).serialized }), ERC1271_INVALID_VALUE);
  // ไม่ใช่ digest 32 byte → ใช้ไม่ได้ (ไม่ hash ข้อความให้อีกแล้ว)
  assert.equal(c.read(WALLET, "isValidSignature", { hash: "hello", signature: walletOwner.signingKey.sign(digest).serialized }), ERC1271_INVALID_VALUE);

  // เจ้าของกระเป๋าเซ็น permit ที่ owner = กระเป๋าโปรแกรม ด้วย signTypedData (MetaMask) → token ถาม isValidSignature แบบ staticcall
  const { input } = await ethersPermit(c, walletOwner, { owner: WALLET, value: 42n });
  const res = c.call(RELAYER, TOKEN, "permit", input);
  assert.equal(res.status, "success", JSON.stringify(res.error));
  const check = res.calls.find((entry) => entry.functionName === "isValidSignature");
  assert.equal(check.type, "staticcall");
  assert.equal(c.read(TOKEN, "allowance", { owner: WALLET, spender: SPENDER }), "42n");
  // คนอื่นเซ็นแทนเจ้าของกระเป๋า → ปฏิเสธ
  const other = await ethersPermit(c, ownerWallet, { owner: WALLET });
  assert.match(c.call(RELAYER, TOKEN, "permit", other.input).error.message, /invalid permit signature/);
  assert.equal(getBytes(input.signature).length, 65);
});
