# Spec for building the Explorer

This document explains everything you need to know to build the explorer for this chain
The reader is a person or agent writing the web front end; no need to read the VM code

---

## 1. Chain overview

- a single server produces blocks, sealing one every ~2 seconds (`BLOCK_MS`); empty blocks are not created
- every tx is signed with EIP-712 (secp256k1) like Ethereum, so MetaMask works · the domain has no chainId (sign from a wallet on any chain) · the chain's chainId is in the message → the node rejects it if it does not match
- addresses are always lowercase, format `0x` + 40 hex — **always lowercase before searching**
- programs (smart contracts) are written in JavaScript and have the same kind of address as wallets

### There are 5 tx types

| action | Meaning | Fields used |
|---|---|---|
| `call` | call a program function | `to` (program), `method`, `input`, `value` |
| `deploy` | upload code to the chain (not usable until init) | `code`, `input` (initInput), `metadata`, `value` |
| `init` / `reject` | the team approves or rejects a program | `to` (program) |
| `transfer` | transfer the native coin, no program involved | `to`, `value` |
| `metadata` | set the name/description of your own address | `input` |

**Program status:** `deploy` → awaiting review (`pending`) → `init` → usable (`active`) or `reject` → rejected and refunded
The explorer should make it clear which programs are still awaiting review

---

## 2. Things to know before writing code (very important)

### 2.1 Numbers are strings ending in `n`

Numbers in programs are always BigInt, so every number coming from a program or from storage is a string like this

```json
{ "amount": "1000n", "balance": "999999999999999999999n" }
```

**Never use `Number()`** because values can exceed 2^53; convert with `BigInt(value.slice(0, -1))` and format it yourself
Native coin balances (native, wei with 18 decimals) are also `"123n"`, while system values (gas, nonce, block number, timestamp) are still plain numbers

### 2.2 A tx has 2 hashes, both searchable

| Name | Comes from | Used where |
|---|---|---|
| `hash` | computed by the VM | DB key, the block's `txHashes` |
| `digest` | the EIP-712 data the user signed | what the wallet shows the user |

`GET /tx/:hash` accepts both values. **We recommend showing `digest` as the tx id on the page** when available, since it matches what the user saw when signing, and using `hash` as an internal mechanism

### 2.3 There are 2 kinds of failed tx, display them differently

| Kind | `accepted` | In a block? | Pays gas? |
|---|---|---|---|
| program throws / insufficient funds | `true` | ✅ with status `throw` | ✅ pays |
| wrong nonce / over quota / sent too often / simulate failed / timed out / expired in queue | `false` | ✅ in the block's **rejected** list (not executed) | ❌ does not pay, nonce not consumed |

The second kind (already passed signature checks) is recorded by the producer in the next block: `GET /tx/:hash` → `{ status: "rejected", block, reason, stage, … }`
(`block: null` = still waiting for the next block) · `stage`: `sendtx` (at submission) · `block` (at block sealing) · `expired` (sat in the queue too long)
Invalid signatures are not recorded (hash / sender cannot be trusted) · display as "Rejected" + reason, not "Failed"

### 2.4 The native coin is stored as 3 cumulative fields

```
balance = received - sended - consumed
```

Every field only ever increases. `consumed` is the lifetime total of gas paid
You can show all 3 values as a statistic EVM chains do not have

### 2.5 Special address

`0x0000000000000000000000000000000000000000` holds the burned portion of gas fees
Its `received` total is the amount of coins removed from the system overall — good as a home-page number

---

## 3. API

Every endpoint returns JSON, `limit` is at most 100, times are unix milliseconds

### Read-only (safe to expose publicly)

| endpoint | Returns |
|---|---|
| `GET /blocks?limit=20` | latest block headers, newest first |
| `GET /block/latest` | latest header |
| `GET /block/:number` | header of that block |
| `GET /block/:number?full=1` | **full receipt** — every tx with input, result, trace, stateChanges, events |
| `GET /tx/:hash` | position and status of the tx (accepts both hash and digest) · still in the queue → `{ status: "pending" }` · replaced → `{ status: "replaced", hash, replacedBy }` (remembered persistently with a cap, survives restarts) · rejected → `{ status: "rejected", block, blockNumber, index, reason, code, stage, sender, nonce, action, to, gasPrice, timestamp }` |
| `GET /rejected?address=&limit=&cursor=` | rejected txs, newest first `{ items, next }` (pass `next` back as `cursor`) · no address = whole chain · `GET /address/:a/rejected` = that sender's |
| `GET /program/:a/interactions?limit=&cursor=` | txs / calls into the program, cursor-based `{ items, next }` (does not count the whole list, no cap) |
| `GET /program/:a/events?limit=&cursor=&name=` | events, cursor-based `{ items, next }` (an empty `cursor` is allowed = first page) · no `cursor` = the old page-number mode `?page=` · `/address/:a/incoming?cursor=` works the same |
| `GET /program/:a/events?name=Transfer&to=0x…&from=0x…` | search by the index of fields emitted as indexed (multiple fields = AND · `name` is required, otherwise 400) → `{ items, next, limit }` newest first · `cursor` / `limit` work · non-indexed field = empty |
| `GET /program/:a/abi` | `{ address, abi, evmAbi }` — `abi` = the `metadata.abi` the program declares (null = none) · `evmAbi` = Ethereum-style JSON ABI |
| `GET /program/:a/groups?scan=&cursor=` | counts storage keys by first key name, in ranges (`scan` ≤ 50,000 per request) → `{ total, groups, scanned, next, complete }` · not complete → send `cursor=next` and add up the results yourself |
| `GET /tx/:hash/receipt` | receipt of a single tx |
| `GET /address/:address` | balance, nonce, metadata, whether it is a program, latest txs |
| `GET /program/:address` | code, creator, metadata, balance, storage, `token` / `collection` (standard NFT ERC-721 / multi-token ERC-1155 · otherwise = null) |
| `GET /address/:address/nfts` | NFTs / multi-tokens held `[{ program, standard, name, symbol, tokenId, amount, uri }]` |
| `GET /events?program=&name=&limit=` | events emitted by programs, newest first |
| `GET /name/:namespace` | name → address |
| `GET /state/:address?block=42` | program storage as of that block |
| `GET /nonce/:address` | next nonce to use (counts txs waiting in the queue too) |
| `GET /pending` | txs waiting in the queue, not yet in a block · `rejectedPending` = rejected txs waiting to be recorded in a block |
| `POST /query` | call a program function read-only, no gas charged |

### Write

| endpoint | Notes |
|---|---|
| `POST /sendtx` | `{ tx, signature }` — returns 400 with `simulation` if it would fail · action: `call` `transfer` (value 0 allowed = cancel a stuck tx by sending 0 to yourself) `deploy` (`upgrader` optional, part of the signed data) `init` `reject` `metadata` `upgrade` (`code` + `input` = migrate input) `setUpgrader` (`input: { upgrader: "0x…" \| null }`) `initUpgrade` `rejectUpgrade` `setGasConfig` (admin only · no `to` · `input: { minBaseFee: "<wei>" \| null }` · null = revert to the genesis value · takes effect from the next block) |

**`POST /query`** is very important for the explorer because it reads values from programs without sending a tx

```json
POST /query
{ "programUuid": "0x4e6d…", "functionName": "balanceOf", "input": { "who": "0x7099…" } }
→ { "status": "success", "result": "1000n", "readOnly": true }
```

---

## 4. Data formats

### block header — `GET /block/:number`

```json
{
  "number": 42,
  "hash": "0x…", "parentHash": "0x…",
  "timestamp": 1735689605000,
  "feeRecipient": "0x…", "burnPercent": 100,
  "txCount": 3, "successCount": 2, "failedCount": 1,
  "gasUsed": 4210, "fee": "4210000000000n",
  "baseFeePerGas": "1000000000n", "gasTarget": 500000, "burnedFee": "4210000000000n", "producerFee": "0n",
  "parentStateRoot": "0x…", "txRoot": "0x…", "stateRoot": "0x…", "writesRoot": "0x…",
  "receiptsRoot": "0x…", "logsBloom": "0x…(512 hex)",
  "txHashes": ["0x…", "0x…", "0x…"],
  "rejectedCount": 1, "rejectedRoot": "0x…"
}
```

`rejectedCount` / `rejectedRoot` appear only on blocks that contain rejected txs (part of the block hash) · the list is in `?full=1` → `rejected: [{ hash, sender, nonce, action, to, gasPrice, reason, code, stage }]`

`stateRoot` = root of the Merkle Patricia Trie of the whole state after this block (any single value can be verified with `GET /proof?key=` · `cardianal_getProof`) · `writesRoot` = hash of this block's state writes · `parentStateRoot` = stateRoot of the previous block (not part of the hash)

`baseFeePerGas` (EIP-1559 · computed from the previous block) · `receiptsRoot` (hash of every condensed receipt) · `logsBloom` (EVM-style log bloom) **are part of the block hash**
`burnedFee` / `producerFee` = the burned portion of gas / the portion `feeRecipient` receives (tip + unburned base fee) · the explorer shows them as Base fee + Fee split
`?full=1` includes `baseFeePerGas` `gasTarget` `burnedFee` `producerFee` `receiptsRoot` `logsBloom` as well

### full receipt — `GET /block/:number?full=1`

```json
{
  "number": 42, "hash": "0x…", "time": "2025-01-01T00:00:05.000Z",
  "txCount": 2, "gasUsed": 4210,
  "transactions": [ /* see below */ ],
  "events": [{ "name": "Transfer", "data": {…}, "depth": 0, "program": "0x…", "txIndex": 0, "txHash": "0x…" }],
  "stateChanges": [{ "program": "0x…", "key": ["balances", "0x…"], "after": "970n" }],
  "nativeChanges": [{ "address": "0x…", "field": "consumed", "after": 813 }]
}
```

### tx receipt

```json
{
  "hash": "0x…", "digest": "0x…", "index": 0,
  "action": "call", "status": "success",
  "from": "0x…", "to": "0x…", "method": "transfer",
  "input": { "to": "0x…", "amount": "30n" },
  "result": true,
  "error": null,
  "nonce": 5, "gasUsed": 813, "gasPrice": "1000000000n", "fee": "813000000000n",
  "type": 2, "effectiveGasPrice": "1000000000n", "baseFeePerGas": "1000000000n",
  "maxFeePerGas": "2000000000n", "maxPriorityFeePerGas": "0n", "burnedFee": "813000000000n", "producerFee": "0n",
  "events": [{ "index": 0, "depth": 0, "program": "0x…", "name": "Transfer", "data": { "amount": "30n" } }],
  "trace": [{ "depth": 0, "program": "0x…", "method": "transfer", "from": "0x…", "origin": "0x…", "status": "success" }],
  "stateChanges": [{ "program": "0x…", "key": ["balances", "0x…"], "after": "970n" }],
  "nativeChanges": [{ "address": "0x…", "field": "consumed", "after": 813 }]
}
```

`signedOnChainId` = the chain the wallet was on when signing (the page fills it from `eth_chainId` · omitted = this chain · part of the signature but not proof) · the tx page shows it as a "Signed on" row

**`trace` is this chain's selling point** because it shows every level of nested program calls without enabling a debug mode
`depth` 0 is the user's call, depth 1 is a program calling another program
`from` is the caller at that level (can be a program address), `origin` is always the user who started the tx

### address — `GET /address/:address`

```json
{
  "address": "0x…",
  "native": { "received": 1000000, "sended": 5000, "consumed": 3013, "balance": 991987 },
  "nonce": 6,
  "metadata": { "namespace": "alice", "type": "program", "creator": "0x…", "createdAt": 1735689600000 },
  "isProgram": false,
  "transactions": [{ "hash": "0x…", "action": "call", "nonce": 5, "status": "success", "timestamp": …, "gasUsed": 813, "fee": 813, "signature": "0x…", "digest": "0x…" }]
}
```

`metadata.type === "program"` means it is a program, and `namespace` is a system-wide unique name. **Show the name instead of the address when available**

### program — `GET /program/:address`

```json
{
  "address": "0x…",
  "code": "function program() {\\n  …",
  "context": { "sender": "0x…", "origin": "0x…" },
  "metadata": { "type": "program", "creator": "0x…", "createdAt": …, "namespace": "mytoken" },
  "native": { "balance": 5000, … },
  "storage": [{ "key": ["balances", "0x…"], "value": "970n" }]
}
```

`code` is stored as a single line with newlines escaped as `\n`. **Convert it back before displaying**

```js
const source = JSON.parse(`"${code}"`);
```

---

## 5. Pages to have

| Page | Endpoints | What to highlight |
|---|---|---|
| Home | `/blocks`, `/block/latest`, `/pending` | block count, tx per second, burned coins, txs waiting in the queue |
| block | `/block/:number?full=1` | tx list, total gas, block sealer, links to previous/next block |
| tx | `/tx/:hash/receipt` | **tree-style trace**, events, storage changes, gas |
| address | `/address/:address` | the 3 balance fields, tx history, namespace name |
| program | `/program/:address`, `/events?program=`, `POST /query` | highlighted code, event feed, **read-only function call buttons** |
| Search | every endpoint | accepts block number, tx hash, digest, address, namespace |

**Features this chain supports that typical explorers lack**

1. **View state as of any block** with `/state/:address?block=42` — build a slider to scroll back through a program's data
2. **Call read functions for free** with `POST /query` — makes a "Try it" page easy
3. **Trace for every tx with no configuration**

---

## 6. Caveats

1. **`?full=1` re-executes the whole block** and takes tens of milliseconds; don't call it on list pages, only when the user opens a detail view
2. **`GET /block/:number?full=1` may return 409** if the chain does not keep history; fall back to showing only the header
3. **A block's `timestamp` comes from the block producer**, not from when the user sent the tx
4. **`method` is an empty string for deploy/init/transfer/metadata**; don't display it as "undefined"
5. **A deploy's `input` has no `code`** because the code is in a separate field
6. **Txs waiting in the queue (`/pending`) have no block yet and may never get one**; show the status as "Pending" and poll again
7. **Events from a branch that failed and was caught disappear**, so the numbers you see come only from branches that actually succeeded
8. **Don't cache `/pending` and `/block/latest`**; sealed blocks never change and can be cached forever

---

## 7. Client example

```js
const api = (path, options) => fetch(`${BASE}${path}`, options).then((r) => r.json());

const toBigInt = (value) => (typeof value === "string" && /^-?\d+n$/.test(value) ? BigInt(value.slice(0, -1)) : value);

const block = await api("/block/42?full=1");
for (const tx of block.transactions) {
  for (const call of tx.trace) console.log("  ".repeat(call.depth) + `${call.program}.${call.method} → ${call.status}`);
}

const balance = await api("/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ programUuid: TOKEN, functionName: "balanceOf", input: { who: address } }),
});
console.log(toBigInt(balance.result));
```

---

## 8. If an endpoint is missing

The VM has these functions you can call directly if you want to add endpoints yourself

```js
vm.listBlocks({ limit, reverse })        vm.getBlock(n)          vm.getBlockBody(n)
vm.replayBlock(n)                        vm.getTransaction(hash) vm.listTransactionsOf(address)
vm.listEvents({ program, name, limit })  vm.listProgramStorage(address)
vm.nativeBalanceOf(address)              vm.getMetadata(address) vm.resolveNamespace(name)
vm.stateAt(blockNumber, dbKey)           vm.snapshotAt(blockNumber, prefix)
vm.query({ programUuid, functionName, input, context })
```

---

## 9. Page style (purple theme)

Reference image `design/explorer-style-ref.png` (a Space and Time–style data app) · a single dark theme, no light mode

- **Header**: near-black bar, hexagon logo on the left · pill buttons (`.pill`, selected = solid purple `#6d28d9`) · search box `#q` · Deploy · the wallet button is an account chip with a green circle (far right)
- **Sidebar** `#side`: collapsible sections (`<details>`) Explorer / Programs / Wallet / Recent programs · small colored circle icons · counts as chips
  The recent programs list comes from `/programs/approved?limit=8` · `markNav()` adds `.on` to `[data-nav]` for the open page (called in every `render()`)
  At ≤960px the sidebar becomes a drawer opened with the ☰ button (`#menu-btn`); picking an item, tapping the backdrop, or Esc closes it · the header pill buttons are hidden
- **Background**: radial gradient, deep purple → magenta (`#2a0a4a → #6b1a9a`) + faint grid lines + a perspective floor grid (`.canvas` fixed, does not scroll)
- **Cards** (`.panel`): a small black label above the card (`h2` uppercase monospace · the number in "(N)" is a `.cnt` chip while the text stays the same)
  The card body is translucent purple with a thin glowing border · table headers are a light purple bar · dense rows · `kv` table row names are uppercase with a diamond icon
  Below lists there is a "● Showing …" chip as a footer · on wide screens a thin purple line on the left links the cards together
- **Tabs / buttons**: tabs sit in the black bar at the top of the card, selected = solid purple · `.btn` translucent purple · `.btn.solid` solid glowing purple
- Main colors are in `:root` (`--card` `--head` `--violet` `--line-2` `--glow` `--mono`) · JSON boxes remain `#04050d` (checked by tests)
- Do not change ids / data-* / button text used by the e2e tests · the "purple theme" test checks the sidebar / drawer / table headers
