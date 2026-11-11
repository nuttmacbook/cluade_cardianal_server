/** metadata.abi ของโปรแกรมแถม: DEX pair (LP token) · DEX router/factory · token lock — ดู src/standards/system-abi.js */

const io = (spec) => spec.split(",").filter(Boolean).map((item) => {
  const [name, type] = item.trim().split(":");
  return name ? { name, type } : { type };
});
const fn = (name, inputs, outputs, extra = {}) => ({ name, inputs: io(inputs), outputs: io(outputs), ...extra });
const view = (name, inputs, outputs, description) => fn(name, inputs, outputs, { readonly: true, ...(description ? { description } : {}) });
const event = (name, fields, indexed = [], description) => ({
  name,
  fields: io(fields).map((field) => (indexed.includes(field.name) ? { ...field, indexed: true } : field)),
  ...(description ? { description } : {}),
});

// TOKEN_CORE (src/standards/token.js) — LP token ของ pair
const TOKEN_CORE_FUNCTIONS = [
  view("name", "", ":string"),
  view("ticker", "", ":string"),
  view("decimals", "", ":uint"),
  view("totalSupply", "", ":uint"),
  view("balanceOf", "who:address", ":uint"),
  view("allowance", "owner:address,spender:address", ":uint"),
  fn("transfer", "to:address,amount:uint", ":bool"),
  fn("multiTransfer", "transfers:array", ":uint", { description: "transfers = JSON [{\"to\":\"0x…\",\"amount\":\"1n\"}, …]; returns the count" }),
  fn("approve", "spender:address,amount:uint", ":bool"),
  fn("transferFrom", "from:address,to:address,amount:uint", ":bool"),
  fn("permit", "owner:address,spender:address,value:uint,deadline:uint,signature:bytes", ":bool",
    { description: "ERC-2612 permit with a 65-byte signature (not v/r/s); deadline in unix seconds" }),
  view("nonces", "owner:address", ":uint"),
  view("permitDomain", "", "name:string,version:string,chainId:uint,verifyingContract:address", "EIP-712 domain used by permit"),
  view("DOMAIN_SEPARATOR", "", ":bytes", "EIP-712 domain separator (32 bytes)"),
];
const TOKEN_CORE_EVENTS = [
  event("Transfer", "from:address,to:address,amount:uint", ["from", "to"]),
  event("Approval", "owner:address,spender:address,amount:uint", ["owner", "spender"]),
];

export const DEX_PAIR_ABI = {
  functions: [
    ...TOKEN_CORE_FUNCTIONS,
    fn("mint", "to:address", "liquidity:uint", { description: "Send token0 and token1 to the pair first; mints LP to 'to'" }),
    fn("burn", "to:address", "amount0:uint,amount1:uint", { description: "Send LP to the pair first; burns it and sends both tokens to 'to'" }),
    fn("swap", "amount0Out:uint,amount1Out:uint,to:address", ":bool", { description: "Send the input token to the pair first; 0.3% fee, no flash-swap callback" }),
    fn("skim", "to:address", "amount0:uint,amount1:uint", { description: "Send balances above the reserves to 'to'" }),
    fn("sync", "", ":bool", { description: "Set reserves to current balances" }),
    view("getReserves", "", "reserve0:uint,reserve1:uint,blockTimestampLast:uint", "blockTimestampLast in unix seconds"),
    view("token0", "", ":address"),
    view("token1", "", ":address"),
    view("factory", "", ":address"),
    view("price0CumulativeLast", "", ":uint", "UQ112.112 price x seconds, no wrap"),
    view("price1CumulativeLast", "", ":uint", "UQ112.112 price x seconds, no wrap"),
  ],
  events: [
    ...TOKEN_CORE_EVENTS,
    event("Sync", "reserve0:uint,reserve1:uint"),
    event("Mint", "sender:address,amount0:uint,amount1:uint", ["sender"]),
    event("Burn", "sender:address,amount0:uint,amount1:uint,to:address", ["sender", "to"]),
    event("Swap", "sender:address,amount0In:uint,amount1In:uint,amount0Out:uint,amount1Out:uint,to:address", ["sender", "to"]),
  ],
};

const PATH_NOTE = "path = JSON array of 2-4 token addresses; returns amounts as a JSON array of \"123n\" strings";
const swapFn = (name, inputs, payable, description) => fn(name, inputs, "amounts:array", { ...(payable ? { payable: true } : {}), description });

export const DEX_ABI = {
  functions: [
    fn("createPair", "tokenA:address,tokenB:address", "pair:address"),
    view("getPair", "tokenA:address,tokenB:address", "pair:address", "Zero address if the pair does not exist"),
    view("pairCount", "", ":uint"),
    view("allPairs", "start:uint,limit:uint", "pairs:array", "JSON array of pair addresses; limit must be 1-100"),
    view("pairTemplate", "", ":address"),
    view("wrapped", "", ":address", "Wrapped native token (WBWSC)"),
    fn("addLiquidity", "tokenA:address,tokenB:address,amountADesired:uint,amountBDesired:uint,amountAMin:uint,amountBMin:uint,to:address,deadline:uint",
      "amountA:uint,amountB:uint,liquidity:uint", { description: "Approve both tokens to the router first; creates the pair if missing; deadline in unix seconds" }),
    fn("addLiquidityNative", "token:address,amountTokenDesired:uint,amountTokenMin:uint,amountNativeMin:uint,to:address,deadline:uint",
      "amountToken:uint,amountNative:uint,liquidity:uint", { payable: true, description: "Native amount = value sent; unused native is refunded" }),
    fn("removeLiquidity", "tokenA:address,tokenB:address,liquidity:uint,amountAMin:uint,amountBMin:uint,to:address,deadline:uint",
      "amountA:uint,amountB:uint", { description: "Approve the LP token to the router first" }),
    fn("removeLiquidityNative", "token:address,liquidity:uint,amountTokenMin:uint,amountNativeMin:uint,to:address,deadline:uint",
      "amountToken:uint,amountNative:uint", { description: "Approve the LP token to the router first; native is unwrapped and sent to 'to'" }),
    swapFn("swapExactTokensForTokens", "amountIn:uint,amountOutMin:uint,path:array,to:address,deadline:uint", false, PATH_NOTE),
    swapFn("swapTokensForExactTokens", "amountOut:uint,amountInMax:uint,path:array,to:address,deadline:uint", false, PATH_NOTE),
    swapFn("swapExactNativeForTokens", "amountOutMin:uint,path:array,to:address,deadline:uint", true, "amountIn = value sent; path starts with wrapped()"),
    swapFn("swapNativeForExactTokens", "amountOut:uint,path:array,to:address,deadline:uint", true, "path starts with wrapped(); unused value is refunded"),
    swapFn("swapExactTokensForNative", "amountIn:uint,amountOutMin:uint,path:array,to:address,deadline:uint", false, "path ends with wrapped()"),
    swapFn("swapTokensForExactNative", "amountOut:uint,amountInMax:uint,path:array,to:address,deadline:uint", false, "path ends with wrapped()"),
    view("getAmountsOut", "amountIn:uint,path:array", "amounts:array", PATH_NOTE),
    view("getAmountsIn", "amountOut:uint,path:array", "amounts:array", PATH_NOTE),
    view("quote", "amountA:uint,reserveA:uint,reserveB:uint", "amountB:uint"),
    view("getAmountOut", "amountIn:uint,reserveIn:uint,reserveOut:uint", "amountOut:uint", "0.3% fee"),
    view("getAmountIn", "amountOut:uint,reserveIn:uint,reserveOut:uint", "amountIn:uint", "0.3% fee"),
    view("getReserves", "tokenA:address,tokenB:address", "reserveA:uint,reserveB:uint", "Reserves ordered as tokenA, tokenB"),
  ],
  events: [
    event("PairCreated", "token0:address,token1:address,pair:address,index:uint", ["token0", "token1"]),
  ],
};

const LOCK_FIELDS = "id:uint,token:address,owner:address,creator:address,amount:uint,withdrawn:uint,withdrawable:uint,lockedAt:uint,unlockAt:uint,"
  + "vesting:bool,tgeAt:uint,tgeBps:uint,cycleSeconds:uint,cycleBps:uint,description:string";

export const TOKEN_LOCK_ABI = {
  functions: [
    fn("lock", "token:address,amount:uint,unlockAt:uint,owner:address,description:string", "id:uint",
      { description: "Approve the token first; unlockAt in unix seconds; owner must be a non-zero address (no default over EVM)" }),
    fn("vestingLock", "token:address,amount:uint,tgeAt:uint,tgeBps:uint,cycleSeconds:uint,cycleBps:uint,owner:address,description:string", "id:uint",
      { description: "Releases tgeBps at tgeAt, then cycleBps every cycleSeconds; bps 1-10000; owner must be non-zero" }),
    fn("unlock", "id:uint", "amount:uint", { description: "Lock owner withdraws everything unlocked so far" }),
    fn("extendLock", "id:uint,unlockAt:uint", ":bool"),
    fn("increaseLock", "id:uint,amount:uint", "received:uint"),
    fn("transferLockOwnership", "id:uint,newOwner:address", ":bool"),
    fn("renounceLockOwnership", "id:uint", ":bool", { description: "Owner becomes the zero address: tokens stay locked forever" }),
    view("getLock", "id:uint", LOCK_FIELDS, "Vesting: unlockAt = time fully vested"),
    view("lockCount", "", ":uint"),
    view("locksOf", "owner:address,start:uint,limit:uint", "locks:array", "JSON array of lock objects; limit is capped at 50 (0 = empty)"),
    view("locksForToken", "token:address,start:uint,limit:uint", "locks:array", "JSON array of lock objects; limit is capped at 50 (0 = empty)"),
    view("totalLocked", "token:address", ":uint"),
    view("withdrawableOf", "id:uint", ":uint"),
  ],
  events: [
    event("Locked", "id:uint,token:address,owner:address,creator:address,amount:uint,unlockAt:uint,vesting:bool", ["id", "token", "owner"]),
    event("Unlocked", "id:uint,token:address,owner:address,amount:uint", ["id", "token", "owner"]),
    event("LockExtended", "id:uint,previousUnlockAt:uint,unlockAt:uint", ["id"]),
    event("LockIncreased", "id:uint,amount:uint,total:uint", ["id"]),
    event("LockOwnerChanged", "id:uint,previousOwner:address,newOwner:address", ["id", "previousOwner", "newOwner"]),
  ],
};
