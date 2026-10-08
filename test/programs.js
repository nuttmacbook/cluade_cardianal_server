/*
 * โปรแกรมตัวอย่างสำหรับทดสอบ VM
 * แต่ละตัวออกแบบให้ครอบคลุมพฤติกรรมที่อาจเกิดขึ้นในการใช้งานจริง
 */

/** ตัวนับพื้นฐาน: init, read/write/delete, ฟังก์ชัน internal */
export const COUNTER = `
function program() {
  function initialization(params) {
    writeDB("count", params.input.start ?? 0)
    return "ready"
  }

  function current() {
    return readDB("count") ?? 0
  }

  function get() {
    return current()
  }

  function add(params) {
    const next = current() + params.input.amount
    writeDB("count", next)
    return next
  }

  function addTwice(params) {
    add(params)
    return add(params)
  }

  function reset() {
    deleteDB("count")
    return readDB("count")
  }
  return { get, add, addTwice, reset }
}
`;

/** token: balances, approve / transferFrom สำหรับให้โปรแกรมอื่นหักเงิน user */
export const TOKEN = `
function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
    writeDB("totalSupply", params.input.supply)
    writeDB(map("balances", params.context.sender), params.input.supply)
  }

  function balance(account) {
    return readDB(map("balances", account)) || 0
  }

  function move(from, to, amount) {
    if (!Number.isInteger(amount) || amount <= 0) throw new Error("amount ไม่ถูกต้อง")
    if (balance(from) < amount) throw new Error("ยอดไม่พอ")
    writeDB(map("balances", from), balance(from) - amount)
    writeDB(map("balances", to), balance(to) + amount)
    return { from, to, amount }
  }

  function balanceOf(params) {
    return balance(params.input.account)
  }

  function transfer(params) {
    return move(params.context.sender, params.input.to, params.input.amount)
  }

  function approve(params) {
    writeDB(map("allowance", params.context.sender, params.input.spender), params.input.amount)
    return true
  }

  function transferFrom(params) {
    const spender = params.context.sender
    const { from, to, amount } = params.input
    const allowed = readDB(map("allowance", from, spender)) || 0
    if (allowed < amount) throw new Error("allowance ไม่พอ")
    writeDB(map("allowance", from, spender), allowed - amount)
    return move(from, to, amount)
  }

  function mint(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("ไม่ใช่ owner")
    writeDB("totalSupply", readDB("totalSupply") + params.input.amount)
    writeDB(map("balances", params.input.to), balance(params.input.to) + params.input.amount)
    return readDB("totalSupply")
  }
  return { balanceOf, transfer, approve, transferFrom, mint }
}
`;

/** ร้านค้า: เรียก token.transferFrom เพื่อหักเงินผู้ซื้อ (origin) แล้วบันทึกข้อมูลของตัวเอง */
export const SHOP = `
function program() {
  function initialization(params) {
    writeDB("shopId", params.input.shopId)
    writeDB("token", params.input.token)
    writeDB("price", params.input.price)
    writeDB("sales", 0)
  }

  function charge(buyer) {
    return runProgram(readDB("token"), "transferFrom", { from: buyer, to: readDB("shopId"), amount: readDB("price") })
  }

  function buy(params) {
    const buyer = params.context.origin
    charge(buyer)
    writeDB(map("items", buyer), (readDB(map("items", buyer)) || 0) + 1)
    writeDB("sales", readDB("sales") + 1)
    return readDB(map("items", buyer))
  }

  function buySafe(params) {
    const buyer = params.context.origin
    writeDB(map("attempts", buyer), (readDB(map("attempts", buyer)) || 0) + 1)
    try {
      charge(buyer)
    } catch (e) {
      writeDB(map("failed", buyer), e.message)
      return false
    }
    writeDB(map("items", buyer), (readDB(map("items", buyer)) || 0) + 1)
    writeDB("sales", readDB("sales") + 1)
    return true
  }

  function buyMany(params) {
    const results = []
    for (let i = 0; i < params.input.qty; i++) results.push(buy(params))
    return results
  }
  return { buy, buySafe, buyMany }
}
`;

/** เดินทางตาม path: D > E > F > A > B, ทำให้ล้ม / catch ที่โปรแกรมไหนก็ได้ */
export const HOP = `
function program() {
  function hop(params) {
    const { path, failAt, catchAt } = params.input
    const self = path[0]
    writeDB("visited", (readDB("visited") || 0) + 1)
    if (failAt === self) throw new Error("fail at " + self)

    const rest = path.slice(1)
    if (rest.length === 0) return [self]

    const next = () => runProgram(rest[0], "hop", { ...params.input, path: rest })
    if (catchAt !== self) return [self, ...next()]

    try {
      return [self, ...next()]
    } catch (e) {
      writeDB("caught", e.message)
      return [self, "caught: " + e.message]
    }
  }
  return { hop }
}
`;

/** เครื่องมือทั่วไปสำหรับทดสอบการเรียกซ้อน */
export const PROBE = `
function program() {
  function whoami(params) {
    return params.context
  }

  function echo(params) {
    return params.input
  }

  function relay(params) {
    return runProgram(params.input.target, params.input.fn, params.input.args)
  }

  function relaySequence(params) {
    return params.input.steps.map((step) => runProgram(step.target, step.fn, step.args))
  }

  function relayCatch(params) {
    try {
      return { ok: true, value: runProgram(params.input.target, params.input.fn, params.input.args) }
    } catch (e) {
      return { ok: false, message: e.message, code: e.code }
    }
  }

  function writeKey(params) {
    writeDB(params.input.key, params.input.value)
    return readDB(params.input.key)
  }

  function writeOnly(params) {
    writeDB(params.input.key, params.input.value)
  }

  function writeThenThrow(params) {
    writeDB("dirty", params.input.mark ?? true)
    throw new Error("boom")
  }

  function writeCallThrow(params) {
    writeDB("mine", 1)
    runProgram(params.input.target, "writeKey", { key: "fromB", value: 1 })
    throw new Error("after nested success")
  }

  function beforeCatchAfter(params) {
    writeDB("before", 1)
    try {
      runProgram(params.input.target, "writeThenThrow", {})
    } catch (e) {
      writeDB("error", e.message)
    }
    writeDB("after", 1)
    return "done"
  }

  function okThenCaughtFailure(params) {
    runProgram(params.input.target, "writeKey", { key: "first", value: 1 })
    try {
      runProgram(params.input.target, "writeThenThrow", {})
    } catch (e) {}
    return readDB("x") ?? "no-own-writes"
  }

  function recurse(params) {
    const left = params.input.left
    if (left === 0) return 0
    return 1 + runProgram(params.input.self, "recurse", { self: params.input.self, left: left === undefined ? undefined : left - 1 })
  }

  function recurseCatch(params) {
    try {
      return runProgram(params.input.self, "recurse", { self: params.input.self })
    } catch (e) {
      return e.code
    }
  }

  function mutateContextThenRelay(params) {
    params.context.sender = "evil"
    params.context.origin = "evil"
    return runProgram(params.input.target, "whoami", {})
  }

  function mutateInput(params) {
    params.input.nested.value = "changed"
    return params.input
  }

  function readAfterNestedWrite(params) {
    runProgram(params.input.target, "writeKey", { key: "shared", value: params.input.value })
    return runProgram(params.input.target, "readKey", { key: "shared" })
  }

  function readKey(params) {
    return readDB(params.input.key)
  }

  function internalOnly() {
    return "secret"
  }

  function callInternal() {
    return internalOnly()
  }
  return { whoami, echo, relay, relaySequence, relayCatch, writeKey, writeOnly, writeThenThrow, writeCallThrow, beforeCatchAfter, okThenCaughtFailure, recurse, recurseCatch, mutateContextThenRelay, mutateInput, readAfterNestedWrite, readKey, callInternal }
}
`;

/** ทะเบียน: เก็บว่าโปรแกรม (sender) ไหนลงทะเบียนในนามของ user (origin) คนไหน */
export const REGISTRY = `
function program() {
  function register(params) {
    writeDB(map("members", params.context.sender), params.context.origin)
    return params.context
  }

  function lookup(params) {
    return readDB(map("members", params.input.member)) ?? null
  }
  return { register, lookup }
}
`;

/** initialization ที่เรียกโปรแกรมอื่น */
export const INIT_CALLS_REGISTRY = `
function program() {
  function initialization(params) {
    return runProgram(params.input.registry, "register", {})
  }

  function ping() {
    return "pong"
  }
  return { ping }
}
`;

/** ค่า JSON / error / key ผิดรูปแบบ */
export const FAULTY = `
function program() {
  function throwError() { throw new Error("error message") }
  function throwTypeError() { null.x }
  function throwReference() { return notDefinedVariable }
  function throwString() { throw "plain string" }
  function throwNumber() { throw 42 }
  function throwObject() { throw { reason: "object" } }
  function stackOverflow() { return stackOverflow() }
  function implicitGlobal() { leakedGlobal = 1 }
  function catchOwnError() {
    try { throw new Error("inside") } catch (e) { return "recovered: " + e.message }
  }
  function fakeTimeoutCaught(params) {
    try { runProgram(params.input.target, "throwFakeTimeout", {}) } catch (e) { return e.code }
  }
  function throwFakeTimeout() { throw { code: "ERR_SCRIPT_EXECUTION_TIMEOUT" } }

  async function asyncFn() { return 1 }
  function thenable() { return { then() {} } }

  function returnUndefined() {}
  function returnNull() { return null }
  function returnNumber() { return 1.5 }
  function returnString() { return "สวัสดี 🎉" }
  function returnNested() { return { a: [1, { b: true }], c: null } }
  function returnDate() { return new Date(0) }
  function returnNaN() { return NaN }
  function returnFunction() { return () => 1 }
  function returnBigInt() { return 10n }
  function returnCircular() { const a = {}; a.self = a; return a }
  function returnWithUndefinedField() { return { a: 1, b: undefined } }

  function writeUndefined() { writeDB("k", undefined) }
  function writeNull() { writeDB("k", null); return readDB("k") }
  function writeFunction() { writeDB("k", () => 1) }
  function writeBigInt() { writeDB("k", 10n) }
  function writeCircular() { const a = {}; a.self = a; writeDB("k", a) }
  function writeDate() { writeDB("k", new Date(0)); return readDB("k") }

  function badKey(params) {
    const keys = {
      empty: "",
      emptyMap: map(),
      emptyPart: map("a", ""),
      floatPart: map("a", 1.5),
      nullPart: map("a", null),
      objectKey: { parts: ["forged"] },
      numberKey: 123,
      nullKey: null,
      arrayKey: ["a", "b"],
    }
    return readDB(keys[params.input.which])
  }
  function badKeyCaught() {
    try { readDB("") } catch (e) { return e.code }
  }

  function spin() { writeDB("spin", 1); while (true) {} }
  function spinCatch(params) {
    try { runProgram(params.input.target, "spin", {}) } catch (e) {}
    writeDB("afterSpin", 1)
    return "survived"
  }
  // Date ในโปรแกรมเป็นเวลาของ block (คงที่) จึงใช้ performance.now() เพื่อเผาเวลาจริงสำหรับทดสอบ timeout
  function busy(params) {
    const end = performance.now() + params.input.ms
    while (performance.now() < end) {}
    return params.input.ms
  }
  function busyThenCall(params) {
    busy(params)
    return runProgram(params.input.target, "busy", { ms: params.input.ms })
  }
  return { throwError, throwTypeError, throwReference, throwString, throwNumber, throwObject, stackOverflow, implicitGlobal, catchOwnError, fakeTimeoutCaught, throwFakeTimeout, asyncFn, thenable, returnUndefined, returnNull, returnNumber, returnString, returnNested, returnDate, returnNaN, returnFunction, returnBigInt, returnCircular, returnWithUndefinedField, writeUndefined, writeNull, writeFunction, writeBigInt, writeCircular, writeDate, badKey, badKeyCaught, spin, spinCatch, busy, busyThenCall }
}
`;

/** ตัวแปรระดับบนสุดของโปรแกรมต้องไม่ค้างข้าม call */
export const STATEFUL = `
function program() {
  let hits = 0

  function hit() {
    hits++
    return hits
  }

  function hitTwice() {
    hit()
    return hit()
  }
  return { hit, hitTwice }
}
`;

export const LOOP_AT_LOAD = `
function program() {
  while (true) {}
  function hello() { return "hi" }
  return { hello }
}
`;

export const THROW_AT_LOAD = `
function program() {
  throw new Error("load failed")
  function hello() { return "hi" }
  return { hello }
}
`;

export const INIT_THROWS = `
function program() {
  function initialization(params) {
    writeDB("partial", 1)
    if (!params.input.ok) throw new Error("init failed")
    return "ok"
  }
  function hello() { return "hi" }
  return { hello }
}
`;

export const INIT_LOOPS = `
function program() {
  function initialization() {
    writeDB("partial", 1)
    while (true) {}
  }
}
`;

export const NO_INIT = `
function program() {
  function hello(params) { return "hi " + params.context.sender }
  return { hello }
}
`;

export const NO_EXPORTS = `function hidden() { return 1 }`;

/** โค้ดที่ต้องถูกปฏิเสธตอน deploy */
export const INVALID_CODES = {
  importUsed: "function program() {\n  import fs from \"node:fs\"\n  function hello() {}\n  return { hello }\n}",
  exportDefault: "export default function program() { return {} }",
  syntaxError: "function program() {\n  function broken( {\n}",
  exportMissing: "function program() {\n  function a() {}\n  return { b }\n}",
  exportInitialization: "function program() {\n  function initialization() {}\n  function hello() { return 1 }\n  return { initialization, hello }\n}",
  exportArrow: "function program() {\n  const arrow = () => 1\n  return { arrow }\n}",
  exportValue: "function program() {\n  const price = 100\n  return { price }\n}",   // ไม่ใช่ฟังก์ชัน
  shadowApi: "function program() {\n  function readDB() {}\n  function a() {}\n  return { a }\n}",
};

/** เวลาในโปรแกรม */
export const CLOCK = `
function program() {
  function initialization(params) {
    writeDB("createdAt", Date.now())
    writeDB("createdAtBlock", params.block.timestamp)
  }

  function now(params) {
    return {
      block: params.block.timestamp,
      dateNow: Date.now(),
      newDate: new Date().getTime(),
      iso: new Date().toISOString(),
      asString: Date(),
      isDate: new Date() instanceof Date,
      epoch: new Date(0).getTime(),
      fromString: new Date("2020-01-01T00:00:00Z").getTime(),
      utc: Date.UTC(2020, 0, 1),
      parse: Date.parse("2020-01-01T00:00:00Z"),
    }
  }

  function nowNested(params) {
    return [Date.now(), runProgram(params.input.target, "now", {}).dateNow]
  }

  function stamp(params) {
    writeDB(map("stamps", params.input.id), Date.now())
    return Date.now()
  }

  function waitWithDate() {
    const end = Date.now() + 5
    while (Date.now() < end) {}
  }
  return { now, nowNested, stamp, waitWithDate }
}
`;

/** ใช้ทดสอบ address ตัวพิมพ์เล็ก / ใหญ่ */
export const ADDRESS_BOOK = `
function program() {
  function initialization(params) {
    writeDB("admin", params.input.admin)
  }

  function whoami(params) {
    return params.context
  }

  function saveLiteral() {
    writeDB(map("balances", "0xABCDEF"), 1)
    return readDB(map("balances", "0xabcdef"))
  }

  function isAdmin(params) {
    return params.context.sender === readDB("admin")
  }

  function save(params) {
    writeDB(map("book", params.input.address), params.input)
    return readDB(map("book", params.input.address))
  }

  function lookup(params) {
    return readDB(map("book", params.input.address)) ?? null
  }

  function saveText(params) {
    writeDB(map("text", params.input.key), params.input.value)
  }
  return { whoami, saveLiteral, isAdmin, save, lookup, saveText }
}
`;

/** ใช้ ThisAddress() แทนการรับ address ของตัวเองทาง input */
export const SELF_AWARE = `
function program() {
  function initialization(params) {
    writeDB("token", params.input.token)
    writeDB("bornAs", ThisAddress())
  }

  function whoAmI() {
    return ThisAddress()
  }

  function collect(params) {
    // ดึงเงินจากผู้เรียกเข้ากระเป๋าของโปรแกรมนี้เอง โดยไม่ต้องรู้ address ตัวเองล่วงหน้า
    runProgram(readDB("token"), "transferFrom", { from: params.context.origin, to: ThisAddress(), amount: params.input.amount })
    writeDB("collected", (readDB("collected") || 0) + params.input.amount)
    return ThisAddress()
  }

  function askOther(params) {
    return { me: ThisAddress(), other: runProgram(params.input.target, "whoAmI", {}) }
  }
  return { whoAmI, collect, askOther }
}
`;

/** ใช้ทดสอบ native balance / transferNative */
export const TREASURY = `
function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
  }

  function payout(params) {
    transferNative(params.input.to, params.input.amount)
    writeDB(map("paid", params.input.to), (readDB(map("paid", params.input.to)) || 0) + params.input.amount)
    return true
  }

  function payoutMany(params) {
    for (const item of params.input.items) transferNative(item.to, item.amount)
    return params.input.items.length
  }

  function payoutSafe(params) {
    try {
      transferNative(params.input.to, params.input.amount)
      return true
    } catch (e) {
      writeDB("lastError", e.message)
      return e.message
    }
  }

  function relayPayout(params) {
    return runProgram(params.input.target, "payout", { to: params.input.to, amount: params.input.amount })
  }

  function gasProbe(params) {
    readDB("probe")
    writeDB("probe", params.input.value)
    return true
  }

  function burnGas(params) {
    for (let i = 0; i < params.input.rounds; i++) writeDB(map("junk", i), params.input.data)
    return params.input.rounds
  }
  return { payout, payoutMany, payoutSafe, relayPayout, gasProbe, burnGas }
}
`;

/** รับเงินที่แนบมากับ call และส่งต่อไปโปรแกรมอื่น */
export const WALLET = `
function program() {
  function deposit(params) {
    const owner = params.context.origin
    writeDB(map("deposits", owner), (readDB(map("deposits", owner)) || 0) + params.value)
    return params.value
  }

  function forward(params) {
    return runProgram(params.input.target, "deposit", {}, { value: params.input.value })
  }

  function forwardAll(params) {
    return runProgram(params.input.target, "deposit", {}, { value: params.value })
  }

  function forwardTooMuch(params) {
    return runProgram(params.input.target, "deposit", {}, { value: params.value + 1 })
  }

  function forwardSafe(params) {
    try {
      return runProgram(params.input.target, "deposit", {}, { value: params.input.value })
    } catch (e) {
      writeDB("lastError", e.message)
      return e.message
    }
  }

  function seenValue(params) {
    writeDB("lastValue", params.value)
    return params.value
  }

  function rejectMoney(params) {
    if (params.value > 0) throw new Error("ไม่รับเงิน")
    return "ok"
  }
  return { deposit, forward, forwardAll, forwardTooMuch, forwardSafe, seenValue, rejectMoney }
}
`;

/** รับเงินตั้งแต่ตอน deploy (แบบ constructor payable) */
export const FUNDED = `
function program() {
  function initialization(params) {
    writeDB("seed", params.value)
    writeDB("owner", params.context.sender)
  }

  function seed() {
    return readDB("seed")
  }

  function payBack(params) {
    transferNative(params.context.origin, params.input.amount)
    return params.input.amount
  }
  return { seed, payBack }
}
`;

/** ใช้ทดสอบการสุ่ม */
export const DICE = `
function program() {
  function roll() {
    const value = Math.floor(Math.random() * 6) + 1
    writeDB("lastRoll", value)
    return value
  }

  function rollMany(params) {
    const rolls = []
    for (let i = 0; i < params.input.times; i++) rolls.push(Math.random())
    return rolls
  }

  function rollNested(params) {
    return [Math.random(), runProgram(params.input.target, "rollMany", { times: 2 }), Math.random()]
  }

  function mathStillWorks() {
    return [Math.floor(2.7), Math.max(1, 5), Math.PI > 3, typeof Math.random()]
  }
  return { roll, rollMany, rollNested, mathStillWorks }
}
`;

/** โปรแกรมที่ตั้ง metadata ของตัวเอง */
export const PROFILE = `
function program() {
  function initialization(params) {
    setMetadata("namespace", params.input.name)
    setMetadata("description", "โปรแกรมตัวอย่าง")
  }

  function rename(params) {
    setMetadata("namespace", params.input.name)
    return params.input.name
  }

  function setField(params) {
    setMetadata(params.input.field, params.input.value)
    return true
  }

  function clearField(params) {
    setMetadata(params.input.field, null)
  }

  function tryReserved() {
    setMetadata("creator", "0xแอบแก้")
  }
  return { rename, setField, clearField, tryReserved }
}
`;

/** ใช้ทดสอบ API ที่โปรแกรมเรียกดูข้อมูลของ address อื่น */
export const INSPECTOR = `
function program() {
  function initialization(params) {
    setMetadata("namespace", params.input.name)
  }

  function me() {
    return { address: ThisAddress(), balance: ThisBalance(), block: BlockNumber() }
  }

  function look(params) {
    const target = params.input.address
    return {
      balance: BalanceOf(target),
      isProgram: IsProgram(target),
      namespace: MetadataOf(target, "namespace"),
      creator: MetadataOf(target, "creator"),
    }
  }

  function payIfWallet(params) {
    if (IsProgram(params.input.to)) throw new Error("ปลายทางเป็นโปรแกรม")
    transferNative(params.input.to, params.input.amount)
    return ThisBalance()
  }

  function sendAll(params) {
    transferNative(params.input.to, ThisBalance())
    return ThisBalance()
  }

  return { me, look, payIfWallet, sendAll }
}
`;

/** ใช้ทดสอบ emit */
export const EVENTFUL = `
function program() {
  function initialization(params) {
    writeDB(map("balances", params.context.sender), params.input.supply)
    emit("Created", { owner: params.context.sender, supply: params.input.supply })
  }

  function balanceOf(a) { return readDB(map("balances", a)) || 0 }

  function transfer(params) {
    const from = params.context.sender
    if (balanceOf(from) < params.input.amount) throw new Error("ยอดไม่พอ")
    writeDB(map("balances", from), balanceOf(from) - params.input.amount)
    writeDB(map("balances", params.input.to), balanceOf(params.input.to) + params.input.amount)
    emit("Transfer", { from, to: params.input.to, amount: params.input.amount })
    return true
  }

  function relay(params) {
    emit("RelayStart", { target: params.input.target })
    const result = runProgram(params.input.target, "transfer", { to: params.input.to, amount: params.input.amount })
    emit("RelayDone", {})
    return result
  }

  function relaySafe(params) {
    try {
      runProgram(params.input.target, "transfer", { to: params.input.to, amount: params.input.amount })
    } catch (e) {
      emit("RelayFailed", { reason: e.message })
    }
    return true
  }

  function badName() {
    emit("ชื่อไทย", {})
  }

  return { transfer, relay, relaySafe, badName }
}
`;

/** ตู้ฝากที่มีช่องโหว่ reentrancy: โอนเงินออกก่อนแล้วค่อยอัปเดตยอด */
export const VULNERABLE_VAULT = `
function program() {
  function initialization(params) { writeDB("hook", params.input.hook ?? null) }

  function deposit(params) {
    writeDB(map("balances", params.context.sender), (readDB(map("balances", params.context.sender)) || 0) + params.value)
    return readDB(map("balances", params.context.sender))
  }

  function withdrawUnsafe(params) {
    const who = params.context.sender
    const balance = readDB(map("balances", who)) || 0
    if (balance <= 0) throw new Error("ไม่มีเงิน")
    runProgram(who, "receive", {}, { value: balance })     // เรียกออกไปก่อน ← ช่องโหว่
    writeDB(map("balances", who), 0)                        // ค่อยอัปเดตทีหลัง
    return balance
  }

  function withdrawSafe(params) {
    const who = params.context.sender
    const balance = readDB(map("balances", who)) || 0
    if (balance <= 0) throw new Error("ไม่มีเงิน")
    writeDB(map("balances", who), 0)                        // อัปเดตก่อน
    runProgram(who, "receive", {}, { value: balance })      // แล้วค่อยเรียกออก
    return balance
  }

  function withdrawGuarded(params) {
    if (readDB("locked")) throw new Error("กำลังทำงานอยู่")
    writeDB("locked", true)
    const who = params.context.sender
    const balance = readDB(map("balances", who)) || 0
    if (balance > 0) {
      runProgram(who, "receive", {}, { value: balance })
      writeDB(map("balances", who), 0)
    }
    deleteDB("locked")
    return balance
  }

  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0 }

  return { deposit, withdrawUnsafe, withdrawSafe, withdrawGuarded, balanceOf }
}
`;

/** ผู้โจมตี: พอได้รับเงินก็เรียกถอนซ้ำทันที */
export const ATTACKER = `
function program() {
  function initialization(params) {
    writeDB("vault", params.input.vault)
    writeDB("rounds", params.input.rounds ?? 2)
  }

  function attack(params) {
    writeDB("method", params.input.method)
    runProgram(readDB("vault"), "deposit", {}, { value: params.value })
    runProgram(readDB("vault"), params.input.method, {})
    return ThisBalance()
  }

  function receive() {
    const left = readDB("rounds") || 0
    if (left > 0) {
      writeDB("rounds", left - 1)
      try {
        runProgram(readDB("vault"), readDB("method"), {})   // เรียกซ้ำระหว่างที่ยังทำงานค้าง
      } catch (e) {
        writeDB("lastError", e.message)                     // ถูกกันไว้ได้ → จำไว้เฉย ๆ
      }
    }
    return true
  }

  return { attack, receive }
}
`;
