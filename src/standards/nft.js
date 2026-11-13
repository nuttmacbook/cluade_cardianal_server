/**
 * NFT standard (similar to ERC-721) — 1 tokenId = a single item with a single owner
 *
 * Required functions (read-only)
 *   name() / symbol()                         → string
 *   balanceOf({ owner })                      → bigint   number of items the owner holds
 *   ownerOf({ tokenId })                      → address  (no such item → throw "token does not exist")
 *   getApproved({ tokenId })                  → address | null
 *   isApprovedForAll({ owner, operator })     → boolean
 *   tokenURI({ tokenId })                     → string   (the item's uri, or baseURI + tokenId)
 * State-changing functions
 *   approve({ to, tokenId })                  → true     (to = null / zero address = revoke) owner or operator only
 *   setApprovalForAll({ operator, approved }) → true
 *   transferFrom({ from, to, tokenId })       → true     owner / approved address / operator
 *   safeTransferFrom({ from, to, tokenId, data? }) → true  program recipient → must return "0x150b7a02" from onERC721Received
 * Extra functions in NFT_PROGRAM
 *   mint({ to, tokenId?, uri? }) → tokenId   program owner / minter only · tokenId omitted = next number (starting at 1n)
 *   burn({ tokenId }) → true · setMinter({ minter, allowed }) · owner() · totalSupply() · supportsInterface({ interfaceId })
 * Events that must be emitted
 *   Transfer { from, to, tokenId }            on every move · mint from = ZERO_ADDRESS · burn to = ZERO_ADDRESS
 *   Approval { owner, approved, tokenId }
 *   ApprovalForAll { owner, operator, approved }
 *
 * tokenId is always a bigint ("5n" in input) · storage: owners:<id> · owned:<owner>:<id> (lets the explorer list an address's holdings) · balances:<owner>
 * /evm maps Transfer → ERC-721 log (4th topic = tokenId) — see src/node/evm-rpc.js
 */
import { ZERO_ADDRESS, checkStandard } from "./token.js";
import { ERC721_RECEIVED } from "./wallet.js";

export const NFT_FUNCTIONS = ["name", "symbol", "balanceOf", "ownerOf", "getApproved", "isApprovedForAll", "tokenURI",
  "approve", "setApprovalForAll", "transferFrom", "safeTransferFrom"];
export const NFT_EVENTS = ["Transfer", "Approval", "ApprovalForAll"];
/** ERC-165 interface ids: ERC-165 / ERC-721 / ERC-721 Metadata */
export const NFT_INTERFACES = ["0x01ffc9a7", "0x80ac58cd", "0x5b5e139f"];

/** does this code follow the NFT standard? → { ok, missing: [] } */
export const checkNftStandard = (code) => checkStandard(code, NFT_FUNCTIONS, NFT_EVENTS);

/**
 * Standard NFT program — input on deploy: { name, symbol, baseURI?, owner?, namespace?, icon?, url?, contact?, description? }
 * owner (omitted = the deployer) (can mint and set other minters)
 */
export const NFT_PROGRAM = `function program() {
  const ZERO = "${ZERO_ADDRESS}"

  function initialization(params) {
    writeDB("name", params.input.name)
    writeDB("symbol", params.input.symbol)
    writeDB("baseURI", params.input.baseURI || "")
    const owner = params.input.owner || params.context.sender   // a factory cloning the template passes owner = the creator
    if (params.input.owner !== undefined && (typeof owner !== "string" || owner.length !== 42)) throw new Error("owner must be an address")
    writeDB("owner", owner)
    writeDB("totalSupply", 0n)
    writeDB("nextTokenId", 1n)
    if (params.input.namespace) setMetadata("namespace", params.input.namespace)
    if (params.input.icon) setMetadata("icon", params.input.icon)
    if (params.input.url) setMetadata("url", params.input.url)
    if (params.input.contact) setMetadata("contact", params.input.contact)
    if (params.input.description) setMetadata("description", params.input.description)
  }

  function checkId(tokenId) {
    if (typeof tokenId !== "bigint" || tokenId < 0n) throw new Error("tokenId must be a non-negative bigint")
    return tokenId
  }
  function checkAddress(address, label) {
    if (typeof address !== "string" || address.length !== 42 || !address.startsWith("0x")) throw new Error(label + " must be an address")
    return address
  }
  function ownerOfId(tokenId) {
    const owner = readDB(map("owners", checkId(tokenId)))
    if (owner === undefined) throw new Error("token does not exist")
    return owner
  }
  function isOperator(owner, operator) { return readDB(map("operators", owner, operator)) === true }
  function canManage(spender, owner, tokenId) {
    return spender === owner || readDB(map("approved", tokenId)) === spender || isOperator(owner, spender)
  }
  function addBalance(who, delta) { writeDB(map("balances", who), (readDB(map("balances", who)) || 0n) + delta) }

  function name() { return readDB("name") }
  function symbol() { return readDB("symbol") }
  function owner() { return readDB("owner") }
  function totalSupply() { return readDB("totalSupply") }
  function balanceOf(params) { return readDB(map("balances", checkAddress(params.input.owner, "owner"))) || 0n }
  function ownerOf(params) { return ownerOfId(params.input.tokenId) }
  function getApproved(params) {
    ownerOfId(params.input.tokenId)
    return readDB(map("approved", params.input.tokenId)) || null
  }
  function isApprovedForAll(params) { return isOperator(params.input.owner, params.input.operator) }
  function tokenURI(params) {
    const tokenId = params.input.tokenId
    ownerOfId(tokenId)
    const own = readDB(map("uris", tokenId))
    if (own) return own
    const base = readDB("baseURI")
    return base ? base + tokenId : ""
  }
  function supportsInterface(params) {
    const id = String(params.input.interfaceId || "").toLowerCase()
    return ${JSON.stringify(NFT_INTERFACES)}.includes(id)
  }

  function setMinter(params) {
    if (params.context.sender !== readDB("owner")) throw new Error("only owner")
    const minter = checkAddress(params.input.minter, "minter")
    writeDB(map("minters", minter), params.input.allowed === true)
    emit("MinterSet", { minter: minter, allowed: params.input.allowed === true })
    return true
  }

  function mint(params) {
    const sender = params.context.sender
    if (sender !== readDB("owner") && readDB(map("minters", sender)) !== true) throw new Error("only owner or minter")
    const to = checkAddress(params.input.to, "to")
    if (to === ZERO) throw new Error("mint to the zero address")
    const next = readDB("nextTokenId")
    const tokenId = checkId(params.input.tokenId === undefined || params.input.tokenId === null ? next : params.input.tokenId)
    if (readDB(map("owners", tokenId)) !== undefined) throw new Error("token already minted")
    if (tokenId >= next) writeDB("nextTokenId", tokenId + 1n)
    writeDB(map("owners", tokenId), to)
    writeDB(map("owned", to, tokenId), true)
    addBalance(to, 1n)
    writeDB("totalSupply", readDB("totalSupply") + 1n)
    if (params.input.uri) writeDB(map("uris", tokenId), params.input.uri)
    emit("Transfer", { from: ZERO, to: to, tokenId: tokenId }, { indexed: ["from", "to", "tokenId"] })
    return tokenId
  }

  function burn(params) {
    const tokenId = checkId(params.input.tokenId)
    const holder = ownerOfId(tokenId)
    if (!canManage(params.context.sender, holder, tokenId)) throw new Error("not owner nor approved")
    deleteDB(map("approved", tokenId))
    deleteDB(map("owners", tokenId))
    deleteDB(map("owned", holder, tokenId))
    deleteDB(map("uris", tokenId))
    addBalance(holder, -1n)
    writeDB("totalSupply", readDB("totalSupply") - 1n)
    emit("Transfer", { from: holder, to: ZERO, tokenId: tokenId }, { indexed: ["from", "to", "tokenId"] })
    return true
  }

  function approve(params) {
    const tokenId = checkId(params.input.tokenId)
    const holder = ownerOfId(tokenId)
    const sender = params.context.sender
    if (sender !== holder && !isOperator(holder, sender)) throw new Error("not owner nor operator")
    const to = params.input.to || ZERO
    checkAddress(to, "to")
    if (to === holder) throw new Error("approve to the current owner")
    if (to === ZERO) deleteDB(map("approved", tokenId))
    else writeDB(map("approved", tokenId), to)
    emit("Approval", { owner: holder, approved: to, tokenId: tokenId }, { indexed: ["owner", "approved", "tokenId"] })
    return true
  }

  function setApprovalForAll(params) {
    const operator = checkAddress(params.input.operator, "operator")
    if (operator === params.context.sender) throw new Error("approve to caller")
    const approved = params.input.approved === true
    writeDB(map("operators", params.context.sender, operator), approved)
    emit("ApprovalForAll", { owner: params.context.sender, operator: operator, approved: approved }, { indexed: ["owner", "operator"] })
    return true
  }

  function transferFrom(params) {
    const tokenId = checkId(params.input.tokenId)
    const from = params.input.from
    const to = checkAddress(params.input.to, "to")
    const holder = ownerOfId(tokenId)
    if (holder !== from) throw new Error("from is not the owner")
    if (!canManage(params.context.sender, holder, tokenId)) throw new Error("not owner nor approved")
    if (to === ZERO) throw new Error("transfer to the zero address (use burn)")
    deleteDB(map("approved", tokenId))
    deleteDB(map("owned", from, tokenId))
    writeDB(map("owned", to, tokenId), true)
    addBalance(from, -1n)
    addBalance(to, 1n)
    writeDB(map("owners", tokenId), to)
    emit("Transfer", { from: from, to: to, tokenId: tokenId }, { indexed: ["from", "to", "tokenId"] })
    return true
  }

  function safeTransferFrom(params) {
    transferFrom(params)
    const to = params.input.to
    if (IsProgram(to)) {
      const reply = runProgram(to, "onERC721Received", { operator: params.context.sender, from: params.input.from,
        tokenId: params.input.tokenId, data: params.input.data || "" })
      if (reply !== "${ERC721_RECEIVED}") throw new Error("receiver did not accept the token")
    }
    return true
  }

  return { name, symbol, owner, totalSupply, balanceOf, ownerOf, getApproved, isApprovedForAll, tokenURI, supportsInterface, setMinter, mint, burn, approve, setApprovalForAll, transferFrom, safeTransferFrom }
}`;
