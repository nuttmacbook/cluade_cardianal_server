/**
 * Multisender (like disperse.app / multisender) — a system program: one tx sends many items to many recipients
 *   input on deploy: { namespace?, icon?, url?, contact?, description? } · no owner / admin · no upgrader · no persistent state
 *
 *   sendNative({ transfers: [{ to, amount }, …] })                 attached value = exactly the sum of amounts (short / over → fails, no funds left behind)
 *   sendToken({ token, transfers: [{ to, amount }, …] })           token.transferFrom(sender → to) straight to the recipient
 *                                                                  (sender must approve(multisender, ≥ total) first)
 *   sendTokens({ transfers: [{ token, to, amount }, …] })          many tokens in one call (approve each token)
 *   sendNft({ nft, transfers: [{ to, tokenId }, …], safe?, data? }) nft.safeTransferFrom(sender → to) (safe: false = transferFrom)
 *                                                                  (sender must setApprovalForAll(multisender, true) first)
 *   sendMultiToken({ multiToken, transfers: [{ to, id, amount }, …], data? })  multiToken.safeTransferFrom(sender → to)
 *                                                                  (sender must setApprovalForAll(multisender, true) first)
 *   every function returns { count, total } · total = sum of amounts (NFT = number of items · sendTokens = raw sum across tokens)
 *
 * event (once per call, not per entry — each token / NFT already emits its own Transfer per entry)
 *   Sent { kind, asset, sender, count, total }   indexed: kind, asset, sender
 *     kind = "native" | "token" | "tokens" | "nft" | "multiToken" · asset = the token's address (native / tokens = ZERO_ADDRESS)
 *
 * Rules
 *   all-or-nothing: any entry fails (balance / allowance / recipient rejects) → the whole call reverts
 *   entries per call 1 … MULTISENDER_MAX_ITEMS (100) — measured on the bluewolf fork (recipients are wallets): 100 entries ≈ 0.12M (native coin)
 *     / 1.05M (token · multiple tokens) / 1.2M (multi-token) / 1.7M (NFT) gas · a single entry ≈ 37k · program recipients = costlier, depending on the hook
 *   recipient: address 0x… 40 hex · not the zero address / the multisender itself / the sender · amount is a bigint > 0n · tokenId / id is a bigint ≥ 0n
 *   functions other than sendNative must not attach value · pulls only from the call's sender (no from in input)
 *   tokens must return true from transferFrom / safeTransferFrom or it fails · no before / after balance checks (the program holds nothing, so there are no books to drift)
 *   program recipients (NFT / multi-token) get onERC721Received / onERC1155Received → they can't re-enter the multisender meanwhile ("reentrant call")
 *   after sendNative the program's native balance must return to what it was before value was attached (rechecked at the end of the call)
 * storage: lock (only during a call · deleted before it ends) — nothing else
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";
import { ZERO_ADDRESS } from "./token.js";

/** max entries per call (keeps a call under the 5M gas block · see the measured numbers above) */
export const MULTISENDER_MAX_ITEMS = 100;
export const MULTISENDER_FUNCTIONS = ["sendNative", "sendToken", "sendTokens", "sendNft", "sendMultiToken"];
export const MULTISENDER_EVENTS = ["Sent"];

export const MULTISENDER_PROGRAM = `function program() {
  const ZERO = "${ZERO_ADDRESS}"
  const MAX_ITEMS = ${MULTISENDER_MAX_ITEMS}
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    setProgramMetadata(params.input)
  }

  function checkRecipient(to, sender, self) {
    const address = checkAddress(to, "to")
    if (address === ZERO) throw new Error("to must not be the zero address")
    if (address === self) throw new Error("to must not be the multisender")
    if (address === sender) throw new Error("to must not be the sender")
    return address
  }
  function checkAmount(amount) {
    if (typeof amount !== "bigint" || amount <= 0n) throw new Error("amount must be a bigint greater than 0")
    return amount
  }
  function checkId(id, label) {
    if (typeof id !== "bigint" || id < 0n) throw new Error(label + " must be a non-negative bigint")
    return id
  }
  function checkAsset(asset, label) {
    const address = checkAddress(asset, label)
    if (address === ZERO || address === ThisAddress()) throw new Error(label + " is not a valid program")
    if (!IsProgram(address)) throw new Error(label + " is not a program")
    return address
  }
  function checkData(data) {
    if (data === undefined || data === null) return ""
    if (typeof data !== "string") throw new Error("data must be a string")
    return data
  }
  function listOf(params) {
    const transfers = params.input.transfers
    if (!Array.isArray(transfers)) throw new Error("transfers must be an array")
    if (transfers.length === 0) throw new Error("no transfers")
    if (transfers.length > MAX_ITEMS) throw new Error("too many transfers (max " + MAX_ITEMS + ")")
    for (const item of transfers) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("each transfer must be an object")
    }
    return transfers
  }
  function noValue(params) {
    if (params.value !== 0n) throw new Error("do not attach native value (use sendNative)")
  }
  // กันการเรียกซ้อน (ผู้รับ NFT / multi-token หรือ token ปลอมเรียกกลับเข้ามา)
  function lock() {
    if (readDB("lock") === true) throw new Error("reentrant call")
    writeDB("lock", true)
  }
  function unlock() { deleteDB("lock") }
  function expectTrue(reply, what) {
    if (reply !== true) throw new Error(what + " did not return true")
  }
  function finish(kind, asset, sender, count, total) {
    unlock()
    emit("Sent", { kind: kind, asset: asset, sender: sender, count: count, total: total }, { indexed: ["kind", "asset", "sender"] })
    return { count: count, total: total }
  }

  function sendNative(params) {
    lock()
    const sender = params.context.sender
    const self = ThisAddress()
    const transfers = listOf(params)
    const items = []
    let total = 0n
    for (const item of transfers) {
      const to = checkRecipient(item.to, sender, self)
      const amount = checkAmount(item.amount)
      total = total + amount
      items.push({ to: to, amount: amount })
    }
    // ตรวจครบก่อนโอนออก · value ต้องเท่าผลรวมพอดี (ไม่มีเงินค้างในโปรแกรม)
    if (params.value !== total) throw new Error("value must equal the sum of amounts (" + total + ")")
    const before = ThisBalance() - params.value
    for (const item of items) transferNative(item.to, item.amount)
    if (ThisBalance() !== before) throw new Error("native balance mismatch")
    return finish("native", ZERO, sender, BigInt(items.length), total)
  }

  function sendToken(params) {
    noValue(params)
    lock()
    const sender = params.context.sender
    const self = ThisAddress()
    const token = checkAsset(params.input.token, "token")
    const transfers = listOf(params)
    const items = []
    let total = 0n
    for (const item of transfers) {
      const to = checkRecipient(item.to, sender, self)
      const amount = checkAmount(item.amount)
      total = total + amount
      items.push({ to: to, amount: amount })
    }
    for (const item of items) {
      expectTrue(runProgram(token, "transferFrom", { from: sender, to: item.to, amount: item.amount }), "token transferFrom")
    }
    return finish("token", token, sender, BigInt(items.length), total)
  }

  function sendTokens(params) {
    noValue(params)
    lock()
    const sender = params.context.sender
    const self = ThisAddress()
    const transfers = listOf(params)
    const items = []
    let total = 0n
    for (const item of transfers) {
      const token = checkAsset(item.token, "token")
      const to = checkRecipient(item.to, sender, self)
      const amount = checkAmount(item.amount)
      total = total + amount
      items.push({ token: token, to: to, amount: amount })
    }
    for (const item of items) {
      expectTrue(runProgram(item.token, "transferFrom", { from: sender, to: item.to, amount: item.amount }), "token transferFrom")
    }
    return finish("tokens", ZERO, sender, BigInt(items.length), total)
  }

  function sendNft(params) {
    noValue(params)
    lock()
    const sender = params.context.sender
    const self = ThisAddress()
    const nft = checkAsset(params.input.nft, "nft")
    const safe = params.input.safe !== false
    const data = checkData(params.input.data)
    const transfers = listOf(params)
    const items = []
    for (const item of transfers) {
      items.push({ to: checkRecipient(item.to, sender, self), tokenId: checkId(item.tokenId, "tokenId") })
    }
    for (const item of items) {
      if (safe) {
        expectTrue(runProgram(nft, "safeTransferFrom", { from: sender, to: item.to, tokenId: item.tokenId, data: data }), "nft safeTransferFrom")
      } else {
        expectTrue(runProgram(nft, "transferFrom", { from: sender, to: item.to, tokenId: item.tokenId }), "nft transferFrom")
      }
    }
    const count = BigInt(items.length)
    return finish("nft", nft, sender, count, count)
  }

  function sendMultiToken(params) {
    noValue(params)
    lock()
    const sender = params.context.sender
    const self = ThisAddress()
    const multiToken = checkAsset(params.input.multiToken, "multiToken")
    const data = checkData(params.input.data)
    const transfers = listOf(params)
    const items = []
    let total = 0n
    for (const item of transfers) {
      const to = checkRecipient(item.to, sender, self)
      const id = checkId(item.id, "id")
      const amount = checkAmount(item.amount)
      total = total + amount
      items.push({ to: to, id: id, amount: amount })
    }
    for (const item of items) {
      expectTrue(runProgram(multiToken, "safeTransferFrom", { from: sender, to: item.to, id: item.id, amount: item.amount, data: data }),
        "multiToken safeTransferFrom")
    }
    return finish("multiToken", multiToken, sender, BigInt(items.length), total)
  }

  return { sendNative, sendToken, sendTokens, sendNft, sendMultiToken }
}`;
