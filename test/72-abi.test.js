import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { programAbi } from "../src/node/explorer-api.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * metadata.abi: คำอธิบายฟังก์ชัน / event ของโปรแกรม (ไม่บังคับ)
 *   { functions: [{ name, inputs: [{ name, type }], outputs, readonly?, payable?, description? }], events: [{ name, fields: [{ name, type, indexed? }] }] }
 *   ส่งตอน deploy หรือ setMetadata("abi", ...) ในโปรแกรม · ตรวจด้วย checkAbi · explorer สร้างฟอร์ม / อ่าน event · /evm คืนเป็น JSON ABI
 */

const OWNER = "0x00000000000000000000000000000000000000a1";
const P = "0x00000000000000000000000000000000000000e1";
const as = (who) => ({ sender: who, origin: who });

const ABI = {
  functions: [
    { name: "set", inputs: [{ name: "value", type: "uint" }, { name: "to", type: "address" }], description: "ตั้งค่า" },
    { name: "get", inputs: [], outputs: [{ type: "uint" }], readonly: true },
    { name: "fund", payable: true },
  ],
  events: [{ name: "Set", fields: [{ name: "to", type: "address", indexed: true }, { name: "value", type: "uint" }] }],
};

const CODE = `function program() {
  function set(params) { emit("Set", { to: params.input.to, value: params.input.value }, { indexed: ["to"] }); return true }
  function get() { return 1n }
  function fund() { return true }
  function publish(params) { setMetadata("abi", params.input.abi); return true }
  return { set, get, fund, publish }
}`;

const save = (vm, res) => {
  assert.equal(res.status, "success", JSON.stringify(res.error));
  vm.commit(res.writes);
  return res;
};

test("checkAbi: ABI ที่ถูกต้องผ่าน · ผิด schema → INVALID_REQUEST พร้อมบอกจุดที่ผิด", () => {
  assert.equal(VM.checkAbi(ABI), ABI);
  assert.deepEqual(VM.checkAbi({}), {});
  const field = (extra) => ({ functions: [{ name: "f", inputs: [{ name: "a", type: "uint", ...extra }] }] });
  for (const [abi, message] of [
    [[], /ต้องเป็น object/],
    [{ functions: [], extra: 1 }, /ไม่รู้จัก 'extra'/],
    [{ functions: {} }, /functions ต้องเป็น array/],
    [{ functions: [{ name: "1bad" }] }, /functions\[0\]\.name ไม่ถูกต้อง/],
    [{ functions: [{ name: "f" }, { name: "f" }] }, /ฟังก์ชัน 'f' ซ้ำ/],
    [{ functions: [{ name: "f", readonly: true, payable: true }] }, /readonly กับ payable/],
    [{ functions: [{ name: "f", readonly: "yes" }] }, /readonly ต้องเป็น true/],
    [field({ type: "uint8" }), /type ต้องเป็นหนึ่งใน/],
    [field({ indexed: true }), /ไม่รู้จัก 'indexed'/],              // indexed มีได้เฉพาะ field ของ event
    [{ functions: [{ name: "f", inputs: [{ name: "a", type: "uint" }, { name: "a", type: "bool" }] }] }, /'a' ซ้ำ/],
    [{ functions: [{ name: "f", description: "x".repeat(201) }] }, /description/],
    [{ functions: Array.from({ length: 65 }, (_, i) => ({ name: `f${i}` })) }, /ไม่เกิน 64/],
    [{ events: [{ name: "E", fields: [1, 2, 3, 4].map((i) => ({ name: `a${i}`, type: "uint", indexed: true })) }] }, /indexed ได้ไม่เกิน 3/],
    [{ events: [{ name: "E" }, { name: "E" }] }, /event 'E' ซ้ำ/],
    [{ events: [{ name: "E", fields: [{ name: "a", type: "uint", indexed: 1 }] }] }, /indexed ต้องเป็น true/],
    [{ functions: [{ name: "f", description: "x".repeat(199) }], events: Array.from({ length: 30 }, (_, i) => ({ name: `E${i}`, description: "y".repeat(199), fields: ["a", "b", "c"].map((name) => ({ name, type: "string", description: "z".repeat(199) })) })) }, /ใหญ่เกิน/],
  ]) {
    assert.throws(() => VM.checkAbi(abi), (error) => error.code === "INVALID_REQUEST" && message.test(error.message), JSON.stringify(abi).slice(0, 80));
  }
});

test("deploy พร้อม metadata.abi: เก็บไว้ · ABI ผิด schema / ประกาศฟังก์ชันที่ไม่ได้ export → ปฏิเสธ", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const bad = vm.deploy({ programUuid: P, code: CODE, context: as(OWNER), metadata: { abi: { functions: [{ name: "nope" }] } } });
  assert.equal(bad.error.code, "INVALID_REQUEST");
  assert.match(bad.error.message, /ฟังก์ชัน 'nope' ไม่ได้ export/);
  assert.match(vm.deploy({ programUuid: P, code: CODE, context: as(OWNER), metadata: { abi: { functions: "x" } } }).error.message, /metadata\.abi ไม่ถูกต้อง/);

  save(vm, vm.deploy({ programUuid: P, code: CODE, context: as(OWNER), metadata: { abi: ABI } }));
  save(vm, vm.init({ programUuid: P }));
  assert.deepEqual(vm.getMetadata(P).abi, ABI);
  assert.deepEqual(programAbi(vm, P).abi, ABI);
});

test("setMetadata(\"abi\") จากในโปรแกรม: ตรวจ schema เหมือนกัน · null = ลบ", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  save(vm, vm.deploy({ programUuid: P, code: CODE, context: as(OWNER) }));
  save(vm, vm.init({ programUuid: P }));
  assert.equal(programAbi(vm, P).abi, null);
  const publish = (abi) => vm.call({ programUuid: P, functionName: "publish", input: { abi }, context: as(OWNER) });
  const wrong = publish({ events: [{ name: "E", fields: [{ name: "x", type: "money" }] }] });
  assert.equal(wrong.status, "throw");
  assert.match(wrong.error.message, /metadata\.abi ไม่ถูกต้อง/);
  save(vm, publish(ABI));
  assert.deepEqual(vm.getMetadata(P).abi, ABI);
  save(vm, publish(null));
  assert.equal(vm.getMetadata(P).abi, undefined);
});

test("toEvmAbi / programAbi / cardianal_getAbi: แปลงเป็น JSON ABI แบบ Ethereum", () => {
  const evm = VM.toEvmAbi(ABI);
  assert.deepEqual(evm, [
    { type: "function", name: "set", inputs: [{ name: "value", type: "uint256" }, { name: "to", type: "address" }], outputs: [], stateMutability: "nonpayable" },
    { type: "function", name: "get", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
    { type: "function", name: "fund", inputs: [], outputs: [], stateMutability: "payable" },
    { type: "event", name: "Set", anonymous: false, inputs: [{ name: "to", type: "address", indexed: true }, { name: "value", type: "uint256", indexed: false }] },
  ]);
  const vm = new VM.VirtualMachine(new MemoryDB());
  save(vm, vm.deploy({ programUuid: P, code: CODE, context: as(OWNER), metadata: { abi: ABI } }));
  save(vm, vm.init({ programUuid: P }));
  assert.deepEqual(programAbi(vm, P.toUpperCase().replace("0X", "0x")), { address: P, abi: ABI, evmAbi: evm });
  const rpc = createEvmRpc({ vm });
  const ask = (address) => rpc.handle({ jsonrpc: "2.0", id: 1, method: "cardianal_getAbi", params: [address] }).result;
  assert.deepEqual(ask(P), evm);
  assert.equal(ask(OWNER), null);
  // event ที่ emit แบบ indexed ตรงกับ ABI → topic0 = keccak("Set(address,uint256)") เหมือนเครื่องมือ EVM คำนวณ
  const res = vm.call({ programUuid: P, functionName: "set", input: { to: OWNER, value: "9n" }, context: as(OWNER) });
  assert.equal(VM.eventLog(res.events[0]).topics[0], VM.keccak256Hex("Set(address,uint256)"));
});
