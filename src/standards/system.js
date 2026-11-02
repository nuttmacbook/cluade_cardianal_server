/**
 * โปรแกรมกลางของเชน (แบบ Multicall3 / WBNB / Gnosis Safe ของ BSC / ETH) — deploy ทั้งชุดด้วย scripts/deploy-system.js
 *
 *   ลำดับ (nonce ของกระเป๋า deployer) → address รู้ล่วงหน้า (programAddressFor(deployer, nonce))
 *     0 multicall            MULTICALL_PROGRAM (src/standards/multicall.js)
 *     1 wcard                WCARD_PROGRAM     ห่อเหรียญหลักเป็น token 1:1 (แบบ WETH / WBNB)
 *     2 multisig-template    MULTISIG_PROGRAM  ต้นแบบกระเป๋าหลายเจ้าของ (clone ผ่าน factory)
 *     3 token-template       TOKEN_PROGRAM     ต้นแบบ token
 *     4 nft-template         NFT_PROGRAM       ต้นแบบ NFT
 *     5 multitoken-template  MULTITOKEN_PROGRAM ต้นแบบ multi-token
 *     6 factory              FACTORY_PROGRAM   ใครก็สร้าง token / NFT / multi-token / multisig ของตัวเองได้ทันที (cloneProgram · ไม่ต้องรอ admin)
 *   ชื่อ (namespace) ข้างหน้าตั้งตอน initialization → explorer แสดงชื่อ · ค้น /name/wcard ได้
 *   ทั้งชุดไม่มี upgrader (แก้ไม่ได้) · ต้นแบบที่ deploy ตรงไม่มีเจ้าของ (ใช้เป็นแม่แบบอย่างเดียว)
 */
import { MULTICALL_PROGRAM } from "./multicall.js";
import { TOKEN_PROGRAM, TOKEN_CORE, TOKEN_CORE_EXPORTS, ZERO_ADDRESS } from "./token.js";
import { NFT_PROGRAM } from "./nft.js";
import { MULTITOKEN_PROGRAM } from "./multitoken.js";
import { ERC1271_MAGIC_VALUE, ERC1271_INVALID_VALUE, ERC721_RECEIVED, ERC1155_RECEIVED, ERC1155_BATCH_RECEIVED } from "./wallet.js";

/** ตั้ง metadata ของโปรแกรมจาก input ตอน initialization (ตั้งได้จากโค้ดเท่านั้น) */
const SET_METADATA = `function setProgramMetadata(input) {
    if (typeof input.namespace === "string" && input.namespace !== "") setMetadata("namespace", input.namespace)
    if (typeof input.icon === "string" && input.icon !== "") setMetadata("icon", input.icon)
    if (typeof input.url === "string" && input.url !== "") setMetadata("url", input.url)
    if (typeof input.contact === "string" && input.contact !== "") setMetadata("contact", input.contact)
    if (typeof input.description === "string" && input.description !== "") setMetadata("description", input.description)
  }`;

const CHECK_ADDRESS = `function checkAddress(address, label) {
    if (typeof address !== "string" || address.length !== 42 || !address.startsWith("0x")) throw new Error(label + " must be an address")
    return address.toLowerCase()
  }`;

/**
 * WCARD — เหรียญหลักแบบ token (มาตรฐาน token ครบ + permit) · ฝาก 1 CARD ได้ 1 WCARD ถอนคืนได้ทุกเมื่อ
 *   input ตอน deploy: { name?, ticker?, namespace?, icon?, url?, description? } (ค่าเริ่ม "Wrapped CARD" / "WCARD")
 *   deposit()               แนบ value → ได้ WCARD เท่ากัน (event Deposit + Transfer จาก zero)
 *   depositTo({ to })       ฝากให้คนอื่น
 *   withdraw({ amount })    เผา WCARD → ได้เหรียญหลักคืน (event Withdrawal + Transfer ไป zero)
 *   withdrawTo({ to, amount })
 *   decimals = 18 เท่าเหรียญหลัก · totalSupply = เหรียญหลักที่ฝากอยู่
 */
export const WCARD_FUNCTIONS = ["deposit", "depositTo", "withdraw", "withdrawTo"];
export const WCARD_PROGRAM = `function program() {
  const ZERO = "${ZERO_ADDRESS}"
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    writeDB("name", params.input.name || "Wrapped CARD")
    writeDB("ticker", params.input.ticker || "WCARD")
    writeDB("decimals", 18n)
    writeDB("totalSupply", 0n)
    setProgramMetadata(params.input)
  }

${TOKEN_CORE}
  function mintTo(to, amount) {
    if (amount <= 0n) throw new Error("send native coin as value")
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
    writeDB("totalSupply", readDB("totalSupply") + amount)
    emit("Transfer", { from: ZERO, to: to, amount: amount }, { indexed: ["from", "to"] })
    emit("Deposit", { to: to, amount: amount }, { indexed: ["to"] })
    return amount
  }

  function burnTo(from, to, amount) {
    if (typeof amount !== "bigint" || amount <= 0n) throw new Error("amount must be greater than 0")
    const balance = readDB(map("balances", from)) || 0n
    if (balance < amount) throw new Error("insufficient balance")
    // ลดยอดก่อนส่งเงินออก (กันเรียกซ้อนกลับเข้ามาถอนซ้ำ)
    writeDB(map("balances", from), balance - amount)
    writeDB("totalSupply", readDB("totalSupply") - amount)
    emit("Transfer", { from: from, to: ZERO, amount: amount }, { indexed: ["from", "to"] })
    emit("Withdrawal", { from: from, to: to, amount: amount }, { indexed: ["from", "to"] })
    transferNative(to, amount)
    return true
  }

  function deposit(params) { return mintTo(params.context.sender, params.value) }
  function depositTo(params) { return mintTo(checkAddress(params.input.to, "to"), params.value) }
  function withdraw(params) { return burnTo(params.context.sender, params.context.sender, params.input.amount) }
  function withdrawTo(params) { return burnTo(params.context.sender, checkAddress(params.input.to, "to"), params.input.amount) }

  return { ${TOKEN_CORE_EXPORTS}, deposit, depositTo, withdraw, withdrawTo }
}`;

/**
 * Multisig — กระเป๋าหลายเจ้าของ m-of-n (แบบ Gnosis Safe ย่อ: ยืนยันด้วย tx ของเจ้าของแต่ละคน ไม่ต้องรวบลายเซ็น)
 *   input: { owners: [address, …] (1–20 คน), threshold (1n … จำนวนเจ้าของ), namespace?, … }
 *     ไม่ส่ง owners = ต้นแบบ (ไม่มีเจ้าของ ทำอะไรไม่ได้) ให้ factory.createMultisig clone ไปใช้
 *   submit({ target, fn?, input?, value? }) → id    เจ้าของเสนอรายการ (ผู้เสนอยืนยันให้ทันที)
 *       fn ว่าง = โอนเหรียญหลัก value ไปที่ target · มี fn = เรียก target.fn(input) โดย sender = multisig (แนบ value ได้)
 *   confirm({ id }) / revoke({ id })                เจ้าของยืนยัน / ถอนการยืนยัน
 *   execute({ id }) → ผลของปลายทาง                  เจ้าของคนไหนก็สั่งได้เมื่อยืนยันครบ threshold (นับจากเจ้าของปัจจุบันเท่านั้น)
 *       ปลายทาง throw → ทั้ง tx ย้อน (รายการยังไม่ถูกทำ ลองใหม่ได้)
 *   ตั้งค่าได้เฉพาะผ่านรายการของ multisig เอง (submit target = multisig นี้):
 *       addOwner({ owner, threshold? }) · removeOwner({ owner, threshold? }) · changeThreshold({ threshold })
 *       approveHash({ hash })  รับรอง digest → isValidSignature ตอบ magic (ERC-1271: ใช้ permit / ลายเซ็นในนามทีมได้)
 *   อ่าน: owners() · threshold() · isOwner({ who }) · transactionCount() · getTransaction({ id }) · isConfirmed({ id, owner })
 *   deposit() แนบ value = รับเหรียญหลัก (event Deposit) · รับ NFT / multi-token แบบ safe transfer ได้
 */
export const MULTISIG_MAX_OWNERS = 20;
export const MULTISIG_FUNCTIONS = ["submit", "confirm", "revoke", "execute", "owners", "threshold", "getTransaction"];
export const MULTISIG_PROGRAM = `function program() {
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    setProgramMetadata(params.input)
    if (params.input.owners === undefined || params.input.owners === null) return   // ต้นแบบ
    const list = []
    if (!Array.isArray(params.input.owners) || params.input.owners.length === 0) throw new Error("owners must be a non-empty array")
    if (params.input.owners.length > ${MULTISIG_MAX_OWNERS}) throw new Error("too many owners (max ${MULTISIG_MAX_OWNERS})")
    for (const item of params.input.owners) {
      const owner = checkAddress(item, "owner")
      if (list.includes(owner)) throw new Error("duplicate owner")
      list.push(owner)
    }
    writeDB("owners", list)
    setThreshold(params.input.threshold, list.length)
  }

  function ownerList() { return readDB("owners") || [] }
  function isOwnerAddress(who) { return typeof who === "string" && ownerList().includes(who.toLowerCase()) }
  function onlyOwner(params) { if (!isOwnerAddress(params.context.sender)) throw new Error("only owner") }
  function onlySelf(params) { if (params.context.sender !== ThisAddress()) throw new Error("only through a multisig transaction") }
  function setThreshold(threshold, count) {
    if (typeof threshold !== "bigint" || threshold < 1n || threshold > BigInt(count)) throw new Error("threshold must be 1n … number of owners")
    writeDB("threshold", threshold)
    emit("ThresholdChanged", { threshold: threshold })
  }
  function load(id) {
    if (typeof id !== "bigint") throw new Error("id must be a bigint")
    const item = readDB(map("txs", id))
    if (item === undefined) throw new Error("transaction does not exist")
    return item
  }
  function countConfirmations(id) {
    let count = 0n
    for (const owner of ownerList()) if (readDB(map("confirmed", id, owner)) === true) count = count + 1n
    return count
  }

  function owners() { return ownerList() }
  function threshold() { return readDB("threshold") || 0n }
  function isOwner(params) { return isOwnerAddress(params.input.who) }
  function transactionCount() { return readDB("count") || 0n }
  function getTransaction(params) {
    const item = load(params.input.id)
    item.confirmations = countConfirmations(params.input.id)
    return item
  }
  function isConfirmed(params) { return readDB(map("confirmed", params.input.id, String(params.input.owner).toLowerCase())) === true }

  function confirmAs(owner, id) {
    if (load(id).executed) throw new Error("already executed")
    if (readDB(map("confirmed", id, owner)) === true) throw new Error("already confirmed")
    writeDB(map("confirmed", id, owner), true)
    emit("Confirmed", { id: id, owner: owner }, { indexed: ["id", "owner"] })
  }

  function submit(params) {
    onlyOwner(params)
    const target = checkAddress(params.input.target, "target")
    const fn = params.input.fn || ""
    const value = params.input.value === undefined || params.input.value === null ? 0n : params.input.value
    if (typeof fn !== "string") throw new Error("fn must be a string")
    if (typeof value !== "bigint" || value < 0n) throw new Error("value must be a non-negative bigint")
    if (fn === "" && value === 0n) throw new Error("nothing to do: give fn or value")
    const id = transactionCount()
    writeDB(map("txs", id), { target: target, fn: fn, input: params.input.input || {}, value: value, executed: false, submitter: params.context.sender })
    writeDB("count", id + 1n)
    emit("Submitted", { id: id, submitter: params.context.sender, target: target, fn: fn, value: value }, { indexed: ["id", "submitter", "target"] })
    confirmAs(params.context.sender, id)
    return id
  }

  function confirm(params) {
    onlyOwner(params)
    confirmAs(params.context.sender, params.input.id)
    return true
  }

  function revoke(params) {
    onlyOwner(params)
    if (load(params.input.id).executed) throw new Error("already executed")
    if (readDB(map("confirmed", params.input.id, params.context.sender)) !== true) throw new Error("not confirmed")
    deleteDB(map("confirmed", params.input.id, params.context.sender))
    emit("Revoked", { id: params.input.id, owner: params.context.sender }, { indexed: ["id", "owner"] })
    return true
  }

  function execute(params) {
    onlyOwner(params)
    const id = params.input.id
    const item = load(id)
    if (item.executed) throw new Error("already executed")
    if (countConfirmations(id) < threshold()) throw new Error("not enough confirmations")
    item.executed = true
    writeDB(map("txs", id), item)   // ทำเครื่องหมายก่อนเรียกออก (กันเรียกซ้อนกลับมาทำซ้ำ)
    let result = true
    if (item.fn === "") transferNative(item.target, item.value)
    else result = runProgram(item.target, item.fn, item.input, item.value > 0n ? { value: item.value } : {})
    emit("Executed", { id: id, executor: params.context.sender }, { indexed: ["id", "executor"] })
    return result
  }

  function addOwner(params) {
    onlySelf(params)
    const owner = checkAddress(params.input.owner, "owner")
    const list = ownerList()
    if (list.includes(owner)) throw new Error("already an owner")
    if (list.length >= ${MULTISIG_MAX_OWNERS}) throw new Error("too many owners (max ${MULTISIG_MAX_OWNERS})")
    list.push(owner)
    writeDB("owners", list)
    emit("OwnerAdded", { owner: owner }, { indexed: ["owner"] })
    setThreshold(params.input.threshold === undefined ? threshold() : params.input.threshold, list.length)
    return true
  }

  function removeOwner(params) {
    onlySelf(params)
    const owner = checkAddress(params.input.owner, "owner")
    const list = ownerList().filter((item) => item !== owner)
    if (list.length === ownerList().length) throw new Error("not an owner")
    if (list.length === 0) throw new Error("cannot remove the last owner")
    writeDB("owners", list)
    emit("OwnerRemoved", { owner: owner }, { indexed: ["owner"] })
    const current = threshold()
    setThreshold(params.input.threshold === undefined ? (current > BigInt(list.length) ? BigInt(list.length) : current) : params.input.threshold, list.length)
    return true
  }

  function changeThreshold(params) {
    onlySelf(params)
    setThreshold(params.input.threshold, ownerList().length)
    return true
  }

  function approveHash(params) {
    onlySelf(params)
    if (typeof params.input.hash !== "string" || params.input.hash.length !== 66) throw new Error("hash must be a 32-byte hex digest")
    writeDB(map("signed", params.input.hash.toLowerCase()), true)
    emit("HashApproved", { hash: params.input.hash.toLowerCase() })
    return true
  }

  function isValidSignature(params) {
    const hash = params.input.hash
    if (typeof hash !== "string") return "${ERC1271_INVALID_VALUE}"
    return readDB(map("signed", hash.toLowerCase())) === true ? "${ERC1271_MAGIC_VALUE}" : "${ERC1271_INVALID_VALUE}"
  }

  function deposit(params) {
    if (params.value <= 0n) throw new Error("send native coin as value")
    emit("Deposit", { from: params.context.sender, amount: params.value }, { indexed: ["from"] })
    return params.value
  }

  function onERC721Received() { return "${ERC721_RECEIVED}" }
  function onERC1155Received() { return "${ERC1155_RECEIVED}" }
  function onERC1155BatchReceived() { return "${ERC1155_BATCH_RECEIVED}" }

  return { owners, threshold, isOwner, transactionCount, getTransaction, isConfirmed, submit, confirm, revoke, execute,
    addOwner, removeOwner, changeThreshold, approveHash, isValidSignature, deposit, onERC721Received, onERC1155Received, onERC1155BatchReceived }
}`;

/**
 * Factory — ใครก็สร้าง token / NFT / multi-token / multisig ของตัวเองจากต้นแบบที่อนุมัติแล้ว (cloneProgram) ไม่ต้องรอ admin
 *   input ตอน deploy: { templates: { token, nft, multiToken, multisig }, namespace?, … }
 *   createToken({ name, ticker, decimals, supply, salt?, namespace?, icon?, url?, contact?, description? }) → address
 *       supply ทั้งหมดเป็นของผู้เรียก (owner = ผู้เรียก)
 *   createNft({ name, symbol, baseURI?, salt?, … }) → address        ผู้เรียก = owner (mint / ตั้ง minter)
 *   createMultiToken({ name?, symbol?, uri?, salt?, … }) → address   ผู้เรียก = owner
 *   createMultisig({ owners, threshold, salt?, … }) → address
 *   salt (ไม่บังคับ) = string ≤ 64 ตัว ไม่ขึ้นต้นด้วย "#" · ไม่ส่ง = "#<ลำดับของผู้เรียก>"
 *       salt จริง = "<ผู้เรียก>:<salt>" → address รู้ล่วงหน้าด้วย vm.cloneAddressFor(factory, salt จริง, โค้ดต้นแบบ) และคนอื่นแย่งไม่ได้
 *   อ่าน: templates() · count() · created({ index }) · createdCount({ creator }) · createdBy({ creator, index }) · kindOf({ address })
 *   event Created { kind, address, creator }
 */
export const FACTORY_KINDS = ["token", "nft", "multiToken", "multisig"];
export const FACTORY_FUNCTIONS = ["createToken", "createNft", "createMultiToken", "createMultisig"];
export const FACTORY_PROGRAM = `function program() {
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    setProgramMetadata(params.input)
    const templates = params.input.templates || {}
    writeDB(map("template", "token"), checkAddress(templates.token, "templates.token"))
    writeDB(map("template", "nft"), checkAddress(templates.nft, "templates.nft"))
    writeDB(map("template", "multiToken"), checkAddress(templates.multiToken, "templates.multiToken"))
    writeDB(map("template", "multisig"), checkAddress(templates.multisig, "templates.multisig"))
  }

  function saltOf(creator, salt) {
    if (salt === undefined || salt === null || salt === "") {
      const n = readDB(map("auto", creator)) || 0n
      writeDB(map("auto", creator), n + 1n)
      return creator + ":#" + n
    }
    if (typeof salt !== "string" || salt.length > 64 || salt.startsWith("#")) throw new Error("salt must be a string (max 64, not starting with #)")
    return creator + ":" + salt
  }

  function text(value, label, max, required) {
    if (value === undefined || value === null || value === "") {
      if (required) throw new Error(label + " is required")
      return ""
    }
    if (typeof value !== "string" || value.length > max) throw new Error(label + " must be a string (max " + max + ")")
    return value
  }

  function withMetadata(input, initInput) {
    initInput.namespace = text(input.namespace, "namespace", 64, false)
    initInput.icon = text(input.icon, "icon", 8192, false)
    initInput.url = text(input.url, "url", 512, false)
    initInput.contact = text(input.contact, "contact", 512, false)
    initInput.description = text(input.description, "description", 512, false)
    return initInput
  }

  function create(kind, params, initInput) {
    const creator = params.context.sender
    const address = cloneProgram(readDB(map("template", kind)), initInput, { salt: saltOf(creator, params.input.salt) })
    const index = readDB("count") || 0n
    writeDB(map("created", index), { kind: kind, address: address, creator: creator })
    writeDB("count", index + 1n)
    const mine = readDB(map("createdCount", creator)) || 0n
    writeDB(map("createdBy", creator, mine), address)
    writeDB(map("createdCount", creator), mine + 1n)
    writeDB(map("kind", address), kind)
    emit("Created", { kind: kind, address: address, creator: creator }, { indexed: ["address", "creator"] })
    return address
  }

  function createToken(params) {
    const input = params.input
    if (typeof input.decimals !== "bigint" || input.decimals < 0n || input.decimals > 36n) throw new Error("decimals must be 0n … 36n")
    if (typeof input.supply !== "bigint" || input.supply < 0n) throw new Error("supply must be a non-negative bigint")
    return create("token", params, withMetadata(input, { name: text(input.name, "name", 64, true), ticker: text(input.ticker, "ticker", 16, true),
      decimals: input.decimals, supply: input.supply, owner: params.context.sender }))
  }

  function createNft(params) {
    const input = params.input
    return create("nft", params, withMetadata(input, { name: text(input.name, "name", 64, true), symbol: text(input.symbol, "symbol", 16, true),
      baseURI: text(input.baseURI, "baseURI", 512, false), owner: params.context.sender }))
  }

  function createMultiToken(params) {
    const input = params.input
    return create("multiToken", params, withMetadata(input, { name: text(input.name, "name", 64, false), symbol: text(input.symbol, "symbol", 16, false),
      uri: text(input.uri, "uri", 512, false), owner: params.context.sender }))
  }

  function createMultisig(params) {
    const input = params.input
    if (!Array.isArray(input.owners)) throw new Error("owners must be an array")
    return create("multisig", params, withMetadata(input, { owners: input.owners, threshold: input.threshold }))
  }

  function templates() {
    return { token: readDB(map("template", "token")), nft: readDB(map("template", "nft")),
      multiToken: readDB(map("template", "multiToken")), multisig: readDB(map("template", "multisig")) }
  }
  function count() { return readDB("count") || 0n }
  function created(params) {
    const item = readDB(map("created", params.input.index))
    if (item === undefined) throw new Error("index out of range")
    return item
  }
  function createdCount(params) { return readDB(map("createdCount", String(params.input.creator).toLowerCase())) || 0n }
  function createdBy(params) {
    const address = readDB(map("createdBy", String(params.input.creator).toLowerCase(), params.input.index))
    if (address === undefined) throw new Error("index out of range")
    return address
  }
  function kindOf(params) { return readDB(map("kind", String(params.input.address).toLowerCase())) || null }

  return { createToken, createNft, createMultiToken, createMultisig, templates, count, created, createdCount, createdBy, kindOf }
}`;

/** salt จริงที่ factory ใช้ (ไว้คำนวณ address ล่วงหน้า: vm.cloneAddressFor(factory, factorySalt(creator, salt), โค้ดต้นแบบ)) */
export function factorySalt(creator, salt) {
  return `${String(creator).toLowerCase()}:${salt}`;
}

/**
 * แผน deploy ทั้งชุดตามลำดับ nonce ของ deployer
 * @param {{ addressAt: (nonce: number) => string, symbol?: string }} options
 *   addressAt(n) = address ของโปรแกรมที่ deploy ด้วย nonce n (vm.programAddressFor(deployer, n))
 * @returns {Array<{ key, nonce, address, namespace, title, description, code, input }>}
 *   input ใช้ตัวเลขแบบ "18n" (ส่งผ่าน JSON ของ /sendtx ได้)
 */
export function systemPrograms({ addressAt, symbol = "CARD" }) {
  const meta = (namespace, description) => ({ namespace, description });
  const list = [
    { key: "multicall", title: "Multicall", code: MULTICALL_PROGRAM,
      input: meta("multicall", "อ่าน / เรียกหลายโปรแกรมใน request เดียว (แบบ Multicall3)") },
    { key: "wcard", title: `Wrapped ${symbol}`, code: WCARD_PROGRAM,
      input: { name: `Wrapped ${symbol}`, ticker: `W${symbol}`, ...meta(`w${symbol.toLowerCase()}`, `ฝาก ${symbol} ได้ W${symbol} 1:1 ถอนคืนได้ทุกเมื่อ (แบบ WETH / WBNB)`) } },
    { key: "multisigTemplate", title: "Multisig template", code: MULTISIG_PROGRAM,
      input: meta("multisig-template", "ต้นแบบกระเป๋าหลายเจ้าของ · สร้างของตัวเองที่ factory.createMultisig") },
    { key: "tokenTemplate", title: "Token template", code: TOKEN_PROGRAM,
      input: { name: "Token template", ticker: "TEMPLATE", decimals: "18n", supply: "0n", ...meta("token-template", "ต้นแบบ token · สร้างของตัวเองที่ factory.createToken") } },
    { key: "nftTemplate", title: "NFT template", code: NFT_PROGRAM,
      input: { name: "NFT template", symbol: "TEMPLATE", ...meta("nft-template", "ต้นแบบ NFT · สร้างของตัวเองที่ factory.createNft") } },
    { key: "multiTokenTemplate", title: "Multi-token template", code: MULTITOKEN_PROGRAM,
      input: { name: "Multi-token template", symbol: "TEMPLATE", uri: "", ...meta("multitoken-template", "ต้นแบบ multi-token · สร้างของตัวเองที่ factory.createMultiToken") } },
    { key: "factory", title: "Factory", code: FACTORY_PROGRAM, input: meta("factory", "สร้าง token / NFT / multi-token / multisig ของตัวเองได้ทันที") },
  ].map((item, nonce) => ({ ...item, nonce, address: addressAt(nonce).toLowerCase(), namespace: item.input.namespace }));
  const at = Object.fromEntries(list.map((item) => [item.key, item.address]));
  list.find((item) => item.key === "factory").input.templates = {
    token: at.tokenTemplate, nft: at.nftTemplate, multiToken: at.multiTokenTemplate, multisig: at.multisigTemplate,
  };
  return list;
}
