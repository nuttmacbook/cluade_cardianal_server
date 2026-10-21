/**
 * โปรแกรมตัวอย่างของ scripts/scenario-full.js — ทุกตัวประกาศ metadata.abi (explorer สร้างฟอร์ม Interact / ถอด event ได้สวย)
 * และตั้ง namespace + description ตอน initialization (ชื่ออ่านง่ายทั้งใน explorer ของเรา และ Blockscout ผ่าน /evm)
 *
 *   COUNTER_V1 / COUNTER_V2  ตัวนับที่อัปเกรดได้ (upgrader ตั้งตอน deploy) · V2 เพิ่ม decrement + migrate(bonus, tag)
 *   LAB_PROGRAM              เรียกโปรแกรมซ้อน (runProgram) · STATICCALL ที่ห้ามเขียน (FORBIDDEN) · catch call ชั้นในที่ล้ม
 *                            · probe(): อ่าน API ของเชนทุกตัว (BlockHash … Math.random) เก็บลง storage + emit
 *   GAS_LAB_PROGRAM          burn(rounds) ใช้แก๊สมากให้ base fee ขึ้น · spin() ลูปไม่รู้จบ (OUT_OF_GAS)
 *                            · กับดัก: arm() แล้ว loopIfArmed() / memoryIfArmed() → OUT_OF_GAS / OUT_OF_MEMORY "ใน block"
 *                              (simulate ที่ /sendtx รันบน state ก่อน arm จึงผ่าน · ใน block arm รันก่อน → ล้มจริง เสียค่าแก๊ส)
 *   NOTE_TEMPLATE            ต้นแบบของ cloneProgram (โน้ตของเจ้าของ 1 คน)
 *   FACTORY_PROGRAM          create({ template, salt, label }) → cloneProgram แบบ CREATE2 (address ทำนายได้ก่อน)
 *   REJECTABLE_PROGRAM       โปรแกรมที่ทีมงานจะ reject (deploy พร้อม value → ได้เงินคืน)
 *
 * กติกาของ autoreview: ห้าม obj[key] / class / this / new (ยกเว้น Error, Date) · ตัวเลขเป็น BigInt เท่านั้น
 */

// ---------- ตัวช่วยสร้าง ABI (metadata.abi) ----------
const field = ([name, type, description]) => ({ name, type, ...(description ? { description } : {}) });
const fn = (name, inputs = [], outputs = [], extra = {}) => ({ name, inputs: inputs.map(field), outputs: outputs.map(([name, type]) => ({ name, type })), ...extra });
const event = (name, fields, description) => ({ name, fields: fields.map(([name, type, indexed]) => ({ name, type, ...(indexed ? { indexed: true } : {}) })), ...(description ? { description } : {}) });
const abi = (value) => JSON.stringify(value);

export const COUNTER_V1_ABI = {
  functions: [
    fn("increment", [["by", "uint", "amount to add (default 1)"]], [["count", "uint"]], { description: "Add to the counter" }),
    fn("get", [], [["count", "uint"]], { readonly: true, description: "Current value" }),
    fn("version", [], [["version", "uint"]], { readonly: true }),
    fn("fail", [], [], { description: "Always throws (used to show a failing inner call)" }),
  ],
  events: [event("Incremented", [["caller", "address", true], ["by", "uint"], ["count", "uint"]], "Counter increased")],
};
export const COUNTER_V2_ABI = {
  functions: [...COUNTER_V1_ABI.functions,
    fn("decrement", [["by", "uint", "amount to subtract (default 1)"]], [["count", "uint"]], { description: "Subtract (added in v2)" }),
    fn("migratedTag", [], [["tag", "string"]], { readonly: true })],
  events: [...COUNTER_V1_ABI.events, event("Decremented", [["caller", "address", true], ["by", "uint"], ["count", "uint"]])],
};

const COUNTER_COMMON = `
  function get() { return readDB("count") || 0n }
  function fail() { throw new Error("intentional failure from the counter") }
  function amountOf(params) {
    const by = params.input.by === undefined || params.input.by === null ? 1n : params.input.by
    if (typeof by !== "bigint" || by <= 0n) throw new Error("by must be a positive bigint")
    return by
  }
  function increment(params) {
    const by = amountOf(params)
    const count = get() + by
    writeDB("count", count)
    emit("Incremented", { caller: params.context.sender, by: by, count: count }, { indexed: ["caller"] })
    return count
  }`;

export const COUNTER_V1 = `function program() {
  function initialization(params) {
    writeDB("count", 0n)
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    setMetadata("description", "Upgradeable counter (version 1)")
    setMetadata("abi", ${abi(COUNTER_V1_ABI)})
  }
${COUNTER_COMMON}
  function version() { return 1n }
  return { increment, get, version, fail }
}`;

export const COUNTER_V2 = `function program() {
${COUNTER_COMMON}
  function version() { return 2n }
  function migratedTag() { return readDB("migratedTag") || "" }
  function decrement(params) {
    const by = amountOf(params)
    const count = get() - by
    if (count < 0n) throw new Error("counter cannot go below zero")
    writeDB("count", count)
    emit("Decremented", { caller: params.context.sender, by: by, count: count }, { indexed: ["caller"] })
    return count
  }
  // รันครั้งเดียวตอนทีมงานอนุมัติการอัปเกรด (เรียกจากภายนอกไม่ได้)
  function migrate(params) {
    writeDB("migratedTag", params.input.tag || "none")
    writeDB("count", get() + (params.input.bonus || 0n))
    setMetadata("description", "Upgradeable counter (version 2: decrement + migrate)")
    setMetadata("abi", ${abi(COUNTER_V2_ABI)})
    return "migrated"
  }
  return { increment, decrement, get, version, fail, migratedTag, migrate }
}`;

export const LAB_ABI = {
  functions: [
    fn("callCounter", [["counter", "address"], ["by", "uint"]], [["count", "uint"]], { description: "Nested call: lab → counter.increment" }),
    fn("staticWrite", [["counter", "address"]], [["result", "object"]], { description: "STATICCALL that tries to write (FORBIDDEN) and one that reads" }),
    fn("catchFailure", [["counter", "address"]], [["result", "object"]], { description: "Calls counter.fail() and catches the error" }),
    fn("probe", [["message", "string"], ["signature", "string"]], [["snapshot", "object"]], { description: "Reads every chain API and stores the snapshot" }),
    fn("lastProbe", [], [["snapshot", "object"]], { readonly: true }),
  ],
  events: [
    event("Nested", [["counter", "address", true], ["count", "uint"]]),
    event("Caught", [["counter", "address", true], ["message", "string"]]),
    event("Probed", [["block", "uint", true], ["random", "string"]]),
  ],
};

export const LAB_PROGRAM = `function program() {
  function initialization(params) {
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    setMetadata("description", "Lab: nested calls, STATICCALL, caught failures and every chain API")
    setMetadata("abi", ${abi(LAB_ABI)})
  }

  function callCounter(params) {
    const count = runProgram(params.input.counter, "increment", { by: params.input.by || 1n })
    writeDB("lastNested", count)
    emit("Nested", { counter: params.input.counter, count: count }, { indexed: ["counter"] })
    return count
  }

  function staticWrite(params) {
    const read = runProgram(params.input.counter, "get", {}, { readonly: true })
    let blocked = null
    try {
      runProgram(params.input.counter, "increment", { by: 1n }, { readonly: true })
    } catch (e) {
      blocked = { code: e.code || null, message: String(e.message) }
    }
    writeDB("lastStatic", { read: read, blocked: blocked })
    return { read: read, blocked: blocked }
  }

  function catchFailure(params) {
    let message = ""
    try {
      runProgram(params.input.counter, "fail", {})
    } catch (e) {
      message = String(e.message)
    }
    writeDB("lastCaught", message)
    emit("Caught", { counter: params.input.counter, message: message }, { indexed: ["counter"] })
    return { caught: message !== "", message: message }
  }

  function probe(params) {
    const me = ThisAddress()
    const number = BlockNumber()
    const snapshot = {
      blockNumber: number,
      blockHash: BlockHash(number - 1n),
      chainId: ChainId(),
      coinbase: Coinbase(),
      blockGasLimit: BlockGasLimit(),
      gasPrice: GasPrice(),
      baseFee: BaseFee(),
      gasLeft: GasLeft(),
      codeHash: CodeHashOf(me),
      codeSize: CodeSizeOf(me),
      sha256: sha256("abc"),
      ripemd160: ripemd160("abc"),
      blake2b: blake2b("abc"),
      keccak256: keccak256("abc"),
      modexp: modexp(3n, 200n, 1000007n),
      signer: ecrecover(params.input.message, params.input.signature),
      senderBalance: BalanceOf(params.context.sender),
      thisBalance: ThisBalance(),
      thisIsProgram: IsProgram(me),
      senderIsProgram: IsProgram(params.context.sender),
      namespace: MetadataOf(me, "namespace"),
      now: BigInt(Date.now()),
      timestamp: params.block.timestamp,
      random: String(Math.random()),
    }
    writeDB("lastProbe", snapshot)
    emit("Probed", { block: number, random: snapshot.random }, { indexed: ["block"] })
    return snapshot
  }

  function lastProbe() { return readDB("lastProbe") || null }

  return { callCounter, staticWrite, catchFailure, probe, lastProbe }
}`;

export const GAS_LAB_ABI = {
  functions: [
    fn("burn", [["rounds", "uint", "loop rounds (≈ 20 gas each)"]], [["total", "uint"]], { description: "Uses a lot of gas so the next base fee rises" }),
    fn("spin", [], [], { description: "Infinite loop → OUT_OF_GAS" }),
    fn("arm", [], [["armed", "bool"]], { description: "Arms the traps below (simulation of a later tx still sees them disarmed)" }),
    fn("loopIfArmed", [], [["result", "string"]], { description: "Infinite loop when armed → OUT_OF_GAS inside a block" }),
    fn("memoryIfArmed", [], [["result", "string"]], { description: "Allocates without limit when armed → OUT_OF_MEMORY inside a block" }),
  ],
  events: [event("Burned", [["by", "address", true], ["rounds", "uint"]])],
};

export const GAS_LAB_PROGRAM = `function program() {
  function initialization(params) {
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    setMetadata("description", "Gas lab: heavy loops, out of gas and out of memory")
    setMetadata("abi", ${abi(GAS_LAB_ABI)})
  }

  function burn(params) {
    let total = 0n
    for (let i = 0n; i < params.input.rounds; i = i + 1n) total = total + i
    emit("Burned", { by: params.context.sender, rounds: params.input.rounds }, { indexed: ["by"] })
    return total
  }

  function spin() {
    let i = 0n
    while (true) i = i + 1n
  }

  // ข้อมูลใหม่ทุกก้อนคิดแก๊สตามขนาด (1 gas ต่อ 32 ตัวอักษร) → 32 MB ≈ 1.05M gas
  // ส่งด้วย gasLimit ≥ 1.5M → ถึงเพดานหน่วยความจำ (OUT_OF_MEMORY) ก่อนแก๊สหมด · gasLimit น้อยกว่านั้น = OUT_OF_GAS
  // (repeat / padStart ถูก autoreview ห้าม → สร้างก้อน 1 MB ด้วย s + s แล้วคัดลอกใหม่ทุกรอบด้วย join)
  function grow() {
    let s = "x"
    while (s.length < 1048576) s = s + s
    const keep = []
    while (true) keep.push([s].join(""))
  }

  function arm() {
    writeDB("armed", true)
    return true
  }
  function loopIfArmed() {
    if (readDB("armed") === true) spin()
    return "disarmed"
  }
  function memoryIfArmed() {
    if (readDB("armed") === true) grow()
    return "disarmed"
  }

  return { burn, spin, arm, loopIfArmed, memoryIfArmed }
}`;

export const NOTE_ABI = {
  functions: [
    fn("note", [], [["note", "object"]], { readonly: true, description: "Owner, label and text" }),
    fn("write", [["text", "string"]], [["ok", "bool"]], { description: "Owner only" }),
  ],
  events: [event("Written", [["owner", "address", true], ["text", "string"]])],
};

export const NOTE_TEMPLATE = `function program() {
  function initialization(params) {
    writeDB("owner", params.input.owner || params.context.sender)
    writeDB("label", params.input.label || "")
    writeDB("text", "")
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    setMetadata("description", "Note " + (params.input.label || "template"))
    setMetadata("abi", ${abi(NOTE_ABI)})
  }
  function note() { return { owner: readDB("owner"), label: readDB("label"), text: readDB("text") } }
  function write(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("only owner")
    writeDB("text", params.input.text)
    emit("Written", { owner: params.context.sender, text: params.input.text }, { indexed: ["owner"] })
    return true
  }
  return { note, write }
}`;

export const FACTORY_ABI = {
  functions: [
    fn("create", [["template", "address"], ["salt", "string"], ["label", "string"]], [["clone", "address"]], { description: "cloneProgram (CREATE2-style address)" }),
    fn("cloneOf", [["salt", "string"]], [["clone", "address"]], { readonly: true }),
    fn("count", [], [["count", "uint"]], { readonly: true }),
  ],
  events: [event("Created", [["creator", "address", true], ["clone", "address", true], ["salt", "string"]])],
};

export const FACTORY_PROGRAM = `function program() {
  function initialization(params) {
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    setMetadata("description", "Factory: creates notes with cloneProgram")
    setMetadata("abi", ${abi(FACTORY_ABI)})
  }
  function create(params) {
    const salt = params.input.salt
    const clone = cloneProgram(params.input.template, { owner: params.context.sender, label: params.input.label, namespace: params.input.namespace || "" }, { salt: salt })
    writeDB(map("clones", salt), clone)
    writeDB("count", (readDB("count") || 0n) + 1n)
    emit("Created", { creator: params.context.sender, clone: clone, salt: salt }, { indexed: ["creator", "clone"] })
    return clone
  }
  function cloneOf(params) { return readDB(map("clones", params.input.salt)) || null }
  function count() { return readDB("count") || 0n }
  return { create, cloneOf, count }
}`;

export const REJECTABLE_PROGRAM = `function program() {
  function initialization(params) {
    setMetadata("description", "This program is meant to be rejected by the reviewers")
  }
  function hello() { return "hello" }
  return { hello }
}`;
