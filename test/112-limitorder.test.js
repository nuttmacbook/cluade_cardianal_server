import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { reviewProgram } from "../src/core/autoreview.js";
import { checkStandard } from "../src/standards/token.js";
import {
  LIMIT_ORDER_PROGRAM, LIMIT_ORDER_FUNCTIONS, LIMIT_ORDER_EVENTS, LIMIT_ORDER_MAX_BATCH, LIMIT_ORDER_BEST_SCAN,
} from "../src/standards/limitorder.js";

/*
 * Limit order book (src/standards/limitorder.js): escrow ของ maker · taker กินเอง · ไม่มีค่าธรรมเนียม
 *   ทุกสถานการณ์จบด้วยการตรวจ escrow invariant: ยอดของโปรแกรมในแต่ละ token = ผลรวม remaining ของ order ที่ยังเปิด
 */

const T = Date.parse("2026-11-01T00:00:00Z");
const SEC = BigInt(T / 1000);
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const ALICE = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b1";
const CAROL = "0x00000000000000000000000000000000000000c1";
const BOOK = "0x000000000000000000000000000000000000b00c";
const TA = "0x000000000000000000000000000000000000aaa1";
const TB = "0x000000000000000000000000000000000000bbb1";
const TC = "0x000000000000000000000000000000000000ccc1";
const FEE = "0x000000000000000000000000000000000000fee1";
const LIAR = "0x0000000000000000000000000000000000001ee1";
const EVIL = "0x000000000000000000000000000000000000e111";
const SUPPLY = 1_000_000_000n;

/** token สำหรับทดสอบ: mode "fee" = หัก 1% ทุกการโอน (เผาทิ้ง) · "lie" = transfer ตอบ true แต่ไม่โอน · "reenter" = transferFrom เรียกกลับเข้า book */
const TEST_TOKEN = `function program() {
  function initialization(params) {
    writeDB("mode", params.input.mode)
    for (const who of params.input.holders) writeDB(map("bal", who), params.input.amount)
  }
  function balanceOf(params) { return readDB(map("bal", params.input.who)) || 0n }
  function approve(params) { writeDB(map("allow", params.context.sender, params.input.spender), params.input.amount); return true }
  function move(from, to, amount) {
    const b = readDB(map("bal", from)) || 0n
    if (amount <= 0n || b < amount) throw new Error("insufficient balance")
    let fee = 0n
    if (readDB("mode") === "fee") fee = amount / 100n
    writeDB(map("bal", from), b - amount)
    writeDB(map("bal", to), (readDB(map("bal", to)) || 0n) + amount - fee)
  }
  function transfer(params) {
    if (readDB("mode") === "lie") return true
    move(params.context.sender, params.input.to, params.input.amount)
    return true
  }
  function transferFrom(params) {
    const a = readDB(map("allow", params.input.from, params.context.sender)) || 0n
    if (a < params.input.amount) throw new Error("insufficient allowance")
    writeDB(map("allow", params.input.from, params.context.sender), a - params.input.amount)
    move(params.input.from, params.input.to, params.input.amount)
    const attack = readDB("attack")
    if (attack && attack.target) runProgram(attack.target, attack.fn, attack.input)
    return true
  }
  function setAttack(params) { writeDB("attack", params.input) ; return true }
  return { balanceOf, approve, transfer, transferFrom, setAttack }
}`;

const big = (v) => (typeof v === "string" && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v);
const deep = (v) => (Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : big(v));
const s = (n) => `${n}n`;

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, forks: { bluewolf: 0 }, maxBlockGas: 5_000_000, maxTxGas: 5_000_000 });
  vm.db.load(Object.fromEntries([DEPLOYER, ALICE, BOB, CAROL].map((a) => [VM.nativeKey(a, "received"), "1000000n"])));
  let time = T;
  const block = (fn, at) => {
    time = at ?? time + 1000;
    const b = vm.createBlock({ timestamp: time });
    const out = fn(b);
    b.commit();
    return out;
  };
  const ok = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return res;
  };
  const deploy = (programUuid, code, initInput) => block((b) => {
    ok(b.deploy({ programUuid, code, context: { sender: DEPLOYER, origin: DEPLOYER }, initInput }));
    ok(b.init({ programUuid }));
  });
  const send = (who, programUuid, functionName, input = {}, extra = {}) =>
    block((b) => b.call({ programUuid, functionName, input, context: { sender: who, origin: who }, ...extra }), extra.at);
  const query = (programUuid, functionName, input = {}, at = time) => deep(ok(vm.query({ programUuid, functionName, input }, { timestamp: at })).result);
  const fails = (res, message) => {
    assert.equal(res.status, "throw", `expected throw, got ${JSON.stringify(res.result)}`);
    if (message) assert.match(res.error.message, message);
    return res;
  };

  deploy(BOOK, LIMIT_ORDER_PROGRAM, { namespace: "limit-orders", description: "on-chain limit order book" });
  for (const [address, ticker] of [[TA, "AAA"], [TB, "BBB"], [TC, "CCC"]]) {
    deploy(address, TOKEN_PROGRAM, { name: ticker, ticker, decimals: "6n", supply: s(SUPPLY * 3n), owner: DEPLOYER });
    for (const who of [ALICE, BOB, CAROL]) ok(send(DEPLOYER, address, "transfer", { to: who, amount: s(SUPPLY) }));
  }
  deploy(FEE, TEST_TOKEN, { mode: "fee", holders: [ALICE, BOB], amount: s(SUPPLY) });
  deploy(LIAR, TEST_TOKEN, { mode: "lie", holders: [ALICE, BOB], amount: s(SUPPLY) });
  deploy(EVIL, TEST_TOKEN, { mode: "reenter", holders: [ALICE, BOB], amount: s(SUPPLY) });
  const tokens = [TA, TB, TC, FEE, LIAR, EVIL];
  for (const token of tokens) for (const who of [ALICE, BOB, CAROL]) ok(send(who, token, "approve", { spender: BOOK, amount: s(SUPPLY * 10n) }));

  const bal = (token, who) => query(token, "balanceOf", { who });
  const now = () => time;
  /** escrow invariant: balanceOf(BOOK) ของทุก token = Σ remaining ของ order ที่ยังเปิด (open / expired) */
  const invariant = () => {
    const count = query(BOOK, "orderCount");
    const sums = Object.fromEntries(tokens.map((t) => [t, 0n]));
    for (let id = 0n; id < count; id++) {
      const order = query(BOOK, "getOrder", { orderId: s(id) });
      if (order.status === "open" || order.status === "expired") sums[order.sellToken] += order.remaining;
      else assert.equal(order.remaining, 0n, `order ${id} closed but remaining > 0`);
      assert.ok(order.filled + order.remaining <= order.sellAmount);
    }
    assert.equal(BigInt(vm.nativeBalanceOf(BOOK).balance), 0n, "book never holds native coin");
    for (const token of tokens) {
      if (token === LIAR) continue;   // token ที่โกหกไม่มีความหมาย แต่ยอดที่ฝากไว้ต้องไม่หาย (ตรวจแยก)
      assert.equal(bal(token, BOOK), sums[token], `escrow mismatch for ${token}`);
    }
    return sums;
  };
  const place = (who, input, extra) => {
    const res = ok(send(who, BOOK, "placeOrder", input, extra));
    return { id: big(res.result), res };
  };
  return { vm, ok, send, query, fails, bal, invariant, place, now, block };
}

// ---------------------------------------------------------------------------

test("limitorder: โค้ดผ่าน autoreview · export ครบ · emit event ครบ · metadata ตั้งตอน init", () => {
  assert.ok(reviewProgram(LIMIT_ORDER_PROGRAM).ok, reviewProgram(LIMIT_ORDER_PROGRAM).message);
  assert.deepEqual(checkStandard(LIMIT_ORDER_PROGRAM, [...LIMIT_ORDER_FUNCTIONS, "getOrder", "orderCount", "ordersOf", "ordersForPair", "bestOrders", "quoteFill"], LIMIT_ORDER_EVENTS), { ok: true, missing: [] });
  const t = setup();
  assert.equal(t.vm.resolveNamespace("limit-orders"), BOOK);
  assert.equal(t.vm.getMetadata(BOOK).description, "on-chain limit order book");
  assert.equal(t.vm.getMetadata(BOOK).upgrader, undefined);
  assert.equal(t.query(BOOK, "orderCount"), 0n);
  t.invariant();
});

test("limitorder: วาง order → escrow · กินบางส่วน (ปัดขึ้น) · กินจนหมด → filled", () => {
  const t = setup();
  // ALICE ขาย 1,000 AAA แลก 3,000 BBB (ราคา 3 BBB / AAA)
  const { id, res } = t.place(ALICE, { sellToken: TA, sellAmount: "1000n", buyToken: TB, buyAmount: "3000n" });
  assert.equal(id, 0n);
  console.log("gas placeOrder:", res.gasUsed);
  const placed = res.events.find((e) => e.name === "OrderPlaced");
  assert.deepEqual(deep(placed.data), { orderId: 0n, maker: ALICE, sellToken: TA, buyToken: TB, sellAmount: 1000n, buyAmount: 3000n, expiresAt: 0n, allowPartial: true });
  assert.equal(t.bal(TA, BOOK), 1000n);
  assert.equal(t.bal(TA, ALICE), SUPPLY - 1000n);
  t.invariant();

  assert.deepEqual(t.query(BOOK, "quoteFill", { orderId: "0n", sellAmountToTake: "333n" }), { ok: true, reason: "", sold: 333n, paid: 999n, remainingAfter: 667n });
  const fill = t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: "0n", sellAmountToTake: "333n", maxBuyAmount: "999n" }));
  console.log("gas fillOrder (partial):", fill.gasUsed);
  assert.deepEqual(deep(fill.result), { orderId: 0n, sold: 333n, paid: 999n, remaining: 667n });
  assert.deepEqual(deep(fill.events.find((e) => e.name === "OrderFilled").data), { orderId: 0n, taker: BOB, maker: ALICE, sold: 333n, paid: 999n, remaining: 667n });
  assert.equal(t.bal(TB, ALICE), SUPPLY + 999n);
  assert.equal(t.bal(TA, BOB), SUPPLY + 333n);
  t.invariant();

  const order = t.query(BOOK, "getOrder", { orderId: "0n" });
  assert.equal(order.status, "open");
  assert.equal(order.remaining, 667n);
  assert.equal(order.filled, 333n);
  assert.equal(order.paid, 999n);

  const last = t.ok(t.send(CAROL, BOOK, "fillOrder", { orderId: "0n", sellAmountToTake: "667n" }));
  console.log("gas fillOrder (full):", last.gasUsed);
  assert.equal(t.query(BOOK, "getOrder", { orderId: "0n" }).status, "filled");
  assert.equal(t.bal(TB, ALICE), SUPPLY + 3000n);
  t.fails(t.send(CAROL, BOOK, "fillOrder", { orderId: "0n", sellAmountToTake: "1n" }), /already filled/);
  assert.deepEqual(t.query(BOOK, "quoteFill", { orderId: "0n", sellAmountToTake: "1n" }).reason, "order filled");
  assert.equal(t.query(BOOK, "ordersForPair", { sellToken: TA, buyToken: TB, openOnly: true }).total, 0n);
  t.invariant();
});

test("limitorder: ปัดขึ้นเสมอ — maker ไม่ได้น้อยกว่าราคา แม้กินทีละนิด", () => {
  const t = setup();
  // ขาย 3 AAA แลก 1 BBB: กิน 1 AAA ต้องจ่าย ⌈1/3⌉ = 1 BBB (ไม่ใช่ 0)
  const { id } = t.place(ALICE, { sellToken: TA, sellAmount: "3n", buyToken: TB, buyAmount: "1n" });
  for (let i = 0; i < 3; i++) {
    const r = deep(t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "1n" })).result);
    assert.equal(r.paid, 1n);
  }
  assert.equal(t.bal(TB, ALICE), SUPPLY + 3n, "maker ได้มากกว่าหรือเท่าราคาเสมอ");
  // ราคา 7 BBB ต่อ 3 AAA: กิน 2 → ⌈14/3⌉ = 5
  const two = t.place(ALICE, { sellToken: TA, sellAmount: "3n", buyToken: TB, buyAmount: "7n" });
  assert.equal(t.query(BOOK, "quoteFill", { orderId: s(two.id), sellAmountToTake: "2n" }).paid, 5n);
  t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(two.id), sellAmountToTake: "2n", maxBuyAmount: "4n" }), /exceeds maxBuyAmount/);
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(two.id), sellAmountToTake: "2n", maxBuyAmount: "5n" }));
  const after = t.query(BOOK, "getOrder", { orderId: s(two.id) });
  assert.ok(after.paid * 3n >= after.filled * 7n);
  t.invariant();
});

test("limitorder: allowPartial = false → กินได้ทั้ง order เท่านั้น", () => {
  const t = setup();
  const { id } = t.place(ALICE, { sellToken: TA, sellAmount: "500n", buyToken: TB, buyAmount: "100n", allowPartial: false });
  t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "499n" }), /does not allow partial/);
  assert.equal(t.query(BOOK, "quoteFill", { orderId: s(id), sellAmountToTake: "1n" }).ok, false);
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "500n" }));
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(id) }).status, "filled");
  t.invariant();
});

test("limitorder: ตรวจ input ของ placeOrder / fillOrder ทุกกรณี", () => {
  const t = setup();
  const base = { sellToken: TA, sellAmount: "10n", buyToken: TB, buyAmount: "10n" };
  const bad = [
    [{ ...base, sellToken: "0x12" }, /sellToken must be an address/],
    [{ ...base, buyToken: undefined }, /buyToken must be an address/],
    [{ ...base, buyToken: TA }, /must differ/],
    [{ ...base, sellToken: ALICE }, /must be a token program/],
    [{ ...base, buyToken: BOOK }, /cannot be this program/],
    [{ ...base, sellAmount: "0n" }, /sellAmount must be/],
    [{ ...base, sellAmount: "-5n" }, /sellAmount must be/],
    [{ ...base, sellAmount: "10" }, /sellAmount must be/],
    [{ ...base, buyAmount: "0n" }, /buyAmount must be/],
    [{ ...base, expiresAt: s(SEC) }, /in the future/],
    [{ ...base, expiresAt: "-1n" }, /expiresAt must be/],
    [{ ...base, expiresAt: "soon" }, /expiresAt must be/],
    [{ ...base, allowPartial: "yes" }, /allowPartial must be a boolean/],
    [{ ...base, sellAmount: s(SUPPLY + 1n) }, /insufficient balance/],
  ];
  for (const [input, message] of bad) t.fails(t.send(ALICE, BOOK, "placeOrder", input), message);
  t.fails(t.send(ALICE, BOOK, "placeOrder", base, { value: 5 }), /native coin not accepted/);
  t.fails(t.send(DEPLOYER, BOOK, "placeOrder", base), /insufficient allowance/);   // ยังไม่ approve
  assert.equal(t.query(BOOK, "orderCount"), 0n);

  const { id } = t.place(ALICE, base);
  const fill = (who, input) => t.send(who, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "5n", ...input });
  t.fails(fill(ALICE, {}), /your own order/);
  t.fails(fill(BOB, { orderId: "9n" }), /does not exist/);
  t.fails(fill(BOB, { orderId: "-1n" }), /orderId must be/);
  t.fails(fill(BOB, { orderId: "0" }), /orderId must be/);
  t.fails(fill(BOB, { sellAmountToTake: "0n" }), /sellAmountToTake must be/);
  t.fails(fill(BOB, { sellAmountToTake: "11n" }), /exceeds remaining/);
  t.fails(fill(BOB, { maxBuyAmount: "-1n" }), /maxBuyAmount must be/);
  t.fails(t.send(DEPLOYER, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "5n" }), /insufficient allowance/);
  t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "5n" }, { value: 1 }), /native coin/);
  t.fails(t.send(BOB, BOOK, "quoteFill", { orderId: s(id), sellAmountToTake: "0n" }), /sellAmountToTake must be/);
  t.invariant();
});

test("limitorder: หมดอายุ (unix วินาที) → กินไม่ได้ · ใครก็คืน escrow ให้ maker ได้ · ยกเลิกได้เฉพาะ maker", () => {
  const t = setup();
  const expiresAt = BigInt(Math.floor(t.now() / 1000)) + 60n;
  const { id } = t.place(ALICE, { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "200n", expiresAt: s(expiresAt) });
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "40n" }));
  t.fails(t.send(CAROL, BOOK, "cancelExpired", { orderId: s(id) }), /has not expired/);
  t.fails(t.send(BOB, BOOK, "cancelOrder", { orderId: s(id) }), /only the maker/);

  const at = Number(expiresAt) * 1000;   // วินาทีของ block = expiresAt → หมดอายุแล้ว
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(id) }, at).status, "expired");
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(id) }, at - 1000).status, "open");
  assert.equal(t.query(BOOK, "quoteFill", { orderId: s(id), sellAmountToTake: "1n" }, at).reason, "order expired");
  t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "1n" }, { at }), /order expired/);
  t.invariant();   // expired แต่ยังไม่คืน = ยังอยู่ใน escrow

  const before = t.bal(TA, ALICE);
  const res = t.ok(t.send(CAROL, BOOK, "cancelExpired", { orderId: s(id) }, { at: at + 1000 }));
  console.log("gas cancelExpired:", res.gasUsed);
  assert.equal(big(res.result), 60n);
  assert.deepEqual(deep(res.events.find((e) => e.name === "OrderCancelled").data), { orderId: id, maker: ALICE, by: CAROL, refunded: 60n, reason: "expired" });
  assert.equal(t.bal(TA, ALICE), before + 60n);
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(id) }).status, "cancelled");
  t.fails(t.send(CAROL, BOOK, "cancelExpired", { orderId: s(id) }), /not open/);
  t.fails(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(id) }), /not open/);
  t.invariant();
});

test("limitorder: cancelOrder คืนยอดที่เหลือ · ยกเลิกซ้ำ / กินหลังยกเลิกไม่ได้", () => {
  const t = setup();
  const { id } = t.place(ALICE, { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "100n" });
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "30n" }));
  const before = t.bal(TA, ALICE);
  const res = t.ok(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(id) }));
  console.log("gas cancelOrder:", res.gasUsed);
  assert.equal(big(res.result), 70n);
  assert.equal(t.bal(TA, ALICE), before + 70n);
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(id) }).filled, 30n);
  t.fails(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(id) }), /not open/);
  t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "1n" }), /order cancelled/);
  t.fails(t.send(ALICE, BOOK, "cancelOrder", { orderId: "5n" }), /does not exist/);
  t.invariant();
});

test("limitorder: fillOrders กินหลาย order (buyToken เดียวกัน) · maxTotalBuy · จำกัดจำนวน · ล้มทั้งชุด", () => {
  const t = setup();
  const a = t.place(ALICE, { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "200n" }).id;
  const c = t.place(CAROL, { sellToken: TC, sellAmount: "50n", buyToken: TB, buyAmount: "75n" }).id;
  const d = t.place(CAROL, { sellToken: TA, sellAmount: "10n", buyToken: TC, buyAmount: "10n" }).id;
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills: [{ orderId: s(a), sellAmountToTake: "10n" }, { orderId: s(d), sellAmountToTake: "1n" }] }), /same buyToken/);
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills: [] }), /non-empty/);
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills: "x" }), /non-empty/);
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills: [5] }), /each fill/);
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills: Array.from({ length: LIMIT_ORDER_MAX_BATCH + 1 }, () => ({ orderId: s(a), sellAmountToTake: "1n" })) }), /too many fills/);
  const fills = [{ orderId: s(a), sellAmountToTake: "50n" }, { orderId: s(c), sellAmountToTake: "50n" }];   // 100 + 75 = 175 BBB
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills, maxTotalBuy: "174n" }), /exceeds maxTotalBuy/);
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills, maxTotalBuy: "x" }), /maxTotalBuy must be/);
  t.fails(t.send(ALICE, BOOK, "fillOrders", { fills }), /your own order/);   // ALICE มี order a อยู่ในชุด → ทั้งชุดล้ม
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(c) }).remaining, 50n);

  const res = t.ok(t.send(BOB, BOOK, "fillOrders", { fills, maxTotalBuy: "175n" }));
  console.log("gas fillOrders (2):", res.gasUsed);
  assert.deepEqual(deep(res.result), { count: 2n, sold: [50n, 50n], paid: [100n, 75n], totalPaid: 175n });
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(c) }).status, "filled");
  assert.equal(t.bal(TB, CAROL), SUPPLY + 75n);
  // order เดียวกันซ้ำในชุด: รายการหลังเห็นยอดที่ลดแล้ว
  t.fails(t.send(BOB, BOOK, "fillOrders", { fills: [{ orderId: s(a), sellAmountToTake: "30n" }, { orderId: s(a), sellAmountToTake: "30n" }] }), /exceeds remaining/);
  t.ok(t.send(BOB, BOOK, "fillOrders", { fills: [{ orderId: s(a), sellAmountToTake: "25n" }, { orderId: s(a), sellAmountToTake: "25n" }] }));
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(a) }).status, "filled");
  t.invariant();
});

test("limitorder: fillOrders เต็มชุด 20 รายการ อยู่ในงบแก๊ส", () => {
  const t = setup();
  const ids = [];
  for (let i = 0; i < LIMIT_ORDER_MAX_BATCH; i++) ids.push(t.place(ALICE, { sellToken: TA, sellAmount: "10n", buyToken: TB, buyAmount: s(10n + BigInt(i)) }).id);
  const res = t.ok(t.send(BOB, BOOK, "fillOrders", { fills: ids.map((id) => ({ orderId: s(id), sellAmountToTake: "10n" })) }));
  console.log(`gas fillOrders (${LIMIT_ORDER_MAX_BATCH}):`, res.gasUsed);
  assert.ok(res.gasUsed < 2_500_000, `${res.gasUsed}`);
  t.invariant();
});

test("limitorder: อ่าน — ordersOf / ordersForPair (ทั้งหมด / เฉพาะที่เปิด) / bestOrders เรียงราคาดีสุด", () => {
  const t = setup();
  // ขาย AAA แลก BBB ราคาต่าง ๆ (BBB ต่อ AAA): 3, 2, 5, 2 (id น้อยก่อน), 1 (หมดอายุ), 4 (ยกเลิก)
  const prices = [[100n, 300n], [100n, 200n], [10n, 50n], [50n, 100n]];
  const ids = prices.map(([sell, buy], i) => t.place(i % 2 ? BOB : ALICE, { sellToken: TA, sellAmount: s(sell), buyToken: TB, buyAmount: s(buy) }).id);
  const soon = BigInt(Math.floor(t.now() / 1000)) + 30n;
  const expired = t.place(CAROL, { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "100n", expiresAt: s(soon) }).id;
  const cancelled = t.place(ALICE, { sellToken: TA, sellAmount: "10n", buyToken: TB, buyAmount: "40n" }).id;
  t.ok(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(cancelled) }));
  t.place(ALICE, { sellToken: TB, sellAmount: "10n", buyToken: TA, buyAmount: "1n" });   // คู่กลับด้าน: ไม่ปน
  const later = Number(soon) * 1000 + 1000;

  assert.equal(t.query(BOOK, "orderCount"), 7n);
  const mine = t.query(BOOK, "ordersOf", { maker: ALICE });
  assert.equal(mine.total, 4n);
  assert.deepEqual(mine.orders.map((o) => o.orderId), [ids[0], ids[2], cancelled, 6n]);
  assert.deepEqual(t.query(BOOK, "ordersOf", { maker: ALICE, start: "1n", limit: "2n" }).orders.map((o) => o.orderId), [ids[2], cancelled]);
  assert.deepEqual(t.query(BOOK, "ordersOf", { maker: ALICE, start: "10n" }).orders, []);

  const all = t.query(BOOK, "ordersForPair", { sellToken: TA, buyToken: TB });
  assert.equal(all.total, 6n);
  assert.equal(all.orders.find((o) => o.orderId === cancelled).status, "cancelled");
  const open = t.query(BOOK, "ordersForPair", { sellToken: TA, buyToken: TB, openOnly: true });
  assert.equal(open.total, 5n);
  assert.deepEqual(open.orders.map((o) => o.orderId).sort(), [...ids, expired].sort());

  const best = t.query(BOOK, "bestOrders", { sellToken: TA, buyToken: TB, limit: "3n" }, later);
  assert.deepEqual(best.orders.map((o) => o.orderId), [ids[1], ids[3], ids[0]], "ราคา 2 (id น้อยก่อน), 2, 3 · ข้ามที่หมดอายุ");
  assert.equal(best.totalOpen, 5n);
  assert.equal(best.scanned, 5n);
  assert.equal(best.truncated, false);
  // ก่อนหมดอายุ: order ราคา 1 ดีสุด
  assert.equal(t.query(BOOK, "bestOrders", { sellToken: TA, buyToken: TB, limit: "1n" }).orders[0].orderId, expired);
  assert.deepEqual(t.query(BOOK, "bestOrders", { sellToken: TB, buyToken: TC }).orders, []);

  for (const [fn, input, message] of [
    ["ordersOf", { maker: "nope" }, /maker must be an address/],
    ["ordersOf", { maker: ALICE, limit: "0n" }, /limit must be/],
    ["ordersOf", { maker: ALICE, limit: "51n" }, /limit must be/],
    ["ordersOf", { maker: ALICE, start: "-1n" }, /start must be/],
    ["ordersForPair", { sellToken: TA, buyToken: 1 }, /buyToken must be/],
    ["bestOrders", { sellToken: TA, buyToken: TB, limit: "100n" }, /limit must be/],
    ["getOrder", { orderId: "99n" }, /does not exist/],
  ]) t.fails(t.vm.query({ programUuid: BOOK, functionName: fn, input }), message);
  t.invariant();
});

test("limitorder: bestOrders ตรวจได้ไม่เกิน 100 order ต่อครั้ง (truncated) · เรียกต่อด้วย start", () => {
  const t = setup();
  const n = LIMIT_ORDER_BEST_SCAN + 5;
  for (let i = 0; i < n; i++) t.place(ALICE, { sellToken: TA, sellAmount: "10n", buyToken: TB, buyAmount: s(BigInt(1000 - i)) });
  const first = t.query(BOOK, "bestOrders", { sellToken: TA, buyToken: TB, limit: "2n" });
  assert.equal(first.scanned, BigInt(LIMIT_ORDER_BEST_SCAN));
  assert.equal(first.truncated, true);
  assert.deepEqual(first.orders.map((o) => o.orderId), [99n, 98n]);
  const rest = t.query(BOOK, "bestOrders", { sellToken: TA, buyToken: TB, limit: "2n", start: s(BigInt(LIMIT_ORDER_BEST_SCAN)) });
  assert.equal(rest.truncated, false);
  assert.deepEqual(rest.orders.map((o) => o.orderId), [104n, 103n]);
  const gas = t.vm.query({ programUuid: BOOK, functionName: "bestOrders", input: { sellToken: TA, buyToken: TB, limit: "50n" } }, { timestamp: t.now() }).gasUsed;
  console.log("gas bestOrders (scan 100, limit 50):", gas);
  assert.ok(gas < 5_000_000);
  t.invariant();
});

test("limitorder: รายการเปิดลบแบบสลับตัวท้าย ยังถูกต้องหลังปิด order กลางรายการ", () => {
  const t = setup();
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(t.place(ALICE, { sellToken: TA, sellAmount: "10n", buyToken: TB, buyAmount: "10n" }).id);
  t.ok(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(ids[1]) }));
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(ids[0]), sellAmountToTake: "10n" }));
  t.ok(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(ids[4]) }));
  const open = t.query(BOOK, "ordersForPair", { sellToken: TA, buyToken: TB, openOnly: true });
  assert.deepEqual(open.orders.map((o) => o.orderId).sort(), [ids[2], ids[3]]);
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(ids[3]), sellAmountToTake: "10n" }));
  t.ok(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(ids[2]) }));
  assert.equal(t.query(BOOK, "ordersForPair", { sellToken: TA, buyToken: TB, openOnly: true }).total, 0n);
  t.place(ALICE, { sellToken: TA, sellAmount: "10n", buyToken: TB, buyAmount: "10n" });
  assert.equal(t.query(BOOK, "ordersForPair", { sellToken: TA, buyToken: TB, openOnly: true }).total, 1n);
  t.invariant();
});

test("limitorder: token หักค่าโอน — order ขายเท่าที่ได้รับจริง · ใช้เป็น buyToken ไม่ได้ (maker ได้น้อยกว่าราคา)", () => {
  const t = setup();
  const { id } = t.place(ALICE, { sellToken: FEE, sellAmount: "1000n", buyToken: TB, buyAmount: "990n" });
  const order = t.query(BOOK, "getOrder", { orderId: s(id) });
  assert.equal(order.sellAmount, 990n, "ฝากจริง 990 (หัก 1%)");
  assert.equal(t.bal(FEE, BOOK), 990n);
  t.invariant();
  // ส่ง FEE ออกจาก escrow: ยอดของโปรแกรมลดเท่าที่ส่งพอดี (ผู้รับโดนหักเอง) → ผ่าน
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "500n" }));
  assert.equal(t.bal(FEE, BOB), SUPPLY + 495n);
  t.invariant();
  // FEE เป็นของที่ maker ขอรับ → maker ได้ไม่ครบ → ล้ม
  const other = t.place(ALICE, { sellToken: TA, sellAmount: "100n", buyToken: FEE, buyAmount: "100n" }).id;
  t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(other), sellAmountToTake: "100n" }), /maker received less than the price/);
  t.ok(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(id) }));
  t.invariant();
});

test("limitorder: token ที่ตอบ true แต่ไม่โอนจริง → fill / cancel ล้ม ไม่กระทบ escrow ของ token อื่น", () => {
  const t = setup();
  const good = t.place(ALICE, { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "100n" }).id;
  const { id } = t.place(ALICE, { sellToken: LIAR, sellAmount: "100n", buyToken: TB, buyAmount: "100n" });
  assert.equal(t.bal(LIAR, BOOK), 100n);
  t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(id), sellAmountToTake: "10n" }), /accounting mismatch/);
  t.fails(t.send(ALICE, BOOK, "cancelOrder", { orderId: s(id) }), /accounting mismatch/);
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(id) }).remaining, 100n);
  assert.equal(t.bal(LIAR, BOOK), 100n);
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(good), sellAmountToTake: "100n" }));
  t.invariant();
});

test("limitorder: reentrancy — token เรียกกลับเข้า book ระหว่างโอน → ล้มด้วย reentrant call", () => {
  const t = setup();
  const victim = t.place(CAROL, { sellToken: TA, sellAmount: "100n", buyToken: EVIL, buyAmount: "100n" }).id;
  const own = t.place(ALICE, { sellToken: EVIL, sellAmount: "100n", buyToken: TB, buyAmount: "100n" }).id;
  // ระหว่าง BOB จ่ายด้วย EVIL → EVIL พยายาม cancel / fill ซ้ำ
  for (const attack of [
    { target: BOOK, fn: "fillOrder", input: { orderId: s(victim), sellAmountToTake: "50n" } },
    { target: BOOK, fn: "cancelOrder", input: { orderId: s(own) } },
    { target: BOOK, fn: "placeOrder", input: { sellToken: EVIL, sellAmount: "1n", buyToken: TB, buyAmount: "1n" } },
  ]) {
    t.ok(t.send(ALICE, EVIL, "setAttack", attack));
    t.fails(t.send(BOB, BOOK, "fillOrder", { orderId: s(victim), sellAmountToTake: "50n" }), /reentrant call/);
    t.fails(t.send(ALICE, BOOK, "placeOrder", { sellToken: EVIL, sellAmount: "5n", buyToken: TB, buyAmount: "1n" }), /reentrant call/);
  }
  assert.equal(t.query(BOOK, "getOrder", { orderId: s(victim) }).remaining, 100n);
  t.ok(t.send(ALICE, EVIL, "setAttack", {}));
  t.ok(t.send(BOB, BOOK, "fillOrder", { orderId: s(victim), sellAmountToTake: "50n" }));
  t.invariant();
});

test("limitorder: tx ที่ล้มไม่ทิ้งตัวล็อกค้าง · ใช้งานต่อได้", () => {
  const t = setup();
  t.fails(t.send(ALICE, BOOK, "placeOrder", { sellToken: TA, sellAmount: "1n", buyToken: TA, buyAmount: "1n" }));
  assert.equal(t.vm.read(`${BOOK}:storage:lock`), undefined);
  t.place(ALICE, { sellToken: TA, sellAmount: "1n", buyToken: TB, buyAmount: "1n" });
  t.invariant();
});

test("limitorder: จำนวน ≥ 2^128 → too large · expiresAt เป็นมิลลิวินาที → ล้ม · bestOrders ยังใช้ได้", () => {
  const t = setup();
  const good = t.place(ALICE, { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "200n" }).id;
  const huge = s(2n ** 128n);
  t.fails(t.send(BOB, BOOK, "placeOrder", { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: huge }), /too large/);
  t.fails(t.send(BOB, BOOK, "placeOrder", { sellToken: TA, sellAmount: huge, buyToken: TB, buyAmount: "100n" }), /too large/);
  t.fails(t.send(BOB, BOOK, "placeOrder", { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: s(2n ** 8000n) }), /too large/);
  t.fails(t.send(BOB, BOOK, "placeOrder", { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "100n", expiresAt: "100000000000n" }), /milliseconds/);
  t.fails(t.send(BOB, BOOK, "placeOrder", { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "100n", expiresAt: s(BigInt(t.now()) + 60_000n) }), /milliseconds/);
  assert.equal(t.query(BOOK, "orderCount"), 1n);
  const best = t.query(BOOK, "bestOrders", { sellToken: TA, buyToken: TB });
  assert.deepEqual(best.orders.map((o) => o.orderId), [good]);
  t.invariant();
});

test("limitorder: ห้ามแนบ native value — placeOrder / ฟังก์ชันอ่าน getOrder / bestOrders ล้ม · book ไม่ถือเหรียญหลัก", () => {
  const t = setup();
  const id = t.place(ALICE, { sellToken: TA, sellAmount: "100n", buyToken: TB, buyAmount: "200n" }).id;
  const a0 = BigInt(t.vm.nativeBalanceOf(ALICE).balance);
  t.fails(t.send(ALICE, BOOK, "placeOrder", { sellToken: TA, sellAmount: "1n", buyToken: TB, buyAmount: "1n" }, { value: "10" }), /native coin not accepted/);   // ฟังก์ชันเขียน state ปฏิเสธอยู่แล้ว
  t.fails(t.send(ALICE, BOOK, "getOrder", { orderId: s(id) }, { value: "10" }), /this function does not accept native value/);
  t.fails(t.send(ALICE, BOOK, "bestOrders", { sellToken: TA, buyToken: TB }, { value: "10" }), /this function does not accept native value/);
  assert.equal(BigInt(t.vm.nativeBalanceOf(BOOK).balance), 0n);
  assert.equal(BigInt(t.vm.nativeBalanceOf(ALICE).balance), a0);
  t.invariant();
});
