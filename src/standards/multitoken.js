/**
 * มาตรฐาน multi-token (คล้าย ERC-1155) — 1 โปรแกรมมีหลาย id · แต่ละ id มีจำนวน (id ที่มีชิ้นเดียว = NFT, หลายชิ้น = เหรียญ / ไอเทม)
 *
 * ฟังก์ชันที่ต้องมี (อ่านอย่างเดียว)
 *   balanceOf({ account, id })                       → bigint
 *   balanceOfBatch({ accounts: [..], ids: [..] })    → [bigint]   (ยาวเท่ากัน · คู่ลำดับเดียวกัน)
 *   isApprovedForAll({ account, operator })          → boolean
 *   uri({ id })                                      → string     uri ของ id นั้น หรือ template ("…/{id}.json" ให้ client แทนค่าเอง)
 * ฟังก์ชันที่เปลี่ยน state
 *   setApprovalForAll({ operator, approved })        → true
 *   safeTransferFrom({ from, to, id, amount, data? })           → true   ผู้เรียก = from หรือ operator ของ from
 *   safeBatchTransferFrom({ from, to, ids, amounts, data? })    → true
 *     ปลายทางเป็นโปรแกรม → ต้องตอบ onERC1155Received = "0xf23a6e61" / onERC1155BatchReceived = "0xbc197c81" ไม่งั้นทั้ง tx ล้ม
 * ฟังก์ชันเสริมใน MULTITOKEN_PROGRAM
 *   mint({ to, id, amount, data? }) / mintBatch({ to, ids, amounts, data? })   เจ้าของโปรแกรม / minter เท่านั้น
 *   burn({ from, id, amount }) · setURI({ id, uri }) · setMinter({ minter, allowed }) · totalSupply({ id }) · name() · symbol() · owner()
 *   supportsInterface({ interfaceId })
 * event ที่ต้อง emit
 *   TransferSingle { operator, from, to, id, amount }     mint from = ZERO_ADDRESS · burn to = ZERO_ADDRESS
 *   TransferBatch  { operator, from, to, ids, amounts }
 *   ApprovalForAll { account, operator, approved }
 *   URI            { value, id }                          (เฉพาะตอน setURI)
 *
 * id / amount เป็น bigint · storage: balances:<account>:<id> (explorer ไล่ของที่ address ถือได้จาก prefix) · supply:<id>
 * /evm แปลง TransferSingle / TransferBatch → log ERC-1155 — ดู src/node/evm-rpc.js
 */
import { ZERO_ADDRESS, checkStandard } from "./token.js";
import { ERC1155_RECEIVED, ERC1155_BATCH_RECEIVED } from "./wallet.js";

export const MULTITOKEN_FUNCTIONS = ["balanceOf", "balanceOfBatch", "isApprovedForAll", "uri",
  "setApprovalForAll", "safeTransferFrom", "safeBatchTransferFrom"];
export const MULTITOKEN_EVENTS = ["TransferSingle", "TransferBatch", "ApprovalForAll"];
/** interface id แบบ ERC-165: ERC-165 / ERC-1155 / ERC-1155 Metadata URI */
export const MULTITOKEN_INTERFACES = ["0x01ffc9a7", "0xd9b67a26", "0x0e89341c"];

/** โค้ดนี้ทำตามมาตรฐาน multi-token ไหม → { ok, missing: [] } */
export const checkMultiTokenStandard = (code) => checkStandard(code, MULTITOKEN_FUNCTIONS, MULTITOKEN_EVENTS);

/**
 * โปรแกรม multi-token ตามมาตรฐาน — input ตอน deploy: { name?, symbol?, uri, namespace?, icon?, url?, contact?, description? }
 * ผู้ deploy = owner (mint / setURI / ตั้ง minter)
 */
export const MULTITOKEN_PROGRAM = `function program() {
  const ZERO = "${ZERO_ADDRESS}"

  function initialization(params) {
    writeDB("name", params.input.name || "")
    writeDB("symbol", params.input.symbol || "")
    writeDB("uri", params.input.uri || "")
    writeDB("owner", params.context.sender)
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    if (params.input.icon) setMetadata("icon", params.input.icon)
    if (params.input.url) setMetadata("url", params.input.url)
    if (params.input.contact) setMetadata("contact", params.input.contact)
    if (params.input.description) setMetadata("description", params.input.description)
  }

  function checkId(id) {
    if (typeof id !== "bigint" || id < 0n) throw new Error("id must be a non-negative bigint")
    return id
  }
  function checkAmount(amount) {
    if (typeof amount !== "bigint" || amount < 0n) throw new Error("amount must be a non-negative bigint")
    return amount
  }
  function checkAddress(address, label) {
    if (typeof address !== "string" || address.length !== 42 || !address.startsWith("0x")) throw new Error(label + " must be an address")
    return address
  }
  function checkLists(ids, amounts) {
    if (!Array.isArray(ids) || !Array.isArray(amounts)) throw new Error("ids and amounts must be arrays")
    if (ids.length !== amounts.length) throw new Error("ids and amounts length mismatch")
    for (const id of ids) checkId(id)
    for (const amount of amounts) checkAmount(amount)
  }
  function balance(account, id) { return readDB(map("balances", account, id)) || 0n }
  function isOperator(account, operator) { return readDB(map("operators", account, operator)) === true }
  function onlyMinter(sender) {
    if (sender !== readDB("owner") && readDB(map("minters", sender)) !== true) throw new Error("only owner or minter")
  }

  /** ย้ายยอด 1 id: from = ZERO คือ mint · to = ZERO คือ burn */
  function move(from, to, id, amount) {
    if (from !== ZERO) {
      const have = balance(from, id)
      if (have < amount) throw new Error("insufficient balance")
      writeDB(map("balances", from, id), have - amount)
    } else {
      writeDB(map("supply", id), (readDB(map("supply", id)) || 0n) + amount)
    }
    if (to !== ZERO) writeDB(map("balances", to, id), balance(to, id) + amount)
    else writeDB(map("supply", id), (readDB(map("supply", id)) || 0n) - amount)
  }

  function accept(fn, magic, input) {
    if (!IsProgram(input.to)) return
    const reply = runProgram(input.to, fn, { operator: input.operator, from: input.from, id: input.id, amount: input.amount,
      ids: input.ids, amounts: input.amounts, data: input.data || "" })
    if (reply !== magic) throw new Error("receiver did not accept the tokens")
  }

  function single(operator, from, to, id, amount, data) {
    checkId(id)
    checkAmount(amount)
    move(from, to, id, amount)
    emit("TransferSingle", { operator: operator, from: from, to: to, id: id, amount: amount })
    if (to !== ZERO) accept("onERC1155Received", "${ERC1155_RECEIVED}", { operator: operator, from: from, to: to, id: id, amount: amount, data: data })
  }

  function batch(operator, from, to, ids, amounts, data) {
    checkLists(ids, amounts)
    ids.forEach((id, i) => move(from, to, id, amounts.at(i)))
    emit("TransferBatch", { operator: operator, from: from, to: to, ids: ids, amounts: amounts })
    if (to !== ZERO) accept("onERC1155BatchReceived", "${ERC1155_BATCH_RECEIVED}", { operator: operator, from: from, to: to, ids: ids, amounts: amounts, data: data })
  }

  function name() { return readDB("name") }
  function symbol() { return readDB("symbol") }
  function owner() { return readDB("owner") }
  function uri(params) { return readDB(map("uris", checkId(params.input.id))) || readDB("uri") }
  function totalSupply(params) { return readDB(map("supply", checkId(params.input.id))) || 0n }
  function balanceOf(params) { return balance(checkAddress(params.input.account, "account"), checkId(params.input.id)) }
  function balanceOfBatch(params) {
    const accounts = params.input.accounts
    const ids = params.input.ids
    if (!Array.isArray(accounts) || !Array.isArray(ids) || accounts.length !== ids.length) throw new Error("accounts and ids length mismatch")
    return accounts.map((account, i) => balance(checkAddress(account, "account"), checkId(ids.at(i))))
  }
  function isApprovedForAll(params) { return isOperator(params.input.account, params.input.operator) }
  function supportsInterface(params) {
    const id = String(params.input.interfaceId || "").toLowerCase()
    return ${JSON.stringify(MULTITOKEN_INTERFACES)}.includes(id)
  }

  function setMinter(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("only owner")
    const minter = checkAddress(params.input.minter, "minter")
    writeDB(map("minters", minter), params.input.allowed === true)
    emit("MinterSet", { minter: minter, allowed: params.input.allowed === true })
    return true
  }

  function setURI(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("only owner")
    const id = checkId(params.input.id)
    if (typeof params.input.uri !== "string") throw new Error("uri must be a string")
    writeDB(map("uris", id), params.input.uri)
    emit("URI", { value: params.input.uri, id: id })
    return true
  }

  function setApprovalForAll(params) {
    const operator = checkAddress(params.input.operator, "operator")
    if (operator === params.context.sender) throw new Error("approve to caller")
    const approved = params.input.approved === true
    writeDB(map("operators", params.context.sender, operator), approved)
    emit("ApprovalForAll", { account: params.context.sender, operator: operator, approved: approved })
    return true
  }

  function checkTransfer(params) {
    const from = checkAddress(params.input.from, "from")
    const to = checkAddress(params.input.to, "to")
    if (to === ZERO) throw new Error("transfer to the zero address (use burn)")
    if (params.context.sender !== from && !isOperator(from, params.context.sender)) throw new Error("caller is not owner nor approved")
    return { from: from, to: to }
  }

  function safeTransferFrom(params) {
    const route = checkTransfer(params)
    single(params.context.sender, route.from, route.to, params.input.id, params.input.amount, params.input.data)
    return true
  }

  function safeBatchTransferFrom(params) {
    const route = checkTransfer(params)
    batch(params.context.sender, route.from, route.to, params.input.ids, params.input.amounts, params.input.data)
    return true
  }

  function mint(params) {
    onlyMinter(params.context.sender)
    const to = checkAddress(params.input.to, "to")
    if (to === ZERO) throw new Error("mint to the zero address")
    single(params.context.sender, ZERO, to, params.input.id, params.input.amount, params.input.data)
    return true
  }

  function mintBatch(params) {
    onlyMinter(params.context.sender)
    const to = checkAddress(params.input.to, "to")
    if (to === ZERO) throw new Error("mint to the zero address")
    batch(params.context.sender, ZERO, to, params.input.ids, params.input.amounts, params.input.data)
    return true
  }

  function burn(params) {
    const from = checkAddress(params.input.from, "from")
    if (params.context.sender !== from && !isOperator(from, params.context.sender)) throw new Error("caller is not owner nor approved")
    single(params.context.sender, from, ZERO, params.input.id, params.input.amount, "")
    return true
  }

  return { name, symbol, owner, uri, totalSupply, balanceOf, balanceOfBatch, isApprovedForAll, supportsInterface, setMinter, setURI, setApprovalForAll, safeTransferFrom, safeBatchTransferFrom, mint, mintBatch, burn }
}`;
