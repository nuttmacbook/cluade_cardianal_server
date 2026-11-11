import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { VM, MemoryDB } from "./helpers.js";
import { checkAbi, codeKey, toEvmAbi } from "../src/core/virtualmachine.js";
import { exportedFunctions } from "../src/standards/token.js";
import { SYSTEM_ABIS, systemAbiOf } from "../src/standards/system-abi.js";
import { systemPrograms } from "../src/standards/system.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * ABI ของโปรแกรมแถม (src/standards/system-abi.js): node ตอบให้จากโค้ด (ไม่ได้เก็บบนเชน)
 *   ตรงกับโค้ด: ฟังก์ชันครบทุกตัวที่ export · ชื่อ input มีในโค้ด · event ตรงกับ emit ทุกจุด (ชื่อ field + ลำดับ + indexed)
 *   ใช้งานจริง: deploy ชุดเต็ม → /evm ตอบ cardianal_getAbi · eth_call ตาม ABI · log ถอดด้วย ethers ได้ · clone ได้ ABI ด้วย
 */

/** emit("Name", { a: …, b: … }, { indexed: [...] }) ทุกจุดในโค้ด → [{ name, fields, indexed }] */
function emitsOf(code) {
  const found = [];
  const pattern = /emit\(\s*"(\w+)"\s*,\s*\{/g;
  for (let match; (match = pattern.exec(code));) {
    let depth = 1;
    let i = pattern.lastIndex;
    for (; i < code.length && depth; i += 1) {
      if ("{([".includes(code[i])) depth += 1;
      else if ("})]".includes(code[i])) depth -= 1;
    }
    const body = code.slice(pattern.lastIndex, i - 1);
    // key ชั้นแรกของ object: "key:" ที่ไม่อยู่ในวงเล็บ / ternary
    const fields = [];
    let level = 0;
    for (const part of body.split(/(?=[,{}()[\]])/)) {
      for (const ch of part) { if ("{([".includes(ch)) level += 1; else if ("})]".includes(ch)) level -= 1; }
      const key = /^[,\s]*(\w+)\s*:/.exec(part.replace(/^[{}()[\]]/, ""));
      if (key && level === 0 && !fields.includes(key[1])) fields.push(key[1]);
    }
    const rest = code.slice(i, i + 200);
    const indexed = /^\s*,\s*\{\s*indexed:\s*\[([^\]]*)\]/.exec(rest)?.[1].match(/\w+/g) ?? [];
    found.push({ name: match[1], fields, indexed });
  }
  return found;
}

for (const { key, code, abi } of SYSTEM_ABIS) {
  test(`system abi ${key}: ผ่าน checkAbi · ฟังก์ชันครบตามที่ export · event ตรงกับ emit`, () => {
    checkAbi(abi);
    const functions = abi.functions ?? [];
    assert.deepEqual(functions.map((fn) => fn.name).sort(), exportedFunctions(code).sort(), "ฟังก์ชันใน ABI ต้องตรงกับที่โปรแกรม export");
    for (const fn of functions) {
      for (const input of fn.inputs ?? []) assert.match(code, new RegExp(`\\b${input.name}\\b`), `${fn.name}: ไม่มี input '${input.name}' ในโค้ด`);
    }
    const emitted = emitsOf(code);
    const events = new Map((abi.events ?? []).map((event) => [event.name, event]));
    for (const emit of emitted) {
      const event = events.get(emit.name);
      assert.ok(event, `ABI ไม่มี event ${emit.name}`);
      assert.deepEqual(event.fields.map((field) => field.name), emit.fields, `${emit.name}: ชื่อ / ลำดับ field ต้องตรงกับ emit`);
      assert.deepEqual(event.fields.filter((field) => field.indexed).map((field) => field.name), emit.indexed, `${emit.name}: indexed ต้องตรงกับ emit`);
    }
    for (const name of events.keys()) assert.ok(emitted.some((emit) => emit.name === name), `ABI มี event ${name} ที่โปรแกรมไม่ได้ emit`);
    new Interface(toEvmAbi(abi));   // ethers อ่าน ABI ได้ (ไม่มีชื่อ / signature ซ้ำ)
  });
}

const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const ALICE = "0x00000000000000000000000000000000000000a1";
const COIN = 10n ** 18n;

test("system abi: deploy ชุดเต็ม → ทุกตัวได้ ABI จากโค้ดในเชน · eth_call ตาม ABI · log ถอดด้วย ethers · clone ได้ ABI", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, requireNonce: true, recordTransactions: true, recordBlocks: true, recordHistory: true });
  vm.db.load(Object.fromEntries([DEPLOYER, ALICE].map((a) => [VM.nativeKey(a, "received"), `${1000n * COIN}n`])));
  const nonces = {};
  let time = Date.parse("2026-11-11T00:00:00Z");
  const block = (fn) => { const b = vm.createBlock({ timestamp: (time += 1000) }); const out = fn(b); b.commit(); return out; };
  const ok = (res) => { assert.equal(res.status, "success", JSON.stringify(res.error)); return res; };
  const nonce = (who) => (nonces[who] = (nonces[who] ?? -1) + 1);
  const plan = systemPrograms({ addressAt: (n) => vm.programAddressFor(DEPLOYER, n) });
  for (const item of plan) {
    block((b) => {
      ok(b.deploy({ code: item.code, context: { sender: DEPLOYER, origin: DEPLOYER }, initInput: item.input, nonce: nonce(DEPLOYER), gasLimit: 5_000_000 }));
      ok(b.init({ programUuid: item.address }));
    });
  }
  const at = Object.fromEntries(plan.map((item) => [item.key, item.address]));
  for (const { key, abi } of SYSTEM_ABIS) assert.equal(systemAbiOf(vm.read(codeKey(at[key]))), abi, key);
  for (const key of ["tokenTemplate", "nftTemplate", "multiTokenTemplate"]) assert.equal(systemAbiOf(vm.read(codeKey(at[key]))), null, key);

  const rpc = createEvmRpc({ vm });
  const call = (method, params) => {
    const res = rpc.handle({ jsonrpc: "2.0", id: 1, method, params });
    assert.equal(res.error, undefined, JSON.stringify(res.error));
    return res.result;
  };
  const iface = (address) => new Interface(call("cardianal_getAbi", [address]));
  for (const { key } of SYSTEM_ABIS) assert.ok(call("cardianal_getAbi", [at[key]]), key);

  // eth_call ตาม ABI (ethers เข้ารหัส / ถอด)
  const read = (address, fn, args = []) => {
    const contract = iface(address);
    return contract.decodeFunctionResult(fn, call("eth_call", [{ to: address, data: contract.encodeFunctionData(fn, args) }, "latest"]));
  };
  assert.equal(read(at.multicall, "getChainId")[0], 7777n);
  assert.equal(read(at.multicall, "getNativeBalance", [ALICE])[0], 1000n * COIN);
  assert.equal(read(at.factory, "count")[0], 0n);
  assert.equal(read(at.dex, "pairCount")[0], 0n);
  assert.equal(read(at.staking, "poolCount")[0], 0n);
  assert.equal(read(at.dex, "wrapped")[0].toLowerCase(), at.wcard);

  // factory.createToken + createMultisig → log Created ถอดด้วย ABI · multisig ที่ clone ได้ ABI ด้วย
  const created = block((b) => ok(b.call({ programUuid: at.factory, functionName: "createToken", context: { sender: ALICE, origin: ALICE }, nonce: nonce(ALICE),
    input: { name: "Coin", ticker: "C", decimals: "18n", supply: "1000n" }, gasLimit: 3_000_000 })));
  const multisig = block((b) => ok(b.call({ programUuid: at.factory, functionName: "createMultisig", context: { sender: ALICE, origin: ALICE }, nonce: nonce(ALICE),
    input: { owners: [ALICE], threshold: "1n" }, gasLimit: 3_000_000 }))).result;
  const receipt = call("eth_getTransactionReceipt", [vm.getBlock(vm.latestBlockNumber() - 1).txHashes[0]]);
  const factory = iface(at.factory);
  const parsed = receipt.logs.filter((log) => log.address === at.factory).map((log) => factory.parseLog(log));
  assert.deepEqual(parsed.map((log) => [log.name, log.args.kind, log.args.address.toLowerCase(), log.args.creator.toLowerCase()]),
    [["Created", "token", created.result, ALICE]]);
  assert.equal(systemAbiOf(vm.read(codeKey(multisig))), SYSTEM_ABIS.find((item) => item.key === "multisigTemplate").abi);
  assert.deepEqual(read(multisig, "owners")[0], JSON.stringify([ALICE]));
  assert.equal(read(multisig, "threshold")[0], 1n);
});
