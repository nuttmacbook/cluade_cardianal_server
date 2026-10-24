import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { VM, MemoryDB } from "./helpers.js";
import { createEvmRpc, EVM_ERROR } from "../src/node/evm-rpc.js";
import { abiFunctions, decodeInput, encodeOutput } from "../src/node/evm-abi.js";

/*
 * ระยะ 3.2: eth_call ของโปรแกรมที่เขียนเอง ถอด / เข้ารหัสตาม metadata.abi (src/node/evm-abi.js)
 *   ฝั่ง dApp ใช้ ethers Interface จาก cardianal_getAbi ได้ตรง ๆ · ตาม block ได้ · from = context.sender
 */

const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b0";
const P = "0x00000000000000000000000000000000000000c1";
const CODE = `function program() {
  function initialization() { writeDB("count", 0n) }
  function bump(params) { writeDB("count", readDB("count") + params.input.by) }
  function count() { return readDB("count") }
  function echo(params) { const i = params.input; return [i.who, i.n, i.z, i.ok, i.text, i.raw, i.data] }
  function profile(params) { return { name: "nutt " + params.input.id, score: params.input.id * 2n, tags: ["a", 1n] } }
  function whoami(params) { return params.context.sender }
  function boom() { throw new Error("nope") }
  function nothing() {}
  return { bump, count, echo, profile, whoami, boom, nothing }
}`;
const ABI = { functions: [
  { name: "bump", inputs: [{ name: "by", type: "uint" }] },
  { name: "count", inputs: [], outputs: [{ type: "uint" }], readonly: true },
  { name: "echo", readonly: true,
    inputs: [{ name: "who", type: "address" }, { name: "n", type: "uint" }, { name: "z", type: "int" }, { name: "ok", type: "bool" },
      { name: "text", type: "string" }, { name: "raw", type: "object" }, { name: "data", type: "bytes" }],
    outputs: [{ type: "address" }, { type: "uint" }, { type: "int" }, { type: "bool" }, { type: "string" }, { type: "object" }, { type: "bytes" }] },
  { name: "profile", inputs: [{ name: "id", type: "uint" }], outputs: [{ name: "name", type: "string" }, { name: "score", type: "uint" }, { name: "tags", type: "array" }], readonly: true },
  { name: "whoami", outputs: [{ type: "address" }], readonly: true },
  { name: "boom", outputs: [{ type: "uint" }], readonly: true },
  { name: "nothing" },
] };

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, recordBlocks: true, recordTransactions: true, recordHistory: true });
  let number = 0;
  const as = { sender: OWNER, origin: OWNER };
  const block = (...requests) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: 1_700_000_000_000 + number * 1000 });
    requests.forEach(([method, request]) => assert.equal(b[method](request).status, "success"));
    b.commit();
  };
  block(["deploy", { programUuid: P, code: CODE, context: as, metadata: { abi: ABI } }], ["init", { programUuid: P }]);
  block(["call", { programUuid: P, functionName: "bump", input: { by: "5n" }, context: as }]);   // block 2
  block(["call", { programUuid: P, functionName: "bump", input: { by: "7n" }, context: as }]);   // block 3
  return { vm, rpc: createEvmRpc({ vm }) };
}
const send = (rpc, method, ...params) => rpc.handle({ jsonrpc: "2.0", id: 1, method, params });
const ask = (rpc, method, ...params) => {
  const reply = send(rpc, method, ...params);
  assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};

test("eth_call ตาม metadata.abi: ethers เข้ารหัส / ถอดได้ทุกชนิด · ตาม block · from = context.sender", () => {
  const { rpc } = chain();
  const iface = new Interface(ask(rpc, "cardianal_getAbi", P));
  const read = (fn, args = [], tag = "latest", extra = {}) =>
    iface.decodeFunctionResult(fn, ask(rpc, "eth_call", { to: P, data: iface.encodeFunctionData(fn, args), ...extra }, tag));

  assert.equal(read("count")[0], 12n);
  assert.equal(read("count", [], "0x2")[0], 5n);   // state ตอนปิด block 2

  const echoed = read("echo", [BOB, 2n ** 200n, -42n, true, "สวัสดี", '{"a":[1,"2n"]}', "0xdeadbeef"]);
  assert.equal(echoed[0].toLowerCase(), BOB);
  // object ผ่านโปรแกรมแล้วกลับเป็น JSON ตามแบบของเชน (จำนวนเต็มใน input เป็น BigInt → "1n")
  assert.deepEqual([...echoed].slice(1), [2n ** 200n, -42n, true, "สวัสดี", '{"a":["1n","2n"]}', "0xdeadbeef"]);

  const profile = read("profile", [21n]);
  assert.equal(profile.name, "nutt 21");
  assert.equal(profile.score, 42n);
  assert.deepEqual(JSON.parse(profile.tags), ["a", "1n"]);

  assert.equal(read("whoami", [], "latest", { from: BOB })[0].toLowerCase(), BOB);
  assert.equal(ask(rpc, "eth_call", { to: P, data: iface.encodeFunctionData("nothing") }, "latest"), "0x");
  assert.equal(ask(rpc, "eth_call", { to: P, data: iface.encodeFunctionData("bump", [1n]) }, "latest"), "0x");   // จำลอง ไม่เขียนจริง
  assert.equal(read("count")[0], 12n);
});

test("eth_call: selector ไม่ตรง / โปรแกรม throw / calldata สั้น / ไม่มี abi → execution reverted", () => {
  const { rpc } = chain();
  const iface = new Interface(ask(rpc, "cardianal_getAbi", P));
  const error = (data, to = P) => send(rpc, "eth_call", { to, data }, "latest").error;
  assert.match(error("0x12345678").message, /no function in metadata\.abi matches selector 0x12345678/);
  assert.match(error(iface.encodeFunctionData("boom")).message, /execution reverted: .*nope/);
  assert.match(error(iface.encodeFunctionData("bump", [1n]).slice(0, 20)).message, /bump\(uint256\): calldata สั้นเกินไป/);
  const notJson = iface.encodeFunctionData("echo", [BOB, 1n, 1n, true, "x", "{nope", "0x"]);
  assert.match(error(notJson).message, /raw: ต้องเป็น JSON/);
  assert.equal(error("0x18160ddd").code, EVM_ERROR.SERVER);
});

test("evm-abi: ถอด / เข้ารหัสตรงกับ ethers (output หลายตัว object / array · int ติดลบ · string ว่าง)", () => {
  const fns = abiFunctions(ABI);
  const echo = [...fns.values()].find((fn) => fn.name === "echo");
  assert.equal(echo.signature, "echo(address,uint256,int256,bool,string,string,bytes)");
  const iface = new Interface([`function ${echo.signature} returns (address,uint256,int256,bool,string,string,bytes)`]);
  const args = [BOB, 0n, -(2n ** 255n), false, "", "[1]", "0x"];
  assert.deepEqual(decodeInput(echo, iface.encodeFunctionData("echo", args)),
    { who: BOB, n: "0n", z: `${-(2n ** 255n)}n`, ok: false, text: "", raw: [1], data: "0x" });
  const decoded = iface.decodeFunctionResult("echo", encodeOutput(echo, [BOB, 1n, -1n, true, "", { a: 1n }, "0x00ff"]));
  assert.equal(decoded[0].toLowerCase(), BOB);
  assert.deepEqual([...decoded].slice(1), [1n, -1n, true, "", '{"a":"1n"}', "0x00ff"]);
  const profile = [...fns.values()].find((fn) => fn.name === "profile");
  assert.equal(encodeOutput(profile, { name: "a", score: 1n, tags: [] }), encodeOutput(profile, ["a", 1n, []]));
  assert.throws(() => encodeOutput([...fns.values()].find((fn) => fn.name === "count"), -1n), /เกินช่วง uint256/);
});
