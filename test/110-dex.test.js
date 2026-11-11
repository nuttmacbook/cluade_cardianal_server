import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { WCARD_PROGRAM } from "../src/standards/system.js";
import { TOKEN_PROGRAM, checkTokenStandard, ZERO_ADDRESS } from "../src/standards/token.js";
import { reviewProgram } from "../src/core/autoreview.js";
import { DEX_PAIR_PROGRAM, DEX_PROGRAM, DEX_FUNCTIONS, DEX_PAIR_FUNCTIONS, DEX_MAX_PATH, dexPairSalt } from "../src/standards/dex.js";

/*
 * DEX แบบ Uniswap V2 (src/standards/dex.js): router/factory + pair (clone จากต้นแบบ) + WBWSC
 *   VM เปิด fork bluewolf (ราคาแก๊สจริงของเชน) · ไม่หักค่าแก๊สจริง (ยอด native ตรวจได้ตรง ๆ) แต่ gasUsed ยังนับ
 */

const T = Date.parse("2026-11-11T00:00:00Z");
const NOW_S = BigInt(T / 1000);
const DEADLINE = `${NOW_S + 3600n}n`;
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b1";
const EVE = "0x00000000000000000000000000000000000000e1";
const WRAPPED = "0x000000000000000000000000000000000000c0c0";
const TEMPLATE = "0x000000000000000000000000000000000000c0c1";
const ROUTER = "0x000000000000000000000000000000000000c0c2";
const TKA = "0x000000000000000000000000000000000000aaaa";
const TKB = "0x000000000000000000000000000000000000bbbb";
const TKC = "0x000000000000000000000000000000000000cccc";
const EVIL = "0x000000000000000000000000000000000000e0e0";
const COIN = 10n ** 18n;
const n = (value) => `${value}n`;
const json = (value) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
const big = (value) => BigInt(String(value).replace(/n$/, ""));

// token ที่ transfer แล้วเรียกโปรแกรมอื่นต่อ (ทดสอบการเรียกซ้อนกลับเข้า pair)
const EVIL_TOKEN = `function program() {
  function initialization(params) { writeDB(map("balances", params.input.owner), params.input.supply); writeDB("totalSupply", params.input.supply) }
  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }
  function totalSupply() { return readDB("totalSupply") }
  function arm(params) { writeDB("hook", params.input) }
  function disarm() { deleteDB("hook") }
  function move(from, to, amount) {
    const b = readDB(map("balances", from)) || 0n
    if (b < amount) throw new Error("insufficient balance")
    writeDB(map("balances", from), b - amount)
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
    emit("Transfer", { from: from, to: to, amount: amount })
  }
  function hook() {
    const h = readDB("hook")
    if (h) { deleteDB("hook"); runProgram(h.target, h.fn, h.input) }
  }
  function transfer(params) { move(params.context.sender, params.input.to, params.input.amount); hook(); return true }
  function approve(params) { writeDB(map("allowance", params.context.sender, params.input.spender), params.input.amount); return true }
  function transferFrom(params) {
    const a = readDB(map("allowance", params.input.from, params.context.sender)) || 0n
    if (a < params.input.amount) throw new Error("insufficient allowance")
    writeDB(map("allowance", params.input.from, params.context.sender), a - params.input.amount)
    move(params.input.from, params.input.to, params.input.amount)
    hook()
    return true
  }
  return { balanceOf, totalSupply, arm, disarm, transfer, approve, transferFrom }
}`;

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 10_000, chainId: 272727, forks: { bluewolf: 0 }, maxBlockGas: 5_000_000 });
  vm.db.load(Object.fromEntries([DEPLOYER, ALICE, BOB, EVE].map((a) => [VM.nativeKey(a, "received"), `${1_000_000n * COIN}n`])));
  let time = T;
  const ok = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return res;
  };
  const block = (fn) => {
    const b = vm.createBlock({ timestamp: (time += 1000) });
    const out = fn(b);
    b.commit();
    return out;
  };
  const deploy = (programUuid, code, initInput) => block((b) => {
    ok(b.deploy({ programUuid, code, context: { sender: DEPLOYER, origin: DEPLOYER }, initInput: json(initInput), gasLimit: 4_000_000 }));
    ok(b.init({ programUuid }));
  });
  const send = (who, programUuid, functionName, input = {}, extra = {}) => block((b) =>
    b.call({ programUuid, functionName, input, context: { sender: who, origin: who }, gasLimit: 4_900_000, ...extra }));
  const query = (programUuid, functionName, input = {}) => ok(vm.query({ programUuid, functionName, input })).result;
  const fails = (res, pattern) => {
    assert.equal(res.status, "throw", "ควรล้ม");
    assert.match(res.error.message, pattern);
  };
  const balance = (who) => BigInt(vm.nativeBalanceOf(who).balance);
  const bal = (token, who) => big(query(token, "balanceOf", { who }));

  deploy(WRAPPED, WCARD_PROGRAM, { name: "Wrapped BWSC", ticker: "WBWSC" });
  deploy(TEMPLATE, DEX_PAIR_PROGRAM, { namespace: "dex-pair-template", description: "ต้นแบบ pair" });
  deploy(ROUTER, DEX_PROGRAM, { pairTemplate: TEMPLATE, wrapped: WRAPPED, namespace: "dex", description: "DEX" });
  for (const [addr, ticker] of [[TKA, "TKA"], [TKB, "TKB"], [TKC, "TKC"]]) {
    deploy(addr, TOKEN_PROGRAM, { name: ticker, ticker, decimals: 18n, supply: 1_000_000n * COIN, owner: ALICE });
    for (const who of [BOB, EVE]) ok(send(ALICE, addr, "transfer", { to: who, amount: n(10_000n * COIN) }));
    for (const who of [ALICE, BOB, EVE]) ok(send(who, addr, "approve", { spender: ROUTER, amount: n(10n ** 40n) }));
  }
  ok(send(ALICE, WRAPPED, "deposit", {}, { value: `${1000n * COIN}` }));
  ok(send(ALICE, WRAPPED, "approve", { spender: ROUTER, amount: n(10n ** 40n) }));
  return { vm, ok, send, query, fails, balance, bal, block, time: () => time };
}

const add = (t, who, a, b, amountA, amountB, extra = {}) => t.send(who, ROUTER, "addLiquidity", {
  tokenA: a, tokenB: b, amountADesired: n(amountA), amountBDesired: n(amountB), amountAMin: "0n", amountBMin: "0n", to: who, deadline: DEADLINE, ...extra });

// สูตรอ้างอิงของ V2 (ฝั่ง JS)
const outFor = (x, rIn, rOut) => (x * 997n * rOut) / (rIn * 1000n + x * 997n);
const inFor = (y, rIn, rOut) => (rIn * y * 1000n) / ((rOut - y) * 997n) + 1n;
const sqrt = (v) => { if (v < 2n) return v; let x = v, y = (x + 1n) / 2n; while (y < x) { x = y; y = (v / x + x) / 2n; } return x; };

test("dex: โค้ดผ่าน autoreview · pair เป็น token ตามมาตรฐาน · ต้นแบบเฉย ๆ ใช้ไม่ได้ · รายชื่อฟังก์ชัน", () => {
  for (const code of [DEX_PAIR_PROGRAM, DEX_PROGRAM]) assert.equal(reviewProgram(code).ok, true, reviewProgram(code).message);
  assert.deepEqual(checkTokenStandard(DEX_PAIR_PROGRAM), { ok: true, missing: [] });
  assert.ok(DEX_FUNCTIONS.includes("swapExactTokensForTokens"));
  assert.deepEqual(DEX_PAIR_FUNCTIONS, ["mint", "burn", "swap", "skim", "sync"]);
  const t = setup();
  assert.equal(t.query(TEMPLATE, "name"), "BWSC-LP");
  assert.equal(t.query(TEMPLATE, "token0"), null);
  t.fails(t.send(EVE, TEMPLATE, "mint", { to: EVE }), /pair not initialized/);
  t.fails(t.send(EVE, TEMPLATE, "sync"), /pair not initialized/);
  assert.equal(t.query(ROUTER, "pairTemplate"), TEMPLATE);
  assert.equal(t.query(ROUTER, "wrapped"), WRAPPED);
  // input ตอน deploy ผิด
  const vm2 = t.vm;
  const bad = vm2.createBlock({ timestamp: t.time() + 1000 });
  bad.deploy({ programUuid: "0x000000000000000000000000000000000000dead", code: DEX_PROGRAM, context: { sender: DEPLOYER, origin: DEPLOYER }, initInput: { pairTemplate: "x", wrapped: WRAPPED } });
  assert.equal(bad.init({ programUuid: "0x000000000000000000000000000000000000dead" }).status, "throw");
});

test("dex: createPair · address รู้ล่วงหน้า · 1 คู่ = 1 pair · getPair / allPairs / pairCount", () => {
  const t = setup();
  const code = t.vm.read(VM.codeKey(TEMPLATE));
  const res = t.ok(t.send(BOB, ROUTER, "createPair", { tokenA: TKB, tokenB: TKA }));
  const pair = res.result;
  assert.equal(pair, t.vm.cloneAddressFor(ROUTER, dexPairSalt(TKB, TKA), code));
  const ev = res.events.find((e) => e.name === "PairCreated");
  assert.deepEqual(ev.data, { token0: TKA, token1: TKB, pair, index: "0n" });
  assert.equal(t.query(pair, "token0"), TKA);
  assert.equal(t.query(pair, "token1"), TKB);
  assert.equal(t.query(pair, "factory"), ROUTER);
  assert.equal(t.query(pair, "decimals"), "18n");
  assert.equal(t.vm.getMetadata(pair).template, TEMPLATE);
  assert.equal(t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB }), pair);
  assert.equal(t.query(ROUTER, "getPair", { tokenA: TKB, tokenB: TKA }), pair);
  assert.equal(t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKC }), null);
  t.fails(t.send(BOB, ROUTER, "createPair", { tokenA: TKA, tokenB: TKB }), /pair exists/);
  t.fails(t.send(BOB, ROUTER, "createPair", { tokenA: TKA, tokenB: TKA }), /identical addresses/);
  t.fails(t.send(BOB, ROUTER, "createPair", { tokenA: TKA, tokenB: BOB }), /tokens must be programs/);
  t.fails(t.send(BOB, ROUTER, "createPair", { tokenA: TKA, tokenB: "0x12" }), /tokenB must be an address/);
  t.fails(t.send(BOB, ROUTER, "createPair", { tokenA: TKA, tokenB: TKC }, { value: "1" }), /not payable/);
  const p2 = t.ok(t.send(BOB, ROUTER, "createPair", { tokenA: TKC, tokenB: TKA })).result;
  assert.equal(t.query(ROUTER, "pairCount"), "2n");
  assert.deepEqual(t.query(ROUTER, "allPairs", { start: "0n", limit: "10n" }), [pair, p2]);
  assert.deepEqual(t.query(ROUTER, "allPairs", { start: "1n" }), [p2]);
  assert.equal(t.vm.query({ programUuid: ROUTER, functionName: "allPairs", input: { limit: "101n" } }).status, "throw");
});

test("dex: เพิ่มสภาพคล่องครั้งแรก / ครั้งที่สอง · MINIMUM_LIQUIDITY · ส่วนเกินไม่ถูกดึง · slippage / deadline", () => {
  const t = setup();
  const a = 1000n * COIN, b = 4000n * COIN;
  const first = t.ok(add(t, ALICE, TKA, TKB, a, b));
  const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB });
  const liq = sqrt(a * b) - 1000n;
  assert.deepEqual(first.result, { amountA: n(a), amountB: n(b), liquidity: n(liq) });
  assert.equal(t.bal(pair, ALICE), liq);
  assert.equal(t.bal(pair, ZERO_ADDRESS), 1000n);
  assert.equal(big(t.query(pair, "totalSupply")), liq + 1000n);
  assert.deepEqual(t.query(pair, "getReserves").reserve0, n(a));
  const names = first.events.map((e) => e.name);
  for (const name of ["PairCreated", "Transfer", "Sync", "Mint"]) assert.ok(names.includes(name), name);
  assert.equal(t.bal(TKA, ROUTER) + t.bal(TKB, ROUTER), 0n, "router ไม่ถือ token");

  // ครั้งที่สอง (สลับลำดับ tokenA/tokenB): ใส่ B 400 → A ที่ต้องใช้ = 100 · desired A 500 ส่วนเกินไม่ถูกดึง
  const bobA = t.bal(TKA, BOB);
  const second = t.ok(add(t, BOB, TKB, TKA, 400n * COIN, 500n * COIN));
  assert.equal(second.result.amountA, n(400n * COIN));
  assert.equal(second.result.amountB, n(100n * COIN));
  assert.equal(t.bal(TKA, BOB), bobA - 100n * COIN);
  const supply = liq + 1000n;
  assert.equal(second.result.liquidity, n((100n * COIN * supply) / a));

  // min ไม่ผ่าน
  t.fails(add(t, BOB, TKA, TKB, 100n * COIN, 100n * COIN, { amountAMin: n(100n * COIN) }), /insufficient A amount/);
  t.fails(add(t, BOB, TKA, TKB, 100n * COIN, 1000n * COIN, { amountBMin: n(401n * COIN) }), /insufficient B amount/);
  // deadline: วินาที · หมดแล้ว / ไม่ใช่ bigint
  t.fails(add(t, BOB, TKA, TKB, COIN, COIN, { deadline: n(NOW_S - 1n) }), /expired/);
  t.fails(add(t, BOB, TKA, TKB, COIN, COIN, { deadline: "soon" }), /deadline must be a bigint/);
  // จำนวนผิด
  t.fails(add(t, BOB, TKA, TKB, 0n, COIN), /amountADesired must be a bigint greater than 0/);
  t.fails(add(t, BOB, TKA, TKB, COIN, COIN, { amountAMin: "-1n" }), /amountAMin must be a non-negative/);
  t.fails(add(t, BOB, TKA, TKB, COIN, COIN, { to: "nope" }), /to must be an address/);
  // ไม่ได้ approve / เงินไม่พอ
  t.fails(add(t, EVE, TKA, TKB, 20_000n * COIN, 80_000n * COIN), /insufficient balance/);
  t.fails(add(t, DEPLOYER, TKA, TKB, COIN, COIN), /insufficient allowance/);   // ไม่ได้ approve router
});

test("dex: ใครเรียก pair.mint ตรง ๆ ได้ (ส่งเหรียญเข้าเองก่อน) · ไม่ส่ง = ล้ม · LP ครั้งแรกเล็กเกิน = ล้ม", () => {
  const t = setup();
  const pair = t.ok(t.send(ALICE, ROUTER, "createPair", { tokenA: TKA, tokenB: TKB })).result;
  t.fails(t.send(EVE, pair, "mint", { to: EVE }), /insufficient liquidity minted/);
  t.ok(t.send(EVE, TKA, "transfer", { to: pair, amount: "1000n" }));
  t.ok(t.send(EVE, TKB, "transfer", { to: pair, amount: "1000n" }));
  t.fails(t.send(EVE, pair, "mint", { to: EVE }), /insufficient liquidity minted/);   // sqrt = 1000 − 1000 = 0
  t.ok(t.send(EVE, TKA, "transfer", { to: pair, amount: "1n" }));
  t.ok(t.send(EVE, TKB, "transfer", { to: pair, amount: "1n" }));
  assert.equal(t.ok(t.send(EVE, pair, "mint", { to: EVE })).result, "1n");
  t.fails(t.send(EVE, pair, "burn", { to: EVE }), /insufficient liquidity burned/);   // pair ไม่ถือ LP
});

test("dex: donation ข้างเดียว + sync ก่อนเพิ่มสภาพคล่องครั้งแรก ไม่ทำให้ pair ใช้ผ่าน router ไม่ได้", () => {
  const t = setup();
  const pair = t.ok(t.send(EVE, ROUTER, "createPair", { tokenA: TKA, tokenB: TKB })).result;
  t.ok(t.send(EVE, TKA, "transfer", { to: pair, amount: "5n" }));
  t.ok(t.send(EVE, pair, "sync"));
  const res = t.ok(add(t, ALICE, TKA, TKB, 100n * COIN, 100n * COIN));
  assert.equal(res.result.liquidity, n(100n * COIN - 1000n));
});

test("dex: swap ทั้งสองทาง · ตรงสูตร 0.3% · k ไม่ลด · slippage / deadline / path ผิด", () => {
  const t = setup();
  const RA = 1000n * COIN, RB = 2000n * COIN;
  t.ok(add(t, ALICE, TKA, TKB, RA, RB));
  const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB });
  const k0 = RA * RB;

  const x = 10n * COIN;
  const expected = outFor(x, RA, RB);
  assert.deepEqual(t.query(ROUTER, "getAmountsOut", { amountIn: n(x), path: [TKA, TKB] }), [n(x), n(expected)]);
  const before = t.bal(TKB, BOB);
  const res = t.ok(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: n(expected), path: [TKA, TKB], to: BOB, deadline: DEADLINE }));
  assert.deepEqual(res.result, [n(x), n(expected)]);
  assert.equal(t.bal(TKB, BOB), before + expected);
  const swap = res.events.find((e) => e.name === "Swap");
  assert.deepEqual(swap.data, { sender: ROUTER, amount0In: n(x), amount1In: "0n", amount0Out: "0n", amount1Out: n(expected), to: BOB });
  let r = t.query(pair, "getReserves");
  assert.ok(big(r.reserve0) * big(r.reserve1) > k0, "k เพิ่มจากค่าธรรมเนียม");

  // ขากลับ: exact output (B → A)
  const want = 5n * COIN;
  const need = inFor(want, big(r.reserve1), big(r.reserve0));
  assert.deepEqual(t.query(ROUTER, "getAmountsIn", { amountOut: n(want), path: [TKB, TKA] }), [n(need), n(want)]);
  t.fails(t.send(BOB, ROUTER, "swapTokensForExactTokens", { amountOut: n(want), amountInMax: n(need - 1n), path: [TKB, TKA], to: BOB, deadline: DEADLINE }), /excessive input amount/);
  const aBefore = t.bal(TKA, BOB), bBefore = t.bal(TKB, BOB);
  t.ok(t.send(BOB, ROUTER, "swapTokensForExactTokens", { amountOut: n(want), amountInMax: n(need), path: [TKB, TKA], to: BOB, deadline: DEADLINE }));
  assert.equal(t.bal(TKA, BOB), aBefore + want);
  assert.equal(t.bal(TKB, BOB), bBefore - need);
  // amountIn − 1 ไม่พอ (ปัดขึ้นถูกทาง): pair ตรวจ k ไม่ผ่าน
  r = t.query(pair, "getReserves");
  assert.ok(outFor(inFor(want, big(r.reserve1), big(r.reserve0)) - 1n, big(r.reserve1), big(r.reserve0)) < want);

  // slippage / deadline / path
  const q = big(t.query(ROUTER, "getAmountsOut", { amountIn: n(x), path: [TKA, TKB] })[1]);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: n(q + 1n), path: [TKA, TKB], to: BOB, deadline: DEADLINE }), /insufficient output amount/);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: "0n", path: [TKA, TKB], to: BOB, deadline: n(NOW_S) }), /expired/);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: "0n", path: [TKA], to: BOB, deadline: DEADLINE }), /path must have 2/);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: "0n", path: [TKA, TKB, TKA, TKB, TKA], to: BOB, deadline: DEADLINE }), new RegExp(`path must have 2 … ${DEX_MAX_PATH}`));
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: "0n", path: [TKA, TKC], to: BOB, deadline: DEADLINE }), /pair does not exist/);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: "0n", amountOutMin: "0n", path: [TKA, TKB], to: BOB, deadline: DEADLINE }), /amountIn must be/);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: "0n", path: [TKA, TKA], to: BOB, deadline: DEADLINE }), /identical/);
  t.fails(t.send(BOB, ROUTER, "swapTokensForExactTokens", { amountOut: n(RB * 10n), amountInMax: n(RA * 100n), path: [TKA, TKB], to: BOB, deadline: DEADLINE }), /insufficient liquidity/);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: "0n", path: [TKA, TKB], to: BOB, deadline: DEADLINE }, { value: "5" }), /not payable/);
  assert.equal(t.bal(TKA, ROUTER) + t.bal(TKB, ROUTER), 0n);
  assert.equal(t.balance(ROUTER), 0n);
});

test("dex: multi-hop A → B → C · ผลตรงสูตรทีละ hop · ทางยาวสุด 3 hop", () => {
  const t = setup();
  t.ok(add(t, ALICE, TKA, TKB, 1000n * COIN, 1000n * COIN));
  t.ok(add(t, ALICE, TKB, TKC, 1000n * COIN, 3000n * COIN));
  t.ok(add(t, ALICE, TKC, WRAPPED, 3000n * COIN, 100n * COIN));
  const x = 50n * COIN;
  const b = outFor(x, 1000n * COIN, 1000n * COIN);
  const c = outFor(b, 1000n * COIN, 3000n * COIN);
  const cBefore = t.bal(TKC, BOB);
  const res = t.ok(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(x), amountOutMin: n(c), path: [TKA, TKB, TKC], to: BOB, deadline: DEADLINE }));
  assert.deepEqual(res.result, [n(x), n(b), n(c)]);
  assert.equal(t.bal(TKC, BOB), cBefore + c);
  assert.equal(res.events.filter((e) => e.name === "Swap").length, 2);
  // exact output ผ่าน 2 hop (C → B → A)
  const amounts = t.query(ROUTER, "getAmountsIn", { amountOut: n(COIN), path: [TKC, TKB, TKA] });
  const out = t.ok(t.send(BOB, ROUTER, "swapTokensForExactTokens", { amountOut: n(COIN), amountInMax: amounts[0], path: [TKC, TKB, TKA], to: BOB, deadline: DEADLINE }));
  assert.deepEqual(out.result, amounts);
  // 3 hop ไปเป็นเหรียญหลัก
  const native = t.balance(BOB);
  const three = t.ok(t.send(BOB, ROUTER, "swapExactTokensForNative", { amountIn: n(COIN), amountOutMin: "1n", path: [TKA, TKB, TKC, WRAPPED], to: BOB, deadline: DEADLINE }));
  assert.equal(t.balance(BOB), native + big(three.result[3]));
  for (const tk of [TKA, TKB, TKC, WRAPPED]) assert.equal(t.bal(tk, ROUTER), 0n);
  assert.equal(t.balance(ROUTER), 0n);
});

test("dex: เหรียญหลัก — addLiquidityNative (คืนส่วนเกิน) · swap เข้า/ออก · removeLiquidityNative · router ไม่ค้างเงิน", () => {
  const t = setup();
  const before = t.balance(ALICE);
  const first = t.ok(t.send(ALICE, ROUTER, "addLiquidityNative", { token: TKA, amountTokenDesired: n(1000n * COIN), amountTokenMin: "0n", amountNativeMin: "0n", to: ALICE, deadline: DEADLINE },
    { value: `${100n * COIN}` }));
  assert.equal(first.result.amountNative, n(100n * COIN));
  assert.equal(t.balance(ALICE), before - 100n * COIN);
  const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: WRAPPED });
  assert.equal(t.bal(WRAPPED, pair), 100n * COIN);
  assert.equal(t.balance(WRAPPED), 1100n * COIN, "เหรียญหลักอยู่ใน WBWSC");

  // ครั้งที่สอง: ส่ง 50 แต่ใช้แค่ 10 (token 100) → คืน 40
  const bobBefore = t.balance(BOB);
  const second = t.ok(t.send(BOB, ROUTER, "addLiquidityNative", { token: TKA, amountTokenDesired: n(100n * COIN), amountTokenMin: "0n", amountNativeMin: "0n", to: BOB, deadline: DEADLINE },
    { value: `${50n * COIN}` }));
  assert.equal(second.result.amountNative, n(10n * COIN));
  assert.equal(t.balance(BOB), bobBefore - 10n * COIN);
  t.fails(t.send(BOB, ROUTER, "addLiquidityNative", { token: TKA, amountTokenDesired: n(COIN), to: BOB, deadline: DEADLINE }), /value must be a bigint greater than 0/);
  t.fails(t.send(BOB, ROUTER, "addLiquidityNative", { token: WRAPPED, amountTokenDesired: n(COIN), to: BOB, deadline: DEADLINE }, { value: "1" }), /must not be the wrapped/);
  t.fails(t.send(BOB, ROUTER, "addLiquidityNative", { token: TKA, amountTokenDesired: n(100n * COIN), amountNativeMin: n(11n * COIN), to: BOB, deadline: DEADLINE }, { value: `${50n * COIN}` }), /insufficient/);

  // native → token
  let r = t.query(ROUTER, "getReserves", { tokenA: WRAPPED, tokenB: TKA });
  const v = 2n * COIN;
  const expect = outFor(v, big(r.reserveA), big(r.reserveB));
  const tkBefore = t.bal(TKA, BOB);
  const nb = t.balance(BOB);
  const s1 = t.ok(t.send(BOB, ROUTER, "swapExactNativeForTokens", { amountOutMin: n(expect), path: [WRAPPED, TKA], to: BOB, deadline: DEADLINE }, { value: `${v}` }));
  assert.deepEqual(s1.result, [n(v), n(expect)]);
  assert.equal(t.bal(TKA, BOB), tkBefore + expect);
  assert.equal(t.balance(BOB), nb - v);
  t.fails(t.send(BOB, ROUTER, "swapExactNativeForTokens", { amountOutMin: "0n", path: [TKA, WRAPPED], to: BOB, deadline: DEADLINE }, { value: "1000" }), /must start with the wrapped/);
  t.fails(t.send(BOB, ROUTER, "swapExactNativeForTokens", { amountOutMin: "0n", path: [WRAPPED, TKA], to: BOB, deadline: DEADLINE }), /value must be/);

  // native → exact token (คืนส่วนเหลือ)
  const amounts = t.query(ROUTER, "getAmountsIn", { amountOut: n(COIN), path: [WRAPPED, TKA] });
  const nb2 = t.balance(BOB);
  t.ok(t.send(BOB, ROUTER, "swapNativeForExactTokens", { amountOut: n(COIN), path: [WRAPPED, TKA], to: BOB, deadline: DEADLINE }, { value: `${5n * COIN}` }));
  assert.equal(t.balance(BOB), nb2 - big(amounts[0]));
  t.fails(t.send(BOB, ROUTER, "swapNativeForExactTokens", { amountOut: n(COIN), path: [WRAPPED, TKA], to: BOB, deadline: DEADLINE }, { value: "1" }), /excessive input/);

  // token → native (ส่งให้คนอื่น)
  r = t.query(ROUTER, "getReserves", { tokenA: TKA, tokenB: WRAPPED });
  const outN = outFor(10n * COIN, big(r.reserveA), big(r.reserveB));
  const eveN = t.balance(EVE);
  const s3 = t.ok(t.send(BOB, ROUTER, "swapExactTokensForNative", { amountIn: n(10n * COIN), amountOutMin: n(outN), path: [TKA, WRAPPED], to: EVE, deadline: DEADLINE }));
  assert.equal(t.balance(EVE), eveN + outN);
  assert.ok(s3.events.some((e) => e.name === "Withdrawal"));
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForNative", { amountIn: n(COIN), amountOutMin: "0n", path: [WRAPPED, TKA], to: BOB, deadline: DEADLINE }), /must end with the wrapped/);
  // token → exact native
  const eveN2 = t.balance(EVE);
  t.ok(t.send(BOB, ROUTER, "swapTokensForExactNative", { amountOut: n(COIN), amountInMax: n(100n * COIN), path: [TKA, WRAPPED], to: EVE, deadline: DEADLINE }));
  assert.equal(t.balance(EVE), eveN2 + COIN);

  // ถอนสภาพคล่องเป็นเหรียญหลัก
  const lp = t.bal(pair, BOB);
  t.fails(t.send(BOB, ROUTER, "removeLiquidityNative", { token: TKA, liquidity: n(lp), to: BOB, deadline: DEADLINE }), /insufficient allowance/);
  t.ok(t.send(BOB, pair, "approve", { spender: ROUTER, amount: n(lp) }));
  r = t.query(pair, "getReserves");
  const supply = big(t.query(pair, "totalSupply"));
  const reserveTk = TKA < WRAPPED ? big(r.reserve0) : big(r.reserve1);
  const reserveW = TKA < WRAPPED ? big(r.reserve1) : big(r.reserve0);
  const expTk = (lp * reserveTk) / supply, expN = (lp * reserveW) / supply;
  t.fails(t.send(BOB, ROUTER, "removeLiquidityNative", { token: TKA, liquidity: n(lp), amountNativeMin: n(expN + 1n), to: BOB, deadline: DEADLINE }), /insufficient native amount/);
  const nb3 = t.balance(BOB), tk3 = t.bal(TKA, BOB);
  const rm = t.ok(t.send(BOB, ROUTER, "removeLiquidityNative", { token: TKA, liquidity: n(lp), amountTokenMin: n(expTk), amountNativeMin: n(expN), to: BOB, deadline: DEADLINE }));
  assert.deepEqual(rm.result, { amountToken: n(expTk), amountNative: n(expN) });
  assert.equal(t.balance(BOB), nb3 + expN);
  assert.equal(t.bal(TKA, BOB), tk3 + expTk);
  assert.equal(t.bal(pair, BOB), 0n);
  assert.ok(rm.events.some((e) => e.name === "Burn"));

  // router ไม่ค้างทั้งเหรียญหลัก / WBWSC / token / LP
  assert.equal(t.balance(ROUTER), 0n);
  for (const tk of [TKA, WRAPPED, pair]) assert.equal(t.bal(tk, ROUTER), 0n);
  // WBWSC ยังมีเหรียญหลักหนุนครบ
  assert.equal(t.balance(WRAPPED), big(t.query(WRAPPED, "totalSupply")));
});

test("dex: removeLiquidity · ได้ตามส่วน (ปัดลง) · min / deadline · LP ล็อกถาวร 1000", () => {
  const t = setup();
  t.ok(add(t, ALICE, TKA, TKB, 1000n * COIN, 1000n * COIN));
  t.ok(add(t, BOB, TKA, TKB, 100n * COIN, 100n * COIN));
  const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB });
  t.ok(t.send(EVE, ROUTER, "swapExactTokensForTokens", { amountIn: n(37n * COIN), amountOutMin: "0n", path: [TKA, TKB], to: EVE, deadline: DEADLINE }));
  const lp = t.bal(pair, BOB);
  t.ok(t.send(BOB, pair, "approve", { spender: ROUTER, amount: n(lp) }));
  const r = t.query(pair, "getReserves");
  const supply = big(t.query(pair, "totalSupply"));
  const expA = (lp * big(r.reserve0)) / supply, expB = (lp * big(r.reserve1)) / supply;
  const base = { tokenA: TKB, tokenB: TKA, liquidity: n(lp), to: BOB, deadline: DEADLINE };
  t.fails(t.send(BOB, ROUTER, "removeLiquidity", { ...base, amountAMin: n(expB + 1n) }), /insufficient A amount/);
  t.fails(t.send(BOB, ROUTER, "removeLiquidity", { ...base, amountBMin: n(expA + 1n) }), /insufficient B amount/);
  t.fails(t.send(BOB, ROUTER, "removeLiquidity", { ...base, deadline: n(NOW_S - 10n) }), /expired/);
  t.fails(t.send(BOB, ROUTER, "removeLiquidity", { ...base, liquidity: "0n" }), /liquidity must be/);
  const res = t.ok(t.send(BOB, ROUTER, "removeLiquidity", { ...base, amountAMin: n(expB), amountBMin: n(expA) }));
  assert.deepEqual(res.result, { amountA: n(expB), amountB: n(expA) });   // tokenA = TKB

  // ALICE ถอนหมด → เหลือ LP 1000 ที่ zero address และ reserve ไม่เป็น 0
  const all = t.bal(pair, ALICE);
  t.ok(t.send(ALICE, pair, "approve", { spender: ROUTER, amount: n(all) }));
  t.ok(t.send(ALICE, ROUTER, "removeLiquidity", { tokenA: TKA, tokenB: TKB, liquidity: n(all), to: ALICE, deadline: DEADLINE }));
  assert.equal(big(t.query(pair, "totalSupply")), 1000n);
  const left = t.query(pair, "getReserves");
  assert.ok(big(left.reserve0) > 0n && big(left.reserve1) > 0n);
  assert.equal(t.bal(TKA, ROUTER) + t.bal(TKB, ROUTER) + t.bal(pair, ROUTER), 0n);
});

test("dex: เรียก pair.swap ตรง ๆ แบบประสงค์ร้าย → K · ส่งเข้าน้อยไป 1 หน่วย → K · ส่งพอดี → ผ่าน", () => {
  const t = setup();
  t.ok(add(t, ALICE, TKA, TKB, 1000n * COIN, 1000n * COIN));
  const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB });
  // ขอเหรียญออกโดยไม่ส่งเข้า
  t.fails(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: n(COIN), to: EVE }), /insufficient input amount/);
  // ส่งเข้าเล็กน้อยแล้วขอออกเกินสูตร (ไม่หักค่าธรรมเนียม)
  t.ok(t.send(EVE, TKA, "transfer", { to: pair, amount: n(10n * COIN) }));
  const fair = outFor(10n * COIN, 1000n * COIN, 1000n * COIN);
  t.fails(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: n(fair + 1n), to: EVE }), /^K$/);
  t.fails(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: n((10n * COIN * 1000n * COIN) / (1010n * COIN)), to: EVE }), /^K$/);
  t.fails(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: "0n", to: EVE }), /insufficient output amount/);
  t.fails(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: n(1000n * COIN), to: EVE }), /insufficient liquidity/);
  t.fails(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: n(fair), to: TKB }), /invalid to/);
  t.fails(t.send(EVE, pair, "swap", { amount0Out: "-1n", amount1Out: n(fair), to: EVE }), /non-negative/);
  // ขอทั้งสองฝั่งพร้อมกัน → K
  t.fails(t.send(EVE, pair, "swap", { amount0Out: n(COIN), amount1Out: n(fair), to: EVE }), /^K$/);
  const before = t.bal(TKB, EVE);
  const ok = t.ok(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: n(fair), to: EVE }));
  assert.equal(t.bal(TKB, EVE), before + fair);
  assert.equal(ok.events.find((e) => e.name === "Swap").data.sender, EVE);
  const r = t.query(pair, "getReserves");
  assert.ok(big(r.reserve0) * big(r.reserve1) >= 1000n * COIN * 1000n * COIN);
  // reserve ตรงกับยอดจริงหลังทุกขั้น
  assert.equal(big(r.reserve0), t.bal(TKA, pair));
  assert.equal(big(r.reserve1), t.bal(TKB, pair));
});

test("dex: donation → skim คืนส่วนเกิน · sync ปรับ reserve · router คิดราคาใหม่ตาม reserve", () => {
  const t = setup();
  t.ok(add(t, ALICE, TKA, TKB, 1000n * COIN, 1000n * COIN));
  const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB });
  t.ok(t.send(EVE, TKA, "transfer", { to: pair, amount: n(7n * COIN) }));
  assert.equal(t.query(pair, "getReserves").reserve0, n(1000n * COIN), "donation ยังไม่เข้า reserve");
  const bobA = t.bal(TKA, BOB);
  const sk = t.ok(t.send(BOB, pair, "skim", { to: BOB }));   // ใครก็เก็บส่วนเกินได้ (แบบ V2)
  assert.deepEqual(sk.result, { amount0: n(7n * COIN), amount1: "0n" });
  assert.equal(t.bal(TKA, BOB), bobA + 7n * COIN);
  assert.equal(t.bal(TKA, pair), 1000n * COIN);
  assert.deepEqual(t.ok(t.send(BOB, pair, "skim", { to: BOB })).result, { amount0: "0n", amount1: "0n" });

  t.ok(t.send(EVE, TKB, "transfer", { to: pair, amount: n(20n * COIN) }));
  const sy = t.ok(t.send(EVE, pair, "sync"));
  assert.deepEqual(sy.events.find((e) => e.name === "Sync").data, { reserve0: n(1000n * COIN), reserve1: n(1020n * COIN) });
  assert.deepEqual(t.query(ROUTER, "getAmountsOut", { amountIn: n(COIN), path: [TKA, TKB] })[1], n(outFor(COIN, 1000n * COIN, 1020n * COIN)));
  // ราคาสะสม (oracle) เดินตามเวลา (วินาที)
  assert.ok(big(t.query(pair, "price0CumulativeLast")) > 0n);
  assert.ok(big(t.query(pair, "getReserves").blockTimestampLast) > NOW_S);
});

test("dex: การปัดเศษเข้าทาง pool — swap จำนวนน้อย ๆ · LP ครั้งต่อไปปัดลง · quote / getAmountIn ปัดขึ้น", () => {
  const t = setup();
  t.ok(add(t, ALICE, TKA, TKB, 1_000_000n, 3_000_000n));
  const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB });
  // 1 หน่วยเข้า → ออก floor(997 × 3e6 / (1e9 + 997)) = 2
  assert.deepEqual(t.query(ROUTER, "getAmountsOut", { amountIn: "1n", path: [TKA, TKB] }), ["1n", "2n"]);
  t.fails(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: "1n", amountOutMin: "0n", path: [TKB, TKA], to: BOB, deadline: DEADLINE }), /insufficient output amount/);
  // ซื้อทีละน้อยหลายครั้ง ไม่ทำให้ k ลด
  let k = 1_000_000n * 3_000_000n;
  for (let i = 0; i < 5; i++) {
    t.ok(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: "3n", amountOutMin: "0n", path: [TKA, TKB], to: BOB, deadline: DEADLINE }));
    const r = t.query(pair, "getReserves");
    const next = big(r.reserve0) * big(r.reserve1);
    assert.ok(next >= k);
    k = next;
  }
  assert.equal(t.query(ROUTER, "getAmountIn", { amountOut: "1n", reserveIn: "1000n", reserveOut: "1000n" }), "2n");
  assert.equal(t.query(ROUTER, "getAmountOut", { amountIn: "2n", reserveIn: "1000n", reserveOut: "1000n" }), "1n");
  assert.equal(t.query(ROUTER, "quote", { amountA: "3n", reserveA: "2n", reserveB: "1n" }), "1n");
  assert.equal(t.vm.query({ programUuid: ROUTER, functionName: "quote", input: { amountA: "3n", reserveA: "0n", reserveB: "1n" } }).status, "throw");
  // ใส่ไม่ตรงสัดส่วนเองที่ pair → ได้ LP ตามฝั่งที่น้อยกว่า (ส่วนเกินเป็นของ pool)
  const supply = big(t.query(pair, "totalSupply"));
  const r = t.query(pair, "getReserves");
  t.ok(t.send(EVE, TKA, "transfer", { to: pair, amount: "1000n" }));
  t.ok(t.send(EVE, TKB, "transfer", { to: pair, amount: "1n" }));
  t.fails(t.send(EVE, pair, "mint", { to: EVE }), /insufficient liquidity minted/);   // 1 × supply / reserve1 ปัดลงเป็น 0
  t.ok(t.send(EVE, TKB, "transfer", { to: pair, amount: "9999n" }));
  const minted = big(t.ok(t.send(EVE, pair, "mint", { to: EVE })).result);
  const l0 = (1000n * supply) / big(r.reserve0), l1 = (10000n * supply) / big(r.reserve1);
  assert.equal(minted, l0 < l1 ? l0 : l1);
  // burn ปัดลง: LP 1 หน่วยไม่พอได้เหรียญทั้งสองฝั่ง
  t.ok(t.send(EVE, pair, "transfer", { to: pair, amount: "1n" }));
  t.fails(t.send(EVE, pair, "burn", { to: EVE }), /insufficient liquidity burned/);
});

test("dex: กันเรียกซ้อน — token ที่ callback กลับเข้า pair / router ระหว่าง swap ล้มทั้ง tx", () => {
  const t = setup();
  const deployEvil = () => t.block((b) => {
    t.ok(b.deploy({ programUuid: EVIL, code: EVIL_TOKEN, context: { sender: DEPLOYER, origin: DEPLOYER }, initInput: json({ owner: ALICE, supply: 10n ** 30n }), gasLimit: 4_000_000 }));
    t.ok(b.init({ programUuid: EVIL }));
  });
  deployEvil();
  t.ok(t.send(ALICE, EVIL, "approve", { spender: ROUTER, amount: n(10n ** 30n) }));
  t.ok(add(t, ALICE, EVIL, TKA, 1000n * COIN, 1000n * COIN));
  const pair = t.query(ROUTER, "getPair", { tokenA: EVIL, tokenB: TKA });
  t.ok(t.send(ALICE, EVIL, "arm", { target: pair, fn: "sync", input: {} }));
  t.fails(t.send(ALICE, ROUTER, "swapExactTokensForTokens", { amountIn: n(COIN), amountOutMin: "0n", path: [TKA, EVIL], to: ALICE, deadline: DEADLINE }), /locked/);
  t.ok(t.send(ALICE, EVIL, "arm", { target: ROUTER, fn: "swapExactTokensForTokens", input: { amountIn: n(COIN), amountOutMin: "0n", path: [TKA, EVIL], to: ALICE, deadline: DEADLINE } }));
  t.fails(t.send(ALICE, ROUTER, "swapExactTokensForTokens", { amountIn: n(COIN), amountOutMin: "0n", path: [EVIL, TKA], to: ALICE, deadline: DEADLINE }), /locked/);
  // tx ที่ล้มไม่ทิ้ง lock ค้าง: ใช้งานต่อได้
  t.ok(t.send(ALICE, EVIL, "disarm"));
  const r0 = t.query(pair, "getReserves");
  t.ok(t.send(ALICE, ROUTER, "swapExactTokensForTokens", { amountIn: n(COIN), amountOutMin: "1n", path: [EVIL, TKA], to: ALICE, deadline: DEADLINE }));
  assert.notDeepEqual(t.query(pair, "getReserves"), r0);
});

test("dex: แก๊สภายใต้ fork bluewolf — addLiquidity · swap 1 hop · swap 2 hop (ต่ำกว่าเพดาน block 5M มาก)", () => {
  const t = setup();
  const create = t.ok(t.send(ALICE, ROUTER, "createPair", { tokenA: TKA, tokenB: TKB }));
  t.ok(add(t, ALICE, TKA, TKB, 1000n * COIN, 1000n * COIN));   // ครั้งแรก (key ใหม่เยอะ)
  t.ok(add(t, ALICE, TKB, TKC, 1000n * COIN, 1000n * COIN));
  const addRes = t.ok(add(t, BOB, TKA, TKB, 10n * COIN, 10n * COIN));
  const swap1 = t.ok(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(COIN), amountOutMin: "0n", path: [TKA, TKB], to: BOB, deadline: DEADLINE }));
  const swap2 = t.ok(t.send(BOB, ROUTER, "swapExactTokensForTokens", { amountIn: n(COIN), amountOutMin: "0n", path: [TKA, TKB, TKC], to: BOB, deadline: DEADLINE }));
  const direct = (() => {
    const pair = t.query(ROUTER, "getPair", { tokenA: TKA, tokenB: TKB });
    t.ok(t.send(EVE, TKA, "transfer", { to: pair, amount: n(COIN) }));
    const r = t.query(pair, "getReserves");
    return t.ok(t.send(EVE, pair, "swap", { amount0Out: "0n", amount1Out: n(outFor(COIN, big(r.reserve0), big(r.reserve1))), to: EVE }));
  })();
  const gas = { createPair: create.gasUsed, addLiquidity: addRes.gasUsed, swap1hop: swap1.gasUsed, swap2hop: swap2.gasUsed, pairSwapDirect: direct.gasUsed };
  console.log("dex gas (bluewolf):", JSON.stringify(gas));
  for (const [name, used] of Object.entries(gas)) assert.ok(used > 15_000 && used < 2_000_000, `${name} ${used}`);
});
