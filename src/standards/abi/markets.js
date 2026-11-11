/** metadata.abi ของโปรแกรมแถม: staking · limit order · NFT market — ดู src/standards/system-abi.js */

const u = (name) => ({ name, type: "uint" });
const a = (name) => ({ name, type: "address" });
const b = (name) => ({ name, type: "bool" });
const s = (name) => ({ name, type: "string" });
const idx = (field) => ({ ...field, indexed: true });
const out = (type) => [{ type }];

// ---------- Staking ----------

export const STAKING_ABI = {
  functions: [
    { name: "createPool", inputs: [a("stakeToken"), a("rewardToken"), u("rewardAmount"), u("duration"), u("startAt")], outputs: out("uint"),
      description: "Create a reward pool (approve rewardToken first). duration in seconds. startAt unix seconds, must be >= block time (0 is rejected). Returns poolId." },
    { name: "stake", inputs: [u("poolId"), u("amount")], outputs: out("uint"),
      description: "Stake stakeToken (approve first). Returns the amount actually received." },
    { name: "unstake", inputs: [u("poolId"), u("amount")], outputs: out("bool"), description: "Withdraw staked principal; pending rewards stay claimable." },
    { name: "claim", inputs: [u("poolId")], outputs: out("uint"), description: "Claim pending rewards. Returns the amount paid." },
    { name: "exit", inputs: [u("poolId")], outputs: out("object"), description: "Unstake everything and claim. Returns {unstaked, claimed}." },
    { name: "emergencyWithdraw", inputs: [u("poolId")], outputs: out("uint"),
      description: "Withdraw all principal and forfeit pending rewards. Returns the principal." },
    { name: "addRewards", inputs: [u("poolId"), u("amount"), u("extendSeconds")], outputs: out("uint"),
      description: "Pool creator only. Add rewards; extendSeconds (0 = no extension) is required once the pool has ended. Returns the new rewardRate." },
    { name: "recoverUnallocated", inputs: [u("poolId")], outputs: out("uint"),
      description: "Pool creator only. Take back rewards nobody can earn. Returns the amount." },
    { name: "getPool", inputs: [u("poolId")], outputs: out("object"), readonly: true,
      description: "Pool state as JSON (creator, tokens, startAt, endAt, totalStaked, rewardRate x1e36, rewardPerYear, reserve, ...)." },
    { name: "poolCount", inputs: [], outputs: out("uint"), readonly: true },
    { name: "pools", inputs: [u("start"), u("limit")], outputs: out("array"), readonly: true,
      description: "Pools from start as JSON array. limit 1..50 (0 is rejected over EVM)." },
    { name: "stakedOf", inputs: [u("poolId"), a("who")], outputs: out("uint"), readonly: true },
    { name: "pendingRewards", inputs: [u("poolId"), a("who")], outputs: out("uint"), readonly: true },
    { name: "poolsOf", inputs: [a("who"), u("start"), u("limit")], outputs: out("array"), readonly: true,
      description: "Pool ids who has staked in, as JSON array. limit 1..100 (0 is rejected over EVM)." },
    { name: "poolsOfCount", inputs: [a("who")], outputs: out("uint"), readonly: true },
  ],
  events: [
    { name: "PoolCreated", fields: [idx(u("poolId")), idx(a("creator")), idx(a("stakeToken")), a("rewardToken"), u("rewardAmount"),
      u("startAt"), u("endAt"), u("rewardRate")] },
    { name: "Staked", fields: [idx(u("poolId")), idx(a("who")), u("amount")] },
    { name: "Unstaked", fields: [idx(u("poolId")), idx(a("who")), u("amount")] },
    { name: "Claimed", fields: [idx(u("poolId")), idx(a("who")), u("amount")] },
    { name: "RewardsAdded", fields: [idx(u("poolId")), u("amount"), u("endAt"), u("rewardRate")] },
    { name: "EmergencyWithdraw", fields: [idx(u("poolId")), idx(a("who")), u("amount"), u("forfeited")] },
    { name: "RewardsRecovered", fields: [idx(u("poolId")), idx(a("to")), u("amount")] },
  ],
};

// ---------- Limit order ----------

export const LIMIT_ORDER_ABI = {
  functions: [
    { name: "placeOrder", inputs: [a("sellToken"), u("sellAmount"), a("buyToken"), u("buyAmount"), u("expiresAt"), b("allowPartial")], outputs: out("uint"),
      description: "Escrow sellToken (approve first) for buyAmount of buyToken. expiresAt unix seconds, 0 = never. Returns orderId." },
    { name: "fillOrder", inputs: [u("orderId"), u("sellAmountToTake"), u("maxBuyAmount")], outputs: out("object"),
      description: "Take from an order (approve buyToken first). maxBuyAmount caps the price; 0 means 0, pass max uint for no cap. Returns {orderId, sold, paid, remaining}." },
    { name: "fillOrders", inputs: [{ name: "fills", type: "array" }, u("maxTotalBuy")], outputs: out("object"),
      description: "Fill 1-20 orders with the same buyToken. fills = JSON [{orderId, sellAmountToTake}]. maxTotalBuy: pass max uint for no cap. Returns {count, sold, paid, totalPaid}." },
    { name: "cancelOrder", inputs: [u("orderId")], outputs: out("uint"), description: "Maker only. Refund the remaining escrow. Returns the refund." },
    { name: "cancelExpired", inputs: [u("orderId")], outputs: out("uint"), description: "Anyone. Refund an expired order to its maker. Returns the refund." },
    { name: "getOrder", inputs: [u("orderId")], outputs: out("object"), readonly: true,
      description: "Order as JSON; status = open | expired | filled | cancelled." },
    { name: "orderCount", inputs: [], outputs: out("uint"), readonly: true },
    { name: "ordersOf", inputs: [a("maker"), u("start"), u("limit")], outputs: out("object"), readonly: true,
      description: "{total, orders} of a maker. limit 1..50 (0 is rejected over EVM)." },
    { name: "ordersForPair", inputs: [a("sellToken"), a("buyToken"), u("start"), u("limit"), b("openOnly")], outputs: out("object"), readonly: true,
      description: "{total, orders} for a pair; openOnly = only open orders. limit 1..50." },
    { name: "bestOrders", inputs: [a("sellToken"), a("buyToken"), u("limit"), u("start")], outputs: out("object"), readonly: true,
      description: "Best-priced open orders: {totalOpen, scanned, truncated, orders}. Scans up to 100 from start. limit 1..50." },
    { name: "quoteFill", inputs: [u("orderId"), u("sellAmountToTake")], outputs: out("object"), readonly: true,
      description: "Preview a fill: {ok, reason, sold, paid, remainingAfter}." },
  ],
  events: [
    { name: "OrderPlaced", fields: [idx(u("orderId")), idx(a("maker")), idx(a("sellToken")), a("buyToken"), u("sellAmount"), u("buyAmount"),
      u("expiresAt"), b("allowPartial")] },
    { name: "OrderFilled", fields: [idx(u("orderId")), idx(a("taker")), idx(a("maker")), u("sold"), u("paid"), u("remaining")] },
    { name: "OrderCancelled", fields: [idx(u("orderId")), idx(a("maker")), a("by"), u("refunded"), s("reason")],
      description: "reason = cancelled | expired" },
  ],
};

// ---------- NFT market ----------

const PAY_TOKEN = { name: "payToken", type: "string" };
const PAGE = [u("start"), u("limit"), b("activeOnly")];

export const NFT_MARKET_ABI = {
  functions: [
    { name: "list", inputs: [a("nft"), u("tokenId"), u("price"), PAY_TOKEN], outputs: out("uint"),
      description: "List an ERC-721 (approve the market first). payToken = token address, or empty string for the native coin. Returns listingId." },
    { name: "listMulti", inputs: [a("multiToken"), u("id"), u("amount"), u("pricePerUnit"), PAY_TOKEN], outputs: out("uint"),
      description: "List ERC-1155 items (setApprovalForAll first). payToken empty = native coin. Returns listingId." },
    { name: "buy", inputs: [u("listingId"), u("amount"), u("price")], outputs: out("object"), payable: true,
      description: "Buy amount (1 for ERC-721) at unit price (must equal the listing price). Native: send value = price x amount. Returns {listingId, amount, price, fee}." },
    { name: "updatePrice", inputs: [u("listingId"), u("price")], outputs: out("bool"), description: "Seller only. New (unit) price." },
    { name: "cancel", inputs: [u("listingId")], outputs: out("bool"), description: "Seller only. Return the remaining items to the seller." },
    { name: "makeOffer", inputs: [a("nft"), u("tokenId"), PAY_TOKEN, u("amount"), u("expiresAt")], outputs: out("uint"), payable: true,
      description: "Offer on an ERC-721. payToken empty = native (send value = amount), else approve first. expiresAt unix seconds, 0 = never. Returns offerId." },
    { name: "cancelOffer", inputs: [u("offerId")], outputs: out("bool"), description: "Offer maker only. Refund the deposit." },
    { name: "acceptOffer", inputs: [u("offerId")], outputs: out("object"),
      description: "Current NFT owner only. Returns {offerId, listingId (null if not listed), amount, fee}." },
    { name: "onERC721Received", inputs: [a("operator"), a("from"), u("tokenId")], outputs: out("string"), readonly: true,
      description: "Receiver hook; accepts only transfers the market pulls during list." },
    { name: "onERC1155Received", inputs: [a("operator"), a("from"), u("id"), u("amount")], outputs: out("string"), readonly: true,
      description: "Receiver hook; accepts only transfers the market pulls during listMulti." },
    { name: "onERC1155BatchReceived", inputs: [], readonly: true, description: "Always rejects." },
    { name: "fee", inputs: [], outputs: out("object"), readonly: true, description: "{feeBps, feeRecipient}" },
    { name: "listingCount", inputs: [], outputs: out("uint"), readonly: true },
    { name: "offerCount", inputs: [], outputs: out("uint"), readonly: true },
    { name: "getListing", inputs: [u("listingId")], outputs: out("object"), readonly: true,
      description: "Listing as JSON; kind = erc721 | erc1155, status = active | sold | cancelled, payToken empty = native." },
    { name: "getOffer", inputs: [u("offerId")], outputs: out("object"), readonly: true,
      description: "Offer as JSON; status = active | accepted | cancelled." },
    { name: "listings", inputs: PAGE, outputs: out("object"), readonly: true, description: "{items, next, total}. limit 1..50 (0 is rejected over EVM)." },
    { name: "listingsOf", inputs: [a("seller"), ...PAGE], outputs: out("object"), readonly: true, description: "{items, next, total}. limit 1..50." },
    { name: "listingsForCollection", inputs: [a("nft"), ...PAGE], outputs: out("object"), readonly: true, description: "{items, next, total}. limit 1..50." },
    { name: "offersFor", inputs: [a("nft"), u("tokenId"), ...PAGE], outputs: out("object"), readonly: true, description: "{items, next, total}. limit 1..50." },
  ],
  events: [
    { name: "Listed", fields: [idx(u("listingId")), s("kind"), idx(a("seller")), idx(a("collection")), u("tokenId"), u("amount"), u("price"), PAY_TOKEN],
      description: "payToken empty = native coin (a token-paid listing logs an address, so its signature differs)" },
    { name: "PriceUpdated", fields: [idx(u("listingId")), u("oldPrice"), u("price")] },
    { name: "Cancelled", fields: [idx(u("listingId")), idx(a("seller")), u("amount")] },
    { name: "Sold", fields: [idx(u("listingId")), idx(a("buyer")), idx(a("seller")), u("amount"), u("price"), u("fee"), PAY_TOKEN],
      description: "price = total paid. payToken empty = native coin (token-paid sales log an address)" },
    { name: "OfferMade", fields: [idx(u("offerId")), idx(a("buyer")), idx(a("collection")), u("tokenId"), PAY_TOKEN, u("amount"), u("expiresAt")],
      description: "payToken empty = native coin (token offers log an address)" },
    { name: "OfferCancelled", fields: [idx(u("offerId")), idx(a("buyer")), u("amount")] },
    { name: "OfferAccepted", fields: [idx(u("offerId")), u("listingId"), idx(a("seller")), idx(a("buyer")), a("collection"), u("tokenId"), u("amount"), u("fee")],
      description: "listingId is null when the NFT was not listed (that log is JSON-encoded, not ABI)" },
  ],
};
