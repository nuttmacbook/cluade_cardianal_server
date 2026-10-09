import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { MULTISEND_PROGRAM, CHAIN_PROGRAM, ROUTER_PROGRAM } from "../scripts/scenario-programs.js";
import { reviewProgram } from "../src/core/autoreview.js";

/* โปรแกรมของ scripts/scenario.js: แจก native หลายกระเป๋า · เรียกต่อกัน 6 ทอด · ส่งต่อ token + native หลายทอด */

const OWNER = "0x00000000000000000000000000000000000000a1";
const USER = "0x00000000000000000000000000000000000000b2";
const RECEIVER = "0x00000000000000000000000000000000000000c3";
const T = "0x00000000000000000000000000000000000000f1";
const SEND = "0x00000000000000000000000000000000000000f2";
const CHAIN = ["a", "b", "c", "d", "e", "f"].map((label, i) => ({ label, address: `0x00000000000000000000000000000000000000d${i}` }));
const ROUTERS = [0, 1, 2, 3].map((i) => `0x00000000000000000000000000000000000000e${i}`);

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { bigintValues: true, recordBlocks: true, chargeGas: true });
  vm.applyGenesis({ balances: { [OWNER]: 10_000_000, [USER]: 1_000_000 } });
  let number = 0;
  const as = (who) => ({ sender: who, origin: who });
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: number * 1000, feeRecipient: OWNER });
    const result = fn(b);
    b.commit();
    return result;
  };
  const deploy = (programUuid, code, initInput) => block((b) => [
    b.deploy({ programUuid, code, context: as(OWNER), initInput }), b.init({ programUuid, context: as(OWNER) }),
  ]).forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  deploy(T, TOKEN_PROGRAM, { name: "Test", ticker: "TEST", decimals: "6n", supply: "1000000000000n" });
  deploy(SEND, MULTISEND_PROGRAM, { name: "multisend" });
  CHAIN.forEach(({ label, address }) => deploy(address, CHAIN_PROGRAM, { label, name: `chain-${label}`, probe: ["c", "e"].includes(label) ? T : "", catch: label === "d" }));
  ROUTERS.forEach((address, i) => deploy(address, ROUTER_PROGRAM, { name: `router-${i + 1}` }));
  const call = (who, programUuid, functionName, input, value = 0) => block((b) => b.call({ programUuid, functionName, input, value, context: as(who) }));
  return { vm, call };
}

test("โปรแกรมของ scenario ผ่าน autoreview (deploy ผ่าน /sendtx ได้)", () => {
  for (const code of [MULTISEND_PROGRAM, CHAIN_PROGRAM, ROUTER_PROGRAM]) assert.deepEqual(reviewProgram(code).issues, []);
});

test("multiSend: แจก native หลายกระเป๋าใน tx เดียว · value ต้องเท่าผลรวม", () => {
  const { vm, call } = chain();
  const recipients = Array.from({ length: 100 }, (_, i) => ({ to: `0x${(0xb000 + i).toString(16).padStart(40, "0")}`, amount: "3000n" }));
  const ok = call(OWNER, SEND, "multiSend", { recipients }, 300_000);
  assert.equal(ok.status, "success", JSON.stringify(ok.error));
  assert.deepEqual(ok.result, { count: "100n", total: "300000n" });
  assert.equal(vm.nativeBalanceOf(recipients[99].to).balance, 3000);
  assert.equal(call(OWNER, SEND, "multiSend", { recipients }, 1).status, "throw");
});

test("step: เรียกต่อกัน 6 ทอด A→F · C / E แวะอ่าน balanceOf · trace มี input / result ทุกชั้น", () => {
  const { call } = chain();
  const [a, ...rest] = CHAIN.map((c) => c.address);
  const res = call(USER, a, "step", { path: rest, depth: "0n", note: "hello" });
  assert.equal(res.status, "success", JSON.stringify(res.error));
  assert.deepEqual(res.calls.map((c) => `${c.depth}:${c.functionName}`),
    ["0:step", "1:step", "2:step", "3:balanceOf", "3:step", "4:step", "5:balanceOf", "5:step"]);
  assert.equal(res.calls.filter((c) => c.functionName === "step").length, 6);
  assert.equal(res.calls.filter((c) => c.functionName === "balanceOf").length, 2);
  assert.equal(Math.max(...res.calls.map((c) => c.depth)), 5);
  let node = res.result;
  for (const label of ["a", "b", "c", "d", "e", "f"]) { assert.equal(node.label, label); node = node.next; }
  assert.equal(res.events.length, 6);
});

test("step: ชั้น F ล้ม → D catch ไว้ tx ยังสำเร็จ · ชั้น B ล้ม → ทั้ง tx ล้ม", () => {
  const { call } = chain();
  const [a, ...rest] = CHAIN.map((c) => c.address);
  const caught = call(USER, a, "step", { path: rest, depth: "0n", failAt: "f" });
  assert.equal(caught.status, "success", JSON.stringify(caught.error));
  assert.deepEqual(caught.result.next.next.next.next, { caught: "requested failure at f" });
  assert.ok(caught.calls.some((c) => c.status === "throw"));
  const failed = call(USER, a, "step", { path: rest, depth: "0n", failAt: "b" });
  assert.equal(failed.status, "throw");
});

test("forward: token + native ผ่าน router 4 ทอด หักทอดละ 1% · ผู้รับได้ทั้งคู่", () => {
  const { vm, call } = chain();
  assert.equal(call(OWNER, T, "transfer", { to: USER, amount: "1000000000n" }).status, "success");
  assert.equal(call(USER, T, "approve", { spender: ROUTERS[0], amount: "1000000000n" }).status, "success");
  const res = call(USER, ROUTERS[0], "forward", { token: T, path: ROUTERS.slice(1), to: RECEIVER, amount: "100000000n", pull: true }, 2_500);
  assert.equal(res.status, "success", JSON.stringify(res.error));
  // 100,000,000 → ×0.99 สี่ครั้ง
  let out = 100_000_000n;
  for (let i = 0; i < 4; i += 1) out -= out / 100n;
  assert.deepEqual(res.result, { delivered: `${out}n`, value: "2500n", to: RECEIVER });
  assert.equal(vm.query({ programUuid: T, functionName: "balanceOf", input: { who: RECEIVER } }).result, `${out}n`);
  assert.equal(vm.nativeBalanceOf(RECEIVER).balance, 2500);
  assert.equal(res.events.filter((e) => e.name === "Transfer").length, 5);   // ดึงเข้า + 3 ทอด + ส่งออก
  assert.equal(Math.max(...res.calls.map((c) => c.depth)), 4);
});
