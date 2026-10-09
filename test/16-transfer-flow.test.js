import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN } from "./programs.js";

/*
 * ข้อมูล block ของโปรแกรมที่เรียก transfer ของโปรแกรมอื่นหลายอัน และเรียกต่อกันสลับไปมา
 * ใช้เป็นตัวอย่างข้อมูลสำหรับทำ explorer แสดงเส้นทางการโอนเงิน
 *
 *   swap    : ดึง tokenA จาก trader เข้าตัวเอง แล้วจ่าย tokenB ของตัวเองคืน (เรียก 2 โปรแกรม)
 *   router  : เรียก swap ต่อกันหลายทอด (router → swap → token สลับกันไปมา)
 *   payroll : โอนให้หลายคนด้วย token เดียว (เรียกโปรแกรมเดียวซ้ำหลายครั้ง)
 */

const SWAP = `
function program() {
  function initialization(params) {
    writeDB("self", params.input.self)
    writeDB("tokenIn", params.input.tokenIn)
    writeDB("tokenOut", params.input.tokenOut)
    writeDB("rate", params.input.rate)
  }

  function swap(params) {
    const trader = params.context.origin
    const amountIn = params.input.amount
    const amountOut = amountIn * readDB("rate")

    runProgram(readDB("tokenIn"), "transferFrom", { from: trader, to: readDB("self"), amount: amountIn })
    runProgram(readDB("tokenOut"), "transfer", { to: trader, amount: amountOut })

    writeDB("volumeIn", (readDB("volumeIn") || 0) + amountIn)
    return amountOut
  }
  return { swap }
}
`;

const ROUTER = `
function program() {
  function route(params) {
    let amount = params.input.amount
    for (const hop of params.input.path) amount = runProgram(hop, "swap", { amount })
    writeDB(map("routed", params.context.origin), amount)
    return amount
  }

  function routeSafe(params) {
    try {
      return route(params)
    } catch (e) {
      writeDB(map("failed", params.context.origin), e.message)
      return null
    }
  }
  return { route, routeSafe }
}
`;

const PAYROLL = `
function program() {
  function initialization(params) {
    writeDB("token", params.input.token)
  }

  function pay(params) {
    let total = 0
    for (const item of params.input.items) {
      runProgram(readDB("token"), "transferFrom", { from: params.context.origin, to: item.to, amount: item.amount })
      total = total + item.amount
    }
    writeDB("paid", (readDB("paid") || 0) + total)
    return total
  }

  function paySafe(params) {
    let paid = 0
    const failed = []
    for (const item of params.input.items) {
      try {
        runProgram(readDB("token"), "transferFrom", { from: params.context.origin, to: item.to, amount: item.amount })
        paid = paid + item.amount
      } catch (e) {
        failed.push(item.to)
      }
    }
    writeDB("paid", (readDB("paid") || 0) + paid)
    if (failed.length > 0) writeDB("lastFailed", failed)
    return { paid, failed }
  }
  return { pay, paySafe }
}
`;

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const bal = (token, account) => `${token}:storage:balances:${account}`;

let endpointCounter = 0;

/**
 * โลกตัวอย่าง: tokenA / tokenB / tokenC, swap 2 ตัว (A→B, B→C), router, payroll
 * alice มี tokenA 1000 และ approve ให้ทุกโปรแกรมแล้ว
 */
function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const block = vm.createBlock({ timestamp: T - 1000 });

  for (const [id, holder] of [["tokena", "alice"], ["tokenb", "swapab"], ["tokenc", "swapbc"]]) {
    block.deploy({ programUuid: id, code: TOKEN, context: user(holder), initInput: { supply: 1000 } });
    block.init({ programUuid: id });
  }
  block.deploy({ programUuid: "swapab", code: SWAP, context: user("owner"), initInput: { self: "swapab", tokenIn: "tokena", tokenOut: "tokenb", rate: 2 } });
  block.init({ programUuid: "swapab" });
  block.deploy({ programUuid: "swapbc", code: SWAP, context: user("owner"), initInput: { self: "swapbc", tokenIn: "tokenb", tokenOut: "tokenc", rate: 3 } });
  block.init({ programUuid: "swapbc" });
  block.deploy({ programUuid: "router", code: ROUTER, context: user("owner") });
  block.init({ programUuid: "router" });
  block.deploy({ programUuid: "payroll", code: PAYROLL, context: user("owner"), initInput: { token: "tokena" } });
  block.init({ programUuid: "payroll" });

  for (const [token, spender] of [["tokena", "swapab"], ["tokenb", "swapbc"], ["tokena", "payroll"]]) {
    block.call({ programUuid: token, functionName: "approve", input: { spender, amount: 100000 }, context: user("alice") });
  }
  assert.ok(block.results().every((r) => r.status === "success"), "setup ต้องสำเร็จทั้งหมด");
  block.commit();
  return vm;
}

const swapTx = (swapId, amount, sender = "alice") => ({ programUuid: swapId, functionName: "swap", input: { amount }, context: user(sender) });
const routeTx = (path, amount, fn = "route") => ({ programUuid: "router", functionName: fn, input: { path, amount }, context: user("alice") });
const payTx = (items, fn = "pay") => ({ programUuid: "payroll", functionName: fn, input: { items }, context: user("alice") });

/** สรุป trace ให้อ่านง่าย: "depth program.fn (sender→origin) status" */
const trace = (result) => result.calls.map((c) => `${c.depth} ${c.programUuid}.${c.functionName} (${c.sender}→${c.origin}) ${c.status}`);

/** เส้นทางการโอนของ token หนึ่ง: คำนวณจาก afterValues (ยอดก่อน → ยอดหลัง) */
function balanceDeltas(summary, token) {
  return summary.afterValues
    .filter((v) => v.dbKey.startsWith(`${token}:storage:balances:`))
    .map((v) => ({ account: v.dbKey.split(":").pop(), after: v.afterValue ?? 0 }));
}

// ---------------------------------------------------------------------------
//  1 tx: เรียก transfer ของ 2 โปรแกรมในการทำงานเดียว
// ---------------------------------------------------------------------------

test("swap: tx เดียวเรียก tokenA.transferFrom และ tokenB.transfer", () => {
  const vm = setup();
  const res = vm.call(swapTx("swapab", 100), { timestamp: T });

  assert.equal(res.status, "success");
  assert.equal(res.result, 200);
  assert.deepEqual(trace(res), [
    "0 swapab.swap (alice→alice) success",
    "1 tokena.transferFrom (swapab→alice) success",
    "1 tokenb.transfer (swapab→alice) success",
  ]);
  assert.deepEqual(res.writes.map((w) => `${w.dbKey} = ${w.value}`), [
    "tokena:storage:allowance:alice:swapab = 99900",
    "tokena:storage:balances:alice = 900",
    "tokena:storage:balances:swapab = 100",
    "tokenb:storage:balances:swapab = 800",
    "tokenb:storage:balances:alice = 200",
    "swapab:storage:volumeIn = 100",
  ]);
});

// ---------------------------------------------------------------------------
//  เรียกต่อกันสลับไปมา: router → swap → token
// ---------------------------------------------------------------------------

test("router: 2 ทอด (A→B→C) สลับ router / swap / token ครบทุกชั้น", () => {
  const vm = setup();
  const res = vm.call(routeTx(["swapab", "swapbc"], 50), { timestamp: T });

  assert.equal(res.result, 300); // 50 × 2 × 3
  assert.deepEqual(trace(res), [
    "0 router.route (alice→alice) success",
    "1 swapab.swap (router→alice) success",
    "2 tokena.transferFrom (swapab→alice) success",
    "2 tokenb.transfer (swapab→alice) success",
    "1 swapbc.swap (router→alice) success",
    "2 tokenb.transferFrom (swapbc→alice) success",
    "2 tokenc.transfer (swapbc→alice) success",
  ]);

  // ยอดสุทธิของแต่ละ token หลัง tx
  assert.deepEqual(balanceDeltas(res, "tokena"), [{ account: "alice", after: 950 }, { account: "swapab", after: 50 }]);
  assert.deepEqual(balanceDeltas(res, "tokenb"), [{ account: "swapab", after: 900 }, { account: "alice", after: 0 }, { account: "swapbc", after: 100 }]);
  assert.deepEqual(balanceDeltas(res, "tokenc"), [{ account: "swapbc", after: 700 }, { account: "alice", after: 300 }]);
  // alice ได้ tokenB มา 100 แล้วจ่ายออกทั้งหมดใน tx เดียวกัน → เหลือ 0 (เดิมไม่มี key จึงนับว่า changed)
  assert.deepEqual(res.afterValues.find((v) => v.dbKey === bal("tokenb", "alice")), { dbKey: bal("tokenb", "alice"), afterValue: 0, changed: true });
});

test("router: ทอดที่สองล้ม ไม่มีใคร catch → ทั้ง tx ล้ม ไม่มีอะไรเปลี่ยน", () => {
  const vm = setup();
  const res = vm.call(routeTx(["swapab", "swapbc"], 300), { timestamp: T }); // ทอดแรกผ่าน แต่ swapbc มี tokenC ไม่พอ (300×2×3 = 1800)

  assert.equal(res.status, "throw");
  assert.deepEqual(res.error, { code: "PROGRAM_ERROR", message: "ยอดไม่พอ" });
  assert.deepEqual(trace(res), [
    "0 router.route (alice→alice) throw",
    "1 swapab.swap (router→alice) success",
    "2 tokena.transferFrom (swapab→alice) success",
    "2 tokenb.transfer (swapab→alice) success",
    "1 swapbc.swap (router→alice) throw",
    "2 tokenb.transferFrom (swapbc→alice) success",
    "2 tokenc.transfer (swapbc→alice) throw",
  ]);
  assert.deepEqual(res.writes, []);
});

test("router: ทอดที่สองล้มแต่ router catch → เก็บเฉพาะผลของทอดแรก", () => {
  const vm = setup();
  const res = vm.call(routeTx(["swapab", "swapbc"], 300, "routeSafe"), { timestamp: T });

  assert.equal(res.status, "success");
  assert.equal(res.result, null);
  assert.deepEqual(trace(res), [
    "0 router.routeSafe (alice→alice) success",
    "1 swapab.swap (router→alice) success",
    "2 tokena.transferFrom (swapab→alice) success",
    "2 tokenb.transfer (swapab→alice) success",
    "1 swapbc.swap (router→alice) throw",
    "2 tokenb.transferFrom (swapbc→alice) success",
    "2 tokenc.transfer (swapbc→alice) throw",
  ]);
  // ทั้งกิ่งของ swapbc ถูกย้อน เหลือเฉพาะ swapab + log ของ router
  assert.deepEqual(res.writes.map((w) => w.dbKey), [
    "tokena:storage:allowance:alice:swapab",
    "tokena:storage:balances:alice",
    "tokena:storage:balances:swapab",
    "tokenb:storage:balances:swapab",
    "tokenb:storage:balances:alice",
    "swapab:storage:volumeIn",
    "router:storage:failed:alice",
  ]);
  assert.equal(res.afterValues.some((v) => v.dbKey.startsWith("tokenc:storage:balances:alice")), false);
});

// ---------------------------------------------------------------------------
//  เรียกโปรแกรมเดียวซ้ำหลายครั้งใน tx เดียว
// ---------------------------------------------------------------------------

test("payroll: โอนให้หลายคนใน tx เดียว (เรียก tokenA.transferFrom 3 ครั้งเรียงกัน)", () => {
  const vm = setup();
  const items = [{ to: "bob", amount: 10 }, { to: "carol", amount: 20 }, { to: "dave", amount: 30 }];
  const res = vm.call(payTx(items), { timestamp: T });

  assert.equal(res.result, 60);
  assert.deepEqual(trace(res), [
    "0 payroll.pay (alice→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
  ]);
  assert.deepEqual(balanceDeltas(res, "tokena"), [
    { account: "alice", after: 940 },
    { account: "bob", after: 10 },
    { account: "carol", after: 20 },
    { account: "dave", after: 30 },
  ]);
});

test("payroll: บางรายการล้มแต่ catch ไว้ → เฉพาะรายการที่ล้มถูกย้อน", () => {
  const vm = setup();
  const items = [{ to: "bob", amount: 10 }, { to: "carol", amount: 99999 }, { to: "dave", amount: 30 }];
  const res = vm.call(payTx(items, "paySafe"), { timestamp: T });

  assert.deepEqual(res.result, { paid: 40, failed: ["carol"] });
  assert.deepEqual(trace(res), [
    "0 payroll.paySafe (alice→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
    "1 tokena.transferFrom (payroll→alice) throw",
    "1 tokena.transferFrom (payroll→alice) success",
  ]);
  // carol ไม่ถูกแตะเลย เพราะ token ตรวจยอดไม่พอก่อนเขียน → ไม่มีใน afterValues
  assert.equal(res.afterValues.some((v) => v.dbKey === bal("tokena", "carol")), false);
  assert.deepEqual(balanceDeltas(res, "tokena"), [
    { account: "alice", after: 960 },
    { account: "bob", after: 10 },
    { account: "dave", after: 30 },
  ]);
  assert.deepEqual(res.writes.at(-1), { type: "put", dbKey: "payroll:storage:lastFailed", value: ["carol"] });
});

// ---------------------------------------------------------------------------
//  ข้อมูลระดับ block
// ---------------------------------------------------------------------------

test("block: หลาย tx ผสมกัน — ข้อมูลของ block ใช้สร้างภาพรวมการโอนได้", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(swapTx("swapab", 100));                                    // tx0 สำเร็จ
  block.call(routeTx(["swapab", "swapbc"], 50));                        // tx1 สำเร็จ
  block.call(payTx([{ to: "bob", amount: 10 }, { to: "carol", amount: 20 }])); // tx2 สำเร็จ
  block.call(routeTx(["swapab", "swapbc"], 300));                       // tx3 ล้มทั้ง tx
  block.call(swapTx("swapbc", 150));                                    // tx4 alice ใช้ tokenB ที่ได้มาใน block นี้

  const summary = block.summary();
  assert.deepEqual(summary.results.map((r) => r.status), ["success", "success", "success", "throw", "success"]);

  // จำนวนครั้งที่แต่ละโปรแกรมถูกเรียกทั้ง block (ใช้ทำหน้า "โปรแกรมที่ถูกเรียกมากที่สุด")
  const callCount = {};
  for (const result of summary.results) {
    for (const call of result.calls) callCount[`${call.programUuid}.${call.functionName}`] = (callCount[`${call.programUuid}.${call.functionName}`] ?? 0) + 1;
  }
  assert.deepEqual(callCount, {
    "swapab.swap": 3,
    "swapbc.swap": 3,
    "router.route": 2,
    "payroll.pay": 1,
    "tokena.transferFrom": 5,
    "tokenb.transfer": 3,
    "tokenb.transferFrom": 3,
    "tokenc.transfer": 3,
  });

  // ยอดสุทธิของทั้ง block (ก่อน block → หลัง block)
  const net = Object.fromEntries(summary.afterValues
    .filter((v) => v.dbKey.includes(":balances:"))
    .map((v) => [v.dbKey.replace(":storage:balances", ""), v.afterValue]));
  assert.deepEqual(net, {
    "tokena:alice": 820,
    "tokena:swapab": 150,
    "tokena:bob": 10,
    "tokena:carol": 20,
    "tokenb:swapab": 700,
    "tokenb:alice": 50,
    "tokenb:swapbc": 250,
    "tokenc:swapbc": 250,
    "tokenc:alice": 750,
  });

  // ยอดรวมของแต่ละ token ต้องคงที่ 1000 เสมอ
  for (const token of ["tokena", "tokenb", "tokenc"]) {
    const total = summary.afterValues
      .filter((v) => v.dbKey.startsWith(`${token}:storage:balances:`))
      .reduce((sum, v) => sum + v.afterValue, 0);
    assert.equal(total, 1000, token);
  }

  block.commit();
  for (const { dbKey, afterValue } of summary.afterValues) assert.deepEqual(vm.db.readKeys([dbKey])[0], afterValue, dbKey);
});

test("block: tx ที่ล้มไม่ปรากฏในข้อมูลรวมของ block แต่ยังมี trace ให้ explorer แสดง", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(routeTx(["swapab", "swapbc"], 300)); // ล้ม
  block.call(swapTx("swapab", 10));               // สำเร็จ

  const summary = block.summary();
  assert.deepEqual(summary.loadValues.map((v) => v.dbKey).filter((k) => k.startsWith("tokenc")), []);
  assert.deepEqual(summary.writes.map((w) => w.dbKey).filter((k) => k.startsWith("tokenc")), []);
  assert.equal(summary.results[0].calls.length, 7); // trace ของ tx ที่ล้มยังครบ
  assert.equal(summary.results[0].calls.filter((c) => c.status === "throw").length, 3);
});

test("block เท่ากับรันทีละ tx แล้ว commit ทีละอัน (สถานการณ์ผสม)", () => {
  const txs = [
    swapTx("swapab", 100),
    routeTx(["swapab", "swapbc"], 50),
    payTx([{ to: "bob", amount: 10 }, { to: "carol", amount: 99999 }], "paySafe"),
    routeTx(["swapab", "swapbc"], 300),
    routeTx(["swapab", "swapbc"], 300, "routeSafe"),
    swapTx("swapbc", 150),
  ];

  const blockVm = setup();
  const block = blockVm.createBlock({ timestamp: T });
  for (const tx of txs) block.call(tx);

  const seqVm = setup();
  const sequential = txs.map((tx) => {
    const res = seqVm.call(tx, { timestamp: T });
    if (res.status === "success") seqVm.commit(res.writes);
    return res;
  });

  assert.deepEqual(block.results(), sequential);
  block.commit();
  assert.deepEqual(blockVm.db.snapshot(), seqVm.db.snapshot());
});

// ---------------------------------------------------------------------------
//  ข้อจำกัดของข้อมูลสำหรับ explorer
// ---------------------------------------------------------------------------

test("calls มี input / value / result / gasUsed ของการเรียกซ้อนทุกชั้น — เห็นจำนวนเงินของแต่ละเส้น", () => {
  const vm = setup();
  const res = vm.call(routeTx(["swapab", "swapbc"], 50), { timestamp: T });

  assert.deepEqual(Object.keys(res.calls[1]), ["depth", "programUuid", "functionName", "sender", "origin", "input", "value", "gasStart", "status", "result", "gasUsed"]);
  for (const call of res.calls) {
    assert.equal(typeof call.input, "object");
    assert.notEqual(call.result, undefined);
    assert.ok(call.gasUsed > 0);
  }
  // gas ของชั้นนอกรวมของชั้นในไว้แล้ว
  assert.ok(res.calls[0].gasUsed >= res.calls[1].gasUsed + res.calls[2].gasUsed);
  assert.ok(res.calls[0].gasUsed <= res.gasUsed);
  assert.equal(res.result, 300);
});
