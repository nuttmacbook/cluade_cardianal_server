/**
 * NFT marketplace (system program) — escrow-based sales (items are held by the market) · supports ERC-721-style NFTs (src/standards/nft.js)
 * and ERC-1155-style multi-tokens (src/standards/multitoken.js) · paid in the native coin (BWSC) or a standard token (src/standards/token.js)
 *
 * input on deploy: { feeBps?, feeRecipient?, namespace?, icon?, url?, contact?, description? }
 *   feeBps 0n … 1000n (max 10%) default 0n · feeBps > 0n requires feeRecipient
 *   the fee is set once at deploy and can never change — no admin / owner / upgrade
 *   fee = floor(total × feeBps / 10000) (rounded down: never above the stated rate) · seller gets exactly total − fee → no dust left in the market
 *
 * State-changing functions (none may attach value unless stated · reentrancy guard via key "lock")
 *   list({ nft, tokenId, price, payToken? }) → listingId
 *       the seller (= ownerOf) must approve / setApprovalForAll the market first · the market pulls the NFT in via safeTransferFrom
 *       payToken "" / omitted = native coin · otherwise = a token program's address
 *   listMulti({ multiToken, id, amount, pricePerUnit, payToken? }) → listingId   (seller must setApprovalForAll the market first)
 *   buy({ listingId, amount?, price? }) → { listingId, amount, price, fee }
 *       amount omitted = 1n (ERC-721 must be 1n) · ERC-1155 can be bought partially
 *       price (optional) = the unit price the buyer saw; mismatch → "price changed" (stops a seller front-running with a price raise — recommended when paying in tokens)
 *       native coin: attach value = unit price × amount exactly (short / over = fails, no change given)
 *       token: buyer approves the market ≥ total → transferFrom buyer → seller (total − fee) and → feeRecipient (fee)
 *       sellers can't buy their own items · items go to the buyer via safeTransferFrom (program buyers must answer onERC721Received / onERC1155Received)
 *   updatePrice({ listingId, price }) → true   seller only (ERC-1155 = unit price)
 *   cancel({ listingId }) → true               seller only · returns the remaining items to the seller
 *   makeOffer({ nft, tokenId, payToken, amount, expiresAt? }) → offerId   (ERC-721 only)
 *       payToken "" = native coin: attach value = amount exactly · token: approve the market first (the market pulls it in and checks the amount actually received)
 *       expiresAt = unix seconds (omitted / 0n = never expires) must be later than the block time · an NFT's owner can't make an offer on it
 *   cancelOffer({ offerId }) → true   offerer only (expired offers can be cancelled too — the deposit stays until the offerer cancels) · refunds the deposit
 *   acceptOffer({ offerId }) → { offerId, listingId, amount, fee }
 *       current NFT owner only: if listed in this market = that listing's seller (the listing closes as "sold") ·
 *       not listed = ownerOf must be the caller, who must approve the market first · expired offers can't be accepted
 *   onERC721Received / onERC1155Received → magic only for items the market pulls itself during list / listMulti (matching what lock expects)
 *       items sent in directly via safe transfer are rejected · onERC1155BatchReceived always rejects
 *       ⚠️ items transferred in via plain transferFrom (no hook) are stuck in the market forever; nobody can get them out
 *
 * Read-only
 *   fee() → { feeBps, feeRecipient } · listingCount() → bigint · getListing({ listingId }) → listing
 *   listings({ start?, limit?, activeOnly? }) · listingsOf({ seller, start?, limit?, activeOnly? })
 *   listingsForCollection({ nft, start?, limit?, activeOnly? }) · offersFor({ nft, tokenId, start?, limit?, activeOnly? })
 *     → { items: [...], next: next position | null, total } · limit default 20n, max 50n (scans at most limit entries per call)
 *   getOffer({ offerId }) → offer · offerCount() → bigint
 *   listing = { listingId, kind: "erc721" | "erc1155", collection, tokenId, amount (remaining), sold, price (per unit), payToken, seller, status: active | sold | cancelled, createdAt }
 *   offer   = { offerId, collection, tokenId, payToken, amount, buyer, expiresAt, status: active | accepted | cancelled, createdAt }
 *
 * event
 *   Listed { listingId, kind, seller, collection, tokenId, amount, price, payToken }
 *   PriceUpdated { listingId, oldPrice, price } · Cancelled { listingId, seller, amount }
 *   Sold { listingId, buyer, seller, amount, price (total), fee, payToken }
 *   OfferMade { offerId, buyer, collection, tokenId, payToken, amount, expiresAt } · OfferCancelled { offerId, buyer, amount }
 *   OfferAccepted { offerId, listingId (null = not listed), seller, buyer, collection, tokenId, amount, fee }
 *
 * storage: feeBps · feeRecipient · listingCount · offerCount · lock (temporary within a tx) · listing:<id> · offer:<id>
 *   active:<collection>:<tokenId> → listingId (ERC-721 currently listed) · sellerCount:<seller> · seller:<seller>:<n> → listingId
 *   collectionCount:<collection> · collection:<collection>:<n> → listingId · offerCountFor:<collection>:<tokenId> · offersFor:<collection>:<tokenId>:<n> → offerId
 *
 * Limitations
 *   no royalties (NFT creators get no share) · no admin, so fees can't be changed / stuck items can't be recovered
 *   sellers must be the owner (operators can't list on their behalf) · offers are ERC-721 only · no loops over a user's entries in state-changing functions
 *   buyers must trust the NFT / token program themselves (the market checks ownerOf / balanceOf after every transfer, but can't catch a program that lies)
 *   fee-on-transfer tokens don't work: the market checks the recipient got the full amount, otherwise the whole tx fails
 */
import { SET_METADATA, CHECK_ADDRESS } from "./common.js";
import { ZERO_ADDRESS } from "./token.js";
import { ERC721_RECEIVED, ERC1155_RECEIVED } from "./wallet.js";

export const NFT_MARKET_MAX_FEE_BPS = 1000n;
export const NFT_MARKET_MAX_PAGE = 50n;
export const NFT_MARKET_FUNCTIONS = ["list", "listMulti", "buy", "updatePrice", "cancel", "makeOffer", "cancelOffer", "acceptOffer"];
export const NFT_MARKET_EVENTS = ["Listed", "PriceUpdated", "Cancelled", "Sold", "OfferMade", "OfferCancelled", "OfferAccepted"];

export const NFT_MARKET_PROGRAM = `function program() {
  // called as a tx with native coin attached → reject (this program has no way to send native coin out, so it would be stuck forever)
  function rejectValue(params) { if (params && params.value !== undefined && params.value !== null && params.value !== 0n) throw new Error("this function does not accept native value") }
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

  // ---------- helpers ----------
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
  // round up: buying one item at a time cannot dodge the fee (feeBps ≤ 10% → fee never exceeds total)
  function feeOf(total) { return (total * readDB("feeBps") + 9999n) / 10000n }

  function tokenBalance(token, who) { return runProgram(token, "balanceOf", { who: who }, { readonly: true }) }
  /** transfer tokens and verify the recipient really got the full amount (does not trust the token's return value alone) · from = ThisAddress() → transfer */
  function moveToken(token, from, to, amount) {
    if (amount === 0n || from === to) return   // transfer to self (feeRecipient buying) = nothing changes
    const before = tokenBalance(token, to)
    if (from === ThisAddress()) runProgram(token, "transfer", { to: to, amount: amount })
    else runProgram(token, "transferFrom", { from: from, to: to, amount: amount })
    if (tokenBalance(token, to) - before !== amount) throw new Error("token transfer did not deliver the full amount")
  }
  function moveNative(to, amount) { if (amount > 0n) transferNative(to, amount) }
  /** pay the total: seller gets total − fee · feeRecipient gets fee (payer = ThisAddress() → pay from deposited funds) */
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
  /** send the NFT / item out of the market and verify it actually reached the recipient */
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

  // ---------- listing ----------
  function list(params) { rejectValue(params);
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

  function listMulti(params) { rejectValue(params);
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

  // ---------- receive hook: accept only items the market pulls itself under the lock ----------
  function expected(params, kind, tokenId, amount) {
    const expect = readDB("lock")
    if (expect === undefined || expect === null || expect.kind !== kind) throw new Error("direct transfers are not accepted; use list / listMulti")
    const input = params.input || {}
    if (params.context.sender !== expect.collection || input.operator !== ThisAddress() || input.from !== expect.from
      || tokenId !== expect.tokenId || amount !== expect.amount) throw new Error("unexpected transfer")
  }
  function onERC721Received(params) { rejectValue(params);
    expected(params, "erc721", (params.input || {}).tokenId, 1n)
    return "${ERC721_RECEIVED}"
  }
  function onERC1155Received(params) { rejectValue(params);
    expected(params, "erc1155", (params.input || {}).id, (params.input || {}).amount)
    return "${ERC1155_RECEIVED}"
  }
  function onERC1155BatchReceived(params) { rejectValue(params); throw new Error("batch transfers are not accepted; use listMulti") }

  // ---------- buy / reprice / cancel ----------
  function buy(params) {
    const input = params.input || {}
    enter(null)
    const listing = activeListing(input.listingId)
    const buyer = params.context.sender
    if (buyer === listing.seller) throw new Error("seller cannot buy own listing")
    const amount = input.amount === undefined || input.amount === null ? 1n : checkPositive(input.amount, "amount")
    if (amount > listing.amount) throw new Error("amount exceeds the listed amount")
    // paying with a token requires price (stops the seller from front-running a price hike and pulling from a large allowance) · native is already checked via value
    if (input.price !== undefined && input.price !== null && input.price !== listing.price) throw new Error("price changed")
    const total = listing.price * amount
    const value = params.value || 0n
    if (listing.payToken === "") {
      if (value !== total) throw new Error("value must equal the exact price (" + total + ")")
    } else if (value !== 0n) throw new Error("this listing is paid in tokens; do not attach native value")
    else if (input.price === undefined || input.price === null) throw new Error("price is required when paying with a token")
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

  function updatePrice(params) { rejectValue(params);
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

  function cancel(params) { rejectValue(params);
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

  // ---------- offers (ERC-721) ----------
  /** current NFT owner: listed in this market → the seller · not listed → ownerOf */
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
    if (expiresAt >= 100000000000n) throw new Error("expiresAt looks like milliseconds: use unix seconds")
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

  function cancelOffer(params) { rejectValue(params);
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

  function acceptOffer(params) { rejectValue(params);
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

  // ---------- reads ----------
  function fee(params) { rejectValue(params); return { feeBps: readDB("feeBps"), feeRecipient: readDB("feeRecipient") } }
  function listingCount(params) { rejectValue(params); return readDB("listingCount") }
  function offerCount(params) { rejectValue(params); return readDB("offerCount") }
  function getListing(params) { rejectValue(params); return loadListing((params.input || {}).listingId) }
  function getOffer(params) { rejectValue(params); return loadOffer((params.input || {}).offerId) }

  /** walk total entries from start, at most limit entries (activeOnly is filtered after loading) */
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
  function listings(params) { rejectValue(params);
    const input = params.input || {}
    return page(input, readDB("listingCount"), (i) => i, loadListing)
  }
  function listingsOf(params) { rejectValue(params);
    const input = params.input || {}
    const seller = checkAddress(input.seller, "seller")
    return page(input, readDB(map("sellerCount", seller)) || 0n, (i) => readDB(map("seller", seller, i)), loadListing)
  }
  function listingsForCollection(params) { rejectValue(params);
    const input = params.input || {}
    const collection = checkAddress(input.nft, "nft")
    return page(input, readDB(map("collectionCount", collection)) || 0n, (i) => readDB(map("collection", collection, i)), loadListing)
  }
  function offersFor(params) { rejectValue(params);
    const input = params.input || {}
    const collection = checkAddress(input.nft, "nft")
    const tokenId = checkId(input.tokenId, "tokenId")
    return page(input, readDB(map("offerCountFor", collection, tokenId)) || 0n, (i) => readDB(map("offersFor", collection, tokenId, i)), loadOffer)
  }

  return { list, listMulti, buy, updatePrice, cancel, makeOffer, cancelOffer, acceptOffer,
    onERC721Received, onERC1155Received, onERC1155BatchReceived,
    fee, listingCount, offerCount, getListing, getOffer, listings, listingsOf, listingsForCollection, offersFor }
}`;
