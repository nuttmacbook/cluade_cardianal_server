# Writing programs for the Program VM

```bash
npm install          # fetches programvm from GitHub
npm test             # test programs locally (runs on the real VM)
PRIVATE_KEY=0x… npm run deploy
```

## Program structure

1 program = 1 JavaScript file containing a single wrapping function

```js
export default function program() {
  function initialization(params) {      // runs once at install · cannot be called from outside
    writeDB("owner", params.context.sender);
  }

  function helper() {}                   // not in the return = internal only

  function greet(params) {
    return "Hello " + params.input.name;
  }

  return { greet };                      // the list of functions others may call
}
```

Rules
- **The whole file is in a single scope** · nothing may live outside the wrapping function
- **No imports** · the program must be self-contained
- The leading `export default` is only for local testing · deploying to the chain uses `String(program)`, which doesn't include it

## `params` every function receives

| Field | Meaning |
|---|---|
| `params.input` | Data sent by the caller |
| `params.context.sender` | Caller of this frame (can be a program if called from one) |
| `params.context.origin` | Always the tx originator |
| `params.value` | Native attached to this call |
| `params.block.timestamp` | Block time |

## APIs available in programs

```js
readDB(key)                  // read the program's own data
writeDB(key, value)          // write (value must be JSON)
deleteDB(key)
map("balances", address)     // build a multi-part key → "balances:0x…"
runProgram(address, "method", input, { value })   // call another program
runProgram(address, "method", input, { readonly: true })   // read-only call (STATICCALL) — see below
cloneProgram(template, initInput, { salt, value })   // create a new program from an approved template → new address (CREATE2-style)
transferNative(to, amount)   // transfer from the program's own wallet
setMetadata(field, value)    // set the program's namespace / description / abi
emit("Transfer", { from, to, amount })   // record an event for the explorer (rolled back if that branch fails)
emit("Transfer", { from, to, amount }, { indexed: ["from", "to"] })   // fields searchable by value (max 3) — see below
ThisAddress()                // the program's own address
keccak256(value)             // hash of a string or object (object keys are sorted for you)
ecrecover(message, signature) // → signer address, or null if the signature is invalid
ThisBalance()                // the program's own remaining native balance
BalanceOf(address)           // native balance of another address
IsProgram(address)           // whether that address is a program or a wallet
MetadataOf(address, field)   // read metadata such as namespace / creator
BlockNumber()                // the block number this tx is in
Date.now()                   // block time (same for every tx in a block)
Math.random()                // deterministic randomness (replays give the same value)

// ---- chain / block / tx data (same as EVM opcodes) ----
BlockHash(n)                 // hash of block n (BigInt), up to 256 blocks back · current / future / older block → null   (BLOCKHASH)
ChainId()                    // the system chainId (BigInt)                                     (CHAINID)
Coinbase()                   // block producer (feeRecipient), or null if none                  (COINBASE)
BlockGasLimit()              // max gas per block (BigInt), or null if unlimited                (GASLIMIT)
GasPrice()                   // actual price per 1 gas of this tx = min(maxFee, baseFee + tip) (BigInt wei)   (GASPRICE)
BaseFee()                    // base fee of this block (BigInt wei · EIP-1559)   (BASEFEE)
GasLeft()                    // gas left in the tx (BigInt) after this call's own cost         (GAS)
CodeHashOf(address)          // keccak256 of the code that address uses · not a program → null (EXTCODEHASH)
CodeSizeOf(address)          // code length in bytes (BigInt) · not a program → 0n              (EXTCODESIZE)

// ---- precompiles (same input as keccak256: string or object → hex "0x…") ----
sha256(value)                // SHA-256 (32 bytes)
ripemd160(value)             // RIPEMD-160 (20 bytes)
blake2b(value)               // BLAKE2b-512 (64 bytes)
modexp(base, exponent, modulus)   // (base ** exponent) % modulus in BigInt · modulus = 0n → 0n · each value at most 1024 bytes

// ---- raw bytes + EIP-712 (MetaMask eth_signTypedData_v4 signatures) ----
keccak256Bytes("0x…")        // keccak256 of raw bytes (hex) → "0x…" 32 bytes (keccak256(value) above always hashes UTF-8 text)
ecrecoverDigest(digest, signature)   // EVM-style ecrecover straight from a 32-byte digest → address or null
eip712Digest(domain, types, primaryType, message)   // the digest that eth_signTypedData_v4 / ethers signTypedData signs
eip712DomainSeparator(domain, types?)               // EIP-712 domainSeparator
```

### EIP-712 in programs (signatures from MetaMask)

`eip712Digest` computes byte for byte the same as ethers `TypedDataEncoder.hash` — supports `address` `bool` `uint8…uint256` `int8…int256` `bytes1…bytes32` `bytes` `string`, nested structs, and arrays (`T[]` / `T[3]`, nestable)
`types` may include `EIP712Domain` or not (omitted = use the domain fields that have values) · numbers must be BigInt · `bytes` / `bytesN` are `"0x…"` · bad data → error code `INVALID_REQUEST` (catchable)

```js
function claim(params) {
  const digest = eip712Digest(
    { name: "Airdrop", version: "1", chainId: ChainId(), verifyingContract: ThisAddress() },
    { Claim: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }] },
    "Claim",
    { to: params.input.to, amount: params.input.amount, nonce: readDB(map("nonce", params.input.to)) || 0n })
  if (ecrecoverDigest(digest, params.input.signature) !== readDB("signer")) throw new Error("bad signature")
  …
}
```
Signer side: MetaMask `eth_signTypedData_v4` (payload `{ types: { EIP712Domain, Claim }, domain, primaryType, message }`) or ethers `wallet.signTypedData(domain, { Claim }, message)`
or the helpers in `programvm/program-signature.js`: `typedDataDigest(domain, types, primaryType, message)` + `signTypedDataDigest(digest, key)`

### Read-only calls (`readonly`)

`runProgram(target, fn, input, { readonly: true })` works like the EVM's `STATICCALL`: the target **and every level it calls further**
can read as usual, but `writeDB` / `deleteDB` / `transferNative` / `setMetadata` / `emit` / `cloneProgram` throw
`"writeDB() ใช้ไม่ได้ในการเรียกแบบอ่านอย่างเดียว …"` ("writeDB() is not allowed in a read-only call …", code `FORBIDDEN`), which can be caught like any error
`value` cannot be attached · shown as `STATICCALL` in traces / `debug_traceTransaction`

```js
// read a price from an oracle, certain the oracle can't secretly modify state or call back (reentrancy)
const price = runProgram(oracle, "price", {}, { readonly: true });
```

### Gas costs of these APIs

The numbers on this page = defaults (`DEFAULT_GAS`) · Bluewolfchain enables the `bluewolf` fork from block 0 → call 1750 · read 150 · write 125 · stateKey 1125 · byte 10 · event 1250 · topic 940 · code 33 · node 3 · builtin 3 + 15,000 per tx (other values unchanged) · for the values the chain actually uses, see `GET /genesis` → `gas`

| API | Gas |
|---|---|
| `ChainId` / `Coinbase` / `BlockGasLimit` / `GasPrice` / `BaseFee` / `GasLeft` | 10 (`env`) |
| `emit` | 200 (`event`) + 1 per byte of data + 375 (`topic`) per indexed field |
| `BlockHash` / `CodeSizeOf` | 100 (`read`) |
| `CodeHashOf` | 100 (`read`) + 100 (`hash`) + 1 per byte of code (not a program = 100) |
| `sha256` / `blake2b` | 100 + 1 per byte of data |
| `ripemd160` | 300 + 1 per byte of data |
| `modexp` | 200 + ⌊words² × exponent bits ÷ 3⌋ (word = 8 bytes of the longer of base / modulus) |
| `runProgram` with `readonly` | Same as a normal call |
| `keccak256` / `keccak256Bytes` | 100 (`hash`) + 1 per byte of data (text = UTF-8 bytes · hex = actual bytes) |
| `ecrecover` | 3000 (`recover`) + 1 per byte of the message |
| `ecrecoverDigest` | 3000 (`recover`) |
| `eip712Digest` / `eip712DomainSeparator` | 100 (`hash`) per internal keccak + 1 per hashed byte (each struct's typeHash · string / bytes · array · struct · digest) — a permit digest ≈ 1,300 |
| `runProgram` / `cloneProgram` | 100 (`call`) + 1 per 32 bytes (rounded up) of input (JSON) and another 1 per 32 bytes of the return value |

### Gas by size of data copied / created

Besides 1 gas per node of code executed, every operation that copies or creates a whole block of data in one instruction costs **1 gas per unit** (`builtin`)

- **1 unit = 1 element** (array / typed array element · object property · Set / Map member · argument)
- **or 32 characters / 32 bytes** (string / ArrayBuffer · rounded up: 1–32 characters = 1 unit)
- number / BigInt / boolean / null / undefined / function = 1 unit

| Operation | Cost |
|---|---|
| `[...a]` · `f(...a)` · `new F(...a)` · `const [x, ...rest] = a` · `f.apply(t, a)` · `new Set(a)` / `new Map(a)` | 1 per copied element |
| `{ ...o }` · `const { x, ...rest } = o` | 1 per property |
| `a + b` / `a += b` producing a string | 1 per 32 characters of the result (adding numbers / BigInts is free) |
| template `` `…${x}…` `` | Same as `"".concat(…)`: inputs + result |
| Built-in methods (`join` `split` `slice` `concat` `map` `filter` `sort` `JSON.stringify` `JSON.parse` `Object.keys` `Object.assign` `repeat` `padStart` `replaceAll` …) | Size of `this` + every argument (before) + result size (after) |
| `repeat` / `padStart` / `padEnd` / `Array.from({ length: n })` | Result size charged **before** creation → `"x".repeat(1e9)` runs out of gas immediately without allocating memory |
| Implicit array-to-string conversion (`a + ""` · `` `${a}` `` · `String(a)`) | Same as `a.join()` (+ the concatenated part) |
| `new ArrayBuffer(n)` | 1 per 32 bytes (charged before allocation) |
| `new Uint8Array(n)` and other typed arrays | 1 per element (charged before allocation) |
| `Array(n)` / `new Array(n)` | Free (no element storage allocated yet) — `fill` / `map` / spread … are charged by `length` when used |

Every call path costs the same: `a.join()` · `Array.prototype.join.call(a)` · `Reflect.apply(…)` · storing the method in a variable first
Example: `[...a, ...a]` for a 1,000-element a = 2,000 gas · so a loop `a = [...a, ...a]` runs out of gas before hitting the memory cap (previously 32 MB could be allocated for ~230 gas)
32 MB of memory ≈ 1,000,000 gas (string / ArrayBuffer) · exceeding memory still pays for the work actually done

Limitations that come with this gas metering:
- `...rest` in patterns is only allowed as `const { a, ...rest } = value` / `const [a, ...rest] = value` (and `({ a, ...rest } = value)` / `([a, ...rest] = value)`)
  in parameters (`function f({ a, ...rest })`) · `for (const [a, ...rest] of …)` · catch · nested in another pattern → deploy fails (no expression to charge gas on) · `function f(...args)` works as usual
- Built-in iterators of array / string / Set / Map can't be modified (`Array.prototype[Symbol.iterator] = …` → TypeError)
- The names `__gas` `__str` `__props` `__spread` `__call` `__add` `__sub` `__mul` `__div` `__mod` `__pow` `__shl` `__shr` `__lt` `__gt` `__le` `__ge` `__eq` `__ne` `__in` `__key` `__big` `__opm` `__k` `__r` are reserved

### No regex · BigInt gas scales with size

CPU time must be chargeable as gas deterministically on every machine, so there are 2 extra rules

**All regex is disabled** — backtracking regex can take exponential time (`/(a+)+$/` on `"a".repeat(30) + "b"`) and steps inside the engine can't be counted
- regex literals (`/…/`) → deploy fails
- `RegExp(…)` / `new RegExp(…)` · `str.match(…)` / `str.matchAll(…)` / `str.search(…)` · `RegExp.prototype` methods → TypeError
- Alternatives: `split(",")` · `replace("a", "b")` / `replaceAll("a", "b")` (string pattern) · `indexOf` · `includes` · `startsWith` · `endsWith`

**BigInt is charged by size** — values ≤ 512 bits (including every uint256) **cost nothing extra**, same gas as before · larger values are charged by actual work
(W = number of 64-bit words in the number · 1 unit = 1 gas · minimum 16 units per operation)

| Operation | Cost |
|---|---|
| `a + b` · `a - b` | 16 (≤ 1024 bits) · 64 (larger) |
| `a * b` | ⌈Wa × Wb ÷ 4⌉ |
| `a / b` · `a % b` | ⌈max(1, Wa − Wb + 1) × Wb ÷ 4⌉ |
| `a ** b` | ⌈W² ÷ 4⌉ of the result — charged **before** computing: `2n ** 1000000000n` runs out of gas immediately |
| `a << b` · `a >> b` | ⌈W ÷ 2⌉ of the result (charged before computing) |
| BigInt → string (`String(x)` · `x.toString()` · `` `${x}` `` · `"" + x` · as key `o[x]` · `join` · `Error(x)` …) | W² (charged before converting) |
| string → BigInt (`BigInt("…")` · `"…" == x` · `"…" < x` · input `"123n"`) | W² where W = ⌈number of characters ÷ 19⌉ (≤ 171 characters is free) |
| Comparing BigInt with BigInt (`<` `==` …) | Nothing extra |

- **BigInt max 8192 bits** (1024 bytes, same as `modexp`) — result too large → `RangeError: BigInt ใหญ่เกิน 8192 bit (1024 ไบต์)` ("BigInt exceeds 8192 bits (1024 bytes)", catchable) · a literal that's too large → deploy fails
- Examples: `x * x` for a 4096-bit x = 1,024 gas · `x.toString()` for an 8192-bit x = 16,384 gas
- `BigInt64Array` / `BigUint64Array` are not available

### Indexed events

`emit(name, data, { indexed: ["from", "to"] })` builds an index per (program, event name, field, value) → searchable without scanning every event

- At most 3 fields · each must exist in `data` · no duplicates (otherwise it throws)
- `GET /program/<address>/events?name=Transfer&to=0x…` (multiple fields = all must match) · EVM tools can search by topic with `eth_getLogs`
- EVM-style logs: topic0 = `keccak256("Transfer(address,address,uint256)")` (types guessed from values: address / uint256 / bool / string …) followed by the values of the indexed fields → a token that indexes `from` / `to` reads like a real ERC-20

### Program ABI (`metadata.abi`, optional)

Declares functions / events so the explorer can build forms and decode events with the right types (and `/evm` returns it as a JSON ABI via `cardianal_getAbi`)

```js
function initialization() {
  setMetadata("abi", {
    functions: [{ name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint" }], outputs: [{ type: "bool" }] },
                { name: "balanceOf", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint" }], readonly: true }],
    events: [{ name: "Transfer", fields: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "amount", type: "uint" }] }],
  })
}
```

Types: `address` `uint` `int` `bool` `string` `bytes` `object` `array` `any` · names must be unique · `readonly` and `payable` can't be combined · at most 64 functions / 32 events / 16 fields / 16 KB
It can also be sent with the deploy (`metadata: { abi }`) — declared functions must actually be exported

**Forbidden:** `process`, `fetch`, `globalThis`, `performance`, `async`/`await`, `setTimeout`, and imports of any kind · code using these will not pass review

Programs run in a sandbox (QuickJS) separate from the server: no `eval` / `new Function` / `Intl` · `console.log` can be called but prints nothing
Total memory for the whole tx is at most 32 MB (exceeded = `OUT_OF_MEMORY`, the whole tx fails and gas is charged) · function calls can nest about 1,400 levels deep (exceeded = RangeError)

## Numbers are BigInt

Every number in a program must always be BigInt (there is no number mode)

```js
const balance = readDB(map("balances", who)) || 0n;   // ✅ 0n, not 0
writeDB(map("balances", who), balance - params.input.amount);
if (balance < params.input.amount) throw new Error("insufficient balance");
```

- Numeric `params.input` values are converted to BigInt automatically, whether the client sends `30` or `"30n"`
- `params.value`, `params.block.timestamp`, `ThisBalance()`, `BalanceOf()`, `BlockNumber()`, `ChainId()`, `GasPrice()`, `GasLeft()`, `CodeSizeOf()`, `modexp()` are all BigInt (`BlockHash()` also takes the block number as BigInt)
- Returned values and events become strings ending in `n`, e.g. `"970n"`, because JSON has no BigInt
- Using a `number` anywhere is rejected with a message pointing at the mistake
- `Date.now()` / `Math.*` in programs still return numbers as usual · wrap them in `BigInt(...)` before storing or returning (round decimals first, or return them as strings)
- Native balances are in the smallest unit with 18 decimals (wei) — 1 coin = `10n ** 18n`

## modifier

Wrap a function in a function, then return the wrapped version

```js
function onlyOwner(fn) {
  return function (params) {
    if (params.context.sender !== readDB("owner")) throw new Error("not the owner");
    return fn(params);
  };
}

const setPrice = onlyOwner(function (params) { writeDB("price", params.input.price); });

return { setPrice };
```

**Read `patterns/SAFE-PATTERNS.md` before writing programs that handle money**, especially the reentrancy section, which can actually lose other people's funds · see `patterns/vault.program.js` for an example using every pattern

## Testing locally

```js
import { createChain } from "../lib/testkit.js";
import program from "./hello.program.js";

const hello = createChain().deploy(program, { as: "owner", initInput: { greeting: "Hello" } });

hello.call("greet", { name: "world" });            // → "Hello world (visit 1)" (returned numbers come out as "123n")
hello.call("greet", {}, { as: "alice" });          // call as someone else
hello.callRaw("greet", { name: "world" });         // see gasUsed / writes / trace
hello.state();                                      // all data the program stores, e.g. { count: "2n" }
hello.address;                                      // the program's address
```

### Quick tests without running the VM

```js
import { createFakeApi } from "../lib/program-globals.js";
const api = createFakeApi({ self: "0xhello", balances: { "0xhello": 500n }, programs: ["0xtoken"] });
Object.assign(globalThis, api);
const { greet } = program();

greet(api.params({ name: "world" }, { sender: "0xalice", value: 0n }));   // pass numbers in input as BigInt yourself (this mode doesn't convert them)
api.store / api.native / api.events / api.transfers   // inspect results directly
```

Supports every API except `runProgram` and `cloneProgram`, which need `createChain()`
(`keccak256` / `ecrecover` / `keccak256Bytes` / `ecrecoverDigest` / `eip712Digest` / `eip712DomainSeparator` / `CodeHashOf` of a program with code also need `createChain()` because `node:crypto` has no keccak · `GasLeft()` returns `null` because this mode doesn't meter gas)

Block / chain values can be set: `createFakeApi({ blockNumber: 10, blockHashes: { 9: "0x…" }, chainId: 1, coinbase: "0xminer", blockGasLimit: 30_000_000, gasPrice: 10n ** 9n, baseFee: 10n ** 9n, code: { "0xtoken": "function program() { … }" } })`

`createChain()` runs on the real VM, so it behaves exactly like the chain, including rollback on throw, gas costs, and block time

More options

```js
createChain({ chargeGas: true, balances: { alice: 10n ** 18n } });   // test gas costs (native balances in wei)
chain.transfer("alice", "bob", 100);
chain.balanceOf("alice");    // { received, sended, consumed, balance } as BigInt
chain.setTime(Date.parse("2025-01-01"));
```

## Ready-to-use standard programs (ERC)

`import { … } from "programvm/standards/<file>.js"` and deploy the code string directly (all pass autoreview)

| File | Purpose | Deploy input |
|---|---|---|
| `token.js` → `TOKEN_PROGRAM` | ERC-20 style coin + `permit` (ERC-2612) | `{ name, ticker, decimals, supply }` |
| `nft.js` → `NFT_PROGRAM` | ERC-721 style NFT (`mint` / `transferFrom` / `safeTransferFrom` / `approve` / `setApprovalForAll` / `tokenURI`) | `{ name, symbol, baseURI? }` |
| `multitoken.js` → `MULTITOKEN_PROGRAM` | Multiple ids in one program, ERC-1155 style (`balanceOfBatch` / `safeBatchTransferFrom` / `mintBatch` / `uri`) | `{ name?, symbol?, uri }` |
| `wallet.js` → `WALLET_PROGRAM` | ERC-1271 style program wallet (`isValidSignature` / `execute`) | `{ owner? }` |
| `multicall.js` → `MULTICALL_PROGRAM` | `aggregate` / `tryAggregate` many calls in one tx / query (`readonly: true` = staticcall) | — |

Every number (tokenId, id, amount, deadline) is BigInt · error messages are in English

### permit (ERC-2612) — let someone else send the allowance tx for the owner

permit is standard EIP-712: the owner can sign directly with MetaMask `eth_signTypedData_v4` (the explorer has a **Permit** tab on the token page)

```js
import { TOKEN_PROGRAM, PERMIT_TYPES } from "programvm/standards/token.js";
import { signPermit, permitTypedData } from "programvm/program-signature.js";

// the token must be at a real address (0x + 40 hex) because it is the domain's verifyingContract
const fields = { name: "Thai Baht Coin", chainId: 41234 /* the chain's ChainId() */, verifyingContract: tokenAddress, owner, spender,
  value: 500n, nonce: 0n /* nonces({ owner }) */, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) /* unix seconds */ };
const signature = signPermit(fields, ownerKey);   // = ethers wallet.signTypedData(domain, PERMIT_TYPES, message) = MetaMask
// MetaMask: ethereum.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(permitTypedData(fields))] })
// owner is a WALLET_PROGRAM (ERC-1271): the wallet's owner signs the same typed data with owner = the wallet's address
send({ action: "call", to: tokenAddress, method: "permit", input: { owner, spender, value: "500n", deadline: `${fields.deadline}n`, signature } });
```

domain = `{ name: name(), version: "1", chainId: ChainId(), verifyingContract: ThisAddress() }` · types = `Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)`
`DOMAIN_SEPARATOR()` = the EIP-712 domainSeparator · expires when `params.block.timestamp / 1000n > deadline` (deadline is in **seconds**) · nonce + 1 after use
Tokens deployed before this version keep the old scheme (digest = keccak256 of canonical JSON · deadline in milliseconds) until redeployed

### Accepting program-wallet signatures (ERC-1271) in your program

```js
import { SIGNATURE_CHECKER } from "programvm/standards/wallet.js";
const code = `function program() {
  ${SIGNATURE_CHECKER}
  function claim(params) {
    const digest = eip712Digest({ name: "Claims", version: "1", chainId: ChainId(), verifyingContract: ThisAddress() },
      { Claim: [{ name: "nonce", type: "uint256" }] }, "Claim", { nonce: 1n })
    if (!isValidSignatureNow(params.input.signer, digest, params.input.signature)) throw new Error("bad signature")
    …
  }
  return { claim }
}`;
```
`isValidSignatureNow(signer, hash, signature)` (hash = a 32-byte digest, e.g. from `eip712Digest`): a personal wallet → `ecrecoverDigest(hash, signature) === signer` · a program → `runProgram(signer, "isValidSignature", { hash, signature }, { readonly: true }) === "0x1626ba7e"`
Signer side: MetaMask `eth_signTypedData_v4` of the same typed data, or `signTypedDataDigest(digest, key)` · `WALLET_PROGRAM.isValidSignature` checks that the owner signed that digest directly

## Deploying to the chain

```js
import program from "./hello-world/hello.program.js";
const code = String(program);    // ← what gets sent is this string

const tx = { chainId: 41234, action: "deploy", from: me, to: "", method: "",
             input: { greeting: "Hello" }, code, value: 0, nonce, gasLimit: 200000,
             maxFeePerGas: "20000000000000", maxPriorityFeePerGas: "0" };   // EIP-1559: pay at most 20,000 gwei (2x the 10,000 gwei minimum) · no tip (legacy gasPrice still works)
await fetch("/sendtx", { method: "POST", body: JSON.stringify({ tx, signature: signTransaction(tx, key) }) });
```

You can also sign with MetaMask (`eth_signTypedData_v4`) · the structure to sign can be built with `buildTypedData(tx)` in `programvm/signature.js`

After deploy, the program is pending review · it becomes usable once the team sends the `init` tx
