/**
 * Limit order book บนเชน (escrow) — ผู้ขาย (maker) ฝาก token ไว้ในโปรแกรม ผู้ซื้อ (taker) มากินเอง · ไม่มีการจับคู่นอกเชน · ไม่มีค่าธรรมเนียม
 *   ซื้อขายได้เฉพาะ token · เหรียญหลัก (BWSC) ต้องห่อเป็น WBWSC (WCARD_PROGRAM ใน system.js, namespace "wbwsc") ก่อน · แนบ value มา = throw
 *   ไม่มี owner / admin / upgrade · input ตอน deploy: { namespace?, icon?, url?, contact?, description? }
 *
 * ฟังก์ชันที่เปลี่ยน state (ทุกตัวมีตัวล็อกกันเรียกซ้อน "reentrant call" · เขียน state ก่อนเรียก token เสมอ ยกเว้นตอนรับเงินฝากของ placeOrder ที่ต้องวัดยอด)
 *   placeOrder({ sellToken, sellAmount, buyToken, buyAmount, expiresAt?, allowPartial? }) → orderId (bigint เริ่ม 0n)
 *       ดึง sellAmount ด้วย sellToken.transferFrom(maker → โปรแกรม) (maker ต้อง approve ก่อน) · ยอดที่ฝากจริง = ยอด balanceOf ของโปรแกรมที่เพิ่มขึ้น
 *       (token หักค่าโอน → order ขายเท่าที่ได้รับจริง แต่ราคารวม buyAmount เท่าเดิม) · ราคา = buyAmount / sellAmount (ของที่ฝากจริง)
 *       expiresAt = unix **วินาที** (0n / ไม่ส่ง = ไม่หมดอายุ) ต้องมากกว่าเวลาของ block · หมดอายุเมื่อ วินาทีของ block ≥ expiresAt
 *       allowPartial (ค่าเริ่ม true) · false = ต้องกินทั้ง order ในครั้งเดียว · sellToken ≠ buyToken · ทั้งคู่ต้องเป็นโปรแกรม
 *   fillOrder({ orderId, sellAmountToTake, maxBuyAmount? }) → { orderId, sold, paid, remaining }
 *       taker จ่าย paid = ⌈sellAmountToTake × buyAmount / sellAmount⌉ (ปัดขึ้น: maker ไม่ได้น้อยกว่าราคา) ด้วย buyToken.transferFrom(taker → maker)
 *       แล้วได้ sellToken จาก escrow · paid > maxBuyAmount → throw · ห้ามกิน order ของตัวเอง / order ที่หมดอายุ / ยกเลิก / ขายหมดแล้ว
 *       ตรวจยอดจริง: ยอดของ maker ต้องเพิ่ม ≥ paid และยอดของโปรแกรมต้องลดเท่ากับที่จ่ายออกพอดี (token ที่โกหก / หักค่าโอน → throw)
 *   fillOrders({ fills: [{ orderId, sellAmountToTake }, …] (1–20), maxTotalBuy? }) → { count, sold: [..], paid: [..], totalPaid }
 *       ทุกรายการต้องใช้ buyToken เดียวกัน · รวม paid > maxTotalBuy → throw · รายการใดล้ม = ทั้ง tx ล้ม
 *   cancelOrder({ orderId }) → refunded          เฉพาะ maker · คืนยอดที่เหลือ (order ที่หมดอายุแล้วก็ยกเลิกได้)
 *   cancelExpired({ orderId }) → refunded        ใครก็ได้ · เฉพาะ order ที่หมดอายุ · คืนยอดที่เหลือให้ maker
 * อ่าน (ไม่เปลี่ยน state)
 *   getOrder({ orderId }) → { orderId, maker, sellToken, buyToken, sellAmount, buyAmount, remaining, filled, paid, expiresAt, allowPartial,
 *       createdAt, status } · status = "open" | "expired" (เปิดอยู่แต่หมดเวลา ยังไม่คืน escrow) | "filled" | "cancelled"
 *   orderCount() → bigint
 *   ordersOf({ maker, start?, limit? }) → { total, orders }        order ของ maker ตามลำดับที่วาง (ตำแหน่ง start … start+limit-1)
 *   ordersForPair({ sellToken, buyToken, start?, limit?, openOnly? }) → { total, orders }
 *       openOnly = true → เฉพาะ order ที่ยังเปิด (รายการเปิดของคู่นี้ ลำดับไม่คงที่: ปิด order แล้วตัวท้ายย้ายมาแทน) · false = ทุก order ตามลำดับที่วาง
 *   bestOrders({ sellToken, buyToken, limit?, start? }) → { totalOpen, scanned, truncated, orders }
 *       ราคาดีสุดก่อน (buyAmount / sellAmount ต่ำสุด · เท่ากันเอา orderId น้อยก่อน) ข้าม order ที่หมดอายุ
 *       ตรวจไม่เกิน 100 order ที่เปิดอยู่ต่อครั้ง (ตำแหน่ง start …) · truncated = ยังมีที่ไม่ได้ตรวจ → เรียกซ้ำด้วย start ถัดไป
 *   quoteFill({ orderId, sellAmountToTake }) → { ok, reason, sold, paid, remainingAfter }   (ไม่ throw ตามสถานะ order · ตรวจเวลาของ block)
 *   limit ของการแบ่งหน้า: 1n … 50n (ค่าเริ่ม 20n) · start ค่าเริ่ม 0n
 * event
 *   OrderPlaced { orderId, maker, sellToken, buyToken, sellAmount, buyAmount, expiresAt, allowPartial }   indexed: orderId, maker, sellToken (EVM ได้ไม่เกิน 3)
 *   OrderFilled { orderId, taker, maker, sold, paid, remaining }                                          indexed: orderId, taker, maker
 *   OrderCancelled { orderId, maker, by, refunded, reason: "cancelled" | "expired" }                      indexed: orderId, maker
 * storage
 *   count · lock (มีเฉพาะระหว่าง tx) · orders:<id> → order (+ openPos = ตำแหน่งในรายการเปิด)
 *   makerCount:<maker> · makerOrders:<maker>:<i> → id
 *   pairCount:<sell>:<buy> · pairOrders:<sell>:<buy>:<i> → id          ทุก order ของคู่ (เพิ่มอย่างเดียว)
 *   openCount:<sell>:<buy> · openOrders:<sell>:<buy>:<i> → id          order ที่ยังเปิด (ลบแบบสลับตัวท้าย)
 * escrow invariant: ยอด balanceOf(โปรแกรมนี้) ของแต่ละ token = ผลรวม remaining ของ order ที่ยังเปิด (รวมที่หมดอายุแต่ยังไม่คืน) ใน token นั้น
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";

/** จำนวนรายการสูงสุดของ fillOrders ต่อ tx (~50k แก๊สต่อรายการ → 20 รายการ ≈ 1M ต่ำกว่า block 5M) */
export const LIMIT_ORDER_MAX_BATCH = 20;
/** bestOrders ตรวจ order ที่เปิดอยู่ได้ไม่เกินเท่านี้ต่อครั้ง */
export const LIMIT_ORDER_BEST_SCAN = 100;
/** limit สูงสุดของการแบ่งหน้า (ordersOf / ordersForPair / bestOrders) */
export const LIMIT_ORDER_MAX_PAGE = 50;

export const LIMIT_ORDER_FUNCTIONS = ["placeOrder", "fillOrder", "fillOrders", "cancelOrder", "cancelExpired"];
export const LIMIT_ORDER_EVENTS = ["OrderPlaced", "OrderFilled", "OrderCancelled"];

export const LIMIT_ORDER_PROGRAM = `function program() {
  const MAX_BATCH = ${LIMIT_ORDER_MAX_BATCH}
  const BEST_SCAN = ${LIMIT_ORDER_BEST_SCAN}n
  const MAX_PAGE = ${LIMIT_ORDER_MAX_PAGE}n
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    setProgramMetadata(params.input)
    writeDB("count", 0n)
  }

  // ---------- ตัวช่วย ----------
  function enter(params) {
    if (readDB("lock") === true) throw new Error("reentrant call")
    if (params.value !== undefined && params.value !== 0n) throw new Error("native coin not accepted: wrap it as WBWSC first")
    writeDB("lock", true)
  }
  function leave() { deleteDB("lock") }
  function nowSeconds(params) { return params.block.timestamp / 1000n }
  function checkAmount(value, label) {
    if (typeof value !== "bigint" || value <= 0n) throw new Error(label + " must be a bigint greater than 0")
    return value
  }
  function checkToken(address, label) {
    const token = checkAddress(address, label)
    if (token === ThisAddress()) throw new Error(label + " cannot be this program")
    if (!IsProgram(token)) throw new Error(label + " must be a token program")
    return token
  }
  function checkId(id) {
    if (typeof id !== "bigint" || id < 0n) throw new Error("orderId must be a non-negative bigint")
    const order = readDB(map("orders", id))
    if (order === undefined) throw new Error("order does not exist")
    return order
  }
  function pageOf(input) {
    const start = input.start === undefined || input.start === null ? 0n : input.start
    const limit = input.limit === undefined || input.limit === null ? 20n : input.limit
    if (typeof start !== "bigint" || start < 0n) throw new Error("start must be a non-negative bigint")
    if (typeof limit !== "bigint" || limit < 1n || limit > MAX_PAGE) throw new Error("limit must be 1n … " + MAX_PAGE + "n")
    return { start: start, limit: limit }
  }
  function isExpired(order, now) { return order.expiresAt !== 0n && now >= order.expiresAt }
  function statusOf(order, now) {
    if (order.status === "open" && isExpired(order, now)) return "expired"
    return order.status
  }
  function view(id, order, now) {
    return { orderId: id, maker: order.maker, sellToken: order.sellToken, buyToken: order.buyToken, sellAmount: order.sellAmount,
      buyAmount: order.buyAmount, remaining: order.remaining, filled: order.filled, paid: order.paid, expiresAt: order.expiresAt,
      allowPartial: order.allowPartial, createdAt: order.createdAt, status: statusOf(order, now) }
  }
  function balanceOfToken(token, who) {
    const value = runProgram(token, "balanceOf", { who: who }, { readonly: true })
    if (typeof value !== "bigint" || value < 0n) throw new Error("token balanceOf returned an invalid value")
    return value
  }
  // ⌈take × buyAmount / sellAmount⌉ คิดจากยอดตั้งต้นของ order ทุกครั้ง (ไม่สะสมเศษ)
  function priceFor(order, take) { return (take * order.buyAmount + order.sellAmount - 1n) / order.sellAmount }
  // ส่ง token ออกจาก escrow · ยอดของโปรแกรมต้องลดเท่ากับ amount พอดี (กัน token ที่โกหกหรือหักเกิน → ไม่กระทบ escrow ของ order อื่น)
  function payOut(token, to, amount) {
    const self = ThisAddress()
    const before = balanceOfToken(token, self)
    runProgram(token, "transfer", { to: to, amount: amount })
    if (before - balanceOfToken(token, self) !== amount) throw new Error("token transfer accounting mismatch")
  }
  function addIndex(countKey, itemKey, id) {
    const n = readDB(countKey) || 0n
    writeDB(itemKey(n), id)
    writeDB(countKey, n + 1n)
    return n
  }
  // เอา order ออกจากรายการเปิดของคู่ (ย้ายตัวท้ายมาแทนที่) · เรียกก่อนเขียน order ของตัวเอง
  function removeOpen(order) {
    const countKey = map("openCount", order.sellToken, order.buyToken)
    const last = readDB(countKey) - 1n
    if (order.openPos !== last) {
      const lastId = readDB(map("openOrders", order.sellToken, order.buyToken, last))
      const moved = readDB(map("orders", lastId))
      moved.openPos = order.openPos
      writeDB(map("orders", lastId), moved)
      writeDB(map("openOrders", order.sellToken, order.buyToken, order.openPos), lastId)
    }
    deleteDB(map("openOrders", order.sellToken, order.buyToken, last))
    writeDB(countKey, last)
    order.openPos = -1n
  }

  // ---------- เปลี่ยน state ----------
  function placeOrder(params) {
    enter(params)
    const input = params.input
    const maker = params.context.sender
    const sellToken = checkToken(input.sellToken, "sellToken")
    const buyToken = checkToken(input.buyToken, "buyToken")
    if (sellToken === buyToken) throw new Error("sellToken and buyToken must differ")
    const sellAmount = checkAmount(input.sellAmount, "sellAmount")
    const buyAmount = checkAmount(input.buyAmount, "buyAmount")
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? 0n : input.expiresAt
    if (typeof expiresAt !== "bigint" || expiresAt < 0n) throw new Error("expiresAt must be a non-negative bigint (unix seconds)")
    const now = nowSeconds(params)
    if (expiresAt !== 0n && expiresAt <= now) throw new Error("expiresAt must be in the future (unix seconds)")
    const allowPartial = input.allowPartial === undefined || input.allowPartial === null ? true : input.allowPartial
    if (typeof allowPartial !== "boolean") throw new Error("allowPartial must be a boolean")

    // รับเงินฝาก: วัดจากยอดจริงของโปรแกรม (ไม่เชื่อค่าที่ token ตอบ)
    const self = ThisAddress()
    const before = balanceOfToken(sellToken, self)
    runProgram(sellToken, "transferFrom", { from: maker, to: self, amount: sellAmount })
    const after = balanceOfToken(sellToken, self)
    if (after <= before) throw new Error("no tokens received")
    const received = after - before

    const id = readDB("count")
    writeDB("count", id + 1n)
    const openPos = addIndex(map("openCount", sellToken, buyToken), (n) => map("openOrders", sellToken, buyToken, n), id)
    addIndex(map("pairCount", sellToken, buyToken), (n) => map("pairOrders", sellToken, buyToken, n), id)
    addIndex(map("makerCount", maker), (n) => map("makerOrders", maker, n), id)
    writeDB(map("orders", id), { maker: maker, sellToken: sellToken, buyToken: buyToken, sellAmount: received, buyAmount: buyAmount,
      remaining: received, filled: 0n, paid: 0n, expiresAt: expiresAt, allowPartial: allowPartial, createdAt: now, status: "open", openPos: openPos })
    emit("OrderPlaced", { orderId: id, maker: maker, sellToken: sellToken, buyToken: buyToken, sellAmount: received, buyAmount: buyAmount,
      expiresAt: expiresAt, allowPartial: allowPartial }, { indexed: ["orderId", "maker", "sellToken"] })
    leave()
    return id
  }

  // ตรวจ + คำนวณ + เขียนผลของการกิน 1 order (ยังไม่โอน) → รายการที่ต้องโอน
  function takeEffects(params, id, take) {
    const order = checkId(id)
    const taker = params.context.sender
    checkAmount(take, "sellAmountToTake")
    if (order.status === "filled") throw new Error("order already filled")
    if (order.status === "cancelled") throw new Error("order cancelled")
    if (isExpired(order, nowSeconds(params))) throw new Error("order expired")
    if (order.maker === taker) throw new Error("cannot fill your own order")
    if (take > order.remaining) throw new Error("sellAmountToTake exceeds remaining")
    if (!order.allowPartial && take !== order.remaining) throw new Error("order does not allow partial fills")
    const pay = priceFor(order, take)
    order.remaining = order.remaining - take
    order.filled = order.filled + take
    order.paid = order.paid + pay
    if (order.remaining === 0n) {
      order.status = "filled"
      removeOpen(order)
    }
    writeDB(map("orders", id), order)
    emit("OrderFilled", { orderId: id, taker: taker, maker: order.maker, sold: take, paid: pay, remaining: order.remaining },
      { indexed: ["orderId", "taker", "maker"] })
    return { maker: order.maker, sellToken: order.sellToken, buyToken: order.buyToken, take: take, pay: pay, remaining: order.remaining }
  }
  // โอนจริง: taker จ่าย maker (วัดยอดที่ maker ได้) แล้วโปรแกรมส่ง sellToken ให้ taker
  function settle(taker, item) {
    const before = balanceOfToken(item.buyToken, item.maker)
    runProgram(item.buyToken, "transferFrom", { from: taker, to: item.maker, amount: item.pay })
    if (balanceOfToken(item.buyToken, item.maker) - before < item.pay) throw new Error("maker received less than the price")
    payOut(item.sellToken, taker, item.take)
  }

  function fillOrder(params) {
    enter(params)
    const item = takeEffects(params, params.input.orderId, params.input.sellAmountToTake)
    const max = params.input.maxBuyAmount
    if (max !== undefined && max !== null) {
      if (typeof max !== "bigint" || max < 0n) throw new Error("maxBuyAmount must be a non-negative bigint")
      if (item.pay > max) throw new Error("price exceeds maxBuyAmount")
    }
    settle(params.context.sender, item)
    leave()
    return { orderId: params.input.orderId, sold: item.take, paid: item.pay, remaining: item.remaining }
  }

  function fillOrders(params) {
    enter(params)
    const fills = params.input.fills
    if (!Array.isArray(fills) || fills.length === 0) throw new Error("fills must be a non-empty array")
    if (fills.length > MAX_BATCH) throw new Error("too many fills (max " + MAX_BATCH + ")")
    const max = params.input.maxTotalBuy
    if (max !== undefined && max !== null && (typeof max !== "bigint" || max < 0n)) throw new Error("maxTotalBuy must be a non-negative bigint")
    const items = []
    let buyToken = ""
    let total = 0n
    for (const fill of fills) {
      if (fill === null || typeof fill !== "object") throw new Error("each fill must be { orderId, sellAmountToTake }")
      const item = takeEffects(params, fill.orderId, fill.sellAmountToTake)
      if (buyToken === "") buyToken = item.buyToken
      else if (item.buyToken !== buyToken) throw new Error("all fills must share the same buyToken")
      total = total + item.pay
      items.push(item)
    }
    if (max !== undefined && max !== null && total > max) throw new Error("total price exceeds maxTotalBuy")
    for (const item of items) settle(params.context.sender, item)
    leave()
    return { count: BigInt(items.length), sold: items.map((item) => item.take), paid: items.map((item) => item.pay), totalPaid: total }
  }

  function closeOrder(params, id, order, reason) {
    const refunded = order.remaining
    order.remaining = 0n
    order.status = "cancelled"
    removeOpen(order)
    writeDB(map("orders", id), order)
    emit("OrderCancelled", { orderId: id, maker: order.maker, by: params.context.sender, refunded: refunded, reason: reason },
      { indexed: ["orderId", "maker"] })
    payOut(order.sellToken, order.maker, refunded)
    return refunded
  }

  function cancelOrder(params) {
    enter(params)
    const id = params.input.orderId
    const order = checkId(id)
    if (order.maker !== params.context.sender) throw new Error("only the maker can cancel")
    if (order.status !== "open") throw new Error("order is not open")
    const refunded = closeOrder(params, id, order, "cancelled")
    leave()
    return refunded
  }

  function cancelExpired(params) {
    enter(params)
    const id = params.input.orderId
    const order = checkId(id)
    if (order.status !== "open") throw new Error("order is not open")
    if (!isExpired(order, nowSeconds(params))) throw new Error("order has not expired")
    const refunded = closeOrder(params, id, order, "expired")
    leave()
    return refunded
  }

  // ---------- อ่าน ----------
  function getOrder(params) {
    const id = params.input.orderId
    return view(id, checkId(id), nowSeconds(params))
  }
  function orderCount() { return readDB("count") || 0n }
  function listIds(params, countKey, itemKey, page) {
    const total = readDB(countKey) || 0n
    const now = nowSeconds(params)
    const orders = []
    for (let i = page.start; i < total && i < page.start + page.limit; i++) {
      const id = readDB(itemKey(i))
      orders.push(view(id, readDB(map("orders", id)), now))
    }
    return { total: total, orders: orders }
  }
  function ordersOf(params) {
    const maker = checkAddress(params.input.maker, "maker")
    return listIds(params, map("makerCount", maker), (i) => map("makerOrders", maker, i), pageOf(params.input))
  }
  function ordersForPair(params) {
    const sellToken = checkAddress(params.input.sellToken, "sellToken")
    const buyToken = checkAddress(params.input.buyToken, "buyToken")
    const page = pageOf(params.input)
    if (params.input.openOnly === true) return listIds(params, map("openCount", sellToken, buyToken), (i) => map("openOrders", sellToken, buyToken, i), page)
    return listIds(params, map("pairCount", sellToken, buyToken), (i) => map("pairOrders", sellToken, buyToken, i), page)
  }
  // a ราคาดีกว่า b (จ่ายต่อหน่วยน้อยกว่า · เท่ากัน → orderId น้อยกว่า)
  function better(a, b) {
    const left = a.buyAmount * b.sellAmount
    const right = b.buyAmount * a.sellAmount
    return left < right || (left === right && a.orderId < b.orderId)
  }
  function bestOrders(params) {
    const sellToken = checkAddress(params.input.sellToken, "sellToken")
    const buyToken = checkAddress(params.input.buyToken, "buyToken")
    const page = pageOf(params.input)
    const totalOpen = readDB(map("openCount", sellToken, buyToken)) || 0n
    const now = nowSeconds(params)
    let best = []
    let scanned = 0n
    for (let i = page.start; i < totalOpen && scanned < BEST_SCAN; i++) {
      scanned = scanned + 1n
      const id = readDB(map("openOrders", sellToken, buyToken, i))
      const order = readDB(map("orders", id))
      if (isExpired(order, now)) continue
      const item = view(id, order, now)
      const next = []
      let placed = false
      for (const current of best) {
        if (!placed && better(item, current)) { next.push(item); placed = true }
        if (BigInt(next.length) < page.limit) next.push(current)
      }
      if (!placed && BigInt(next.length) < page.limit) next.push(item)
      best = next
    }
    return { totalOpen: totalOpen, scanned: scanned, truncated: page.start + scanned < totalOpen, orders: best }
  }
  function quoteFill(params) {
    const id = params.input.orderId
    const take = params.input.sellAmountToTake
    const order = checkId(id)
    checkAmount(take, "sellAmountToTake")
    const now = nowSeconds(params)
    const status = statusOf(order, now)
    let reason = ""
    if (status !== "open") reason = "order " + status
    else if (take > order.remaining) reason = "sellAmountToTake exceeds remaining"
    else if (!order.allowPartial && take !== order.remaining) reason = "order does not allow partial fills"
    if (reason !== "") return { ok: false, reason: reason, sold: 0n, paid: 0n, remainingAfter: order.remaining }
    return { ok: true, reason: "", sold: take, paid: priceFor(order, take), remainingAfter: order.remaining - take }
  }

  return { placeOrder, fillOrder, fillOrders, cancelOrder, cancelExpired, getOrder, orderCount, ordersOf, ordersForPair, bestOrders, quoteFill }
}`;
