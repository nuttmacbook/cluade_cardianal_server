import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, mockData, resetVM, user, save, activate } from "./helpers.js";
import { TOKEN, SHOP, PROBE, HOP, FAULTY, COUNTER } from "./programs.js";

beforeEach(resetVM);

const REPEAT = 5;

/** รันซ้ำบน DB สถานะเดิม แล้วเทียบผลลัพธ์ทั้งก้อน */
function assertDeterministic(name, run) {
  const snapshot = new Map([...mockData].map(([k, v]) => [k, structuredClone(v)]));
  const results = [];
  for (let i = 0; i < REPEAT; i++) {
    mockData.clear();
    for (const [k, v] of snapshot) mockData.set(k, structuredClone(v));
    results.push(JSON.stringify(run()));
  }
  assert.equal(new Set(results).size, 1, `${name}: ผลลัพธ์ไม่เหมือนกันทุกครั้ง`);
}

test("ผลลัพธ์ (รวม calls) เหมือนเดิมทุกครั้งในทุกกรณี", () => {
  activate("token", TOKEN, { initInput: { supply: 1000 } });
  activate("shop", SHOP, { initInput: { shopId: "shop", token: "token", price: 100 } });
  for (const id of ["A", "B", "C"]) activate(id, PROBE);
  for (const id of ["D", "E", "F", "G"]) activate(id, HOP);
  activate("faulty", FAULTY);
  activate("faulty2", FAULTY);
  save(vm.call({ programUuid: "token", functionName: "transfer", input: { to: "alice", amount: 250 }, context: user("owner") }));
  save(vm.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 1000 }, context: user("alice") }));

  const TIMESTAMP = { timestamp: 1_700_000_000_000 };
  const call = (programUuid, functionName, input, sender = "alice") => () => vm.call({ programUuid, functionName, input, context: user(sender) }, TIMESTAMP);
  const cases = {
    buySuccess: call("shop", "buy"),
    buyManyFail: call("shop", "buyMany", { qty: 5 }),
    buySafeFail: call("shop", "buySafe", {}, "bob"),
    hopFail: call("D", "hop", { path: ["D", "E", "F", "G"], failAt: "F" }),
    hopCatch: call("D", "hop", { path: ["D", "E", "F", "G"], failAt: "G", catchAt: "E" }),
    nestedRollback: call("A", "relayCatch", { target: "B", fn: "writeCallThrow", args: { target: "C" } }),
    recursionLimit: call("A", "recurse", { self: "A" }),
    recursionCatch: call("A", "recurseCatch", { self: "A" }),
    timeoutTop: call("faulty", "spin"),
    timeoutNestedCaught: call("faulty", "spinCatch", { target: "faulty2" }),
    timeoutAtInit: () => {
      mockData.set("pending:loop-init", { code: VM.toOneLine("function initialization(p) { runProgram(p.input.t, \"spin\", {}) }"), context: user("a"), initInput: { t: "faulty" } });
      return vm.init({ programUuid: "loop-init" }, TIMESTAMP);
    },
  };

  for (const [name, run] of Object.entries(cases)) assertDeterministic(name, run);
});

test("flow จริง: deploy → init → หลาย call ต่อเนื่อง ได้ DB สุดท้ายเหมือนเดิมทุกครั้ง", () => {
  const finals = [];
  for (let i = 0; i < REPEAT; i++) {
    resetVM();
    const log = [];
    const at = { timestamp: 1_700_000_000_000 }; // เวลาคงที่ เพราะ init บันทึก metadata.createdAt
    const step = (res) => { log.push(res.status); save(res); };
    step(vm.deploy({ programUuid: "token", code: TOKEN, context: user("owner"), initInput: { supply: 500 } }, at));
    step(vm.init({ programUuid: "token" }, at));
    step(vm.deploy({ programUuid: "counter", code: COUNTER, context: user("owner") }, at));
    step(vm.reject({ programUuid: "counter" }, at));
    step(vm.deploy({ programUuid: "shop", code: SHOP, context: user("owner"), initInput: { shopId: "shop", token: "token", price: 50 } }, at));
    step(vm.init({ programUuid: "shop" }, at));
    step(vm.call({ programUuid: "token", functionName: "transfer", input: { to: "alice", amount: 120 }, context: user("owner") }, at));
    step(vm.call({ programUuid: "token", functionName: "approve", input: { spender: "shop", amount: 120 }, context: user("alice") }, at));
    step(vm.call({ programUuid: "shop", functionName: "buyMany", input: { qty: 3 }, context: user("alice") }, at));
    step(vm.call({ programUuid: "shop", functionName: "buyMany", input: { qty: 2 }, context: user("alice") }, at));
    step(vm.call({ programUuid: "shop", functionName: "buySafe", context: user("alice") }, at));
    finals.push(JSON.stringify({ log, db: [...mockData].sort() }));
  }
  assert.equal(new Set(finals).size, 1);

  const { log, db } = JSON.parse(finals[0]);
  assert.deepEqual(log, ["success", "success", "success", "success", "success", "success", "success", "success", "throw", "success", "success"]);
  const data = Object.fromEntries(db);
  assert.equal(data["token:storage:balances:alice"], 20);
  assert.equal(data["token:storage:balances:shop"], 100);
  assert.equal(data["shop:storage:sales"], 2);
  assert.equal(data["shop:storage:failed:alice"], "allowance ไม่พอ");
  assert.equal(data["pending:counter"], undefined);
});
