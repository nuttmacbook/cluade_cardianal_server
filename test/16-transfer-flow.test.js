import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN } from "./programs.js";

/*
 * block data for programs that call transfer on several other programs, calling back and forth
 * serves as sample data for building an explorer view of transfer paths
 *
 *   swap    : pulls tokenA from the trader into itself, then pays out its own tokenB (calls 2 programs)
 *   router  : chains several swaps (router → swap → token, back and forth)
 *   payroll : pays many people with one token (calls one program repeatedly)
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

    writeDB("volumeIn", (readDB("volumeIn") || 0n) + amountIn)
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
    let total = 0n
    for (const item of params.input.items) {
      runProgram(readDB("token"), "transferFrom", { from: params.context.origin, to: item.to, amount: item.amount })
      total = total + item.amount
    }
    writeDB("paid", (readDB("paid") || 0n) + total)
    return total
  }

  function paySafe(params) {
    let paid = 0n
    const failed = []
    for (const item of params.input.items) {
      try {
        runProgram(readDB("token"), "transferFrom", { from: params.context.origin, to: item.to, amount: item.amount })
        paid = paid + item.amount
      } catch (e) {
        failed.push(item.to)
      }
    }
    writeDB("paid", (readDB("paid") || 0n) + paid)
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
 * sample world: tokenA / tokenB / tokenC, 2 swaps (A→B, B→C), router, payroll
 * alice holds 1000 tokenA and has approved every program
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
  assert.ok(block.results().every((r) => r.status === "success"), "setup must fully succeed");
  block.commit();
  return vm;
}

const swapTx = (swapId, amount, sender = "alice") => ({ programUuid: swapId, functionName: "swap", input: { amount }, context: user(sender) });
const routeTx = (path, amount, fn = "route") => ({ programUuid: "router", functionName: fn, input: { path, amount }, context: user("alice") });
const payTx = (items, fn = "pay") => ({ programUuid: "payroll", functionName: fn, input: { items }, context: user("alice") });

/** readable trace summary: "depth program.fn (sender→origin) status" */
const trace = (result) => result.calls.map((c) => `${c.depth} ${c.programUuid}.${c.functionName} (${c.sender}→${c.origin}) ${c.status}`);

/** transfer path of one token: computed from afterValues (balance before → after) */
function balanceDeltas(summary, token) {
  return summary.afterValues
    .filter((v) => v.dbKey.startsWith(`${token}:storage:balances:`))
    .map((v) => ({ account: v.dbKey.split(":").pop(), after: v.afterValue ?? "0n" }));   // DB values look like "123n"
}

// ---------------------------------------------------------------------------
//  1 tx: calls transfer on 2 programs in one execution
// ---------------------------------------------------------------------------

test("swap: one tx calls tokenA.transferFrom and tokenB.transfer", () => {
  const vm = setup();
  const res = vm.call(swapTx("swapab", 100), { timestamp: T });

  assert.equal(res.status, "success");
  assert.equal(res.result, "200n");
  assert.deepEqual(trace(res), [
    "0 swapab.swap (alice→alice) success",
    "1 tokena.transferFrom (swapab→alice) success",
    "1 tokenb.transfer (swapab→alice) success",
  ]);
  assert.deepEqual(res.writes.map((w) => `${w.dbKey} = ${w.value}`), [
    "tokena:storage:allowance:alice:swapab = 99900n",
    "tokena:storage:balances:alice = 900n",
    "tokena:storage:balances:swapab = 100n",
    "tokenb:storage:balances:swapab = 800n",
    "tokenb:storage:balances:alice = 200n",
    "swapab:storage:volumeIn = 100n",
  ]);
});

// ---------------------------------------------------------------------------
//  calling back and forth: router → swap → token
// ---------------------------------------------------------------------------

test("router: 2 hops (A→B→C) alternating router / swap / token at every level", () => {
  const vm = setup();
  const res = vm.call(routeTx(["swapab", "swapbc"], 50), { timestamp: T });

  assert.equal(res.result, "300n"); // 50 × 2 × 3
  assert.deepEqual(trace(res), [
    "0 router.route (alice→alice) success",
    "1 swapab.swap (router→alice) success",
    "2 tokena.transferFrom (swapab→alice) success",
    "2 tokenb.transfer (swapab→alice) success",
    "1 swapbc.swap (router→alice) success",
    "2 tokenb.transferFrom (swapbc→alice) success",
    "2 tokenc.transfer (swapbc→alice) success",
  ]);

  // net balances of each token after the tx
  assert.deepEqual(balanceDeltas(res, "tokena"), [{ account: "alice", after: "950n" }, { account: "swapab", after: "50n" }]);
  assert.deepEqual(balanceDeltas(res, "tokenb"), [{ account: "swapab", after: "900n" }, { account: "alice", after: "0n" }, { account: "swapbc", after: "100n" }]);
  assert.deepEqual(balanceDeltas(res, "tokenc"), [{ account: "swapbc", after: "700n" }, { account: "alice", after: "300n" }]);
  // alice receives 100 tokenB and pays it all out in the same tx → 0 left (the key did not exist, so it counts as changed)
  assert.deepEqual(res.afterValues.find((v) => v.dbKey === bal("tokenb", "alice")), { dbKey: bal("tokenb", "alice"), afterValue: "0n", changed: true });
});

test("router: second hop fails with no catch → the whole tx fails, nothing changes", () => {
  const vm = setup();
  const res = vm.call(routeTx(["swapab", "swapbc"], 300), { timestamp: T }); // the first hop passes, but swapbc lacks tokenC (300×2×3 = 1800)

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

test("router: second hop fails but router catches → only the first hop's effects are kept", () => {
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
  // swapbc's whole branch reverts, only swapab + router's log remain
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
//  calling one program repeatedly in a single tx
// ---------------------------------------------------------------------------

test("payroll: pays many people in one tx (calls tokenA.transferFrom 3 times in a row)", () => {
  const vm = setup();
  const items = [{ to: "bob", amount: 10 }, { to: "carol", amount: 20 }, { to: "dave", amount: 30 }];
  const res = vm.call(payTx(items), { timestamp: T });

  assert.equal(res.result, "60n");
  assert.deepEqual(trace(res), [
    "0 payroll.pay (alice→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
  ]);
  assert.deepEqual(balanceDeltas(res, "tokena"), [
    { account: "alice", after: "940n" },
    { account: "bob", after: "10n" },
    { account: "carol", after: "20n" },
    { account: "dave", after: "30n" },
  ]);
});

test("payroll: some items fail but are caught → only the failed items revert", () => {
  const vm = setup();
  const items = [{ to: "bob", amount: 10 }, { to: "carol", amount: 99999 }, { to: "dave", amount: 30 }];
  const res = vm.call(payTx(items, "paySafe"), { timestamp: T });

  assert.deepEqual(res.result, { paid: "40n", failed: ["carol"] });
  assert.deepEqual(trace(res), [
    "0 payroll.paySafe (alice→alice) success",
    "1 tokena.transferFrom (payroll→alice) success",
    "1 tokena.transferFrom (payroll→alice) throw",
    "1 tokena.transferFrom (payroll→alice) success",
  ]);
  // carol is never touched, because token checks the balance before writing → not in afterValues
  assert.equal(res.afterValues.some((v) => v.dbKey === bal("tokena", "carol")), false);
  assert.deepEqual(balanceDeltas(res, "tokena"), [
    { account: "alice", after: "960n" },
    { account: "bob", after: "10n" },
    { account: "dave", after: "30n" },
  ]);
  assert.deepEqual(res.writes.at(-1), { type: "put", dbKey: "payroll:storage:lastFailed", value: ["carol"] });
});

// ---------------------------------------------------------------------------
//  block-level data
// ---------------------------------------------------------------------------

test("block: mixed txs — block data can build a transfer overview", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(swapTx("swapab", 100));                                    // tx0 succeeds
  block.call(routeTx(["swapab", "swapbc"], 50));                        // tx1 succeeds
  block.call(payTx([{ to: "bob", amount: 10 }, { to: "carol", amount: 20 }])); // tx2 succeeds
  block.call(routeTx(["swapab", "swapbc"], 300));                       // tx3 fails entirely
  block.call(swapTx("swapbc", 150));                                    // tx4 alice spends tokenB received in this block

  const summary = block.summary();
  assert.deepEqual(summary.results.map((r) => r.status), ["success", "success", "success", "throw", "success"]);

  // how many times each program was called in the block (for a "most called programs" page)
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

  // net balances over the whole block (before → after)
  const net = Object.fromEntries(summary.afterValues
    .filter((v) => v.dbKey.includes(":balances:"))
    .map((v) => [v.dbKey.replace(":storage:balances", ""), v.afterValue]));
  assert.deepEqual(net, {
    "tokena:alice": "820n",
    "tokena:swapab": "150n",
    "tokena:bob": "10n",
    "tokena:carol": "20n",
    "tokenb:swapab": "700n",
    "tokenb:alice": "50n",
    "tokenb:swapbc": "250n",
    "tokenc:swapbc": "250n",
    "tokenc:alice": "750n",
  });

  // each token's total supply must stay at 1000
  for (const token of ["tokena", "tokenb", "tokenc"]) {
    const total = summary.afterValues
      .filter((v) => v.dbKey.startsWith(`${token}:storage:balances:`))
      .reduce((sum, v) => sum + BigInt(v.afterValue.slice(0, -1)), 0n);
    assert.equal(total, 1000n, token);
  }

  block.commit();
  for (const { dbKey, afterValue } of summary.afterValues) assert.deepEqual(vm.db.readKeys([dbKey])[0], afterValue, dbKey);
});

test("block: failed txs are absent from the block's aggregate data but still have a trace for the explorer", () => {
  const vm = setup();
  const block = vm.createBlock({ timestamp: T });
  block.call(routeTx(["swapab", "swapbc"], 300)); // fails
  block.call(swapTx("swapab", 10));               // succeeds

  const summary = block.summary();
  assert.deepEqual(summary.loadValues.map((v) => v.dbKey).filter((k) => k.startsWith("tokenc")), []);
  assert.deepEqual(summary.writes.map((w) => w.dbKey).filter((k) => k.startsWith("tokenc")), []);
  assert.equal(summary.results[0].calls.length, 7); // the failed tx's trace is still complete
  assert.equal(summary.results[0].calls.filter((c) => c.status === "throw").length, 3);
});

test("a block equals running each tx and committing one by one (mixed scenario)", () => {
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
//  data limits for the explorer
// ---------------------------------------------------------------------------

test("calls include input / value / result / gasUsed for every nested level — amounts visible on each path", () => {
  const vm = setup();
  const res = vm.call(routeTx(["swapab", "swapbc"], 50), { timestamp: T });

  assert.deepEqual(Object.keys(res.calls[1]), ["depth", "programUuid", "functionName", "sender", "origin", "input", "value", "gasStart", "status", "result", "gasUsed"]);
  for (const call of res.calls) {
    assert.equal(typeof call.input, "object");
    assert.notEqual(call.result, undefined);
    assert.ok(call.gasUsed > 0);
  }
  // outer-level gas already includes the inner levels
  assert.ok(res.calls[0].gasUsed >= res.calls[1].gasUsed + res.calls[2].gasUsed);
  assert.ok(res.calls[0].gasUsed <= res.gasUsed);
  assert.equal(res.result, "300n");
});
