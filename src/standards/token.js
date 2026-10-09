/**
 * มาตรฐาน token (คล้าย ERC-20) — explorer นับเหรียญที่แต่ละ address ถือจาก event Transfer ของโปรแกรมที่ทำตามนี้
 *
 * ฟังก์ชันที่ต้องมี (อ่านอย่างเดียว)
 *   name()            → string               ชื่อเต็ม เช่น "Thai Baht Coin"
 *   ticker()          → string               ชื่อย่อ เช่น "THBC"
 *   decimals()        → bigint               จำนวนหลักทศนิยม เช่น 6n (ยอด 1_500_000n = 1.5 เหรียญ)
 *   totalSupply()     → bigint
 *   balanceOf({ who })               → bigint
 *   allowance({ owner, spender })    → bigint
 * ฟังก์ชันที่เปลี่ยน state
 *   transfer({ to, amount })                 → true
 *   approve({ spender, amount })             → true
 *   transferFrom({ from, to, amount })       → true   (ใช้วงเงินที่ from approve ไว้ให้ผู้เรียก)
 * event ที่ต้อง emit
 *   Transfer { from, to, amount }      ทุกครั้งที่ยอดย้าย · ตอนสร้างเหรียญใช้ from = ZERO_ADDRESS
 *   Approval { owner, spender, amount } ทุกครั้งที่ตั้งวงเงิน
 *
 * จำนวนเงินทั้งหมดเป็น bigint หน่วยเล็กสุด (เหมือน wei) · หน้าเว็บหารด้วย 10^decimals ตอนแสดง
 */

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const TOKEN_FUNCTIONS = ["name", "ticker", "decimals", "totalSupply", "balanceOf", "allowance", "transfer", "approve", "transferFrom"];
export const TOKEN_EVENTS = ["Transfer", "Approval"];

/**
 * โปรแกรม token ตามมาตรฐาน — input ตอน deploy: { name, ticker, decimals, supply, namespace?, icon?, url?, contact?, description? }
 * supply เป็นหน่วยเล็กสุด (6 decimals + supply 1_000_000_000_000n = 1,000,000 เหรียญ)
 */
export const TOKEN_PROGRAM = `function program() {
  function initialization(params) {
    const owner = params.context.sender
    writeDB("name", params.input.name)
    writeDB("ticker", params.input.ticker)
    writeDB("decimals", params.input.decimals)
    writeDB("totalSupply", params.input.supply)
    writeDB("owner", owner)
    writeDB(map("balances", owner), params.input.supply)
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    // metadata ของโปรแกรมตั้งได้จากโค้ดเท่านั้น: icon / url / contact / description ส่งมาตอน deploy ได้
    if (params.input.icon) setMetadata("icon", params.input.icon)
    if (params.input.url) setMetadata("url", params.input.url)
    if (params.input.contact) setMetadata("contact", params.input.contact)
    if (params.input.description) setMetadata("description", params.input.description)
    emit("Transfer", { from: "${ZERO_ADDRESS}", to: owner, amount: params.input.supply })
  }

  function name() { return readDB("name") }
  function ticker() { return readDB("ticker") }
  function decimals() { return readDB("decimals") }
  function totalSupply() { return readDB("totalSupply") }
  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }
  function allowance(params) { return readDB(map("allowance", params.input.owner, params.input.spender)) || 0n }

  function move(from, to, amount) {
    if (amount <= 0n) throw new Error("จำนวนต้องมากกว่า 0")
    const balance = readDB(map("balances", from)) || 0n
    if (balance < amount) throw new Error("ยอดไม่พอ")
    writeDB(map("balances", from), balance - amount)
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
    emit("Transfer", { from: from, to: to, amount: amount })
  }

  function transfer(params) {
    move(params.context.sender, params.input.to, params.input.amount)
    return true
  }

  function approve(params) {
    writeDB(map("allowance", params.context.sender, params.input.spender), params.input.amount)
    emit("Approval", { owner: params.context.sender, spender: params.input.spender, amount: params.input.amount })
    return true
  }

  function transferFrom(params) {
    const spender = params.context.sender
    const allowed = readDB(map("allowance", params.input.from, spender)) || 0n
    if (allowed < params.input.amount) throw new Error("วงเงินไม่พอ")
    writeDB(map("allowance", params.input.from, spender), allowed - params.input.amount)
    move(params.input.from, params.input.to, params.input.amount)
    return true
  }

  return { name, ticker, decimals, totalSupply, balanceOf, allowance, transfer, approve, transferFrom }
}`;

/** โค้ดที่ VM เก็บไว้มี \\n เป็นตัวอักษร (escape แบบ JSON) → คืนเป็นโค้ดปกติ */
export function unescapeCode(code) {
  const raw = String(code ?? "");
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

/** โค้ดนี้ทำตามมาตรฐาน token ไหม (ดูจากฟังก์ชันที่ export และ event ที่ emit) → { ok, missing: [] } */
export function checkTokenStandard(code) {
  const source = unescapeCode(code);
  const exported = /return\s*\{([^}]*)\}\s*;?\s*\}\s*$/.exec(source)?.[1].split(",").map((name) => name.trim()) ?? [];
  const missing = [
    ...TOKEN_FUNCTIONS.filter((name) => !exported.includes(name)),
    ...TOKEN_EVENTS.filter((name) => !new RegExp(`emit\\(\\s*["'\`]${name}["'\`]`).test(source)).map((name) => `event ${name}`),
  ];
  return { ok: missing.length === 0, missing };
}
