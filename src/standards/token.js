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
 * ฟังก์ชันเสริม (ไม่บังคับในมาตรฐาน)
 *   multiTransfer({ transfers: [{ to, amount }, …] }) → จำนวนรายการ   โอนหลายกระเป๋าใน tx เดียว (Transfer ต่อรายการ)
 *   permit({ owner, spender, value, deadline, signature }) → true    ตั้งวงเงินด้วยลายเซ็นของ owner (คล้าย ERC-2612)
 *   nonces({ owner }) → bigint · permitDomain() → { name, version, chainId, verifyingContract } · DOMAIN_SEPARATOR() → hash ของ domain
 *
 * permit: ข้อความที่ owner เซ็น (ดู permitTypedData ใน src/crypto/program-signature.js)
 *   { domain: { name, version: "1", chainId: ChainId(), verifyingContract: ThisAddress() },
 *     primaryType: "Permit", types: PERMIT_TYPE, message: { owner, spender, value, nonce, deadline } }
 *   digest = keccak256(canonical JSON ของข้อความนี้) — ตรงกับที่ ecrecover(ข้อความ, signature) คำนวณ (bigint เป็น "123n")
 *   deadline = มิลลิวินาทีแบบเดียวกับ params.block.timestamp · block.timestamp > deadline → "permit expired"
 *   nonce ของ owner เพิ่มทีละ 1 ทุกครั้งที่ permit สำเร็จ (ลายเซ็นเดิมใช้ซ้ำไม่ได้) · chain อื่น / token อื่น → ลายเซ็นใช้ไม่ได้
 *   owner เป็นโปรแกรม → ถาม owner.isValidSignature({ hash: digest, signature }) แบบ readonly (ERC-1271, src/standards/wallet.js)
 * event ที่ต้อง emit
 *   Transfer { from, to, amount }      ทุกครั้งที่ยอดย้าย · ตอนสร้างเหรียญใช้ from = ZERO_ADDRESS
 *   Approval { owner, spender, amount } ทุกครั้งที่ตั้งวงเงิน
 *
 * จำนวนเงินทั้งหมดเป็น bigint หน่วยเล็กสุด (เหมือน wei) · หน้าเว็บหารด้วย 10^decimals ตอนแสดง
 */

import { SIGNATURE_CHECKER } from "./wallet.js";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** ชนิดของข้อความ permit (ฟิลด์ types ในข้อความที่เซ็น — เหมือน type string ของ EIP-712) */
export const PERMIT_TYPE = "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)";
export const PERMIT_VERSION = "1";
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
    if (amount <= 0n) throw new Error("amount must be greater than 0")
    const balance = readDB(map("balances", from)) || 0n
    if (balance < amount) throw new Error("insufficient balance")
    writeDB(map("balances", from), balance - amount)
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
    emit("Transfer", { from: from, to: to, amount: amount })
  }

  function transfer(params) {
    move(params.context.sender, params.input.to, params.input.amount)
    return true
  }

  function multiTransfer(params) {
    let count = 0n
    for (const item of params.input.transfers) {
      move(params.context.sender, item.to, item.amount)
      count = count + 1n
    }
    if (count === 0n) throw new Error("no transfers")
    return count
  }

  function setAllowance(owner, spender, amount) {
    writeDB(map("allowance", owner, spender), amount)
    emit("Approval", { owner: owner, spender: spender, amount: amount })
  }

  function approve(params) {
    setAllowance(params.context.sender, params.input.spender, params.input.amount)
    return true
  }

  ${SIGNATURE_CHECKER}

  function permitDomain() {
    return { name: readDB("name"), version: "${PERMIT_VERSION}", chainId: ChainId(), verifyingContract: ThisAddress() }
  }
  function DOMAIN_SEPARATOR() { return keccak256(permitDomain()) }
  function nonces(params) { return readDB(map("nonces", params.input.owner)) || 0n }

  function permit(params) {
    const owner = params.input.owner
    const spender = params.input.spender
    const value = params.input.value
    const deadline = params.input.deadline
    if (typeof owner !== "string" || typeof spender !== "string") throw new Error("owner and spender must be addresses")
    if (typeof value !== "bigint" || value < 0n) throw new Error("value must be a non-negative bigint")
    if (typeof deadline !== "bigint") throw new Error("deadline must be a bigint (milliseconds, like params.block.timestamp)")
    if (params.block.timestamp > deadline) throw new Error("permit expired")
    const nonce = readDB(map("nonces", owner)) || 0n
    const typed = { domain: permitDomain(), primaryType: "Permit", types: "${PERMIT_TYPE}",
      message: { owner: owner, spender: spender, value: value, nonce: nonce, deadline: deadline } }
    if (!isValidSignatureNow(owner, typed, params.input.signature)) throw new Error("invalid permit signature")
    writeDB(map("nonces", owner), nonce + 1n)
    setAllowance(owner, spender, value)
    return true
  }

  function transferFrom(params) {
    const spender = params.context.sender
    const allowed = readDB(map("allowance", params.input.from, spender)) || 0n
    if (allowed < params.input.amount) throw new Error("insufficient allowance")
    writeDB(map("allowance", params.input.from, spender), allowed - params.input.amount)
    move(params.input.from, params.input.to, params.input.amount)
    return true
  }

  return { name, ticker, decimals, totalSupply, balanceOf, allowance, transfer, multiTransfer, approve, transferFrom,
    permit, nonces, permitDomain, DOMAIN_SEPARATOR }
}`;

/** โค้ดที่ VM เก็บไว้มี \\n เป็นตัวอักษร (escape แบบ JSON) → คืนเป็นโค้ดปกติ */
export function unescapeCode(code) {
  const raw = String(code ?? "");
  try { return JSON.parse(`"${raw}"`); } catch { return raw; }
}

/** ชื่อฟังก์ชันใน return { … } ตัวสุดท้ายของโปรแกรม */
export function exportedFunctions(code) {
  const source = unescapeCode(code);
  return /return\s*\{([^}]*)\}\s*;?\s*\}\s*$/.exec(source)?.[1].split(",").map((name) => name.trim()).filter(Boolean) ?? [];
}

/** โค้ดนี้ export ฟังก์ชันครบ และ emit event ครบตามรายชื่อไหม → { ok, missing: [] } (ใช้ร่วมกันทุกมาตรฐาน) */
export function checkStandard(code, functions, events) {
  const source = unescapeCode(code);
  const exported = exportedFunctions(source);
  const missing = [
    ...functions.filter((name) => !exported.includes(name)),
    ...events.filter((name) => !new RegExp(`emit\\(\\s*["'\`]${name}["'\`]`).test(source)).map((name) => `event ${name}`),
  ];
  return { ok: missing.length === 0, missing };
}

/** โค้ดนี้ทำตามมาตรฐาน token ไหม (ดูจากฟังก์ชันที่ export และ event ที่ emit) → { ok, missing: [] } */
export const checkTokenStandard = (code) => checkStandard(code, TOKEN_FUNCTIONS, TOKEN_EVENTS);
