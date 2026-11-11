/**
 * DEX แบบ Uniswap V2 (AMM สูตร x · y = k) — router/factory 1 โปรแกรม + pair 1 โปรแกรมต่อคู่เหรียญ (clone จากต้นแบบ)
 *
 * ── Pair (DEX_PAIR_PROGRAM) ── เป็น LP token ตามมาตรฐาน token เต็มตัว (TOKEN_CORE: transfer / approve / transferFrom / permit …)
 *   name "BWSC-LP" · ticker "BWSC-LP" · decimals 18n → explorer แสดงเป็น token และล็อกใน token locker ได้
 *   input ตอน clone: { token0, token1, description? } (token0 < token1 ต้องเรียงแล้ว) · ผู้ clone (router) = factory
 *     deploy ตรงโดยไม่ส่ง token0 / token1 = ต้นแบบเฉย ๆ (inert: mint / burn / swap / skim / sync throw "pair not initialized")
 *   ทุกฟังก์ชันเปิดให้ทุกคนเรียก (permissionless แบบ V2) — ปลอดภัยเพราะคิดยอดจาก balanceOf ของ pair เทียบกับ reserve ที่เก็บไว้
 *   mint({ to }) → liquidity            ส่ง token0 / token1 เข้า pair ก่อน แล้วเรียก → ได้ LP ตามส่วน
 *       ครั้งแรก: sqrt(amount0 × amount1) − 1000 · LP 1000 หน่วย (MINIMUM_LIQUIDITY) ล็อกที่ zero address ตลอดไป
 *       ครั้งต่อไป: min(amount0 × supply / reserve0, amount1 × supply / reserve1) (ปัดลง · ส่วนเกินเป็นของ pool)
 *   burn({ to }) → { amount0, amount1 }  ส่ง LP เข้า pair ก่อน แล้วเรียก → เผา LP ทั้งหมดที่ pair ถือ ได้ token คืนตามส่วน (ปัดลง)
 *   swap({ amount0Out, amount1Out, to }) → true   ส่ง token ขาเข้าก่อน แล้วเรียก · ค่าธรรมเนียม 0.3% (ตรวจ k ด้วย 997/1000)
 *       (balance0×1000 − in0×3) × (balance1×1000 − in1×3) ≥ reserve0 × reserve1 × 1000²   (ไม่มี flash-swap callback)
 *   skim({ to }) → { amount0, amount1 }  ส่งยอดที่เกิน reserve ออกไป · sync() → true  ตั้ง reserve = balance
 *   อ่าน: getReserves() → { reserve0, reserve1, blockTimestampLast } · token0() · token1() · factory()
 *         price0CumulativeLast() · price1CumulativeLast()  (ราคาสะสมแบบ UQ112.112 × วินาที ไม่ wrap)
 *   เพดาน reserve = 2^112 − 1 (แบบ uint112 ของ V2) · กันเรียกซ้อน (lock) ทุกฟังก์ชันที่เปลี่ยน state ของ pool
 *   event: Mint { sender, amount0, amount1 } · Burn { sender, amount0, amount1, to }
 *          Swap { sender, amount0In, amount1In, amount0Out, amount1Out, to } · Sync { reserve0, reserve1 } · Transfer (LP)
 *   storage: token0 / token1 / factory / reserve0 / reserve1 / blockTimestampLast / price0CumulativeLast / price1CumulativeLast
 *            locked · name / ticker / decimals / totalSupply · balances:<who> · allowance:<o>:<s> · nonces:<o> (TOKEN_CORE)
 *
 * ── Router / factory (DEX_PROGRAM) ── input ตอน deploy: { pairTemplate, wrapped, namespace?, icon?, url?, contact?, description? }
 *   pairTemplate = ต้นแบบ pair ที่อนุมัติแล้ว · wrapped = WBWSC (WCARD_PROGRAM: deposit แนบ value / withdraw({ amount }))
 *   ไม่มีเจ้าของ / admin / ค่าธรรมเนียมเข้าใคร · แก้ไม่ได้
 *   createPair({ tokenA, tokenB }) → pair    ใครก็สร้างได้ 1 pair ต่อ 1 คู่ · salt = "<token0>:<token1>"
 *       → address = vm.cloneAddressFor(router, salt, โค้ดต้นแบบ) · event PairCreated { token0, token1, pair, index }
 *   getPair({ tokenA, tokenB }) → address | null · pairCount() → bigint · allPairs({ start?, limit? }) → [address] (limit ≤ 100)
 *   pairTemplate() · wrapped()
 *   ทุก "deadline" = unix วินาที (bigint) · วินาทีของ block > deadline → "expired"
 *   ผู้ใช้ approve router ที่ token ก่อน → router ดึง (transferFrom) จากผู้ใช้เข้า pair ตรง ๆ แล้วเรียก pair
 *   addLiquidity({ tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, to, deadline }) → { amountA, amountB, liquidity }
 *       ยังไม่มี pair = สร้างให้ · ใส่ตามสัดส่วน reserve (quote) ไม่ต่ำกว่า min
 *   addLiquidityNative({ token, amountTokenDesired, amountTokenMin, amountNativeMin, to, deadline }) แนบ value
 *       → { amountToken, amountNative, liquidity } · ห่อเป็น WBWSC · เหรียญหลักที่ไม่ได้ใช้คืนผู้เรียก
 *   removeLiquidity({ tokenA, tokenB, liquidity, amountAMin, amountBMin, to, deadline }) → { amountA, amountB }  (approve LP ให้ router)
 *   removeLiquidityNative({ token, liquidity, amountTokenMin, amountNativeMin, to, deadline }) → { amountToken, amountNative }  (แกะ WBWSC)
 *   swapExactTokensForTokens({ amountIn, amountOutMin, path, to, deadline }) → amounts
 *   swapTokensForExactTokens({ amountOut, amountInMax, path, to, deadline }) → amounts
 *   swapExactNativeForTokens({ amountOutMin, path, to, deadline }) แนบ value · path.at(0) = wrapped → amounts
 *   swapNativeForExactTokens({ amountOut, path, to, deadline }) แนบ value · คืนส่วนที่เหลือ → amounts
 *   swapExactTokensForNative({ amountIn, amountOutMin, path, to, deadline }) · path สุดท้าย = wrapped → amounts
 *   swapTokensForExactNative({ amountOut, amountInMax, path, to, deadline }) → amounts
 *   อ่าน: getAmountsOut({ amountIn, path }) · getAmountsIn({ amountOut, path }) · quote({ amountA, reserveA, reserveB })
 *         getAmountOut({ amountIn, reserveIn, reserveOut }) · getAmountIn({ amountOut, reserveIn, reserveOut })
 *         getReserves({ tokenA, tokenB }) → { reserveA, reserveB }
 *   path: 2 … DEX_MAX_PATH (4) token = สูงสุด 3 hop · ทุก hop ต้องมี pair อยู่แล้ว
 *   router ไม่เก็บเงินของผู้ใช้ค้างไว้: ฟังก์ชันที่ไม่รับ native แนบ value ไม่ได้ · native ที่ได้จาก WBWSC.withdraw ส่งต่อทันที
 *   storage: pairTemplate / wrapped / locked / pairCount · pair:<token0>:<token1> · pairs:<index> · isPair:<pair>
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";
import { TOKEN_CORE, TOKEN_CORE_EXPORTS, ZERO_ADDRESS } from "./token.js";

export const DEX_MAX_PATH = 4;
export const DEX_MINIMUM_LIQUIDITY = 1000n;
export const DEX_LP_NAME = "BWSC-LP";
export const DEX_PAIR_FUNCTIONS = ["mint", "burn", "swap", "skim", "sync"];
export const DEX_FUNCTIONS = ["createPair", "addLiquidity", "addLiquidityNative", "removeLiquidity", "removeLiquidityNative",
  "swapExactTokensForTokens", "swapTokensForExactTokens", "swapExactNativeForTokens", "swapNativeForExactTokens",
  "swapExactTokensForNative", "swapTokensForExactNative"];
export const DEX_PAIR_EVENTS = ["Mint", "Burn", "Swap", "Sync", "Transfer"];
export const DEX_EVENTS = ["PairCreated"];

/** salt ที่ router ใช้ clone pair (ไว้คำนวณ address ล่วงหน้า: vm.cloneAddressFor(router, dexPairSalt(a, b), โค้ดต้นแบบ)) */
export function dexPairSalt(tokenA, tokenB) {
  const [token0, token1] = [String(tokenA).toLowerCase(), String(tokenB).toLowerCase()].sort();
  return `${token0}:${token1}`;
}

export const DEX_PAIR_PROGRAM = `function program() {
  const ZERO = "${ZERO_ADDRESS}"
  const MINIMUM_LIQUIDITY = ${DEX_MINIMUM_LIQUIDITY}n
  const MAX_RESERVE = 5192296858534827628530496329220095n
  const Q112 = 5192296858534827628530496329220096n
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    const input = params.input
    writeDB("name", "${DEX_LP_NAME}")
    writeDB("ticker", "${DEX_LP_NAME}")
    writeDB("decimals", 18n)
    writeDB("totalSupply", 0n)
    setProgramMetadata(input)
    if ((input.token0 === undefined || input.token0 === null) && (input.token1 === undefined || input.token1 === null)) return   // ต้นแบบ
    const token0 = checkAddress(input.token0, "token0")
    const token1 = checkAddress(input.token1, "token1")
    if (!(token0 < token1)) throw new Error("tokens must be sorted (token0 < token1) and different")
    writeDB("token0", token0)
    writeDB("token1", token1)
    writeDB("factory", params.context.sender)
    writeDB("reserve0", 0n)
    writeDB("reserve1", 0n)
    writeDB("blockTimestampLast", 0n)
    writeDB("price0CumulativeLast", 0n)
    writeDB("price1CumulativeLast", 0n)
    writeDB("locked", false)
  }

${TOKEN_CORE}
  function lock() {
    if (readDB("token0") === undefined) throw new Error("pair not initialized")
    if (readDB("locked") === true) throw new Error("locked")
    writeDB("locked", true)
  }
  function unlock() { writeDB("locked", false) }

  function amountArg(value, label) {
    if (typeof value !== "bigint" || value < 0n) throw new Error(label + " must be a non-negative bigint")
    return value
  }

  function sqrt(y) {
    if (y > 3n) {
      let z = y
      let x = y / 2n + 1n
      while (x < z) { z = x; x = (y / x + x) / 2n }
      return z
    }
    return y === 0n ? 0n : 1n
  }

  function balanceOfToken(token) {
    return runProgram(token, "balanceOf", { who: ThisAddress() }, { readonly: true })
  }

  function safeTransfer(token, to, amount) {
    if (runProgram(token, "transfer", { to: to, amount: amount }) === false) throw new Error("token transfer failed")
  }

  function mintLP(to, amount) {
    writeDB("totalSupply", readDB("totalSupply") + amount)
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
    emit("Transfer", { from: ZERO, to: to, amount: amount }, { indexed: ["from", "to"] })
  }

  function burnLP(from, amount) {
    writeDB(map("balances", from), (readDB(map("balances", from)) || 0n) - amount)
    writeDB("totalSupply", readDB("totalSupply") - amount)
    emit("Transfer", { from: from, to: ZERO, amount: amount }, { indexed: ["from", "to"] })
  }

  function update(balance0, balance1, reserve0, reserve1, params) {
    if (typeof balance0 !== "bigint" || typeof balance1 !== "bigint" || balance0 < 0n || balance1 < 0n) throw new Error("token balanceOf must return a bigint")
    if (balance0 > MAX_RESERVE || balance1 > MAX_RESERVE) throw new Error("reserve overflow")
    const now = params.block.timestamp / 1000n
    const elapsed = now - readDB("blockTimestampLast")
    if (elapsed > 0n && reserve0 !== 0n && reserve1 !== 0n) {
      writeDB("price0CumulativeLast", readDB("price0CumulativeLast") + reserve1 * Q112 / reserve0 * elapsed)
      writeDB("price1CumulativeLast", readDB("price1CumulativeLast") + reserve0 * Q112 / reserve1 * elapsed)
    }
    writeDB("reserve0", balance0)
    writeDB("reserve1", balance1)
    if (elapsed !== 0n) writeDB("blockTimestampLast", now)
    emit("Sync", { reserve0: balance0, reserve1: balance1 })
  }

  function mint(params) {
    lock()
    const to = checkAddress(params.input.to, "to")
    const reserve0 = readDB("reserve0")
    const reserve1 = readDB("reserve1")
    const balance0 = balanceOfToken(readDB("token0"))
    const balance1 = balanceOfToken(readDB("token1"))
    const amount0 = balance0 - reserve0
    const amount1 = balance1 - reserve1
    if (amount0 <= 0n || amount1 <= 0n) throw new Error("insufficient liquidity minted")
    const supply = readDB("totalSupply")
    let liquidity
    if (supply === 0n) {
      liquidity = sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY
      if (liquidity <= 0n) throw new Error("insufficient liquidity minted")
      mintLP(ZERO, MINIMUM_LIQUIDITY)   // ล็อกถาวร (กันหารด้วยศูนย์ / ราคา LP ถูกปั่น)
    } else {
      const l0 = amount0 * supply / reserve0
      const l1 = amount1 * supply / reserve1
      liquidity = l0 < l1 ? l0 : l1
    }
    if (liquidity <= 0n) throw new Error("insufficient liquidity minted")
    mintLP(to, liquidity)
    update(balance0, balance1, reserve0, reserve1, params)
    emit("Mint", { sender: params.context.sender, amount0: amount0, amount1: amount1 }, { indexed: ["sender"] })
    unlock()
    return liquidity
  }

  function burn(params) {
    lock()
    const to = checkAddress(params.input.to, "to")
    const token0 = readDB("token0")
    const token1 = readDB("token1")
    const self = ThisAddress()
    const balance0 = balanceOfToken(token0)
    const balance1 = balanceOfToken(token1)
    const liquidity = readDB(map("balances", self)) || 0n
    const supply = readDB("totalSupply")
    if (liquidity === 0n || supply === 0n) throw new Error("insufficient liquidity burned")
    const amount0 = liquidity * balance0 / supply   // ปัดลง (เข้าทาง pool)
    const amount1 = liquidity * balance1 / supply
    if (amount0 <= 0n || amount1 <= 0n) throw new Error("insufficient liquidity burned")
    burnLP(self, liquidity)   // เผาก่อนส่งออก
    safeTransfer(token0, to, amount0)
    safeTransfer(token1, to, amount1)
    update(balanceOfToken(token0), balanceOfToken(token1), readDB("reserve0"), readDB("reserve1"), params)
    emit("Burn", { sender: params.context.sender, amount0: amount0, amount1: amount1, to: to }, { indexed: ["sender", "to"] })
    unlock()
    return { amount0: amount0, amount1: amount1 }
  }

  function swap(params) {
    lock()
    const amount0Out = amountArg(params.input.amount0Out === undefined ? 0n : params.input.amount0Out, "amount0Out")
    const amount1Out = amountArg(params.input.amount1Out === undefined ? 0n : params.input.amount1Out, "amount1Out")
    const to = checkAddress(params.input.to, "to")
    if (amount0Out === 0n && amount1Out === 0n) throw new Error("insufficient output amount")
    const reserve0 = readDB("reserve0")
    const reserve1 = readDB("reserve1")
    if (amount0Out >= reserve0 || amount1Out >= reserve1) throw new Error("insufficient liquidity")
    const token0 = readDB("token0")
    const token1 = readDB("token1")
    if (to === token0 || to === token1 || to === ThisAddress()) throw new Error("invalid to")
    if (amount0Out > 0n) safeTransfer(token0, to, amount0Out)   // ส่งออกก่อน แล้วตรวจ k (ผิด = ย้อนทั้ง tx)
    if (amount1Out > 0n) safeTransfer(token1, to, amount1Out)
    const balance0 = balanceOfToken(token0)
    const balance1 = balanceOfToken(token1)
    const amount0In = balance0 > reserve0 - amount0Out ? balance0 - (reserve0 - amount0Out) : 0n
    const amount1In = balance1 > reserve1 - amount1Out ? balance1 - (reserve1 - amount1Out) : 0n
    if (amount0In === 0n && amount1In === 0n) throw new Error("insufficient input amount")
    const adjusted0 = balance0 * 1000n - amount0In * 3n
    const adjusted1 = balance1 * 1000n - amount1In * 3n
    if (adjusted0 < 0n || adjusted1 < 0n || adjusted0 * adjusted1 < reserve0 * reserve1 * 1000000n) throw new Error("K")
    update(balance0, balance1, reserve0, reserve1, params)
    emit("Swap", { sender: params.context.sender, amount0In: amount0In, amount1In: amount1In, amount0Out: amount0Out, amount1Out: amount1Out, to: to },
      { indexed: ["sender", "to"] })
    unlock()
    return true
  }

  function skim(params) {
    lock()
    const to = checkAddress(params.input.to, "to")
    const token0 = readDB("token0")
    const token1 = readDB("token1")
    const amount0 = balanceOfToken(token0) - readDB("reserve0")
    const amount1 = balanceOfToken(token1) - readDB("reserve1")
    if (amount0 > 0n) safeTransfer(token0, to, amount0)
    if (amount1 > 0n) safeTransfer(token1, to, amount1)
    unlock()
    return { amount0: amount0 > 0n ? amount0 : 0n, amount1: amount1 > 0n ? amount1 : 0n }
  }

  function sync(params) {
    lock()
    update(balanceOfToken(readDB("token0")), balanceOfToken(readDB("token1")), readDB("reserve0"), readDB("reserve1"), params)
    unlock()
    return true
  }

  function getReserves() {
    return { reserve0: readDB("reserve0") || 0n, reserve1: readDB("reserve1") || 0n, blockTimestampLast: readDB("blockTimestampLast") || 0n }
  }
  function token0() { return readDB("token0") || null }
  function token1() { return readDB("token1") || null }
  function factory() { return readDB("factory") || null }
  function price0CumulativeLast() { return readDB("price0CumulativeLast") || 0n }
  function price1CumulativeLast() { return readDB("price1CumulativeLast") || 0n }

  return { ${TOKEN_CORE_EXPORTS}, mint, burn, swap, skim, sync, getReserves, token0, token1, factory, price0CumulativeLast, price1CumulativeLast }
}`;

export const DEX_PROGRAM = `function program() {
  const MAX_PATH = ${DEX_MAX_PATH}
  const MAX_PAGE = 100n
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    const template = checkAddress(params.input.pairTemplate, "pairTemplate")
    const wrapped = checkAddress(params.input.wrapped, "wrapped")
    if (!IsProgram(template)) throw new Error("pairTemplate must be a program")
    if (!IsProgram(wrapped)) throw new Error("wrapped must be a program")
    writeDB("pairTemplate", template)
    writeDB("wrapped", wrapped)
    writeDB("pairCount", 0n)
    writeDB("locked", false)
    setProgramMetadata(params.input)
  }

  // ── ตัวช่วย ──
  function lock() {
    if (readDB("locked") === true) throw new Error("locked")
    writeDB("locked", true)
  }
  function unlock() { writeDB("locked", false) }
  function notPayable(params) { if (params.value > 0n) throw new Error("function is not payable") }
  function positive(value, label) {
    if (typeof value !== "bigint" || value <= 0n) throw new Error(label + " must be a bigint greater than 0")
    return value
  }
  function nonNegative(value, label) {
    if (value === undefined || value === null) return 0n
    if (typeof value !== "bigint" || value < 0n) throw new Error(label + " must be a non-negative bigint")
    return value
  }
  function ensure(params) {
    const deadline = params.input.deadline
    if (typeof deadline !== "bigint") throw new Error("deadline must be a bigint (unix seconds)")
    if (params.block.timestamp / 1000n > deadline) throw new Error("expired")
  }
  function sortTokens(tokenA, tokenB) {
    const a = checkAddress(tokenA, "tokenA")
    const b = checkAddress(tokenB, "tokenB")
    if (a === b) throw new Error("identical addresses")
    return a < b ? [a, b] : [b, a]
  }
  function pairOf(tokenA, tokenB) {
    const sorted = sortTokens(tokenA, tokenB)
    return readDB(map("pair", sorted.at(0), sorted.at(1)))
  }
  function requirePair(tokenA, tokenB) {
    const pair = pairOf(tokenA, tokenB)
    if (pair === undefined) throw new Error("pair does not exist")
    return pair
  }
  function reservesOf(tokenA, tokenB) {
    const pair = requirePair(tokenA, tokenB)
    const r = runProgram(pair, "getReserves", {}, { readonly: true })
    const a = checkAddress(tokenA, "tokenA")
    const b = checkAddress(tokenB, "tokenB")
    return a < b ? { pair: pair, reserveA: r.reserve0, reserveB: r.reserve1 } : { pair: pair, reserveA: r.reserve1, reserveB: r.reserve0 }
  }
  function quoteAmount(amountA, reserveA, reserveB) {
    positive(amountA, "amount")
    if (reserveA <= 0n || reserveB <= 0n) throw new Error("insufficient liquidity")
    return amountA * reserveB / reserveA
  }
  function amountOutFor(amountIn, reserveIn, reserveOut) {
    positive(amountIn, "amountIn")
    if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("insufficient liquidity")
    const withFee = amountIn * 997n
    return withFee * reserveOut / (reserveIn * 1000n + withFee)   // ปัดลง
  }
  function amountInFor(amountOut, reserveIn, reserveOut) {
    positive(amountOut, "amountOut")
    if (reserveIn <= 0n || reserveOut <= 0n) throw new Error("insufficient liquidity")
    if (amountOut >= reserveOut) throw new Error("insufficient liquidity")
    return reserveIn * amountOut * 1000n / ((reserveOut - amountOut) * 997n) + 1n   // ปัดขึ้น
  }
  function checkPath(path) {
    if (!Array.isArray(path) || path.length < 2 || path.length > MAX_PATH) throw new Error("path must have 2 … " + MAX_PATH + " tokens")
    const list = []
    for (const item of path) {
      const token = checkAddress(item, "path[" + list.length + "]")
      if (list.length > 0 && token === list.at(-1)) throw new Error("identical addresses")
      list.push(token)
    }
    return list
  }
  function amountsOut(amountIn, path) {
    const amounts = [positive(amountIn, "amountIn")]
    for (let i = 0; i < path.length - 1; i++) {
      const r = reservesOf(path.at(i), path.at(i + 1))
      const out = amountOutFor(amounts.at(i), r.reserveA, r.reserveB)
      if (out <= 0n) throw new Error("insufficient output amount")
      amounts.push(out)
    }
    return amounts
  }
  function amountsIn(amountOut, path) {
    const amounts = [positive(amountOut, "amountOut")]
    for (let i = path.length - 1; i > 0; i--) {
      const r = reservesOf(path.at(i - 1), path.at(i))
      amounts.unshift(amountInFor(amounts.at(0), r.reserveA, r.reserveB))
    }
    return amounts
  }
  function pull(token, from, to, amount) {
    if (runProgram(token, "transferFrom", { from: from, to: to, amount: amount }) === false) throw new Error("transferFrom failed")
  }
  function push(token, to, amount) {
    if (runProgram(token, "transfer", { to: to, amount: amount }) === false) throw new Error("transfer failed")
  }
  function wrap(amount) {
    const wrapped = readDB("wrapped")
    runProgram(wrapped, "deposit", {}, { value: amount })
    return wrapped
  }
  function unwrapTo(amount, to) {
    runProgram(readDB("wrapped"), "withdraw", { amount: amount })
    transferNative(to, amount)
  }
  // amounts.at(0) ต้องอยู่ใน pair แรกแล้ว · hop สุดท้ายส่งไปที่ to
  function swapAlong(amounts, path, to) {
    for (let i = 0; i < path.length - 1; i++) {
      const input = path.at(i)
      const output = path.at(i + 1)
      const out = amounts.at(i + 1)
      const next = i < path.length - 2 ? requirePair(output, path.at(i + 2)) : to
      const io = input < output ? { amount0Out: 0n, amount1Out: out } : { amount0Out: out, amount1Out: 0n }
      runProgram(requirePair(input, output), "swap", { amount0Out: io.amount0Out, amount1Out: io.amount1Out, to: next })
    }
  }

  // ── factory ──
  function createPairFor(tokenA, tokenB) {
    const sorted = sortTokens(tokenA, tokenB)
    const token0 = sorted.at(0)
    const token1 = sorted.at(1)
    if (readDB(map("pair", token0, token1)) !== undefined) throw new Error("pair exists")
    if (!IsProgram(token0) || !IsProgram(token1)) throw new Error("tokens must be programs")
    const pair = cloneProgram(readDB("pairTemplate"), { token0: token0, token1: token1, description: "${DEX_LP_NAME} " + token0 + " / " + token1 },
      { salt: token0 + ":" + token1 })
    const index = readDB("pairCount")
    writeDB(map("pair", token0, token1), pair)
    writeDB(map("pairs", index), pair)
    writeDB(map("isPair", pair), true)
    writeDB("pairCount", index + 1n)
    emit("PairCreated", { token0: token0, token1: token1, pair: pair, index: index }, { indexed: ["token0", "token1"] })
    return pair
  }

  function createPair(params) {
    notPayable(params)
    return createPairFor(params.input.tokenA, params.input.tokenB)
  }
  function getPair(params) { return pairOf(params.input.tokenA, params.input.tokenB) || null }
  function pairCount() { return readDB("pairCount") }
  function allPairs(params) {
    const start = nonNegative(params.input.start, "start")
    const limit = params.input.limit === undefined || params.input.limit === null ? MAX_PAGE : positive(params.input.limit, "limit")
    if (limit > MAX_PAGE) throw new Error("limit must be at most " + MAX_PAGE)
    const count = readDB("pairCount")
    const list = []
    for (let i = start; i < count && i < start + limit; i++) list.push(readDB(map("pairs", i)))
    return list
  }
  function pairTemplate() { return readDB("pairTemplate") }
  function wrapped() { return readDB("wrapped") }

  // ── liquidity ──
  function optimalAmounts(tokenA, tokenB, desiredA, desiredB, minA, minB) {
    let pair = pairOf(tokenA, tokenB)
    if (pair === undefined) pair = createPairFor(tokenA, tokenB)
    const r = reservesOf(tokenA, tokenB)
    // ยังว่าง (หรือมีคน sync donation ข้างเดียวไว้) → ใส่ตาม desired (pair.mint ครั้งแรกคิดจากยอดที่เกิน reserve)
    if (r.reserveA === 0n || r.reserveB === 0n) return { pair: pair, amountA: desiredA, amountB: desiredB }
    const optimalB = quoteAmount(desiredA, r.reserveA, r.reserveB)
    if (optimalB <= desiredB) {
      if (optimalB < minB || optimalB === 0n) throw new Error("insufficient B amount")
      return { pair: pair, amountA: desiredA, amountB: optimalB }
    }
    const optimalA = quoteAmount(desiredB, r.reserveB, r.reserveA)
    if (optimalA > desiredA) throw new Error("insufficient A amount")
    if (optimalA < minA || optimalA === 0n) throw new Error("insufficient A amount")
    return { pair: pair, amountA: optimalA, amountB: desiredB }
  }

  function addLiquidity(params) {
    notPayable(params)
    ensure(params)
    lock()
    const input = params.input
    const tokenA = checkAddress(input.tokenA, "tokenA")
    const tokenB = checkAddress(input.tokenB, "tokenB")
    const to = checkAddress(input.to, "to")
    const desiredA = positive(input.amountADesired, "amountADesired")
    const desiredB = positive(input.amountBDesired, "amountBDesired")
    const minA = nonNegative(input.amountAMin, "amountAMin")
    const minB = nonNegative(input.amountBMin, "amountBMin")
    const plan = optimalAmounts(tokenA, tokenB, desiredA, desiredB, minA, minB)
    pull(tokenA, params.context.sender, plan.pair, plan.amountA)
    pull(tokenB, params.context.sender, plan.pair, plan.amountB)
    const liquidity = runProgram(plan.pair, "mint", { to: to })
    unlock()
    return { amountA: plan.amountA, amountB: plan.amountB, liquidity: liquidity }
  }

  function addLiquidityNative(params) {
    ensure(params)
    lock()
    const input = params.input
    const token = checkAddress(input.token, "token")
    const to = checkAddress(input.to, "to")
    const native = readDB("wrapped")
    if (token === native) throw new Error("token must not be the wrapped native token")
    const desiredToken = positive(input.amountTokenDesired, "amountTokenDesired")
    const desiredNative = positive(params.value, "value")
    const plan = optimalAmounts(token, native, desiredToken, desiredNative,
      nonNegative(input.amountTokenMin, "amountTokenMin"), nonNegative(input.amountNativeMin, "amountNativeMin"))
    pull(token, params.context.sender, plan.pair, plan.amountA)
    push(wrap(plan.amountB), plan.pair, plan.amountB)
    const liquidity = runProgram(plan.pair, "mint", { to: to })
    const refund = desiredNative - plan.amountB
    if (refund > 0n) transferNative(params.context.sender, refund)
    unlock()
    return { amountToken: plan.amountA, amountNative: plan.amountB, liquidity: liquidity }
  }

  function burnLiquidity(params, tokenA, tokenB, to) {
    const pair = requirePair(tokenA, tokenB)
    const liquidity = positive(params.input.liquidity, "liquidity")
    pull(pair, params.context.sender, pair, liquidity)
    const out = runProgram(pair, "burn", { to: to })
    return tokenA < tokenB ? { amountA: out.amount0, amountB: out.amount1 } : { amountA: out.amount1, amountB: out.amount0 }
  }

  function removeLiquidity(params) {
    notPayable(params)
    ensure(params)
    lock()
    const input = params.input
    const tokenA = checkAddress(input.tokenA, "tokenA")
    const tokenB = checkAddress(input.tokenB, "tokenB")
    const to = checkAddress(input.to, "to")
    const minA = nonNegative(input.amountAMin, "amountAMin")
    const minB = nonNegative(input.amountBMin, "amountBMin")
    const out = burnLiquidity(params, tokenA, tokenB, to)
    if (out.amountA < minA) throw new Error("insufficient A amount")
    if (out.amountB < minB) throw new Error("insufficient B amount")
    unlock()
    return out
  }

  function removeLiquidityNative(params) {
    notPayable(params)
    ensure(params)
    lock()
    const input = params.input
    const token = checkAddress(input.token, "token")
    const to = checkAddress(input.to, "to")
    const native = readDB("wrapped")
    if (token === native) throw new Error("token must not be the wrapped native token")
    const minToken = nonNegative(input.amountTokenMin, "amountTokenMin")
    const minNative = nonNegative(input.amountNativeMin, "amountNativeMin")
    const out = burnLiquidity(params, token, native, ThisAddress())
    if (out.amountA < minToken) throw new Error("insufficient token amount")
    if (out.amountB < minNative) throw new Error("insufficient native amount")
    push(token, to, out.amountA)
    unwrapTo(out.amountB, to)
    unlock()
    return { amountToken: out.amountA, amountNative: out.amountB }
  }

  // ── swap ──
  function swapExactTokensForTokens(params) {
    notPayable(params)
    ensure(params)
    lock()
    const path = checkPath(params.input.path)
    const to = checkAddress(params.input.to, "to")
    const min = nonNegative(params.input.amountOutMin, "amountOutMin")
    const amounts = amountsOut(params.input.amountIn, path)
    if (amounts.at(-1) < min) throw new Error("insufficient output amount")
    pull(path.at(0), params.context.sender, requirePair(path.at(0), path.at(1)), amounts.at(0))
    swapAlong(amounts, path, to)
    unlock()
    return amounts
  }

  function swapTokensForExactTokens(params) {
    notPayable(params)
    ensure(params)
    lock()
    const path = checkPath(params.input.path)
    const to = checkAddress(params.input.to, "to")
    const max = positive(params.input.amountInMax, "amountInMax")
    const amounts = amountsIn(params.input.amountOut, path)
    if (amounts.at(0) > max) throw new Error("excessive input amount")
    pull(path.at(0), params.context.sender, requirePair(path.at(0), path.at(1)), amounts.at(0))
    swapAlong(amounts, path, to)
    unlock()
    return amounts
  }

  function swapExactNativeForTokens(params) {
    ensure(params)
    lock()
    const path = checkPath(params.input.path)
    const to = checkAddress(params.input.to, "to")
    if (path.at(0) !== readDB("wrapped")) throw new Error("path must start with the wrapped native token")
    const min = nonNegative(params.input.amountOutMin, "amountOutMin")
    const amounts = amountsOut(positive(params.value, "value"), path)
    if (amounts.at(-1) < min) throw new Error("insufficient output amount")
    push(wrap(amounts.at(0)), requirePair(path.at(0), path.at(1)), amounts.at(0))
    swapAlong(amounts, path, to)
    unlock()
    return amounts
  }

  function swapNativeForExactTokens(params) {
    ensure(params)
    lock()
    const path = checkPath(params.input.path)
    const to = checkAddress(params.input.to, "to")
    if (path.at(0) !== readDB("wrapped")) throw new Error("path must start with the wrapped native token")
    const value = positive(params.value, "value")
    const amounts = amountsIn(params.input.amountOut, path)
    if (amounts.at(0) > value) throw new Error("excessive input amount")
    push(wrap(amounts.at(0)), requirePair(path.at(0), path.at(1)), amounts.at(0))
    swapAlong(amounts, path, to)
    if (value > amounts.at(0)) transferNative(params.context.sender, value - amounts.at(0))
    unlock()
    return amounts
  }

  function swapExactTokensForNative(params) {
    notPayable(params)
    ensure(params)
    lock()
    const path = checkPath(params.input.path)
    const to = checkAddress(params.input.to, "to")
    if (path.at(-1) !== readDB("wrapped")) throw new Error("path must end with the wrapped native token")
    const min = nonNegative(params.input.amountOutMin, "amountOutMin")
    const amounts = amountsOut(params.input.amountIn, path)
    const out = amounts.at(-1)
    if (out < min) throw new Error("insufficient output amount")
    pull(path.at(0), params.context.sender, requirePair(path.at(0), path.at(1)), amounts.at(0))
    swapAlong(amounts, path, ThisAddress())
    unwrapTo(out, to)
    unlock()
    return amounts
  }

  function swapTokensForExactNative(params) {
    notPayable(params)
    ensure(params)
    lock()
    const path = checkPath(params.input.path)
    const to = checkAddress(params.input.to, "to")
    if (path.at(-1) !== readDB("wrapped")) throw new Error("path must end with the wrapped native token")
    const max = positive(params.input.amountInMax, "amountInMax")
    const amounts = amountsIn(params.input.amountOut, path)
    if (amounts.at(0) > max) throw new Error("excessive input amount")
    pull(path.at(0), params.context.sender, requirePair(path.at(0), path.at(1)), amounts.at(0))
    swapAlong(amounts, path, ThisAddress())
    unwrapTo(amounts.at(-1), to)
    unlock()
    return amounts
  }

  // ── อ่าน ──
  function getAmountsOut(params) { return amountsOut(params.input.amountIn, checkPath(params.input.path)) }
  function getAmountsIn(params) { return amountsIn(params.input.amountOut, checkPath(params.input.path)) }
  function quote(params) {
    return quoteAmount(params.input.amountA, nonNegative(params.input.reserveA, "reserveA"), nonNegative(params.input.reserveB, "reserveB"))
  }
  function getAmountOut(params) {
    return amountOutFor(params.input.amountIn, nonNegative(params.input.reserveIn, "reserveIn"), nonNegative(params.input.reserveOut, "reserveOut"))
  }
  function getAmountIn(params) {
    return amountInFor(params.input.amountOut, nonNegative(params.input.reserveIn, "reserveIn"), nonNegative(params.input.reserveOut, "reserveOut"))
  }
  function getReserves(params) {
    const r = reservesOf(params.input.tokenA, params.input.tokenB)
    return { reserveA: r.reserveA, reserveB: r.reserveB }
  }

  return { createPair, getPair, pairCount, allPairs, pairTemplate, wrapped,
    addLiquidity, addLiquidityNative, removeLiquidity, removeLiquidityNative,
    swapExactTokensForTokens, swapTokensForExactTokens, swapExactNativeForTokens, swapNativeForExactTokens,
    swapExactTokensForNative, swapTokensForExactNative,
    getAmountsOut, getAmountsIn, quote, getAmountOut, getAmountIn, getReserves }
}`;
