/**
 * ตลาด NFT (โปรแกรมกลาง) — ขายแบบฝากของไว้กับตลาด (escrow) · รองรับ NFT แบบ ERC-721 (src/standards/nft.js)
 * และ multi-token แบบ ERC-1155 (src/standards/multitoken.js) · จ่ายด้วยเหรียญหลัก (BWSC) หรือ token ตามมาตรฐาน (src/standards/token.js)
 *
 * input ตอน deploy: { feeBps?, feeRecipient?, namespace?, icon?, url?, contact?, description? }
 *   feeBps 0n … 1000n (สูงสุด 10%) ค่าเริ่ม 0n · feeBps > 0n ต้องมี feeRecipient
 *   ค่าธรรมเนียมตั้งครั้งเดียวตอน deploy เปลี่ยนไม่ได้ตลอดไป — ไม่มี admin / owner / upgrade
 *   fee = floor(ยอดรวม × feeBps / 10000) (ปัดลง: ไม่เกินอัตราที่ประกาศ) · ผู้ขายได้ ยอดรวม − fee พอดี → ไม่มีเศษค้างในตลาด
 *
 * ฟังก์ชันที่เปลี่ยน state (ทุกตัวห้ามแนบ value ยกเว้นที่ระบุ · กันเรียกซ้อน (reentrancy) ด้วย key "lock")
 *   list({ nft, tokenId, price, payToken? }) → listingId
 *       ผู้ขาย (= เจ้าของ ownerOf) ต้อง approve / setApprovalForAll ให้ตลาดก่อน · ตลาดดึง NFT มาเก็บด้วย safeTransferFrom
 *       payToken "" / ไม่ส่ง = เหรียญหลัก · อื่น ๆ = address ของโปรแกรม token
 *   listMulti({ multiToken, id, amount, pricePerUnit, payToken? }) → listingId   (ผู้ขาย setApprovalForAll ให้ตลาดก่อน)
 *   buy({ listingId, amount?, price? }) → { listingId, amount, price, fee }
 *       amount ไม่ส่ง = 1n (ERC-721 ต้องเป็น 1n) · ERC-1155 ซื้อบางส่วนได้
 *       price (ไม่บังคับ) = ราคาต่อหน่วยที่ผู้ซื้อเห็น ไม่ตรง → "price changed" (กันผู้ขายขึ้นราคาตัดหน้า — แนะนำให้ส่งเมื่อจ่ายด้วย token)
 *       เหรียญหลัก: แนบ value = ราคาต่อหน่วย × amount พอดี (ขาด / เกิน = ล้ม ไม่มีการทอน)
 *       token: ผู้ซื้อ approve ให้ตลาด ≥ ยอดรวม → transferFrom ผู้ซื้อ → ผู้ขาย (ยอดรวม − fee) และ → feeRecipient (fee)
 *       ผู้ขายซื้อของตัวเองไม่ได้ · ของส่งให้ผู้ซื้อด้วย safeTransferFrom (ผู้ซื้อที่เป็นโปรแกรมต้องตอบ onERC721Received / onERC1155Received)
 *   updatePrice({ listingId, price }) → true   ผู้ขายเท่านั้น (ERC-1155 = ราคาต่อหน่วย)
 *   cancel({ listingId }) → true               ผู้ขายเท่านั้น · คืนของที่เหลือให้ผู้ขาย
 *   makeOffer({ nft, tokenId, payToken, amount, expiresAt? }) → offerId   (ERC-721 เท่านั้น)
 *       payToken "" = เหรียญหลัก: แนบ value = amount พอดี · token: approve ให้ตลาดก่อน (ตลาดดึงมาเก็บ ตรวจยอดที่ได้รับจริง)
 *       expiresAt = unix วินาที (ไม่ส่ง / 0n = ไม่หมดอายุ) ต้องมากกว่าเวลาของ block · เจ้าของ NFT เสนอซื้อของตัวเองไม่ได้
 *   cancelOffer({ offerId }) → true   ผู้เสนอเท่านั้น (หมดอายุแล้วก็ยกเลิกได้ — เงินที่ฝากค้างจนกว่าผู้เสนอจะยกเลิก) · คืนเงินที่ฝาก
 *   acceptOffer({ offerId }) → { offerId, listingId, amount, fee }
 *       เจ้าของ NFT ปัจจุบันเท่านั้น: ถ้าวางขายอยู่ในตลาดนี้ = ผู้ขายของรายการนั้น (รายการปิดเป็น "sold") ·
 *       ไม่ได้วางขาย = ownerOf ต้องเป็นผู้เรียก และต้อง approve ให้ตลาดก่อน · ข้อเสนอหมดอายุ = รับไม่ได้
 *   onERC721Received / onERC1155Received → magic เฉพาะของที่ตลาดดึงเองระหว่าง list / listMulti (ตรงตามที่คาดไว้ใน lock)
 *       ของที่ส่งเข้ามาตรง ๆ ด้วย safe transfer ถูกปฏิเสธ · onERC1155BatchReceived ปฏิเสธเสมอ
 *       ⚠️ ของที่โอนเข้ามาด้วย transferFrom ธรรมดา (ไม่ผ่าน hook) ค้างในตลาดถาวร ไม่มีใครดึงออกได้
 *
 * อ่านอย่างเดียว
 *   fee() → { feeBps, feeRecipient } · listingCount() → bigint · getListing({ listingId }) → listing
 *   listings({ start?, limit?, activeOnly? }) · listingsOf({ seller, start?, limit?, activeOnly? })
 *   listingsForCollection({ nft, start?, limit?, activeOnly? }) · offersFor({ nft, tokenId, start?, limit?, activeOnly? })
 *     → { items: [...], next: ตำแหน่งถัดไป | null, total } · limit ค่าเริ่ม 20n สูงสุด 50n (ไล่ไม่เกิน limit รายการต่อครั้ง)
 *   getOffer({ offerId }) → offer · offerCount() → bigint
 *   listing = { listingId, kind: "erc721" | "erc1155", collection, tokenId, amount (เหลือ), sold, price (ต่อหน่วย), payToken, seller, status: active | sold | cancelled, createdAt }
 *   offer   = { offerId, collection, tokenId, payToken, amount, buyer, expiresAt, status: active | accepted | cancelled, createdAt }
 *
 * event
 *   Listed { listingId, kind, seller, collection, tokenId, amount, price, payToken }
 *   PriceUpdated { listingId, oldPrice, price } · Cancelled { listingId, seller, amount }
 *   Sold { listingId, buyer, seller, amount, price (ยอดรวม), fee, payToken }
 *   OfferMade { offerId, buyer, collection, tokenId, payToken, amount, expiresAt } · OfferCancelled { offerId, buyer, amount }
 *   OfferAccepted { offerId, listingId (null = ไม่ได้วางขาย), seller, buyer, collection, tokenId, amount, fee }
 *
 * storage: feeBps · feeRecipient · listingCount · offerCount · lock (ชั่วคราวใน tx) · listing:<id> · offer:<id>
 *   active:<collection>:<tokenId> → listingId (ERC-721 ที่วางขายอยู่) · sellerCount:<seller> · seller:<seller>:<n> → listingId
 *   collectionCount:<collection> · collection:<collection>:<n> → listingId · offerCountFor:<collection>:<tokenId> · offersFor:<collection>:<tokenId>:<n> → offerId
 *
 * ข้อจำกัด
 *   ไม่มี royalty (ผู้สร้าง NFT ไม่ได้ส่วนแบ่ง) · ไม่มี admin จึงแก้ค่าธรรมเนียม / ดึงของที่ค้างไม่ได้
 *   ผู้ขายต้องเป็นเจ้าของเอง (operator วางขายแทนไม่ได้) · ข้อเสนอเฉพาะ ERC-721 · ไม่มี loop ตามรายการของผู้ใช้ในฟังก์ชันที่เปลี่ยน state
 *   ผู้ซื้อต้องเชื่อโปรแกรม NFT / token เอง (ตลาดตรวจ ownerOf / balanceOf หลังโอนทุกครั้ง แต่โปรแกรมที่โกหกเองตรวจไม่ได้)
 *   token แบบหักค่าโอน (fee-on-transfer) ใช้ไม่ได้: ตลาดตรวจว่าผู้รับได้ยอดเต็ม ไม่งั้นทั้ง tx ล้ม
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";
import { ZERO_ADDRESS } from "./token.js";
import { ERC721_RECEIVED, ERC1155_RECEIVED } from "./wallet.js";

export const NFT_MARKET_MAX_FEE_BPS = 1000n;
export const NFT_MARKET_MAX_PAGE = 50n;
export const NFT_MARKET_FUNCTIONS = ["list", "listMulti", "buy", "updatePrice", "cancel", "makeOffer", "cancelOffer", "acceptOffer"];
export const NFT_MARKET_EVENTS = ["Listed", "PriceUpdated", "Cancelled", "Sold", "OfferMade", "OfferCancelled", "OfferAccepted"];

export const NFT_MARKET_PROGRAM = `function program() {
  const ZERO = "${ZERO_ADDRESS}"
  const MAX_FEE_BPS = ${NFT_MARKET_MAX_FEE_BPS}n
  const MAX_PAGE = ${NFT_MARKET_MAX_PAGE}n
  ${SET_METADATA}
  ${CHECK_ADDRESS}

  function initialization(params) {
    const input = params.input || {}
    const feeBps = input.feeBps === undefined || input.feeBps === null ? 0n : input.feeBps
    if (typeof feeBps !== "bigint" || feeBps < 0n || feeBps > MAX_FEE_BPS) throw new Error("feeBps must be a bigint 0n … " + MAX_FEE_BPS + "n")
    let recipient = null
    if (input.feeRecipient !== undefined && input.feeRecipient !== null && input.feeRecipient !== "") {
      recipient = checkAddress(input.feeRecipient, "feeRecipient")
      if (recipient === ZERO) throw new Error("feeRecipient must not be the zero address")
    }
    if (feeBps > 0n && recipient === null) throw new Error("feeRecipient is required when feeBps > 0")
    writeDB("feeBps", feeBps)
    writeDB("feeRecipient", recipient)
    writeDB("listingCount", 0n)
    writeDB("offerCount", 0n)
    setProgramMetadata(input)
  }

  // ---------- ตัวช่วย ----------
  function now(params) { return params.block.timestamp / 1000n }
  function noValue(params) { if (params.value !== undefined && params.value !== 0n) throw new Error("this function does not accept native value") }
  function checkId(value, label) {
    if (typeof value !== "bigint" || value < 0n) throw new Error(label + " must be a non-negative bigint")
    return value
  }
  function checkPositive(value, label) {
    if (typeof value !== "bigint" || value <= 0n) throw new Error(label + " must be a bigint greater than 0")
    return value
  }
  function checkProgram(address, label) {
    const addr = checkAddress(address, label)
    if (addr === ThisAddress()) throw new Error(label + " must not be the market")
    if (!IsProgram(addr)) throw new Error(label + " must be a program")
    return addr
  }
  function checkPayToken(value) {
    if (value === undefined || value === null || value === "") return ""
    return checkProgram(value, "payToken")
  }
  function enter(expect) {
    if (readDB("lock") !== undefined) throw new Error("reentrant call")
    writeDB("lock", expect)
  }
  function exit() { deleteDB("lock") }
  function feeOf(total) { return total * readDB("feeBps") / 10000n }

  function tokenBalance(token, who) { return runProgram(token, "balanceOf", { who: who }, { readonly: true }) }
  /** โอน token แล้วตรวจว่าผู้รับได้ยอดเต็มจริง (ไม่เชื่อค่าที่ token ตอบอย่างเดียว) · from = ThisAddress() → transfer */
  function moveToken(token, from, to, amount) {
    if (amount === 0n) return
    const before = tokenBalance(token, to)
    if (from === ThisAddress()) runProgram(token, "transfer", { to: to, amount: amount })
    else runProgram(token, "transferFrom", { from: from, to: to, amount: amount })
    if (tokenBalance(token, to) - before !== amount) throw new Error("token transfer did not deliver the full amount")
  }
  function moveNative(to, amount) { if (amount > 0n) transferNative(to, amount) }
  /** จ่ายยอดรวม: ผู้ขายได้ total − fee · feeRecipient ได้ fee (payer = ThisAddress() → จ่ายจากเงินที่ฝากไว้) */
  function settle(payToken, payer, seller, total) {
    const fee = feeOf(total)
    const recipient = readDB("feeRecipient")
    if (payToken === "") {
      moveNative(seller, total - fee)
      if (fee > 0n) moveNative(recipient, fee)
    } else {
      moveToken(payToken, payer, seller, total - fee)
      if (fee > 0n) moveToken(payToken, payer, recipient, fee)
    }
    return fee
  }
  function ownerOfNft(collection, tokenId) { return runProgram(collection, "ownerOf", { tokenId: tokenId }, { readonly: true }) }
  function multiBalance(collection, account, id) { return runProgram(collection, "balanceOf", { account: account, id: id }, { readonly: true }) }
  /** ส่ง NFT / ของออกจากตลาด แล้วตรวจว่าถึงผู้รับจริง */
  function deliver(listing, to, amount, safe) {
    if (listing.kind === "erc721") {
      runProgram(listing.collection, safe ? "safeTransferFrom" : "transferFrom", { from: ThisAddress(), to: to, tokenId: listing.tokenId })
      if (ownerOfNft(listing.collection, listing.tokenId) !== to) throw new Error("nft was not delivered")
    } else {
      const before = multiBalance(listing.collection, to, listing.tokenId)
      runProgram(listing.collection, "safeTransferFrom", { from: ThisAddress(), to: to, id: listing.tokenId, amount: amount, data: "" })
      if (multiBalance(listing.collection, to, listing.tokenId) - before !== amount) throw new Error("items were not delivered")
    }
  }

  function loadListing(listingId) {
    const listing = readDB(map("listing", checkId(listingId, "listingId")))
    if (listing === undefined) throw new Error("listing not found")
    return listing
  }
  function activeListing(listingId) {
    const listing = loadListing(listingId)
    if (listing.status !== "active") throw new Error("listing is not active")
    return listing
  }
  function loadOffer(offerId) {
    const offer = readDB(map("offer", checkId(offerId, "offerId")))
    if (offer === undefined) throw new Error("offer not found")
    return offer
  }

  function addListing(listing) {
    const id = readDB("listingCount")
    listing.listingId = id
    writeDB("listingCount", id + 1n)
    writeDB(map("listing", id), listing)
    const sellerCount = readDB(map("sellerCount", listing.seller)) || 0n
    writeDB(map("seller", listing.seller, sellerCount), id)
    writeDB(map("sellerCount", listing.seller), sellerCount + 1n)
    const collectionCount = readDB(map("collectionCount", listing.collection)) || 0n
    writeDB(map("collection", listing.collection, collectionCount), id)
    writeDB(map("collectionCount", listing.collection), collectionCount + 1n)
    return id
  }
  function emitListed(listing) {
    emit("Listed", { listingId: listing.listingId, kind: listing.kind, seller: listing.seller, collection: listing.collection,
      tokenId: listing.tokenId, amount: listing.amount, price: listing.price, payToken: listing.payToken },
      { indexed: ["listingId", "seller", "collection"] })
  }

  // ---------- วางขาย ----------
  function list(params) {
    noValue(params)
    const input = params.input || {}
    const collection = checkProgram(input.nft, "nft")
    const tokenId = checkId(input.tokenId, "tokenId")
    const price = checkPositive(input.price, "price")
    const payToken = checkPayToken(input.payToken)
    const seller = params.context.sender
    if (ownerOfNft(collection, tokenId) !== seller) throw new Error("only the nft owner can list it")
    if (readDB(map("active", collection, tokenId)) !== undefined) throw new Error("token is already listed")
    enter({ kind: "erc721", collection: collection, tokenId: tokenId, amount: 1n, from: seller })
    const listing = { listingId: 0n, kind: "erc721", collection: collection, tokenId: tokenId, amount: 1n, sold: 0n, price: price,
      payToken: payToken, seller: seller, status: "active", createdAt: now(params) }
    const id = addListing(listing)
    writeDB(map("active", collection, tokenId), id)
    runProgram(collection, "safeTransferFrom", { from: seller, to: ThisAddress(), tokenId: tokenId, data: "" })
    if (ownerOfNft(collection, tokenId) !== ThisAddress()) throw new Error("nft was not escrowed")
    exit()
    emitListed(listing)
    return id
  }

  function listMulti(params) {
    noValue(params)
    const input = params.input || {}
    const collection = checkProgram(input.multiToken, "multiToken")
    const id = checkId(input.id, "id")
    const amount = checkPositive(input.amount, "amount")
    const price = checkPositive(input.pricePerUnit, "pricePerUnit")
    const payToken = checkPayToken(input.payToken)
    const seller = params.context.sender
    enter({ kind: "erc1155", collection: collection, tokenId: id, amount: amount, from: seller })
    const listing = { listingId: 0n, kind: "erc1155", collection: collection, tokenId: id, amount: amount, sold: 0n, price: price,
      payToken: payToken, seller: seller, status: "active", createdAt: now(params) }
    const listingId = addListing(listing)
    const before = multiBalance(collection, ThisAddress(), id)
    runProgram(collection, "safeTransferFrom", { from: seller, to: ThisAddress(), id: id, amount: amount, data: "" })
    if (multiBalance(collection, ThisAddress(), id) - before !== amount) throw new Error("items were not escrowed")
    exit()
    emitListed(listing)
    return listingId
  }

  // ---------- hook รับของ: รับเฉพาะของที่ตลาดดึงเองตาม lock ----------
  function expected(params, kind, tokenId, amount) {
    const expect = readDB("lock")
    if (expect === undefined || expect === null || expect.kind !== kind) throw new Error("direct transfers are not accepted; use list / listMulti")
    const input = params.input || {}
    if (params.context.sender !== expect.collection || input.operator !== ThisAddress() || input.from !== expect.from
      || tokenId !== expect.tokenId || amount !== expect.amount) throw new Error("unexpected transfer")
  }
  function onERC721Received(params) {
    expected(params, "erc721", (params.input || {}).tokenId, 1n)
    return "${ERC721_RECEIVED}"
  }
  function onERC1155Received(params) {
    expected(params, "erc1155", (params.input || {}).id, (params.input || {}).amount)
    return "${ERC1155_RECEIVED}"
  }
  function onERC1155BatchReceived() { throw new Error("batch transfers are not accepted; use listMulti") }

  // ---------- ซื้อ / แก้ราคา / ยกเลิก ----------
  function buy(params) {
    const input = params.input || {}
    enter(null)
    const listing = activeListing(input.listingId)
    const buyer = params.context.sender
    if (buyer === listing.seller) throw new Error("seller cannot buy own listing")
    const amount = input.amount === undefined || input.amount === null ? 1n : checkPositive(input.amount, "amount")
    if (amount > listing.amount) throw new Error("amount exceeds the listed amount")
    if (input.price !== undefined && input.price !== null && input.price !== listing.price) throw new Error("price changed")
    const total = listing.price * amount
    const value = params.value || 0n
    if (listing.payToken === "") {
      if (value !== total) throw new Error("value must equal the exact price (" + total + ")")
    } else if (value !== 0n) throw new Error("this listing is paid in tokens; do not attach native value")
    listing.amount = listing.amount - amount
    listing.sold = listing.sold + amount
    if (listing.amount === 0n) {
      listing.status = "sold"
      if (listing.kind === "erc721") deleteDB(map("active", listing.collection, listing.tokenId))
    }
    writeDB(map("listing", listing.listingId), listing)
    const fee = settle(listing.payToken, buyer, listing.seller, total)
    deliver(listing, buyer, amount, true)
    exit()
    emit("Sold", { listingId: listing.listingId, buyer: buyer, seller: listing.seller, amount: amount, price: total, fee: fee,
      payToken: listing.payToken }, { indexed: ["listingId", "buyer", "seller"] })
    return { listingId: listing.listingId, amount: amount, price: total, fee: fee }
  }

  function updatePrice(params) {
    noValue(params)
    const input = params.input || {}
    const listing = activeListing(input.listingId)
    if (params.context.sender !== listing.seller) throw new Error("only the seller")
    const price = checkPositive(input.price, "price")
    const oldPrice = listing.price
    listing.price = price
    writeDB(map("listing", listing.listingId), listing)
    emit("PriceUpdated", { listingId: listing.listingId, oldPrice: oldPrice, price: price }, { indexed: ["listingId"] })
    return true
  }

  function cancel(params) {
    noValue(params)
    enter(null)
    const listing = activeListing((params.input || {}).listingId)
    if (params.context.sender !== listing.seller) throw new Error("only the seller")
    const amount = listing.amount
    listing.status = "cancelled"
    listing.amount = 0n
    writeDB(map("listing", listing.listingId), listing)
    if (listing.kind === "erc721") deleteDB(map("active", listing.collection, listing.tokenId))
    deliver(listing, listing.seller, amount, false)
    exit()
    emit("Cancelled", { listingId: listing.listingId, seller: listing.seller, amount: amount }, { indexed: ["listingId", "seller"] })
    return true
  }

  // ---------- ข้อเสนอซื้อ (ERC-721) ----------
  /** เจ้าของ NFT ตอนนี้: วางขายในตลาดนี้ → ผู้ขาย · ไม่ได้วางขาย → ownerOf */
  function currentOwner(collection, tokenId) {
    const listingId = readDB(map("active", collection, tokenId))
    if (listingId !== undefined) return { owner: loadListing(listingId).seller, listingId: listingId }
    return { owner: ownerOfNft(collection, tokenId), listingId: null }
  }

  function makeOffer(params) {
    const input = params.input || {}
    const collection = checkProgram(input.nft, "nft")
    const tokenId = checkId(input.tokenId, "tokenId")
    const payToken = checkPayToken(input.payToken)
    const amount = checkPositive(input.amount, "amount")
    const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? 0n : checkId(input.expiresAt, "expiresAt")
    if (expiresAt !== 0n && expiresAt <= now(params)) throw new Error("expiresAt must be in the future")
    const buyer = params.context.sender
    const value = params.value || 0n
    if (payToken === "") {
      if (value !== amount) throw new Error("value must equal the offer amount (" + amount + ")")
    } else if (value !== 0n) throw new Error("token offers do not accept native value")
    enter(null)
    if (currentOwner(collection, tokenId).owner === buyer) throw new Error("cannot make an offer on your own nft")
    const offerId = readDB("offerCount")
    writeDB("offerCount", offerId + 1n)
    const offer = { offerId: offerId, collection: collection, tokenId: tokenId, payToken: payToken, amount: amount, buyer: buyer,
      expiresAt: expiresAt, status: "active", createdAt: now(params) }
    writeDB(map("offer", offerId), offer)
    const count = readDB(map("offerCountFor", collection, tokenId)) || 0n
    writeDB(map("offersFor", collection, tokenId, count), offerId)
    writeDB(map("offerCountFor", collection, tokenId), count + 1n)
    if (payToken !== "") moveToken(payToken, buyer, ThisAddress(), amount)
    exit()
    emit("OfferMade", { offerId: offerId, buyer: buyer, collection: collection, tokenId: tokenId, payToken: payToken, amount: amount,
      expiresAt: expiresAt }, { indexed: ["offerId", "buyer", "collection"] })
    return offerId
  }

  function cancelOffer(params) {
    noValue(params)
    enter(null)
    const offer = loadOffer((params.input || {}).offerId)
    if (offer.status !== "active") throw new Error("offer is not active")
    if (params.context.sender !== offer.buyer) throw new Error("only the offer maker")
    offer.status = "cancelled"
    writeDB(map("offer", offer.offerId), offer)
    if (offer.payToken === "") moveNative(offer.buyer, offer.amount)
    else moveToken(offer.payToken, ThisAddress(), offer.buyer, offer.amount)
    exit()
    emit("OfferCancelled", { offerId: offer.offerId, buyer: offer.buyer, amount: offer.amount }, { indexed: ["offerId", "buyer"] })
    return true
  }

  function acceptOffer(params) {
    noValue(params)
    enter(null)
    const offer = loadOffer((params.input || {}).offerId)
    if (offer.status !== "active") throw new Error("offer is not active")
    if (offer.expiresAt !== 0n && now(params) > offer.expiresAt) throw new Error("offer expired")
    const seller = params.context.sender
    const current = currentOwner(offer.collection, offer.tokenId)
    if (current.owner !== seller) throw new Error("only the current nft owner")
    if (seller === offer.buyer) throw new Error("cannot accept your own offer")
    offer.status = "accepted"
    writeDB(map("offer", offer.offerId), offer)
    let from = seller
    if (current.listingId !== null) {
      const listing = loadListing(current.listingId)
      listing.status = "sold"
      listing.amount = 0n
      listing.sold = 1n
      writeDB(map("listing", listing.listingId), listing)
      deleteDB(map("active", offer.collection, offer.tokenId))
      from = ThisAddress()
    }
    const fee = settle(offer.payToken, ThisAddress(), seller, offer.amount)
    runProgram(offer.collection, "safeTransferFrom", { from: from, to: offer.buyer, tokenId: offer.tokenId, data: "" })
    if (ownerOfNft(offer.collection, offer.tokenId) !== offer.buyer) throw new Error("nft was not delivered")
    exit()
    emit("OfferAccepted", { offerId: offer.offerId, listingId: current.listingId, seller: seller, buyer: offer.buyer,
      collection: offer.collection, tokenId: offer.tokenId, amount: offer.amount, fee: fee }, { indexed: ["offerId", "seller", "buyer"] })
    return { offerId: offer.offerId, listingId: current.listingId, amount: offer.amount, fee: fee }
  }

  // ---------- อ่าน ----------
  function fee() { return { feeBps: readDB("feeBps"), feeRecipient: readDB("feeRecipient") } }
  function listingCount() { return readDB("listingCount") }
  function offerCount() { return readDB("offerCount") }
  function getListing(params) { return loadListing((params.input || {}).listingId) }
  function getOffer(params) { return loadOffer((params.input || {}).offerId) }

  /** ไล่ total รายการตั้งแต่ start ไม่เกิน limit รายการ (กรอง activeOnly หลังโหลด) */
  function page(input, total, idAt, load) {
    const start = input.start === undefined || input.start === null ? 0n : checkId(input.start, "start")
    const limit = input.limit === undefined || input.limit === null ? 20n : checkPositive(input.limit, "limit")
    if (limit > MAX_PAGE) throw new Error("limit must be at most " + MAX_PAGE + "n")
    const items = []
    let i = start
    while (i < total && i < start + limit) {
      const item = load(idAt(i))
      if (input.activeOnly !== true || item.status === "active") items.push(item)
      i = i + 1n
    }
    return { items: items, next: i < total ? i : null, total: total }
  }
  function listings(params) {
    const input = params.input || {}
    return page(input, readDB("listingCount"), (i) => i, loadListing)
  }
  function listingsOf(params) {
    const input = params.input || {}
    const seller = checkAddress(input.seller, "seller")
    return page(input, readDB(map("sellerCount", seller)) || 0n, (i) => readDB(map("seller", seller, i)), loadListing)
  }
  function listingsForCollection(params) {
    const input = params.input || {}
    const collection = checkAddress(input.nft, "nft")
    return page(input, readDB(map("collectionCount", collection)) || 0n, (i) => readDB(map("collection", collection, i)), loadListing)
  }
  function offersFor(params) {
    const input = params.input || {}
    const collection = checkAddress(input.nft, "nft")
    const tokenId = checkId(input.tokenId, "tokenId")
    return page(input, readDB(map("offerCountFor", collection, tokenId)) || 0n, (i) => readDB(map("offersFor", collection, tokenId, i)), loadOffer)
  }

  return { list, listMulti, buy, updatePrice, cancel, makeOffer, cancelOffer, acceptOffer,
    onERC721Received, onERC1155Received, onERC1155BatchReceived,
    fee, listingCount, offerCount, getListing, getOffer, listings, listingsOf, listingsForCollection, offersFor }
}`;
