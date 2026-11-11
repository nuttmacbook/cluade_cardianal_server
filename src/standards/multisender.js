/**
 * Multisender (แบบ disperse.app / multisender) — โปรแกรมกลาง: tx เดียวส่งของหลายชิ้นให้หลายคน
 *   input ตอน deploy: { namespace?, icon?, url?, contact?, description? } · ไม่มีเจ้าของ / admin · ไม่มี upgrader · ไม่เก็บ state ถาวร
 *
 *   sendNative({ transfers: [{ to, amount }, …] })                 แนบ value = ผลรวม amount พอดี (ขาด / เกิน → ล้ม ไม่มีเงินค้าง)
 *   sendToken({ token, transfers: [{ to, amount }, …] })           token.transferFrom(sender → to) ตรงถึงผู้รับ
 *                                                                  (sender ต้อง approve(multisender, ≥ ผลรวม) ไว้ก่อน)
 *   sendTokens({ transfers: [{ token, to, amount }, …] })          หลาย token ใน call เดียว (approve ทีละ token)
 *   sendNft({ nft, transfers: [{ to, tokenId }, …], safe?, data? }) nft.safeTransferFrom(sender → to) (safe: false = transferFrom)
 *                                                                  (sender ต้อง setApprovalForAll(multisender, true) ไว้ก่อน)
 *   sendMultiToken({ multiToken, transfers: [{ to, id, amount }, …], data? })  multiToken.safeTransferFrom(sender → to)
 *                                                                  (sender ต้อง setApprovalForAll(multisender, true) ไว้ก่อน)
 *   ทุกฟังก์ชันคืน { count, total } · total = ผลรวม amount (NFT = จำนวนชิ้น · sendTokens = ผลรวมดิบข้ามหลาย token)
 *
 * event (1 ครั้งต่อ call ไม่ใช่ต่อรายการ — Transfer ของแต่ละรายการ token / NFT emit เองอยู่แล้ว)
 *   Sent { kind, asset, sender, count, total }   indexed: kind, asset, sender
 *     kind = "native" | "token" | "tokens" | "nft" | "multiToken" · asset = address ของ token (native / tokens = ZERO_ADDRESS)
 *
 * กติกา
 *   all-or-nothing: รายการไหนล้ม (ยอด / วงเงิน / ผู้รับปฏิเสธ) → ทั้ง call ย้อน
 *   รายการต่อ call 1 … MULTISENDER_MAX_ITEMS (100) — วัดด้วย fork bluewolf (ผู้รับเป็นกระเป๋า): 100 รายการ ≈ 0.12M (เหรียญหลัก)
 *     / 1.05M (token · หลาย token) / 1.2M (multi-token) / 1.7M (NFT) gas · ส่งรายการเดียว ≈ 37k · ผู้รับเป็นโปรแกรม = แพงขึ้นตาม hook
 *   ผู้รับ: address 0x… 40 hex · ห้าม zero address / ตัว multisender เอง / ผู้ส่งเอง · amount เป็น bigint > 0n · tokenId / id เป็น bigint ≥ 0n
 *   ฟังก์ชันที่ไม่ใช่ sendNative ห้ามแนบ value · ดึงจาก sender ของ call เท่านั้น (ไม่มี from ใน input)
 *   token ต้องตอบ true จาก transferFrom / safeTransferFrom ไม่งั้นล้ม · ไม่ไล่เช็คยอดก่อน / หลัง (โปรแกรมไม่ถือของ จึงไม่มีบัญชีให้เพี้ยน)
 *   ผู้รับที่เป็นโปรแกรม (NFT / multi-token) ถูกเรียก onERC721Received / onERC1155Received → ระหว่างนั้นเรียก multisender ซ้อนไม่ได้ ("reentrant call")
 *   หลัง sendNative ยอดเหรียญหลักของโปรแกรมต้องกลับเท่าก่อนแนบ value (ตรวจซ้ำท้าย call)
 * storage: lock (มีเฉพาะระหว่าง call · ลบทิ้งก่อนจบ) — นอกนั้นไม่มี
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";
import { ZERO_ADDRESS } from "./token.js";

/** รายการสูงสุดต่อ call (กัน call เกิน block 5M gas · ดูตัวเลขที่วัดได้ข้างบน) */
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
