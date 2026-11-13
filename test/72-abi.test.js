import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { programAbi } from "../src/node/explorer-api.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * metadata.abi: description of a program's functions / events (optional)
 *   { functions: [{ name, inputs: [{ name, type }], outputs, readonly?, payable?, description? }], events: [{ name, fields: [{ name, type, indexed? }] }] }
 *   sent at deploy or via setMetadata("abi", ...) in the program · checked by checkAbi · the explorer builds forms / decodes events · /evm returns it as a JSON ABI
 */

const OWNER = "0x00000000000000000000000000000000000000a1";
const P = "0x00000000000000000000000000000000000000e1";
const as = (who) => ({ sender: who, origin: who });

const ABI = {
  functions: [
    { name: "set", inputs: [{ name: "value", type: "uint" }, { name: "to", type: "address" }], description: "set the value" },
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

test("checkAbi: a valid ABI passes · schema errors → INVALID_REQUEST naming the bad spot", () => {
  assert.equal(VM.checkAbi(ABI), ABI);
  assert.deepEqual(VM.checkAbi({}), {});
  const field = (extra) => ({ functions: [{ name: "f", inputs: [{ name: "a", type: "uint", ...extra }] }] });
  for (const [abi, message] of [
    [[], /must be an object/],
    [{ functions: [], extra: 1 }, /unknown 'extra'/],
    [{ functions: {} }, /functions must be an array/],
    [{ functions: [{ name: "1bad" }] }, /functions\[0\]\.name is invalid/],
    [{ functions: [{ name: "f" }, { name: "f" }] }, /function 'f' is duplicated/],
    [{ functions: [{ name: "f", readonly: true, payable: true }] }, /readonly and payable/],
    [{ functions: [{ name: "f", readonly: "yes" }] }, /readonly must be true/],
    [field({ type: "uint8" }), /type must be one of/],
    [field({ indexed: true }), /unknown 'indexed'/],              // indexed is allowed only on event fields
    [{ functions: [{ name: "f", inputs: [{ name: "a", type: "uint" }, { name: "a", type: "bool" }] }] }, /'a' is duplicated/],
    [{ functions: [{ name: "f", description: "x".repeat(201) }] }, /description/],
    [{ functions: Array.from({ length: 65 }, (_, i) => ({ name: `f${i}` })) }, /at most 64/],
    [{ events: [{ name: "E", fields: [1, 2, 3, 4].map((i) => ({ name: `a${i}`, type: "uint", indexed: true })) }] }, /at most 3 indexed/],
    [{ events: [{ name: "E" }, { name: "E" }] }, /event 'E' is duplicated/],
    [{ events: [{ name: "E", fields: [{ name: "a", type: "uint", indexed: 1 }] }] }, /indexed must be true/],
    [{ functions: [{ name: "f", description: "x".repeat(199) }], events: Array.from({ length: 30 }, (_, i) => ({ name: `E${i}`, description: "y".repeat(199), fields: ["a", "b", "c"].map((name) => ({ name, type: "string", description: "z".repeat(199) })) })) }, /larger than/],
  ]) {
    assert.throws(() => VM.checkAbi(abi), (error) => error.code === "INVALID_REQUEST" && message.test(error.message), JSON.stringify(abi).slice(0, 80));
  }
});

test("deploy with metadata.abi: stored · invalid schema / declaring non-exported functions → rejected", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const bad = vm.deploy({ programUuid: P, code: CODE, context: as(OWNER), metadata: { abi: { functions: [{ name: "nope" }] } } });
  assert.equal(bad.error.code, "INVALID_REQUEST");
  assert.match(bad.error.message, /function 'nope' is not exported/);
  assert.match(vm.deploy({ programUuid: P, code: CODE, context: as(OWNER), metadata: { abi: { functions: "x" } } }).error.message, /invalid metadata\.abi/);

  save(vm, vm.deploy({ programUuid: P, code: CODE, context: as(OWNER), metadata: { abi: ABI } }));
  save(vm, vm.init({ programUuid: P }));
  assert.deepEqual(vm.getMetadata(P).abi, ABI);
  assert.deepEqual(programAbi(vm, P).abi, ABI);
});

test("setMetadata(\"abi\") from inside a program: same schema check · null = remove", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  save(vm, vm.deploy({ programUuid: P, code: CODE, context: as(OWNER) }));
  save(vm, vm.init({ programUuid: P }));
  assert.equal(programAbi(vm, P).abi, null);
  const publish = (abi) => vm.call({ programUuid: P, functionName: "publish", input: { abi }, context: as(OWNER) });
  const wrong = publish({ events: [{ name: "E", fields: [{ name: "x", type: "money" }] }] });
  assert.equal(wrong.status, "throw");
  assert.match(wrong.error.message, /invalid metadata\.abi/);
  save(vm, publish(ABI));
  assert.deepEqual(vm.getMetadata(P).abi, ABI);
  save(vm, publish(null));
  assert.equal(vm.getMetadata(P).abi, undefined);
});

test("toEvmAbi / programAbi / cardianal_getAbi: convert to an Ethereum JSON ABI", () => {
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
  // an indexed event matching the ABI → topic0 = keccak("Set(address,uint256)"), as EVM tools compute it
  const res = vm.call({ programUuid: P, functionName: "set", input: { to: OWNER, value: "9n" }, context: as(OWNER) });
  assert.equal(VM.eventLog(res.events[0]).topics[0], VM.keccak256Hex("Set(address,uint256)"));
});
