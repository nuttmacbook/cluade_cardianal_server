# Checkpoint 5

> This document is a snapshot as of Checkpoint 5 · the latest information (files, env, open items) is in `HANDOFF.md` — if the two files disagree, `HANDOFF.md` wins
> Values on this page are from that time (chainId 1 · `burnPercent` 50 · 1 s blocks / 1M gas · `public/explorer.html` · 868 cases) · now = Bluewolfchain (BWSC) chainId 41234 · 2 s blocks · 5M gas · minimum 10,000 gwei · fork `bluewolf` · explorer lives in `explorerscan/` · for the values actually in use see `server.js` / `deploy/genesis.mainnet.example.json`

Status: stable — all 868 test cases pass (`npm install` then `npm test`)

| File | Lines | sha256 (first 16) |
|---|---|---|
| virtualmachine.js | ~2,000 | ca8737c988554f0a |
| db.js | 160 | 640235038481add0 |
| signature.js | 200 | 0032ca5d2f5685bd |
| mempool.js | 160 | 39c0ef6fe71850f7 |

## Files in the system

```
src/core/virtualmachine.js   VM, Transaction, Block, Compiler
src/storage/db.js            DB (LMDB) + MemoryDB
src/crypto/signature.js      EIP-712 on secp256k1
src/node/mempool.js          tx queue: rate limit, TTL, ordered by gasPrice
src/node/sync.js             reader node + syncRoute()
src/node/simulate.js         dry-runs a tx before accepting it into the queue
src/core/autoreview.js       code review via a whitelist
server.js                    the real server (node:http) + automatic block sealing
public/explorer.html         single-file explorer
index.js                     single entry point
scripts/                     demo.js, examples.js, seed.js, demo-market.js, demo-chain.js
program-sdk/ test/           program-writing kit for outside developers, tests
```

## Recommended settings for production

```js
const vm = new VirtualMachine(new DB("./data", { mapSize: 100 * 1024 ** 3 }), {
  chainId: 1,
  requireNonce: true, chargeGas: true, deriveProgramAddress: true, forceOriginFromSender: true,
  recordTransactions: true, recordBlocks: true, recordHistory: true,   // numbers in programs are always BigInt (no longer an option)
  gas: { call: 100, read: 100, write: 500, byte: 1, event: 200, hash: 100, recover: 3000, code: 10, price: 1 },
  feeRecipient: MINER, burnPercent: 50,
  maxTransactions: 500, maxTransactionsPerSender: 16, maxBlockGas: 1_000_000,   // 1 s blocks (BLOCK_MS 1000)
  maxCodeSize: 64 * 1024, maxKeySize: 1000, maxValueSize: 64 * 1024,
  admins: [ADMIN],
});
const mempool = new Mempool(vm, { maxPerSender: 16, maxSize: 5000, ttlMs: 5 * 60_000, rateLimit: 60 });
```

## Available tx types

| action | Method | Notes |
|---|---|---|
| call | `vm.call` | can attach `value` |
| deploy | `vm.deploy` | can attach `value` / `metadata`, address = keccak256(deployer + nonce) |
| init / reject | `vm.init` / `vm.reject` | signed by the team, restricted by `admins` |
| transfer | `vm.transfer` | native transfer, does not call a program |
| metadata | `vm.setMetadata` | your own namespace / description |

## In-program API (18 functions)

```
readDB / writeDB / deleteDB / map
runProgram(target, method, input, { value })
transferNative / setMetadata / emit
keccak256 / ecrecover · keccak256Bytes / ecrecoverDigest / eip712Digest / eip712DomainSeparator (MetaMask-style EIP-712)
ThisAddress / ThisBalance / BalanceOf / IsProgram / MetadataOf / BlockNumber
Date (block time) / Math (deterministic random)
```

Program structure: a single wrapping function + `return { … }` at the end of the function; supports modifiers (consts that are functions)

## DB keys

```
pending:<id> | <id>:code | <id>:context | <id>:this | <id>:storage:<a>:<b>
<addr>:nonce | <addr>:native:received|sended|consumed | <addr>:metadata:<field>
namespace:<name> | <addr>:txn:<nonce>:<txhash> | txto:<addr>:<n>:<idx>:<callIdx> | event:<program>:<name>:<n>:<idx>:<i>
block:<n> | blockbody:<n> | blockundo:<n> | blockhash:<hash> | latestblock
tx:<txhash> | sigtx:<digest> | history:<dbKey>:<n>
0x000…000:native:received   (burned funds)
```

## Measured numbers

| | |
|---|---|
| seal a 100-tx block | 61ms |
| `replayBlock` of an old block | 67ms, constant at any depth |
| `stateAt` | ≤3 DB reads |
| `rebuildFrom(150)` out of 300 blocks | 1.4s |
| size per block (full, 100 tx) | ~190 KB / 664 keys |
| deploy 1.4 KB of code | 13,960 gas |
| plain call | ~1,300 gas |

## Locked-in behavior

- nothing reaches the DB until commit
- timeout / DB failure / out of gas → the whole tx fails, the program cannot catch it
- `runProgram` target fails and is caught → writes and events of that branch are rolled back
- wrong nonce → not included in a block, nonce not consumed, no gas charged
- tx that fails inside the program → included in a block, consumes the nonce and pays gas
- exceeds the block limit → `LIMIT_EXCEEDED`, not included in the block
- time and `Math.random()` are tied to the block + tx hash, so replays give the same result
- addresses are always lowercase, `origin = sender` for user txs

## ⚠️ Not done yet

**Before letting outsiders deploy**
- no sandbox — programs can access Node globals
- intermediate values in memory are not limited yet (`maxValueSize` only guards writes / return / emit)

**Before there is a second node**
- the reader node is ready (`sync.js`); what remains is step-counting gas to close the `while(true)` hole that never touches the DB

**Half a day of work before going live**
- ~~wire `mempool.js` into the real API~~ done in `server.js`
- ~~enable `recordHistory` + `bigintValues`~~ enabled in `server.js` (wipe the DB and start over if it has old data) · number mode was later removed, the VM always uses BigInt
- test signatures with real MetaMask

**When the time comes**
- fast rollback · ~~merkle tree~~ done (phase 4: stateRoot = Merkle trie + `cardianal_getProof`)
- factory (programs that create programs), program upgrades, token standards
- native as BigInt (together with step-counting gas) · ~~prune old history / snapshot~~ done (phase 4: `HISTORY_KEEP_BLOCKS` · `SNAPSHOT_EVERY` + `startSync({ snapshot: true })`)
