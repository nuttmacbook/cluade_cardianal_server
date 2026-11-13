# HANDOFF — Program VM + Explorer

Project handoff document for another agent or team to continue the work. Read this one file and you can pick up right away

> **30-second summary**
> A blockchain whose smart contracts are written in plain JavaScript, with txs signed using EIP-712 (MetaMask works)
> The VM is fully sync + deterministic, storing data in LMDB as flat key/value
> There is a real server (node:http) + explorer (`explorerscan/`) + an SDK for program authors
> **Step-counting gas + a real sandbox are in place (QuickJS in WebAssembly — section 4 "Sandbox")** · before letting outsiders deploy, see section 11

| | |
|---|---|
| Language / runtime | JavaScript (ESM), Node 22 only (`engines: >=22 <23`) |
| Dependencies | `@noble/curves`, `@noble/hashes`, `acorn`, `lmdb`, `quickjs-emscripten` (pinned to 0.32.0, do not bump it yourself, see section 4) (+`ethers` as dev) |
| Total code | ~16,600 lines in `src/` `server.js` and both SDKs (the VM itself ~4,300) |
| Language in code | comments / error messages are English, variable names are English — **keep this style** · Thai that remains in consensus text (deployed program source, VM execution messages in `src/core/`) is part of existing blocks and must not be changed |
| Tests | `npm test` → 1045 cases + `npm run test:e2e` 34 cases |

---

## 1. Getting started in 2 minutes

```bash
npm install
npm test                         # 1045 cases, all should pass before you change anything

npm run dev                      # server + explorer at http://localhost:3000 (data in memory · DEV=1 does not require ADMINS / PRODUCER_KEY)
node dev/seed.js             # in another terminal: creates a sample token + txs of every type
node dev/demo-market.js      # NFT market + token + native, 4 users, ~23 blocks
```
⚠️ `demo-market` / `demo-chain` set the gas price to 1 gwei but the chain minimum is now 10,000 gwei → start the server with `GAS_PRICE=1000000000 npm run dev` (`seed.js` reads the price from `/genesis` itself)

Both scripts above take the URL as their first argument (`node dev/seed.js http://localhost:3100`)
`npm run seed` / `npm run demo:market` also work but only target `http://localhost:3000`

Server env: `PORT` `DATA` `DEV` `GENESIS` `PRODUCER_KEY` `MINER` `ADMINS` `BLOCK_MS` (default 2000) `MAX_BLOCK_GAS` (5M) `MAX_TX_GAS` (= MAX_BLOCK_GAS) `MAX_TX_PER_BLOCK` (500) `CHAIN_ID` (41234) `GAS_PRICE` (minimum base fee, default 10,000 gwei) `TIMEOUT_MS` (default 5000) `RATE_LIMIT` (POSTs per IP per minute, default 120, 0 = unlimited · `eth_sendRawTransaction` counts toward this quota) `VERIFY_WORKERS` (signature-check workers, default CPU − 1, max 4 · 0 = main thread) `SANDBOX_WARM_CACHE` (warm program images, default 32 ≈ 110 MB RAM · 0 = compile every tx) `EVM_RATE_LIMIT` (`/evm` requests per IP per minute, default 600 · 0 = unlimited · local testing with MetaMask + Blockscout uses 0) `EVM_MAX_BATCH` (requests per `/evm` batch, default 1000 · every request in a batch counts toward `EVM_RATE_LIMIT`) `MAX_BODY_BYTES` (POST body, default 1 MB · over = 413) `EVM_NAME` `EVM_SYMBOL` (name / symbol the Add network button sends to the wallet) `HOST` (unset = all interfaces · in production behind nginx use 127.0.0.1) `TRUST_PROXY` (number of reverse proxy layers in front, default 0) `HISTORY_KEEP_BLOCKS` (pruning · unset = archive) `SNAPSHOT_EVERY` `SNAPSHOT_DIR` `SNAPSHOT_KEEP` (state snapshots) `FOLLOW` `FOLLOW_SNAPSHOT` `FAILOVER_FROM` (standby machine / producer migration) · the rest are at the top of `server.js` + `GENESIS_SETTINGS` in `src/node/genesis.js` (`CHAIN_ID` `PRODUCERS` are not at the top of server.js)
`npm start` (without `DEV=1`) refuses to start unless `ADMINS` and `PRODUCER_KEY` are set — see "Launching a real network" below · the full set of config files for production is in `deploy/` (read `deploy/README.md`)
No `DATA` = `MemoryDB` (lost on shutdown); set = LMDB at that path
Initial balances are read from `genesis.json` — the key for address `0x7099…79c8` used by the scripts is
`0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` (Hardhat test key, account #1)

Other scripts: `dev/demo.js` (single-process playground), `dev/examples.js` (sample requests of every type), `dev/demo-chain.js`

### Launching a real network (tests `85-genesis-producer` `86-ops`)
- **Bluewolfchain (BWSC)**: server defaults = chainId 41234 · 10,000 gwei · 2 s blocks · 5M gas blocks · `genesis.json` enables the `bluewolf` fork from block 0 (unit prices ×2.5 of the real machine cost + `gas.tx` 15,000 per tx · native transfer 17,300 gas) · name in /evm = Bluewolfchain / BWSC · wrapped coin = WBWSC (`wbwsc`) · tests that start a server set `GAS_PRICE=1 gwei` to use development-era numbers
- **genesis.config** locks values every machine must share (part of the genesis hash): `chainId` (top level) · `burnPercent` `minBaseFee` `gasTarget` `baseFeeDenominator` `blockMs` `maxBlockGas` `upgradeDelayBlocks` `memoryLimitMb` `stackLimitKb` `admins` `producers` (`src/node/genesis.js`)
  `genesis.forks` = fork table `{ name: block }` (not part of the genesis hash · can be added later · see the gas section "forks by block height")
  `genesis.producerSchedule` = `[{ fromBlock, producers }]` changes the producer list from a given block (not part of the genesis hash · see "Producer down / key lost / key leaked" below)
  Values = genesis → env → default · env differing from genesis = server refuses to start · a genesis without `config` (the in-repo development file) = locks nothing · `GENESIS=path` picks the file
- **Not `DEV=1`** → requires `ADMINS` (unset = anyone can approve deploys / upgrades) and `PRODUCER_KEY` · the producer must be in `config.producers` if genesis defines it
- **Producer signs blocks**: `new VirtualMachine(db, { producer: { address, sign(hash) } })` → the header has `producer` (part of the hash · blocks without a producer hash byte-for-byte as before) + `producerSignature` (r‖s‖v over the block hash · outside the hash)
  `sync.js`: `verifyProducer(header, producers)` · pass `producers` → blocks must have a listed producer + a valid signature · `startSync({ genesis })` reads `genesis.config.producers` itself · `/genesis` reports `producer` / `producers`
  replay / rebuild use the producer + signature from the original header (a machine without the key rebuilds the same hash) · the explorer block page shows Producer
- **Producer down / key lost / key leaked** (test `100-producer-failover` · fully explained in the project's producer-key.md)
  Machine down: a standby machine with `FOLLOW=<producer url>` (+ `DATA`) keeps syncing, does not produce blocks or accept txs (`/sendtx` 503 · `eth_sendRawTransaction` error), needs no `PRODUCER_KEY` · `FOLLOW_SNAPSHOT=1` = start from a snapshot
  Take over production: restart the standby with `PRODUCER_KEY` + `FAILOVER_FROM=<old machine url>` (no `FOLLOW`) → `prepareFailover` (`src/node/failover.js`) first asks the old machine's `/health`: `role: "producer"` (or an old version that reports no role) = **refuses to start** · no longer producing = syncs whatever is missing first · unreachable = starts + warns (network partition while the old machine still produces = chain split, the operator must be sure it is really down) · never start the old machine as a producer again, bring it back as `FOLLOW=<new machine>`
  Key lost: put a backup key (kept offline) in `config.producers` from the chain reset → you can keep producing with the backup key immediately · only one key = the server warns at startup (`startupWarnings`)
  Key leaked: add `producerSchedule: [{ fromBlock: N, producers: [new key] }]` to genesis.json on **every node** and restart (genesis hash unchanged) → from block N the old key cannot produce (rejected even with a valid signature) · blocks before N still sync · a removed producer stops producing on its own (`/health` `role: "retired"` + problem `miner`) · the new key starts with `FAILOVER_FROM`
  `producersAt(settings, n)` / `producerSetOf(genesis)` → `(n) => list` · `verifyProducer` / `startSync` / `loadSnapshot` / `client.verifiedState({ producers })` accept either a list or a function · `/genesis` reports `producers` (for the next block) `baseProducers` `producerSchedule` `role`
- **Timeout during replay / sync**: txs run with `replayTimeoutMs` (default 60 s) instead of the producer's `timeoutMs` — the producer already filters TIMEOUT out before inclusion (`code === TIMEOUT → accepted: false`), so slower machines don't get different results · gas is still the main stopper (3M gas takes about 0.1 s)
- **`/health`** → `{ ok, problems, latest, latestAt, blockAgeMs, blockMs, historyFrom, pending, rejectedPending, role, producer, miner, follow, db }` · any problem = **HTTP 503**
  `role`: `producer` / `follower` (FOLLOW) / `retired` (key removed by producerSchedule) / `standby` (waiting for prepareFailover)
  problems: `stalled` (txs waiting but no new block for over `HEALTH_STALL_MS`, default max(10 × BLOCK_MS, 30 s)) · `miner` (block sealing failed repeatedly) · `follow` (standby sync stopped, e.g. block mismatch) · `disk` (LMDB ≥ `HEALTH_DISK_PERCENT`, default 90%)
- **`npm run monitor -- --url … [--webhook URL] [--interval 30] [--once]`** alerts when status changes (POSTs `{ text, url, problems, health }` to the webhook) · `--once` exit 1 = problem (for cron)
- **`npm run backup -- --data ./data --out ./backups [--keep 7] [--compact]`** backs up LMDB while the server runs (`DB.backup` = mdb_env_copy reading one snapshot) + `replaced-tx.jsonl` + `manifest.json`
  Verified every time: latest block matches the manifest · parentHash chain over the latest 1,000 blocks · blockhash points back · `--verify <set>` verifies only
  Restore: stop the server then `npm run backup -- --restore <set> --data ./data` (existing data → `--force` moves it to `<data>.before-restore-<time>`)
- TLS: the server is plain `http`, it needs a reverse proxy (nginx / Caddy) in front for HTTPS · rate limits count per IP in each process's memory
- **Behind a proxy you must set `TRUST_PROXY=1`** (CDN + nginx = 2) · unset = everyone gets the proxy's IP → the whole network shares one `RATE_LIMIT` / `EVM_RATE_LIMIT` quota (`src/node/client-ip.js` · test `95-client-ip`)
  IP = counted from the right of `X-Forwarded-For` + socket (users can only forge the left part the proxy did not add) · nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` · Caddy adds it itself
  ⚠️ With `TRUST_PROXY` > 0 the server port must be open only to the proxy (otherwise users can send a forged IP header)

---

## 2. File map — where to go to change what

```
src/core/virtualmachine.js   4,293 lines   all chain logic (see section 4)
src/core/sandbox.js          2,159        program sandbox: QuickJS (WebAssembly) + per-tx snapshot + cross-boundary value converters
src/core/autoreview.js         204        whitelist code review — usable standalone
src/storage/db.js              242        DB (LMDB) + MemoryDB — readKeys / writeKeys / listKeys
src/crypto/signature.js        302        EIP-712 + secp256k1 (domain has no chainId · section 6)
src/crypto/program-signature.js           signatures that programs verify: signPermit (EIP-712 / ERC-2612) / signWalletHash / signTypedDataDigest / signProgramMessage
src/crypto/eip712.js                      eth_signTypedData_v4-style EIP-712 (= ethers TypedDataEncoder), no VM dependency: eip712Digest / eip712DomainSeparator / recoverAddress
src/standards/                            standard programs: token (ERC-20 + permit) · nft (ERC-721) · multitoken (ERC-1155)
                                          · wallet (ERC-1271 + SIGNATURE_CHECKER) · multicall (section 8 "NFT standards / …")
                                          · system (WBWSC · Multisig · Factory + system-program deploy plan · section 8 "Chain system programs")
                                          · multisender · tokenlock · dex · staking · limitorder · nftmarket (6 more system programs · section 8)
scripts/deploy-system.js                  deploys the whole system-program set in the deployer's nonce order → deploy/system-programs.json
scripts/set-gas.js                        admin adjusts the gas price minimum mid-flight (setGasConfig tx · takes effect next block)
src/node/mempool.js            415        tx queue: rate limit, TTL, dedup, ordered by effective tip (EIP-1559), replaces same-nonce txs
src/node/ratelimit.js           54        per-key rate limit (the server uses it to limit POSTs per IP)
src/node/simulate.js            52        dry-runs a tx before accepting it into the queue
src/node/sync.js               129        reader node: fetches blocks, executes them itself, and compares hashes
server.js                      590        the real server (node:http) — the one in use
explorerscan/                  ~2,300     explorer: index.html + theme/ (colors) + ui/ (look) + core/ (logic) · see explorerscan/README.md
index.js                        12        single entry point for importing as a library
scripts/                                  live-chain operations: preflight · deploy-system · set-gas · backup · snapshot · monitor
dev/                                      tests only (can be deleted): demo · seed · scenario · simulate · load-test · bench · fuzz · evm-proxy · see dev/README.md
test/                                     tests (can be deleted, the chain doesn't use them) · genesis.json at root = development genesis, never use it to launch a real chain
```

Split into 3 groups (README table, section "Layout"): used by the live chain = server.js · src/ · explorerscan/ · deploy/ · scripts/ · developer tools = client-sdk/ · program-sdk/ · docs/ · tests only = test/ · dev/ · genesis.json

Dependencies always go one way: **`node` → `crypto` → `core` → `storage`**
`core` knows nothing about signatures / HTTP / queues · `storage` does not know what keys mean — don't break this direction

| What you want to change | Go to |
|---|---|
| Gas, price table | `DEFAULT_GAS` at the end of the "Frequently tuned values" section in `virtualmachine.js` |
| VM defaults | `DEFAULT_OPTIONS` in the same file |
| Error messages | `ERRORS` in the same file (all messages in one place) |
| DB key formats | the `*Key()` function group around lines 430–490 + `decodeDbKey()` |
| Accepted program structure | `PROGRAM_WRAPPER_PATTERN` / `Compiler.parse` |
| APIs programs can call | `PROGRAM_API_NAMES` + `createProgramApi()` + `API_OPS` in `sandbox.js` + `PROGRAM_API` in `autoreview.js` (**all 4 places must be changed**) |
| Memory / stack / program isolation | `src/core/sandbox.js` (section 4 "Sandbox") |
| Code review rules | `ALLOWED_NODES` / `ALLOWED_MEMBERS` / `BANNED_*` in `autoreview.js` |
| Endpoints | `ROUTES` + `DYNAMIC` + `handlePost` in `server.js` |
| Web pages | `explorerscan/` — colors `theme/colors.css` · look `theme/style.css` + `ui/` · logic (chain reads / wallet / signatures) `core/` |

### Parts that exist twice — be careful

**canonical JSON**: exists in `virtualmachine.js` (`canonicalJson`) and is rewritten in `explorerscan/core/wallet.js` (`canonical`)
**If you change one without the other, every signature from the web page will be invalid**

(`src/node/routes.js`, the Fastify example, and the `client/` folder that duplicated `program-sdk/` have been removed — the real server is `server.js` alone)

---

## 3. Program structure (smart contract)

A program is **a whole-file valid JavaScript in a single scope**, sent through the API directly as a string

```js
function program() {
  function initialization(params) {       // runs once at init — can never be called externally
    writeDB("owner", params.context.sender)
    writeDB(map("balances", params.context.sender), params.input.supply)
  }

  function helper() {}                    // not in return = internal

  const onlyOwner = (fn) => (params) => { // modifiers work (consts whose value is a function)
    if (readDB("owner") !== params.context.sender) throw new Error("not the owner")
    return fn(params)
  }

  const mint = onlyOwner(function (params) { /* … */ })

  function transfer(params) {
    const balance = readDB(map("balances", params.context.sender)) || 0n
    if (balance < params.input.amount) throw new Error("insufficient balance")
    // …
    emit("Transfer", { to: params.input.to, amount: params.input.amount })
    return true
  }

  return { transfer, mint }               // ← last line: the names callable externally
}
```

Rules
- The wrapping function can have any name · `const program = () => { … }` works too · **no `import` / `export`**
- `return { … }` must be the **last line** of the wrapping function (a regex matches the end of the file)
- Do not export `initialization`
- `migrate(params)` (if present) runs once, only when an upgrade is approved — it is stripped even if listed in `return { … }`, **cannot be called externally**, just like `initialization`
- `params` passed to every function: `{ input, context: { sender, origin }, value, block: { timestamp } }`
  (the block number is not in `params` — call `BlockNumber()` instead)

### Program upgrades — test `56-upgrade`

**No upgrader = immutable forever** · every pre-existing program has no upgrader, so none of them can be changed
- **The upgrader is set only at deploy**: `vm.deploy({ …, upgrader: "0x…" })` / signed tx `{ action: "deploy", …, upgrader: "0x…" }`
  → stored in `pending:<id>` (the `upgrader` field exists only when sent) → at `init` it is written as `metadata.upgrader`
  (`upgrader` / `version` / `template` are system fields — users cannot set them via metadata / a program's `setMetadata`)
- **Transfer / renounce the right**: `vm.setUpgrader({ programUuid, upgrader, context })` — must be the current upgrader · `upgrader: null` = renounce → immutable from then on
  Signed tx: `{ action: "setUpgrader", to: <program>, input: { upgrader: "0x…" | null } }`
- **Submit new code**: `vm.upgrade({ programUuid, code, migrateInput, context })` from the upgrader · checked exactly like a deploy (size / syntax / autoreview / gas `call + code × byte`)
  → `pending-upgrade:<id>` `{ code, context, migrateInput }` (one at a time per program) · signed tx: `{ action: "upgrade", to, code, input: migrateInput }`
- **Team approves / rejects**: `vm.initUpgrade({ programUuid, context })` / `vm.rejectUpgrade(…)` — **approver rules are exactly the same as init / reject** (`admins`, no context = internal call)
  Signed tx: `action: "initUpgrade"` / `"rejectUpgrade"` · the upgrader must still be the one who submitted the code (transferred / renounced → cannot be approved, reject it)
- **On approval** (`applyUpgrade`): replaces `<id>:code` → stores `<id>:codeversion:<n>` `{ version, code, blockNumber, timestamp }`
  (version 1 is stored the first time it is replaced, `blockNumber: null`) → `metadata.version` + 1 (missing = 1)
  → runs `migrate(params)` once (`input = migrateInput`, `sender = upgrader`, already sees the new code) · **migrate throws = approval fails, nothing changes** (pending stays)
  Existing storage is intact · the compile cache is keyed by code content (new code = recompile) and the old code is dropped with `compiler.forget()`
- **timelock** — option `upgradeDelayBlocks` (server: env `UPGRADE_DELAY_BLOCKS`, default 0)
  - `0` → the new code is used immediately in the approving tx (the next tx in the same block sees the new code)
  - `N > 0` → approved at block B: deletes pending, writes `scheduled-upgrade:<id>` `{ …, approvedAt: B, activateAt: B + N }` + index `upgradeat:<B+N>` `[id…]`
    Returns `{ state: "scheduled", activateAt }` · the old code keeps running · new code cannot be submitted again until activation
  - **Activated when block B+N is created** (`Block` constructor → `#activateUpgrades` → `vm.activateUpgrade`) before the first tx, even if that block has no txs
    Not a tx (no hash / payer / not in the body), but its writes are in the block state → included in stateRoot + history → **replay / rebuild give the same result**
    `header.upgrades = [{ program, status, version, error }]` (only on blocks with an activation) · migrate fails at that point → the upgrade is cancelled, the old code keeps running
  - Requires a block number (`recordBlocks` / pass `number`) · approval outside a block → error · `simulate` of `initUpgrade` simulates the next block itself
- Historical reads: `vm.listCodeVersions(addr)` · `vm.getCodeVersion(addr, n)` · `vm.codeAt(blockNumber, addr)` (= `stateAt` of `<id>:code`)
  `replayBlock` of a block before an upgrade always uses the code as of that time (reads `<id>:code` through history)

### cloneProgram — program factory (CREATE2-style) — test `57-clone`

```js
const address = cloneProgram(template, initInput, { salt, value })   // inside a program (factory)
```
- `template` = any **approved** program (has `<id>:code`) · pending / rejected / missing → `NOT_FOUND`
- address = `addressFromHash(hashData({ chainId, factory, salt, codeHash: keccak256(code) }))` — known before creation via `vm.cloneAddressFor(factory, salt, code)`
  `salt` = a non-empty string or a BigInt (its numeric value is used as a string) · duplicate salt (address already exists) → `INVALID_REQUEST`
- **copies** the code to the new address (later template upgrades don't affect the clone), then runs `initialization` immediately in the same tx
  `context.sender = factory` · `origin` unchanged · `value` (optional) transfers native from factory → clone before initialization (visible as `params.value`)
- metadata: `type: "program"`, `creator: factory`, `createdAt`, `template` · approved immediately (has `<id>:this` → counted in `/programs/approved`) · no upgrader = immutable
- Gas: `call` (in initialization) + `code × byte` of the code (like deploy) + `write × 7` + 1 read · depth is counted like `runProgram` (`maxCallDepth`)
- **A failure anywhere rolls back everything**: initialization throws / the branch calling clone throws and an upper level catches → no code / metadata / transferred funds remain
- trace: the clone entry has `type: "create"` (`tx.calls` → receipt `trace[].type` → `txto` action `create` → callTracer `CREATE`)
  Plain calls have no `type` field (existing receipts unchanged) · a template without initialization still gets a create entry (`functionName: "create"`)

### params / return values — numbers are BigInt

**Numbers in programs must be BigInt only** — the VM always works this way (the `bigintValues` option / number mode has been removed)

- `10` → error `numberNotAllowed` · you must write `10n`
- Stored in the DB as the string `"123n"`, converted back to BigInt automatically on read
- Values leaving via API JSON are also `"123n"` → **clients must not use `Number()`**, use `BigInt(v.slice(0,-1))`
- Native balances are BigInt in wei (18 decimals, 1 coin = 10^18), stored in DB / receipt / tx record as `"123n"`
  Incoming `value` / `gasPrice` accept number, BigInt, `"123"` and `"123n"` · the server's default gas price is 10,000 gwei (`GAS_PRICE`)
- The remaining system values (gasUsed, gasLimit, nonce, block number, timestamp) are still plain `number` outside programs
  (inside programs `params.block.timestamp` / `BlockNumber()` are BigInt · `Date.now()` is still a number, wrap it in `BigInt()` before storing)

### In-program API (36 functions)

```
readDB(key) / writeDB(key, value) / deleteDB(key) / map(...parts)
runProgram(target, functionName, input, { value })      call another program
runProgram(target, functionName, input, { readonly: true })   STATICCALL-style: the target + every nested level cannot modify state
cloneProgram(template, initInput, { salt, value })      create a new program from an approved template → address (see the cloneProgram section)
transferNative(to, amount)                              transfer the native coin from the program
setMetadata(field, value) / emit(name, data, { indexed: ["from", "to"] }?)   indexed = fields searchable by value (at most 3 · see the indexed events section)
keccak256(value) / ecrecover(value, signature)
ThisAddress() / ThisBalance() / BalanceOf(addr) / IsProgram(addr) / MetadataOf(addr, field) / BlockNumber()
Date        block time (Date.now() returns the same value for every tx in the block)
Math        random() tied to the tx hash → replays give the same result
sha256(value) / ripemd160(value) / blake2b(value)        hash precompiles (same input as keccak256 · blake2b = BLAKE2b-512)
modexp(base, exponent, modulus)                          BigInt · modulus 0n → 0n · each value ≤ 1024 bytes (MODEXP_MAX_BYTES)
BlockHash(n) / ChainId() / Coinbase() / BlockGasLimit() / GasPrice() / BaseFee() / GasLeft()
CodeHashOf(addr) / CodeSizeOf(addr)                      keccak256 / bytes of the stored code · not a program → null / 0n
keccak256Bytes("0x…")                                    keccak256 of raw bytes (hex) → "0x…" 32 bytes (the original keccak256(value) always hashes the UTF-8 text)
ecrecoverDigest(digest, signature)                       EVM-style ecrecover directly from a 32-byte digest → address | null
eip712Digest(domain, types, primaryType, message)        the digest MetaMask eth_signTypedData_v4 signs (= ethers TypedDataEncoder.hash)
eip712DomainSeparator(domain, types?)                    domainSeparator (= TypedDataEncoder.hashDomain)
```

**Raw bytes / EIP-712** (`src/crypto/eip712.js` · test `78-eip712`) — added without touching the existing ones: the original `keccak256` / `ecrecover` take text / objects (UTF-8 hash / canonical JSON), **behavior and gas unchanged to the unit**, old programs replay with the same result

| API | Behavior | Gas |
|---|---|---|
| `keccak256Bytes(hex)` | `"0x"` + whole bytes (upper / lower case ok · `"0x"` = empty bytes) · malformed → `INVALID_REQUEST` (catchable) | `hash` + `byte` × byte count |
| `ecrecoverDigest(digest, sig)` | digest `"0x"` + 64 hex · sig r‖s‖v 65 bytes, v = 27 / 28 (the same recoverer as the original `ecrecover` — `recoverAddress()` · high s still recovers as before) · unusable signature → `null` · malformed → throw | `recover` (3000) |
| `eip712Digest(domain, types, primaryType, message)` | full EIP-712 encodeData rules: `address` `bool` `uintN` `intN` `bytesN` `bytes` `string`, nested structs, nested arrays `T[]` / `T[k]` · types may or may not include `EIP712Domain` (absent = use the domain fields that have values in the order name, version, chainId, verifyingContract, salt, like ethers) · numbers must be BigInt (number → error like other APIs) · extra fields are skipped; missing / wrong type / out of range / recursive struct → `INVALID_REQUEST: EIP-712: …` (catchable) · ≤ 64 struct types · ≤ 128 fields · ≤ 32 nesting levels (protects the host stack so every machine fails at the same point) · `primaryType = "EIP712Domain"` → digest of the domain only, like MetaMask | `hash` × number of keccak calls + `byte` × all bytes hashed (typeHash of every struct, string / bytes, array, struct, digest) — charged after computing (work is linear in data the program already paid gas to build) |
| `eip712DomainSeparator(domain, types?)` | same as above but returns the domain's hashStruct | same |

Example from EIP-712 (Mail): `eip712Digest({ name: "Ether Mail", version: "1", chainId: 1n, verifyingContract }, { Person: […], Mail: […] }, "Mail", message)` = `0xbe609aee…`, matching the example in EIP-712

APIs compared to EVM (all deterministic · return BigInt / string / null):

| API | EVM | Behavior | Gas |
|---|---|---|---|
| `BlockHash(n)` | BLOCKHASH | `block:<n>.hash`, up to 256 blocks back (`BLOCK_HASH_WINDOW`) · current / future / older / block 0 → `null` · a query outside a block treats the block after the latest as current · `n` must be BigInt | `read` |
| `ChainId()` | CHAINID | `vm.chainId` | `env` 10 |
| `Coinbase()` | COINBASE | the block's `feeRecipient` (null if none) | `env` |
| `BlockGasLimit()` | GASLIMIT | `vm.maxBlockGas` (null = unlimited · uses the VM's value, not the Block's, so replay gives the same result) | `env` |
| `GasPrice()` | GASPRICE | `tx.gasPrice` = actual price per gas `min(maxFee, baseFee + priority)` | `env` |
| `BaseFee()` | BASEFEE | base fee of the tx's block (`tx.baseFee` · a query outside a block = base fee of the next block) | `env` |
| `GasLeft()` | GAS | `gasLimit - gasUsed` after deducting its own `env` (null if there is no cap) | `env` |
| `CodeHashOf(a)` | EXTCODEHASH | `keccak256(<a>:code)` = the same codeHash `cloneProgram` uses to compute addresses | `read` + `hash` + `byte` × code size |
| `CodeSizeOf(a)` | EXTCODESIZE | bytes of `<a>:code` | `read` |
| `sha256` / `ripemd160` / `blake2b` | precompile 0x02 / 0x03 / (BLAKE2F) | hex `0x…` | `sha256` 100 / `ripemd160` 300 / `blake2b` 100 + `byte` × data size |
| `modexp` | precompile 0x05 | square-and-multiply | `modexp` 200 + ⌊word² × max(exp bits, 1) ÷ 3⌋ (charged before computing) |
| `runProgram(..., { readonly: true })` | STATICCALL | `caller.readonly` propagates to every level · `writeDB` / `deleteDB` / `transferNative` / `setMetadata` / `emit` / `cloneProgram` → `ERRORS.readonlyCall` (FORBIDDEN, catchable) · cannot attach value (`readonlyValue`) · trace `type: "staticcall"` → callTracer `STATICCALL` | same as a normal call |

**Adding a new API requires changes in 4 places**: `PROGRAM_API_NAMES`, `createProgramApi()` (both in `virtualmachine.js`), `API_OPS` in `sandbox.js` (name + argument types — missing = the program cannot reach the host) and `PROGRAM_API` in `autoreview.js` — forget the last one and autoreview rejects code using the new API as unknown · don't forget the fake APIs in `program-sdk/lib/program-globals.js` and the SDK README

---

## 4. Inside virtualmachine.js

4 classes in one file:

| class | Role |
|---|---|
| `VirtualMachine` | owns options / DB, all public methods, creates Blocks and Transactions |
| `Block` | the set of txs committed together — computes hashes, assembles header/body, writes history |
| `Transaction` | a single tx: read cache, accumulated writes, gas counting, branch rollback support |
| `Compiler` | turns a code string → a callable function (`parse` + `compile`) |

### How the Compiler works (the easiest part to break)

`Compiler.parse()` uses regexes, not an AST:
1. rejects if it finds `import`/`export` at the start of a line
2. `PROGRAM_WRAPPER_PATTERN` extracts the body of the wrapping function as `body`
3. `RETURN_EXPORT_PATTERN` matches the **final** `return { … }` → the export list, then strips that line from the body
4. collects candidate names (`candidateNames`) from `function name(` and `const/let name =` (the latter is what makes modifiers work)

Then it injects the gas counter (`gasmeter.js`) and assembles the factory **source** (string)
```js
(function (api) { "use strict"; const { readDB, writeDB, …, __gas, __str, __props, __spread, __add, …, __opm } = api; ${body} ;return { … }; })
```
→ the API is destructured as `const` in the same scope as the user code (cannot be overwritten) · this source runs in the sandbox (QuickJS), not in the server's V8
Syntax is checked against both V8 (the original error messages) and QuickJS (`checkGuestSyntax` — the one that actually runs) before the code is accepted

`isTopLevelDeclaration()` uses a trick worth knowing before you change it: append `let <name>;` to the code and compile
If V8 complains `'<name>' has already been declared` = the name really is declared at the top level — checked without running the code
Compile results (the source with the counter injected) are cached by code string (`#cache`)

### Sandbox (`src/core/sandbox.js` · test `58-sandbox`)

Program code runs in **QuickJS compiled to WebAssembly** (`quickjs-emscripten` 0.32.0, sync variant, QuickJS 2025-09-13)
not in the server's V8 → programs have no way to see `process` / `require` / Node globals / any host object

| | |
|---|---|
| On import | loads the wasm once (top-level await) · creates 1 runtime + 8 spare contexts with the prelude loaded · takes a **snapshot** of the wasm memory (~1.8 MB) · self-checks that the snapshot can really be restored (fail = import fails) |
| Start of a tx | restores memory to the snapshot (~0.13 ms) → every tx starts from the byte-identical heap, nothing left over from earlier txs (modified globals / GC garbage) |
| 1 outermost tx | = one runtime · memory / stack / time are counted across the whole call chain (`runProgram` / `cloneProgram` init run nested in the same runtime) |
| 1 program in a tx | = 1 context (separate globals) · the factory is called anew on every call → top-level variables don't persist across calls |
| Warm images (test `89-warm-sandbox`) | the first program of a tx: uses the memory "initial snapshot + this source's factory already evaluated" (LRU `SANDBOX_WARM_CACHE`, default 32 · `warmStats` / `clearWarmCache`) instead of recompiling · the image = a pure function of (snapshot, source) → cache hit or miss, every tx result is byte-identical (including gas and the OUT_OF_MEMORY point) · token transfer 2.2 → 0.94 ms/tx (load test) · the second program in a tx (`runProgram`) compiles within the tx as before<br>~3.4 MB per image → 32 images ≈ 110 MB RAM · not cached: compile and keep using that memory directly (no extra restore), then capture it over the buffer of the evicted image · `0` = no storing or copying (cost equals compiling every tx, as before) · programs rotating beyond the limit = miss every time, ~30% slower than no cache (raise `SANDBOX_WARM_CACHE` if more than 32 programs are popular) |
| fuzz (test `87-sandbox-fuzz`) | `npm run fuzz -- --iterations N --seed S`: random programs + cross-boundary values, checks no INTERNAL / throw leaks to the caller · identical results on two VMs · host not contaminated · results are pure data · sandbox remains usable · a long run of 20,000 iterations (seed 1000) found no issues |
| Cross-boundary values | always JSON text (BigInt / undefined / NaN / -0 / map(...) tagged with the key `"\u0000"`) → a fresh copy every time · functions / symbols / non-data objects are sent as "not data" and the host rejects them as before · host errors the program receives are program-side `Error`s (with `code`); if rethrown, the host gets its original error back |
| Globals | standard JS built-ins + the block's `Date` / `Math` (Math.random asks the host) · `eval` / `new Function` / async / generator function constructors are disabled (EvalError) because code created at run time bypasses the gas counter · `console.*` can be called but prints nothing · no `Intl` / `performance` / `setTimeout` / `queueMicrotask` / `structuredClone` / `Atomics` |
| Gas | `__gas(n)` / `__str` / `__props` / `__spread` and the wrapped built-in methods run on the program side (no host round trip every time) · the pending total is sent to the host on every API call · pending total exceeds what is left → asks the host immediately → OUT_OF_GAS at the same point as before. **Gas numbers unchanged to the unit** |
| Out of gas / timeout / DB failure / memory exceeded | the host answers "dead" → every `__gas` / API after that throws again (every catch / finally starts with `__gas`), so it cannot be caught · loops that call nothing are stopped by QuickJS's interrupt handler (also uncatchable) |
| Stack | `maxStackBytes` default 256 KB (~1,400 levels of nested calls — the old V8 allowed ~10,000) · overflow = a catchable `PROGRAM_ERROR (RangeError)` · only 16–256 KB is allowed (512 KB overflows Node's stack and crashes the wasm) |
| Memory | `memoryLimitBytes` default 32 MB per tx (1 MB–1 GB allowed) · exceeded = **`OUT_OF_MEMORY`** (new code) |

**Memory — why not use QuickJS's memory limit**: on emscripten `malloc_usable_size` does not work, so QuickJS only counts ~8 bytes per block (tested: set 32 MB but 2 GB could be allocated · quickjs-ng is the same)
So it is controlled at the WebAssembly memory level instead: the instance that runs programs has its own `WebAssembly.Memory` whose `grow` is wrapped
At the start of a tx (after restoring the snapshot) a "balloon" is allocated so that exactly `memoryLimitBytes` + a 2 MB host reserve remain free, then memory growth is locked
→ malloc always fails at the same point on every machine (the tx-start heap is byte-identical and independent of how far memory had grown before) · any touch of the lock = OUT_OF_MEMORY
OUT_OF_MEMORY behaves like OUT_OF_GAS: the whole tx fails, catch / finally cannot catch it, no program writes, **included in the block (`accepted: true`), consumes the nonce, and pays for the gas used**
(gas still pending on the program side when malloc fails is sent back via `"f<n>|"` → allocating 32 MB actually costs ~1,000,000 gas, not just the part already sent to the host)
⚠️ Every node in the network must set the same `MEMORY_LIMIT_MB` / `STACK_LIMIT_KB`, otherwise memory-heavy txs will produce different results

**snapshot — assumptions to know before bumping the quickjs-emscripten version**: wasm memory = [static data ~90 KB | C stack 5 MB | dlmalloc heap]
The snapshot stores the lower 1 MB (static) + the heap up to the last free chunk (dlmalloc's `top`, whose location is found experimentally at import)
The self-check at import verifies this; if the layout changes so the state cannot be fully restored, the server will not start (rather than run incorrectly) · `top` not found = store the whole memory (correct but slow)
Never `dispose` the runtime while handles are still alive (QuickJS aborts the whole wasm) — the runtime lives for the whole process and `Sandbox.dispose()` releases every handle / context created in the tx

**Differences from the old V8 that programs might notice** (API results / gas / error codes are all the same — compared with a probe suite):
`Date()` / Date's `toString()` do not append "(Coordinated Universal Time)" · `toLocaleString` / `localeCompare` don't use ICU · no `Intl`
Engine error messages differ (`cannot read property 'x' of null`) but names are the same (non-plain `Error` errors are already converted to their name)
Stack overflow is an `InternalError` on the program side (a RangeError after crossing the boundary, as before) · Promises never resolve (no job queue — async doesn't work anyway)
`debug.at` reports line / column from QuickJS's stack

Server variables: `MEMORY_LIMIT_MB=32` `STACK_LIMIT_KB=256` (`TIMEOUT_MS` is still the last line of defense for time) · option `wallClock: true` gives programs the real `performance.now()` — tests only

**Plan notes / open paths**
- Speed: token transfer ~1.4 ms/tx (old V8 ~0.6), mostly recompiling the program factory every tx (~0.4 ms) + QuickJS's interpreter · pure computation is ~4–5× slower than V8 (~50 M gas/s) · re-measure with `node dev/bench-vm.js`
- A speedup considered but not done: keep contexts with popular programs precompiled in the snapshot — **careful**: the snapshot would then differ by each node's history → tx-start heaps differ → the out-of-memory point could differ; the set of programs in the snapshot must first become part of chain state
- QuickJS bytecode cannot cross runtimes / snapshots in quickjs-emscripten (no API to read / write bytecode), so the counter-injected source is cached instead
- Using QuickJS's own memory limit in the future requires a build with `malloc_usable_size`
- ~~`gasmeter.js` turned `(255).toString(36)` into syntactically invalid code~~ gone now: calls are no longer rewritten to `__call` (built-in methods are wrapped in the prelude instead)

### Lifecycle of a single tx

```
POST /sendtx
  → postLimiter.allow(ip)       limits POSTs per IP → over the limit returns 429
  → verifyTransaction()         checks the signature → sender comes only from the signature (never trust tx.from)
  → mempool.add(…, { simulate }) rate limit + quota + nonce order first, then calls simulate:
      reviewProgram(code)       deploy action only
      simulate(vm, verified)    runs in a throwaway block (number:null, no commit) → on error returns 400
                                failed simulations also count toward the per-address rate limit
  ⏱ every BLOCK_MS (default 2 seconds)
  → vm.createBlock() → mempool.take(block) → block.commit()
```

`take()` orders txs with `sortPendingTransactions(items, { baseFee: block.baseFee })` (highest effective tip first), skips those with maxFee < base fee (they stay queued), then checks `block.checkTransaction()` one by one

**Rejected txs are recorded in the block** — those that passed signature checks but were not executed:
- `stage: "sendtx"` rejected at `/sendtx` (wrong nonce / queue full / sent too often / simulate or code review failed / replacement priced too low)
- `stage: "block"` the VM refused at block sealing (TIMEOUT / block gas full) · `stage: "expired"` sat in the queue longer than `ttlMs`
- Invalid signatures (hash / sender untrustworthy) and resubmissions (hash already has a real status) are **not** recorded
- The mempool remembers them in order (`#rejections`, ≤ `maxRejectedQueue` 100,000) → `take()` puts them into the block with `block.recordRejected(entry)`
  At most `maxRejectedPerBlock` (server `REJECTED_PER_BLOCK`, default 1,000), the rest carry over to the next block
  **Only rejected txs → the server holds them** to ride along with the next block that has real txs, or seals a block once the oldest waiting one reaches `REJECTED_HOLD_MS` (default 60,000 · 0 = seal immediately, the old behavior) — `shouldMine()` in server.js uses `mempool.oldestRejectionAt` (time kept in the mempool only, not in the block) · `/pending` reports `rejectedHoldMs`
  Resubmitting the same tx and it passes → removed from the waiting list (not recorded as rejected)
  **The exact same tx (same hash) already recorded as rejected in an earlier block, and never included for real → not recorded again** (the sender still gets the same error)
  1 hash lives in one block → the explorer and `/evm` / Blockscout agree, and rapid resubmission does not create new blocks (previously `/evm` moved the hash to the latest block but Blockscout had already indexed it → they disagreed)
- entry: `{ hash, sender, nonce, action, to, gasPrice, reason (≤ 500 chars), code, stage }` · **not executed, does not touch state, does not consume the nonce, no gas charged** (existing chain rules)
- The header has `rejectedCount` + `rejectedRoot` (= hash of the ordered list) **part of the block hash** · blocks without entries hash byte-for-byte as before
- Stored as block data: `blockrejected:<n>` (list) · `rejtx:<hash>` · `rejfrom:<sender>:<n>:<i>` (indexes, in history/undo → `rebuildFrom` cleans them up)
- `replayBlock` / `rebuildFrom` / `sync` (`applyBlock(vm, { header, body, rejected })`, `/sync` sends `rejected` too) insert the original list and compare hashes
- `/evm`: appended after the block's real txs as failed txs (`status 0x0`, `gasUsed 0`, `effectiveGasPrice` from the tx, no logs, `cumulativeGasUsed` = that of the last real tx)
  index = number of real txs + position · hashes later included for real / rejected again in a later block are not shown twice · `eth_getTransactionCount` unchanged
- Tests `60-rejected-in-block` · `61-rejected-server` · `77-rejected-once`
- Explorer block list: blocks with rejected txs show a `Rejected N` badge (blocks with only rejected txs don't show Empty)

**Replacing a queued tx (replace-by-fee)** — `mempool.add()` accepts nonces in the range [on-chain nonce, on-chain nonce + number queued]
- nonce = next → appended to the queue as before · skipped number → rejected as before (`nonce must be N`)
- nonce = a queued tx from the same sender → replaceable when **both** the new maxFee and priority ≥ old × 1.1 (`replaceBumpPercent: 10`, computed with BigInt rounding up · legacy gasPrice = both values)
  Not enough (both legacy) → `gas price too low for replacement (must be at least X)` · with 1559 → `(requires maxFeePerGas ≥ X and maxPriorityFeePerGas ≥ Y)` + `minimumMaxFeePerGas` / `minimumMaxPriorityFeePerGas`
  · no gasPrice given = `vm.gas.price`
- The new tx can be any action → **cancel = replace with a 0 transfer to yourself** (`{ action: "transfer", to: <yourself>, value: 0 }`)
  The chain accepts EVM-style native transfers of 0: gas is still charged and the nonce consumed · negative / non-integer → `amount must be a non-negative integer`
  (`transferNative` inside programs still does not accept 0, as before)
- Does not use up more `maxPerSender` / `maxSize`, but counts toward the per-address rate limit · must pass simulate first — fails → the old tx stays
- The old tx leaves the queue but stays in "seen" (it cannot be resubmitted) · `mempool.replacedBy(hash)` remembers it in memory for `ttlMs`
  then falls back to `replacedLog` (`src/node/txlog.js`, off-chain, not in blocks): a server with `DATA` → file `<DATA>/replaced-tx.jsonl`
  (appended JSON lines · keeps ≤ `REPLACED_LOG_MAX` 100,000 entries / ≤ `REPLACED_LOG_DAYS` 30 days · rewrites the file when lines exceed 2×) → **survives restarts** · no DATA = in memory with the same caps
  → `GET /tx/:hash` returns `{ status: "replaced", hash, replacedBy }` · the explorer shows "Replaced by …"
- The replacement uses the same nonce → `take()` still picks each address's txs in nonce order · `/nonce/:address` does not move
- `/evm`: the txpool only sees the new tx · `eth_getTransactionByHash` of the old tx returns `null` (like geth)

### Methods you will probably need

```js
// 5 tx types
vm.deploy({ programUuid?, code, context, initInput, value, metadata, nonce, gasLimit, gasPrice })
vm.init({ programUuid, context, … })      // team approves → runs initialization
vm.reject({ programUuid, context, … })    // reject + refund
vm.call({ programUuid, functionName, input, context, value, … })
vm.transfer({ from, to, amount, … })
vm.setMetadata({ metadata, context, … })
// upgrades (see the "Program upgrades" section) — deploy also accepts upgrader
vm.upgrade({ programUuid, code, migrateInput, context, … })          // upgrader submits new code → pending-upgrade
vm.setUpgrader({ programUuid, upgrader /* null = renounce */, context, … })
vm.initUpgrade({ programUuid, context, … }) / vm.rejectUpgrade(…)    // team (same rules as init / reject)
vm.listCodeVersions(addr) / vm.getCodeVersion(addr, n) / vm.codeAt(blockNumber, addr) / vm.cloneAddressFor(factory, salt, code)

// reading data
vm.read(dbKey) / vm.listKeys(prefix, opts) / vm.listEntries(prefix, opts)
vm.getBlock(n) / vm.getBlockBody(n) / vm.getBlockByHash(h) / vm.listBlocks(opts) / vm.latestBlockNumber()
vm.getTransaction(hashOrDigest)           // accepts both the VM hash and the EIP-712 digest
vm.listTransactionsOf(addr, opts)         // txs sent by the address
vm.listTransactionsTo(addr, opts)         // who interacted (including nested runProgram)
vm.listEvents({ program, name, limit, start, reverse })
vm.listProgramStorage(addr, opts) / vm.nativeBalanceOf(addr) / vm.getMetadata(addr) / vm.resolveNamespace(name)

// query reads values without paying gas (readOnly: true, no commit)
vm.query({ programUuid, functionName, input, context, value })

// history / recovery  (requires recordHistory)
vm.stateAt(blockNumber, dbKey)            // value of that key as of that block — ≤3 DB reads
vm.snapshotAt(blockNumber, prefix)        // the whole prefix as of that block (cost scales with key count, not chain length)
vm.pageSnapshotAt(n, prefix, { limit, after })   // paginated → { items: [[dbKey, value]], next }
vm.historyFrom()                          // first block that can be looked up (key historyfrom · checked once, no blockundo scan)
vm.replayBlock(n, { verify })             // re-executes a block from blockbody → full receipt + hash comparison
vm.rebuildFrom(targetBlock, { verify, batch })   // rolls state back to before block 1 then re-executes block by block · every step works in batches (batch 10,000)
vm.getBlockUndo(n)                        // list of keys that block touched

// checks before accepting
vm.checkTransaction({ from, nonce })      // → { ok, expectedNonce, reason }
vm.applyGenesis(obj) / vm.genesisHash() / vm.checkGenesis(obj)
```

### Block

```js
const block = vm.createBlock({ timestamp, feeRecipient, number?, parentHash?, checkChain?, recordBlocks?, recordHistory? });
block.call(request)                       // and deploy / init / reject / transfer / setMetadata / upgrade / setUpgrader / initUpgrade / rejectUpgrade
block.upgrades()                          // upgrades whose timelock expired and were activated when this block was created
block.checkTransaction(request)           // checks quota + nonce before actually adding
block.header() / block.body() / block.hashes() / block.txHashes()
block.receipt({ number })                 // receipts of every tx
block.writes()                            // final writes (1 entry per key) + history
block.commit()                            // writes once via db.writeKeys (atomic) · includes trie nodes (stateRoot) · historyKeep → prunes old history afterwards
vm.stateRoot() / vm.getProof([dbKey]) / vm.rebuildTrie() / vm.pruneHistory({ keep }) / vm.hashHeader(header)   // phase 4
```

### Gas

```
call 100 · read 100 · write 500 · stateKey 1000 · byte 1 · event 200 · topic 375 · hash 100 · recover 3000 · code 10/byte · node 1 · builtin 1 · tx 0 · price 1
```
(= `DEFAULT_GAS` · Bluewolfchain enables the `bluewolf` fork from block 0: call 1750 · read 150 · write 125 · stateKey 1125 · byte 10 · event 1250 · topic 940 · code 33 · node 3 · builtin 3 · tx 15000 · the rest unchanged · values actually in use: `GET /genesis` → `gas`)
`emit` = `event + byte × data size + topic × number of indexed fields`
**`stateKey`** = per state key the tx writes / deletes for the first time (`writeDB` / `deleteDB` · repeated keys in a tx are not charged again · `tx.stateKeys`) — the cost of updating the Merkle trie + history at block sealing
  Without it, a 3M-gas block packed with only new keys (5,450 keys) takes 1.9–2.5 s to seal at 1 million state keys · with it ≤ ~1,950 keys seals in 0.74–0.86 s (`test/99`) · token transfer +2,000 (2 keys) · native transfer unchanged
**Forks by block height** (`FORKS` in virtualmachine.js · `genesis.json` `"forks": { "<name>": <block> }` · test `99-trie-gas-forks`): change rules from a given block without resetting the chain
  `forks` is not part of the genesis hash (`vm.hashGenesis`) → the table can be added later · a name the code doesn't know = the VM refuses to start (nodes must upgrade the software first) · `/genesis` reports `forks`
  Rules: `FORKS.<name> = { description, gas: { new gas values } }` (except `price`) → `vm.gasAt(blockNumber)` · other kinds of rules check `vm.forkActive(name, blockNumber)` at the point of change
  Earlier blocks use the old rules → `replayBlock` / sync / `rebuildFrom` give the same result · nodes with different tables = hash mismatch from that block on · `FORKS` currently has `bluewolf` (Bluewolfchain gas prices · `genesis.json` / `deploy/genesis.mainnet.example.json` enable it from block 0)
**The owner adjusts the gas price minimum mid-flight** (tx `setGasConfig` · `scripts/set-gas.js` · explorer menu "Gas settings" · test `106-gas-config` + e2e): no fork / chain reset / restart needed
  The signer must be in genesis `admins` (chains without admins = cannot adjust) · input `{ minBaseFee: "wei" ≥ 1 | null }` (null = back to the genesis value)
  **Unit prices (DEFAULT_GAS) cannot be adjusted on-chain**; sending `gas` = rejected → forks only (even a leaked admin key cannot set it to 0 to make txs free)
  Writes state key `gasconfig` `{ minBaseFee, block, by }` (in stateRoot / history / snapshot) → **takes effect from the next block**: `Block` computes the base fee from `vm.baseFeeAfter(previous, read)`, which reads state before the block
  · replay reads `stateAt(n − 1)` and gets the same result · following machines sync and get the same hash · `vm.minBaseFeeNow()` = the minimum currently in effect
  Lowering the minimum = every tx type becomes proportionally cheaper (gas per tx / block capacity unchanged) · the base fee still moves with block fullness · it falls toward the new minimum by ≤ 12.5% per block · raising = applied immediately in the next block
  VMs without admins never read this key · `/genesis` reports `minBaseFee` `genesisMinBaseFee` `gasConfig` `gas` `admins` (`gasPrice` = the minimum currently in effect)
**Step-counting gas** (`src/core/gasmeter.js`): at compile time `__gas(n)` is injected at the start of each function / each loop iteration / every branch of if, switch, try
(n = number of AST nodes in that range × `node`) · the code in the DB is unchanged (injected at every compile)
· the names `__gas` `__str` `__props` `__spread` `__call` `__add` `__sub` `__mul` `__div` `__mod` `__pow` `__shl` `__shr` `__lt` `__gt` `__le` `__ge` `__eq` `__ne` `__in` `__key` `__big` `__opm` `__k` `__r` are reserved

**Gas by size of copied / created data** (test `76-gas-bulk-copy`): `builtin` (1) per **unit** · 1 unit = 1 element / property / argument or 32 chars / bytes (rounded up) · a scalar = 1
- spread / rest: `[...a]` `f(...a)` `new F(...a)` `const [x, ...r] = a` → `__spread` charges 1 per element · `{ ...o }` `const { x, ...r } = o` → `__props` charges 1 per property
  (rest in patterns with no expression to wrap — parameters / for-of / catch / nested → deploy fails · `function f(...args)` works)
- `a + b` / `a += b` → `__str` charges by result length if it is a string (QuickJS concatenates as a rope and copies later, so large pieces must be charged at concat time) · templates use the wrapped `"".concat`
- Built-in methods (Array / TypedArray / String / Object / JSON / Reflect / Set / Map / Promise / URI …) are wrapped in the prelude before user code runs (RegExp disabled — see "CPU-based gas")
  The real ones live only in a closure → `a.join()` / `.call` / `Reflect.apply` / storing in a variable all cost the same · implicit string conversion (`a + ""`, `${a}`) goes through the wrapped `join`
  Charges `this` + arguments before running and the result after · `repeat` `padStart` `padEnd` `Array.from({length})` charge the result size before creating it
- `ArrayBuffer` / typed arrays / `Set` / `Map` / `WeakSet` / `WeakMap` / `AggregateError` are wrapped with a Proxy (charged before allocating) · `Array(n)` is not charged (not actually allocated yet)
- The built-in iterators of array / string / Set / Map are locked (cannot be modified) → spread uses the engine's fast copy path and knows the exact element count · Proxies created by programs are tracked (spread then copies property by property)
- `runProgram` / `cloneProgram`: 1 per 32 bytes of input (JSON) and of the return value
- Result: the loop `a = [...a, ...a]` went from ~230 gas per 32 MB → runs out of gas at 3M before reaching the memory cap · a 32 MB string / ArrayBuffer ≈ 1,050,000 gas
- Not yet charged by size: array-likes whose `length` getter lies (allocated first, charged after — bounded by the memory cap)

**CPU-based gas: regex / BigInt** (test `81-cpu-gas`) — previously these two burned seconds of CPU for a few hundred gas and could only be stopped by timeout (not deterministic across machines)
- **regex is fully disabled** (exponential backtracking, gas cannot be charged deterministically — the engine has no hook to count steps): regex literal → deploy fails (`regular expression ใช้ในโปรแกรมไม่ได้` — "regular expressions cannot be used in programs"; consensus message, kept in Thai)
  · `RegExp` / `new RegExp` / `Reflect.construct(RegExp)` → TypeError · `RegExp.prototype` keeps only `toString` (exec / test / `[Symbol.match|matchAll|replace|search|split]` throw)
  · `String.prototype.match` / `matchAll` / `search` → TypeError (previously they took a string pattern and built a regex themselves, **passing autoreview**)
  · `split` / `replace` / `replaceAll` with strings work as before (use `indexOf` / `includes` / `split` instead of regex)
- **BigInt charged by size** — injected at compile time: `a op b` (`+ - * / % ** << >> < > <= >= == != in`) → `__op(a, b)` · `x op= y` → `x = __op(x, y)` (complex members → `__opm`)
  · computed keys `o[k]` → `__key` (only when k is not a string / number) · return values → `__big` (large BigInts the host / engine would convert to strings)
  · the helpers charge no gas themselves for: number / string / BigInt ≤ 512 bits, **prices unchanged to the unit** (token / uint256 unaffected) — fast path when `typeof` of both is number
  · Prices (`builtin` per unit, minimum 16 when an operand / result > 512 bits) · W = number of 64-bit words

  | op | Units | Charged when |
  |---|---|---|
  | `+` `-` | 16 (≤ 1024 bits) · 64 | after (operands within the cap → bounded work) |
  | `*` | ⌈Wa·Wb / 4⌉ | after |
  | `/` `%` | ⌈max(1, Wa − Wb + 1) · Wb / 4⌉ | after |
  | `**` | ⌈Wr² / 4⌉ (Wr from bits × exponent) | **before computing** · result certainly over the cap → RangeError without computing |
  | `<<` `>>` | max(16, ⌈Wr / 2⌉) | before computing |
  | BigInt → string (`String` / `toString` / template / `+ ""` / key / `join` / `Error(x)` …) | W² | before converting |
  | string → BigInt (`BigInt(s)` / `s == 1n` / `s < 1n` / input `"123n"`) | W² (W = ⌈length / 19⌉ · ≤ 171 chars free) | before converting |
  | comparisons `<` `==` … between BigInts | 0 (linear work, very fast) | — |

  · **cap 8192 bits** (= 1024 bytes, same as modexp) — result over the cap → RangeError `BigInt ใหญ่เกิน 8192 bit (1024 ไบต์)` ("BigInt larger than 8192 bits (1024 bytes)"; consensus message, kept in Thai) (catchable) · literal over the cap → deploy fails
    The cap guards the paths where the engine converts BigInt to string itself without going through the counter: ≤ ~0.4 ms per conversion (stock QuickJS accepted up to ~1M bits = 0.7 s toString)
  · Methods where the engine converts BigInt ↔ string internally are wrapped / rewritten in the prelude to charge per the table: `join` `sort` (default comparator) `toSorted` `Object.fromEntries`
    `Error.prototype.toString` `String.raw` (rewritten per spec) · `Object.hasOwn` / `defineProperty` / `Reflect.*` / `Map.get` / `Array.pop` / `at` / `parseInt` / `Symbol` / `Error(x)` … (charge arguments and results)
    · `BigInt64Array` / `BigUint64Array` are removed · `DataView.setBigInt64` charges the parse · `BigInt.asUintN(n, negative)` charges n before running (and n > 8192 → RangeError)
  · Size is measured with `Number(x)` (+ shifting 1000 bits at a time when ≥ 2^1024) — at the 2^k boundary it may round by 1 bit, but gives the same value on every machine (wasm + IEEE 754) → deterministic gas
  · Result: `2n ** 10n ** 9n` runs out of gas in one step (~2.4×10¹⁴) within ~10 ms · loops of `x.toString()` / `H * H` / `B / H` on 8192-bit values exhaust 3M gas in ~0.1 s (previously timeout)
  · Cost: calling the helpers makes pure-number loops ~2–3× slower (roughly 0.5 µs → 1 µs per iteration) · token transfer ~3.0 → ~3.5 ms (same gas)
  · QuickJS: `BigInt.asUintN(n, -1n)` returns `-1n` (engine bug — the correct value is 2^n − 1); don't rely on asUintN results with negative values
Per-tx cap `maxTxGas` (default 10,000,000, server = `MAX_BLOCK_GAS` 5,000,000) applies even when gas isn't deducted → infinite loops end with OUT_OF_GAS without waiting for timeout (the server's 5 s timeout remains the last guard)
The payer is always the outermost sender · `gasLimit` / `gasPrice` (or `maxFeePerGas` / `maxPriorityFeePerGas`) can be supplied
The burned portion → **transferred to `0x000…000`, it doesn't just vanish**; the rest goes to `feeRecipient` (see the next section)

### EIP-1559 gas (tests `68-base-fee` `69-fee-mempool` `73-evm-fees`)

| Value (VM option · server env) | Default | Meaning |
|---|---|---|
| `minBaseFee` · `GAS_PRICE` | `gas.price` (server 10,000 gwei) | minimum base fee (and the base fee of the first block) |
| `gasTarget` · `GAS_TARGET` | `maxBlockGas / 2` (server 2,500,000) | target gas per block · no `maxBlockGas` and unset = base fee fixed at the minimum (old behavior) |
| `baseFeeChangeDenominator` · `BASE_FEE_DENOMINATOR` | 8 | changes by at most 1/8 = 12.5% per block |
| `burnPercent` · `BURN_PERCENT` | 100 | % of the **base fee portion** that is burned (the server previously used 50 of the total fee) |

- The base fee of block n = `nextBaseFee(header n−1)` per the EIP-1559 formula: `parent ± parent × |gasUsed − target| ÷ target ÷ denominator` (rises by at least 1 · never below `minBaseFee`)
  Always computed from the previous header (producers cannot set it) → replay / sync get the same value · `vm.currentBaseFee()` = the next block's
- 1559 txs send `maxFeePerGas` + `maxPriorityFeePerGas` · legacy txs send `gasPrice` = both values · neither = pays the base fee (tip 0)
  · 1559 without maxFee = `baseFee + priority` · priority > maxFee → `INVALID_REQUEST` · maxFee / gasPrice < base fee → rejected (not included in a block)
- **Effective price** `effectiveGasPrice = min(maxFee, baseFee + priority)` = `tx.gasPrice` · fee = gasUsed × effective price
- **Fee split**: `base = gasUsed × baseFee` (the base fee portion) → burns `base × burnPercent / 100` · tip `fee − base` + the unburned base portion → `feeRecipient`
  (no feeRecipient = burn everything) · tx results / receipts include `baseFee` `burnedFee` `producerFee` (+ `feeType: 2` `maxFeePerGas` `maxPriorityFeePerGas` for 1559)
  · price equal to the base fee (tip 0) and burnPercent 100 = burn everything, as before
- The mempool orders by the block's effective tip `min(priority, maxFee − baseFee)` · txs with maxFee < baseFee **stay queued** and are not picked until the base fee drops
  · replacing an existing tx (same nonce) requires raising both maxFee and priority by ≥ 10%, like geth (legacy ↔ legacy, same message as before)
- The header has `baseFeePerGas` `gasTarget` `burnedFee` `producerFee` (`baseFeePerGas` is part of the hash)

### receiptsRoot / logsBloom in the header (test `70-header-roots`)
- `receiptsRoot` = hash of every condensed receipt in order `{ hash, status, gasUsed, cumulativeGasUsed, effectiveGasPrice, fee, error (code), logs }`
- `logsBloom` = EVM-style 2048-bit bloom of every log (address + every topic · logs from `eventLog(event)`, which does not depend on state)
- Both + `baseFeePerGas` + `gasUsed` are in `hashBlock` → replay / `rebuildFrom` / sync (`applyBlock`) execute themselves and compare hashes → producers cannot forge receipts / blooms
- /evm uses the header values directly · `eth_getLogs` skips blocks whose bloom lacks the requested address / topic

### Indexed events (test `71-indexed-events`)
- `emit(name, data, { indexed: ["from", "to"] })` · at most 3 fields (`MAX_INDEXED`, same as LOG4) · must exist in data · no duplicates · the event also stores `indexed`
- Index `eventidx:<program>:<name>:<field>:<topic>:<n>:<idx>:<i>` → value = the event's dbKey · `topic = topicOf(value)` (address = zero-padded to 32 bytes · numbers = uint256 · bool · string = keccak)
  `eventsig:<topic0>:<program>:<name>` → `{ program, name, indexed }` (lets eth_getLogs find the program from topic0)
- EVM-style logs: with indexed → topic0 = `keccak("Name(type,…)")` of every field in data order · subsequent topics = indexed fields · data = ABI of the remaining fields
  · no indexed → topic0 = keccak(name) + data as JSON (as before) · standard token / NFT / multi-token index per ERC (Transfer from / to (+ tokenId) · Approval · ApprovalForAll · TransferSingle/Batch · URI · OwnershipTransferred)
- `vm.listIndexedEvents({ program, name, field, value, limit, cursor, fromBlock, toBlock })` · `GET /program/:a/events?name=Transfer&to=0x…` (multiple fields = AND) · `eth_getLogs` uses the index when topic0 + another topic are given
- Indexes have no history and are not in `blockundo` → `rebuildFrom` deletes all indexes and replay recreates them (test `83`)

### Long chains (test `84-chain-scale`)
- `historyfrom` = the first block from which history is continuous to the latest (the first block storing history · blocks not storing it → the next block) → `replayBlock` / `snapshotAt` check it once instead of reading `blockundo` of every newer block
- `snapshotAt` / `pageSnapshotAt`: keys = those present now ∪ those with history (scans `history:<prefix>`, skipping over each key's history) → no `blockundo` reads
  Limitation: child keys whose next segment is a number with leading zeros about as long as a 12-digit block number (e.g. `map("a", "0000000001")`) and that have been deleted may not show up
- `rebuildFrom`: restores state from each key's first history entry → deletes history / indexes → re-executes blocks 1..target over the old ones (`createBlock({ overwrite: true })`) → deletes blocks beyond · every step in batches
- Measured on an LMDB chain of 30,000 blocks (1 call per block · program with 200 keys):
  | | Before | After |
  |---|---|---|
  | `replayBlock(2)` | 33.5 ms (grows with the number of newer blocks) | 2.7 ms (same as the latest block) |
  | `snapshotAt(2)` | 38.2 ms (grows with chain length) | 7.1 ms (by the program's key count) |
  | `snapshotAt(latest − 1)` | 1.7 ms | 3.6 ms |
  | `rebuildFrom(29,990)` time / peak heap | 109 s / +179 MB | 113 s / +15 MB |
  Extrapolated to 10 million blocks: replaying an old block ~11 s (in RAM) → ~3 ms · rebuild still has to execute the whole chain (needs a snapshot to be fast) but no longer fails from memory

### metadata.abi (test `72-abi`)
```js
{ functions: [{ name, inputs: [{ name, type, description? }], outputs: [{ name?, type }], readonly?, payable?, description? }],
  events:    [{ name, fields: [{ name, type, indexed?, description? }], description? }] }
// type ∈ address uint int bool string bytes object array any
```
- Sent at deploy (`metadata: { abi }` · declared functions must actually be exported) or `setMetadata("abi", …)` in the program · validated by `checkAbi` (names / types / no duplicates / indexed ≤ 3 / ≤ 64 functions · 32 events · 16 fields · 16 KB)
- The explorer builds the Interact form from inputs (instead of guessing from code) · the Events tab shows types / indexed · ABI tab
- `GET /program/:a/abi` → `{ address, abi, evmAbi }` · `/evm` `cardianal_getAbi(address)` → Ethereum-style JSON ABI (`toEvmAbi`: uint → uint256 · object / array / any → string)

### Locked-in behavior (covered by tests — don't break it)

- Nothing reaches the DB until `commit()`
- timeout / DB failure / out of gas / memory exceeded → the whole tx fails, the program cannot `catch` it
- **Memory exceeded (`OUT_OF_MEMORY`) → included in the block, consumes the nonce, pays for gas used** (like out of gas · including the total pending on the program side)
- **Copying / creating whole data blobs costs gas by size** (spread / rest / `+` producing strings / built-in methods), the same whichever way it's called (test `76`)
- `runProgram` target fails and the caller catches → writes + events of that branch are rolled back
- **Wrong nonce / over quota / timeout → not included, nonce not consumed, no gas** (`accepted: false`)
- **Program throws / insufficient funds → included, consumes the nonce, pays gas** (`status: "throw"`, `accepted: true`)
- `parentHash` always chains · block numbers cannot repeat · timestamp must be greater than the previous block's
- Duplicate txs (same hash) cannot get in · rejected txs never overwrite the `tx:<hash>` of a successful one
- Time and `Math.random()` are tied to the block + tx hash → replays give exactly the same result
- V8 errors are sanitized before storing (the real message goes into `debug`, which is **not written to the DB**) so replays match
- Addresses are always lowercase · `origin = sender` for user txs

---

## 5. All DB keys

LMDB stores flat key/value; keys are strings separated by `:`, values are JSON

### Address / program state
```
pending:<id>                        deployed program awaiting init  { code, context, initInput, metadata, value }
<id>:code                           code (escaped string)
<id>:context                        { sender, origin } at deploy
<id>:this                           its own address — used to check whether this address is a program
<id>:storage:<a>:<b>:…              program data (the parts map() builds, URI-encoded per part)
<addr>:nonce                        next tx sequence number
<addr>:native:received|sended|consumed    cumulative counters, increase only
<addr>:metadata:<field>             namespace / description / type / creator / createdAt / upgrader / version / template
namespace:<name>                    name → address (unique system-wide)
pending-upgrade:<id>                new code submitted by the upgrader, awaiting the team  { code, context, migrateInput }
scheduled-upgrade:<id>              approved, waiting for the timelock  { code, context, migrateInput, approvedAt, activateAt }
upgradeat:<n>                       index: programs whose new code activates when block n is created  [id…] (deleted on activation)
<id>:codeversion:<n>                code version n  { version, code, blockNumber, timestamp } (only programs that were upgraded)
```
`pending-upgrade:` / `scheduled-upgrade:` use a hyphen so they don't mix with `pending:` (the deploy approval queue is counted by the `pending:` prefix)

### Phase 4: Merkle trie · pruning · snapshot (tests `96-trie` `97-phase4` `98-phase4-server`)
⚠️ **Changes how block hashes are computed → the old chain must be reset** (old LMDB data opens, but new blocks cannot follow old headers · cannot sync with old-version nodes)
- **stateRoot = root of an Ethereum-style Merkle Patricia Trie of the whole state** (`src/core/trie.js` · matches geth's vectors byte-for-byte)
  Trie key = keccak256(dbKey) · value = utf8(canonicalJson(value)) · state = `isStateKey(dbKey)` (not block / history / index / historyfrom / genesis / trie)
  Nodes are stored at `trie:<nibble path>`, **only the latest trie** (overwritten in place · removed nodes are deleted, path-based like geth) → does not grow with block count
  `vm.commit(writes)` always updates the trie in the same commit (genesis / block / rebuild) · Block computes it once at `hashes()` and commit reuses that set (DB modified in between = `trieStale`)
  A DB with state but no trie (pre-phase 4) → `rebuildTrie()` runs automatically the first time · `vm.stateRoot()` = the current root
- The header has **`writesRoot`** = hash of the block's state writes (sorted by key · like the old stateRoot but not chained) · `parentStateRoot` is still in the header but no longer part of the hash
  `replayBlock` of an old block cannot compute the trie of that time → uses the `stateRoot` from the original header (`createBlock({ stateRoot })`) and verifies execution with writesRoot / receiptsRoot
  `vm.hashHeader(header)` recomputes the hash from the header fields (`headerFields` in `encoding.js` · the SDK uses the same one)
- **Proofs**: `vm.getProof([dbKey])` → `{ blockNumber, blockHash, stateRoot, proofs: [{ dbKey, value, proof }] }` (missing key = absence can be proven)
  `GET /proof?key=…&key=…` · `/evm` `cardianal_getProof([dbKey | { program, key }])` · `eth_getProof` = error (the state is not an EVM account trie)
  Client side: `verifyProof(root, dbKey, proof)` · `client.verifiedState(keys, { producers })` verifies the header hash + producer signature + proof, no need to trust the node
- **pruning** (`historyKeep` / `HISTORY_KEEP_BLOCKS=N`): after every block commit, deletes `history:` + `blockundo:` of blocks older than N blocks (≤ 50,000 keys at a time) · `historyfrom` moves accordingly
  Historical state / `replayBlock` / `/block/:n?full=1` / block-based eth_* only work for the latest N blocks · `rebuildFrom` is unavailable (needs history from block 1) · headers / bodies are kept in full (can sync other nodes)
  Not part of the hash → can differ per machine · keep at least 1 machine as archive (unset) for the explorer / rebuild
- **snapshot** (`src/node/snapshot.js`): gzip JSON lines file = manifest + the latest 256 block headers (BlockHash · base fee) + `[dbKey, value]` of the state as of block N
  `writeSnapshot(vm, file)` doesn't stop the chain (reads in batches · blocks sealed meanwhile read values as of N from history) · `SNAPSHOT_EVERY=N` takes them automatically → `GET /snapshot` (manifest) · `GET /snapshot/<N>` (file)
  `loadSnapshot(vm, lines, { producers })` (DB with no blocks yet): every header hash must recompute · chain together · be producer-signed → builds the trie from the state, which must match header N's stateRoot (mismatch = wipe the state and throw)
  After loading: `historyfrom` = N + 1 · no bodies before N · `startSync({ snapshot: true })` = empty DB → loads the source's `/snapshot` first then keeps syncing · CLI `npm run snapshot -- export|import|verify`
- **Speed** (test machine · LMDB · keccak is noble's pure JS, ~28µs per 500-byte node · Node has no native keccak)
  Load test 500 tx (close + roots p50 vs. pre-phase 4): native 355 vs 242 ms · token 909 vs 812 ms · mix 1186 vs 1260 ms · DB grows an extra ~700–900 bytes per tx
  1 million state keys: `rebuildTrie` 65 seconds (sort keys then build at once, `buildTrie`) · a block touching 4,000 keys = trieUpdate ~0.8–1.5 seconds + commit ~0.45 seconds · proof ~2.6 KB
  Nodes are stored in the DB as bytes (LMDB compresses values > ~1000 bytes, which makes hex slow) · updates don't verify the hashes of nodes read (`proof()` always does · `new StateTrie({ verify: true })` if needed)

**Balance = received − sended − consumed** (`consumed` = gas paid); there is no key storing the net balance
Designed so every value only grows in one direction, so unrelated txs don't contend for the same key

### Chain / indexes
```
block:<n>              header (n zero-padded to 12 digits in every key containing a block number)
blockbody:<n>          every raw tx [{ action, method, request }] → replay can rebuild the whole state
blockundo:<n>          list of state keys that block touched (indexes excluded)
blockhash:<hash>       hash → block number
latestblock            latest block number
tx:<vmhash>            { hash, digest, blockNumber, index, action, status, from, nonce }
sigtx:<digest>         EIP-712 digest → vm hash (lets you search by the hash the user signed)
txto:<addr>:<n>:<idx>:<callIdx>    index of "who interacted with this address" (the value doesn't store blockNumber / index / timestamp · `readTransactionTo` fills them from the key + header)
event:<program>:<name>:<n>:<idx>:<i>   event index
eventidx:<program>:<name>:<field>:<topic>:<n>:<idx>:<i>   index of fields emitted as indexed → the event's dbKey
eventsig:<topic0>:<program>:<name>     EVM-style topic0 → { program, name, indexed } (eth_getLogs)
holding:<addr>:<program>   index of "this address has received/sent this program's tokens", from Transfer events (from/to) of successful txs · requires recordBlocks
history:<dbKey>:<n>    the value **before** the change { existed: false } or { existed: true, before } (pruning deletes those of blocks older than HISTORY_KEEP_BLOCKS)
trie:<nibbles>         Merkle trie nodes of the latest state (RLP as bytes · old hex ones are still readable · path from the root · "trie:" = root) — stateRoot of the latest block
0x000…000:native:received    total burned coins
```

`txto` with `callIdx > 0` is a nested call via `runProgram` and additionally has `depth` + `via`
(this is what lets the explorer see that a token was `transferFrom`'d by a marketplace)

`history:` is designed so `stateAt(block, key)` works with a single seek:
find the first `history:<key>:<n'>` with `n' > block`; none = the current value, found = that entry's `before` value
→ no need to walk back block by block. **The chain's own data (blocks/indexes) keeps no history** because it can be rebuilt from bodies
(indexes = `isIndexKey`: tx / txn / txto / sigtx / event / eventidx / eventsig / holding / rejtx / rejfrom / blockrejected · nobody reads them during tx execution · `snapshotAt` doesn't return indexes)

`<addr>:txn:<nonce>:<hash>` doesn't store signature / digest: signatures are in `blockbody` (`vm.transactionSignature` · `getTransaction(hash, { signature: true })` · `/tx/:hash` · `/tx/:hash/receipt` · eth_getTransactionByHash v r s) · the digest is in `tx:` (`readTransactionRecord` fills it into a wallet's tx list)

`maxKeySize: 1000` is set because `history:` has to nest keys as a prefix

Real sizes: a full block of 100 txs ≈ 190 KB / 664 keys

---

## 6. Signatures (EIP-712)

```js
import { signTransaction, verifyTransaction, buildTypedData, hashTypedData, addressOf } from "programvm/signature.js";

const tx = { chainId: 41234, action: "call", from, to: program, method: "transfer",
             input: { to: bob, amount: "100n" }, value: 0, nonce, gasLimit: 500000, gasPrice: "20000000000000" };   // 20,000 gwei (chain minimum is 10,000 gwei)
const signature = signTransaction(tx, privateKey);       // wallet side
const { action, method, sender, hash, request } = verifyTransaction({ tx, signature });  // server side
vm[method](request);
```

- domain `{ name: "Bluewolfchain", version: "2" }` (**no chainId** → MetaMask can sign whichever chain the wallet is on, no need to add this chain · MetaMask requires the domain chainId to match the active chain)
- Signed fields, **order must not change**: `chainId, action, from, to, method, input, value, nonce, gasLimit, gasPrice, signedOnChainId`
  · `chainId` = this chain (41234) → **the mempool rejects mismatched chainIds** (`tx chainId (X) does not match the chain (Y)`) = prevents cross-chain replay · an EIP-712 message signature is not an EVM tx, so it cannot be submitted on other chains
  · `signedOnChainId` = the chain the wallet was on when signing (the explorer fills it from `eth_chainId` · omitted = chainId) → the receipt has `signedOnChainId` · the tx page shows "Signed on" · a value the web page sets itself, not proof · txs from `eth_sendRawTransaction` = the tx's chainId
  · EIP-1559 txs (with `maxFeePerGas` or `maxPriorityFeePerGas`) use `TRANSACTION_TYPE_1559` = the same set without `gasPrice`, followed by `maxFeePerGas, maxPriorityFeePerGas` (before `signedOnChainId`)
  · the explorer shows the amount + estimated gas before opening the wallet popup (`estimateCost` in `explorerscan/core/wallet.js`: call = gas from `/query` + `gas.tx`) because a wallet on another chain doesn't know the BWSC balance · insufficient balance = the wallet is not called
  · token permits (EIP-2612) still have chainId in the domain per the standard → the wallet must be on this chain when signing a permit · sending gasPrice (≠ 0) together with the two new fields = rejected · `maxFeePerGas: 0` = unspecified
- `input` and `code` are folded into a single string with `canonicalJson({ input, code })` → any data type can be signed
- Accepted `action`s: `call` `deploy` `transfer` `metadata` `init` `reject` `upgrade` `setUpgrader` `initUpgrade` `rejectUpgrade` `setGasConfig` (admin · section 4 "Gas")
  → `VM_METHOD` maps them to VM methods (`metadata` → `setMetadata` · the rest have the same name)
  - `upgrade`: `to` = program · `code` = new code · `input` = migrateInput · `setUpgrader`: `input = { upgrader: "0x…" | null }`
  - `deploy` may add an `upgrader` field → folded into the signed string as `canonicalJson({ input, code, upgrader })`
    **Not sent = the key is absent** → every existing tx / signature keeps the same digest (likewise in the VM hash)
- `sender` comes **only** from recovering the signature; `tx.from` is used only for comparison
- **Gas sponsor (paymaster / fee payer · test `93-paymaster`)**: `tx.sponsor` = address → appends a `sponsor` (address) field to the end of the type (legacy or 1559 · no sponsor = byte-identical digest)
  `/sendtx { tx, signature, sponsorSignature }` · `sponsorSignature` = the sponsor signs **the same digest** (sees the whole tx before agreeing to pay) · the sender cannot change the sponsor because it is in the data they signed
  VM: `request.sponsor` is in the hash (`feeFields`) · the sender uses their own nonce + pays the value themselves · gas is deducted from the sponsor (`tx.payer.sponsor`) · receipt / explorer show `sponsor` ("Gas paid by")
  The VM trusts `request.sponsor` (its signature is checked on mempool entry like the sender's · sync trusts the producer who signed the block) · if you use the VM directly you must check it yourself
- **Client-side SDK** (`client-sdk/index.js` = `programvm/client` · test `92-sdk`): does not import VM / sandbox / node:* (works in the browser · shared helpers moved to `src/core/encoding.js`)
  `createClient({ url })` → `send(fields, signer, { sponsor? })` (fills chainId / from / nonce / 1559 gas itself) · `prepare` · `submit` · `wait(hash)` (follows replacements) · `query` · `balance` · `abi` · `receipt`
  signer: `keySigner(key)` · `walletSigner(window.ethereum)` (eth_signTypedData_v4 with `walletTypedData` = uint256 fields as plain decimal, because wallets can't read `"5n"`)

### A tx has 2 hashes, both searchable
| | Comes from | Used for |
|---|---|---|
| `hash` | computed by the VM from the request | DB key, the block's `txHashes` |
| `digest` | the EIP-712 data the user signed | what the wallet shows the user — **show this one as the tx id** |

`GET /tx/:x` and `vm.getTransaction(x)` accept both (via `sigtx:`)

---

## 7. HTTP API (server.js)

Every response is JSON · BigInt is serialized as `"123n"` · CORS wide open (`*`)
`limit` at most 200 (default 20) · **detailed response formats are in `EXPLORER-SPEC.md` section 4**

### Read
| endpoint | Returns |
|---|---|
| `GET /genesis` | `{ hash, chainId, latest, pending, gasPrice, decimals, minBaseFee, genesisMinBaseFee, gasConfig, gas, admins, baseFee, gasTarget, maxBlockGas, burnPercent, burned, forks, producer, role, producers, baseProducers, producerSchedule }` — the explorer polls it every 2 s · `baseFee` = the next block's |
| `GET /blocks?before&limit` | past headers |
| `GET /block/latest` | latest header |
| `GET /block/:n` | header · `?full=1` → `replayBlock()` full receipt (409 if the hash doesn't match) |
| `GET /tx/:hashOrDigest` | index + `record` · in the queue → `{ status: "pending" }` · replaced → `{ status: "replaced", hash, replacedBy }` (hash only, digest not accepted) · rejected → `{ status: "rejected", block, blockNumber, index, reason, code, stage, sender, nonce, action, to, gasPrice, timestamp }` (`block: null` = waiting for the next block) |
| `GET /rejected?address&limit&cursor` · `GET /address/:a/rejected` | rejected txs, newest first `{ items, next }` · no address = whole chain (scans ≤ 1,000 blocks per request) |
| `GET /tx/:hash/receipt` | receipt from replaying that block + `blockNumber` |
| `GET /address/:a` | native, nonce, metadata, isProgram, transactions, incoming |
| `GET /program/:a` | code, context, metadata, native, storage (first 50), interactions, events, `token` (null if not a standard token), `collection` (`{ address, standard: "ERC-721" \| "ERC-1155", name, symbol, totalSupply? }` · null if not NFT / multi-token), `pendingUpgrade` / `scheduledUpgrade` (null if none) |
| `GET /program/:a/versions` | every code version `[{ version, code, blockNumber, timestamp }]` (empty = never upgraded) |
| `GET /address/:a/tokens` | tokens held `[{ address, name, ticker, decimals, totalSupply, balance }]` · zero balances hidden |
| `GET /address/:a/nfts` | NFTs / multi-tokens held `[{ program, standard, name, symbol, tokenId, amount, uri }]` (max 200) · programs from the `holding:` index · items from `owned:<a>:<id>` (ERC-721) / `balances:<a>:<id>` (ERC-1155) · zero balances hidden |
| `GET /token/:a` | `{ address, name, ticker, decimals, totalSupply }` · 404 if not a token |
| `GET /program/:a/storage?prefix&start&limit` | `{ items, next, prefix }` — cursor pagination |
| `GET /program/:a/groups?scan&cursor` | counts keys by first key name **in ranges**: `scan` keys per request (default 20,000 · max 50,000) → `{ total, groups, scanned, next, complete }` · `next` not null → send `cursor=next` and add up the results yourself (counts every key) |
| `GET /program/:a/interactions?limit&cursor` · `/program/:a/events?cursor=` · `/address/:a/incoming?cursor=` | cursor-based (like the storage tab) `{ items, next }`, reads only limit + 1 keys, no full count, no 50,000 cap · no `cursor` = the old page-number mode |
| `GET /nonce/:a` | next nonce **including queued txs** — use this when building a tx |
| `GET /name/:ns` | namespace → address |
| `GET /state/:a?block` | program state as of that block (`snapshotAt`) · `&limit=&cursor=` → `{ items, next }` (`pageSnapshotAt`) · block not reachable → 409 |
| `GET /proof?key=<dbKey>&key=…` | Merkle proof of keys in the latest state `{ blockNumber, blockHash, stateRoot, proofs: [{ dbKey, value, proof }] }` (1–100 keys) · verify with `verifyProof` / `client.verifiedState` |
| `GET /snapshot` · `GET /snapshot/:n` | manifest of the latest snapshot `{ number, hash, stateRoot, size, file }` · gzip file (requires `SNAPSHOT_EVERY` · none = 404) |
| `GET /health` | `{ ok, problems, latest, latestAt, blockAgeMs, blockMs, historyFrom, pending, rejectedPending, role, producer, miner, follow, db: { usedBytes, mapSize, usedPercent } }` (db = null if no `DATA`) · any problem = 503 (see section 1 "Launching a real network") · `usedPercent` near 100 = raise `LMDB_MAP_SIZE` before the chain stops |
| `GET /events?program&name&limit` | event |
| `GET /pending` | `{ size, transactions, rejectedPending }` (`rejectedPending` = rejected txs waiting to be recorded in a block) |
| `GET /programs` | `{ approved, pending }` counts of approved programs (with `<address>:this`) / awaiting approval (`pending:<address>`) · no aggregate index, so it scans 1 key per address (`approvedProgramAddresses`) |
| `GET /programs/pending` · `/programs/approved` | paginated `?page=&limit=` → `{ items: [{ address, name, deployer \| creator, createdAt, value, codeSize, token, collection? }], total, pages }` (`collection` = `"ERC-721"` / `"ERC-1155"`, only for NFT / multi-token → shown as NFT / Multi-token) · explorer page `#programs` (opened from the box on the home page) |
| `GET /sync?from` | `[{ header, body, rejected }]` up to 50 blocks — for reader nodes to pull |

**Paginated** (the explorer uses this for every long list) · `?page=<from 1>&limit=<≤100, default 20>` → `{ items, total, page, pages, limit, truncated }`
A page past the last → returns the last page · counts at most 50,000 keys per list (`PAGE_SCAN`), beyond that `truncated: true`
Code lives in `src/node/explorer-api.js` (`pageOf` `slicePage` `page*`) · test `49-explorer-paging`

| endpoint | List |
|---|---|
| `GET /blocks/page` | headers, newest first (computed from block numbers, no key scan) |
| `GET /address/:a/txs` | txs sent by the address · **ordered by nonce number** (`txn` keys are not zero-padded, so lexical order goes wrong from nonce 10) |
| `GET /address/:a/incoming` | incoming txs (`txto:` index including nested calls · nested rows have `status` = result of that call level and `txStatus` = result of the whole tx) |
| `GET /program/:a/events?name` | events, newest first · `&<field>=<value>` (requires name) = cursor-based search by the indexed index |
| `GET /program/:a/abi` | `{ address, abi, evmAbi }` (not declared = null) |
| `GET /program/:a/entries?name` | 2-level keys of group `name` (skips 3-level keys) |
| `GET /token/:a/holders` | holders from the program's `balances:<address>` · skips zero balances · largest first · 404 if not a token |

**trace in receipts** (`/tx/:h/receipt` → `trace[]`): `{ depth, program, method, from, origin, input, value, result, gasUsed, status, error }`
`input` / `value` / `result` / `gasUsed` were added on Oct 9 (kept in `tx.calls` during execution, not written to the DB and not part of the block hash)
The outer level's `gasUsed` includes the inner levels · server error messages are English (VM execution error messages in `src/core/` stay in Thai because they are part of consensus)
`type: "create"` appears only on entries that created a program with `cloneProgram` (plain calls have no such field) · the tx page shows "Create #n" + a CREATE tag · `/evm`'s callTracer shows it as a `CREATE` frame
| `GET /` or `/explorer` | the explorer page |

### Write
```
POST /sendtx   { tx, signature, sponsorSignature? }   signatures are verified in a worker thread (src/node/verify-pool.js · test 90 · ~2.4 ms/tx → 3 workers ~2.8× faster)
  200 → { queued: true, hash, sender, simulation }
  400 → { queued: false, error | issues | simulation }      bad signature / autoreview failed / simulate failed / queue refused

POST /query    { programUuid, functionName, input, context?, value? }
  200 → { status: "success", result, gasUsed, events, calls, loadValues, afterValues, readOnly: true }
  400 → results whose status is not success
```

`/sendtx` **always returns the error before queueing** if simulate fails (users don't waste time waiting for a tx that will certainly fail)
`simulate` runs on the DB's current state without the effects of queued txs → an "estimate", not a guarantee

### `/evm` — adapter for wallets / EVM tools / Blockscout (`src/node/evm-rpc.js` + `evm-ws.js` · tests `50-evm-rpc` `51-evm-ws` + e2e)
Reads the existing data and answers as EVM-style JSON-RPC 2.0 (MetaMask / ethers / viem / Blockscout can connect) · the only write path: `eth_sendRawTransaction` through the same intake as `/sendtx` (the server's `submit`)
```
POST /evm                      JSON-RPC 2.0 (supports batches) · separate rate limit EVM_RATE_LIMIT (default 600/min/IP · 0 = unlimited, for indexers)
ws://host/evm                  same as POST + eth_subscribe("newHeads" | "logs" | "newPendingTransactions") / eth_unsubscribe (checks for new blocks every 1 second, only while someone is subscribed)
GET  /evm                      values for wallet_addEthereumChain { chainId, chainName, nativeCurrency, rpcUrls, blockExplorerUrls }
GET  /evm/explorer/{tx|address|token|block}/:id   302 → /#tx/… (EIP-3091 · block accepts both number and hash · the wallet's "view in explorer" links)
GET  /evm/explorer                                302 → / (explorer URL registered in chainlist · ethereum-lists CI actually opens it)
```
- Supported (`rpc.methods`): `eth_chainId` `net_version` `eth_blockNumber` `eth_getBalance` `eth_getTransactionCount` `eth_getCode` `eth_gasPrice`
  `eth_maxPriorityFeePerGas` `eth_feeHistory` `cardianal_getAbi` `cardianal_getProof` (`eth_getProof` = an error pointing to this one)
  `eth_getBlockByNumber/ByHash` `eth_getBlockReceipts` `eth_getTransactionByHash` `…ByBlockNumberAndIndex` `…ByBlockHashAndIndex` `eth_getTransactionReceipt`
  `eth_getLogs` (range at most 1000 blocks) `eth_call` (ERC-20 / ERC-721 / ERC-1155 + programs with `metadata.abi`) `eth_estimateGas` `eth_sendRawTransaction`
  `debug_traceTransaction` `debug_traceBlockByNumber` `debug_traceBlockByHash` (only `{ tracer: "callTracer" }`) `txpool_content` `txpool_inspect` `txpool_status`
  `eth_newFilter` `eth_newBlockFilter` `eth_newPendingTransactionFilter` `eth_getFilterChanges` `eth_getFilterLogs` `eth_uninstallFilter` `eth_createAccessList` `eth_simulateV1` (see below) etc. · the full list = `METHODS` in `evm-rpc.js`
- **Historical block tags** (`eth_getBalance` / `eth_getTransactionCount` / `eth_getCode` / `eth_call`) read from the chain history with `vm.stateAt(n, key)`
  (requires `recordHistory`, which the server enables) · historical `eth_call` runs `vm.query` on the state as of that block (`options.read`) · a block that doesn't exist yet → error `header not found`
- `vm.replayBlock` results are cached for 64 blocks (key = number + hash) → every receipt / `logIndex` (continuous across the block) / `cumulativeGasUsed` come from a single replay
- The chain already stores native in wei → `EVM_DECIMALS` default 0 (no multiplication) · `nativeCurrency.decimals` = always 18 · `eth_gasPrice` = next block's base fee + suggested tip (`eth_maxPriorityFeePerGas` = median tip of the latest 20 blocks)
  · geth-style `eth_feeHistory` (≤ 1024 blocks · baseFeePerGas includes a slot for the next block · reward by gas-weighted percentile) · blocks have `baseFeePerGas`
  · 1559 txs / receipts = `type 0x2` + `maxFeePerGas` `maxPriorityFeePerGas` `accessList: []` · `gasPrice` / `effectiveGasPrice` = the effective price
- timestamp ÷ 1000 · block 0 = genesis (`vm.genesisHash()`, time = block 1's time) · `gasLimit` = `vm.maxBlockGas` (unset → 30M)
- status `0x1/0x0` · `contractAddress` = the deploy's programUuid · the block's `logsBloom` / `receiptsRoot` come from the header · a receipt's are computed from its logs
- Logs come from the VM's `eventLog(event)` (no state reads): events emitted with indexed → topic0 = keccak of the signature + topics of the indexed fields + ABI data
  (standard tokens → exact ERC-20 logs) · other events → topic0 = keccak(name), data = JSON as hex
- Standard NFTs (`checkNftStandard`) → ERC-721-style `Transfer` with 4 topics (from, to, **tokenId indexed**, data `0x`) + `Approval(address,address,uint256)` + `ApprovalForAll(address,address,bool)`
  Standard multi-tokens (`checkMultiTokenStandard`) → ERC-1155-style `TransferSingle` (data = id, value) / `TransferBatch` (data = ABI `uint256[]` × 2) / `ApprovalForAll` / `URI`
  Blockscout distinguishes ERC-20 / ERC-721 by the number of Transfer topics and recognizes ERC-1155 by TransferSingle / Batch · verified with ethers `Interface.parseLog` in test `66-evm-nft-logs`
- NFT `eth_call`: `name symbol totalSupply balanceOf ownerOf tokenURI getApproved isApprovedForAll supportsInterface` · multi-token: `name symbol balanceOf(address,uint256) uri totalSupply(uint256) isApprovedForAll supportsInterface`
- tx `input` = JSON `{action, method, input}` as hex (not ABI) · `eth_getCode` = the program's JS source as UTF-8 hex (wallets → `0x`)
- callTracer: root = tx (`CREATE` for deploys), `calls[]` = nested trace by depth · native transferred by programs with `transferNative` (not in the trace)
  is derived from `nativeChanges` after subtracting every level's value and the fees (consumed → zero address / feeRecipient) → a `CALL` from that program to the recipient · gas fees are not internal txs
- txpool: from `mempool.list()` (no to / value because the mempool doesn't expose them)
- **ABIs of the bundled programs** (`src/standards/system-abi.js` + `src/standards/abi/*.js` · test `118-system-abi`): the node supplies the ABI itself when the on-chain code matches a bundled program character for character (not stored on-chain · the ABI can be fixed in the next node version · clones such as trading pairs / multisigs get it too, at no gas) · used everywhere ABIs are read: `eth_call` / `eth_sendRawTransaction` / `cardianal_getAbi` / `GET /program/:a/abi` / `metadata` of `/program` `/address` (explorer)
  Limitations: lists / objects are passed as JSON strings (BigInt as `"123n"`) · optional inputs must always be sent (see the description in the ABI) · events emitted without indexed (the pair's `Sync` · multisig's `ThresholdChanged` / `HashApproved`) cannot be decoded by ethers · nft-market paid with a token: the `Listed` / `Sold` / `OfferMade` logs have payToken typed as address, so they don't match the ABI (the ABI uses the native-coin variant)
- **`eth_call` via `metadata.abi`** (`src/node/evm-abi.js` · test `91-evm-abi-call`): after ERC-20 / 721 / 1155 of standard programs → selector = keccak("name(type,…)") per `toEvmAbi` · decodes arguments Solidity-style (uint / int → `"123n"` · lowercase address · bytes → `"0x…"` · object / array / any = JSON string, parsed for you)
  → `vm.query` (from = `context.sender`) → encodes the result per outputs (multiple = an array in order or an object by name · no outputs = `0x`) · undecodable / program throws = `execution reverted: …`
- **`eth_sendRawTransaction`** (`src/node/evm-raw.js` · test `94-evm-send-raw` uses ethers JsonRpcProvider + Wallet like Hardhat / dApps)
  Accepts legacy with chainId (EIP-155) and type 2 (empty accessList) · rejects: no chainId · mismatched chainId · type 1 / 3 / 4 · bytecode deploys (empty `to`) · data to a non-program address · high s (EIP-2)
  Mapping: not a program + empty data → `transfer` · standard token + ERC-20 `transfer` / `approve` / `transferFrom` → the token's functions · otherwise → functions per `metadata.abi` (writes allowed)
  The request stores `digest = keccak(raw)` + `evmRaw` (the whole raw tx is in the block body and can be re-verified) · `/tx/:hash` · receipt · getTransactionByHash answer with the Ethereum hash (`evmHash` in the receipt) · nonce shares the counter with EIP-712 txs
- `eth_estimateGas`: native transfer = 21000 (what wallets expect · you pay what is actually used · the `bluewolf` fork actually uses 17,300) · program calls = simulated with `vm.query` × 1.25 + 1000 + `gas.tx` · failure = `execution reverted`
- **Filters over HTTP** (tests `115-evm-filters-simulate` · `116-ethers-filters` use real ethers `contract.on` / `provider.on("pending")`):
  `eth_newFilter` / `eth_newBlockFilter` / `eth_newPendingTransactionFilter` → `eth_getFilterChanges` (new items since the last call) · `eth_getFilterLogs` · `eth_uninstallFilter`
  Kept in memory (restart = lost → `filter not found`) · not polled for 5 minutes = deleted · at most 10,000 per node / 100 per IP · log filters scan at most 1,000 blocks per call
  pending gets hashes from `mempool.onAdded` (up to 10,000 buffered) · ws: `eth_subscribe("newPendingTransactions"[, true])` pushes as soon as a tx is queued
- `eth_createAccessList` → `accessList: []` + `gasUsed` = `eth_estimateGas` (the chain has no access lists)
- `eth_simulateV1`: 1 blockStateCalls set (≤ 100 calls) · calls run in sequence on a simulated next block (no commit) → status / returnData / gasUsed / logs per call
  Does not accept stateOverrides / blockOverrides / old blocks · charges gas like a real tx · simulated block / tx hashes = 0x00…
- Not supported: `eth_getStorageAt`, `eth_getProof`, `trace_*`, `eth_call` on non-standard programs without an ABI, `balanceOfBatch` via eth_call · non-full block tx lists still use the internal hash for txs from wallets
- chainId comes from the chain's genesis / `CHAIN_ID` (default + in-repo `genesis.json` = 41234) · testing with real MetaMask: `docs/metamask-checklist.md`
- Blockscout: `ETHEREUM_JSONRPC_VARIANT=geth` · `ETHEREUM_JSONRPC_HTTP_URL` / `ETHEREUM_JSONRPC_TRACE_URL` = `http://host/evm` · `ETHEREUM_JSONRPC_WS_URL=ws://host/evm`
  · `INDEXER_INTERNAL_TRANSACTIONS_TRACER_TYPE=call_tracer` · `INDEXER_DISABLE_BLOCK_REWARD_FETCHER=true` · chain side `EVM_RATE_LIMIT=0`
  · Blockscout 9.x additionally needs `ETHEREUM_JSONRPC_HTTP_REQUEST_COMPRESSION_HEAVY_METHODS_ENABLED=false` (/evm doesn't read gzip) · full steps + start/stop + troubleshooting: `docs/blockscout.md`
  · request sniffer for /evm: `node dev/evm-proxy.mjs` (:3001 → :3000/evm)

---

## 8. Explorer (`explorerscan/`)

The `explorerscan/` folder splits files by role (structure + which parts are editable / which are core logic: `explorerscan/README.md`). **The whole page is in English** (e2e tests check there are no Thai characters except user data). No build step, no framework, no external dependencies
Plain HTML + CSS + JS (scripts, not modules · load order in `index.html` matters) · `server.js` serves `/explorerscan/*` and `GET /` (index.html + `<base href="/explorerscan/">`) · `EXPLORER_DIR` = use a forked folder you customized · can be hosted separately (`config.js` → `api`)
- The **Add network** button (`addNetwork()` in `core/wallet.js`) sends `GET /evm` to `wallet_addEthereumChain`

### Structure
- Routing via `location.hash` → `render(soft)` dispatches to `home()` / `block(n)` / `tx(h)` / `address(a)`
  `soft` = redraw in place (page / tab change), no Loading shown, scroll position kept
  Every render has a sequence number (`renderSeq`) — only the latest render may draw (prevents a slow-loading old page from overwriting the new one)
- `cut()` shortens addresses / hashes to `0x1234…abcd` (first 4 and last 4) in tables · detail pages show them in full with `full()` (wrapping on small screens)
- Pagination: `pager(res, "setPage('id',$)")` under every long list → page-number buttons (first / last / ±2 around the current page) + ‹ › + a Go to box
  `pageState[hash|id]` remembers the page number per explorer page and per list · lists that arrive in full (txs in a block, tokens held) are paginated in the browser (`slicePage`)
- Small helpers: `esc` `cut` `num` `when` `ago` `utc` `age` `copy` `addr` `txLink` `panel` `table` `kv`
- Every "… ago" time uses `age(t)` (or `utc(t)` appended): a small `YYYY-MM-DD HH:MM:SS UTC` line below · at ≤720px seconds are hidden (`.utc .sec`)
  **`num()` converts `"123n"` → a readable number — every value coming from a program must go through it**
- Theme: a single dark navy / indigo theme (`color-scheme:dark`) · all colors are in `explorerscan/theme/colors.css` (`--bg:#060914` `--panel:#0f1530` `--accent:#a5b4fc` `--accent-2:#818cf8` `--violet:#4f52d6`) · background gradient #17204a → #070a17 + faint grid lines · left sidebar (mobile = drawer, ☰ button `#menu-btn`)
  Selected tab / primary button = `--violet` · cards have a small label on top · JSON / code / result boxes = `#04050d` · details in EXPLORER-SPEC.md item 9
- Responsive down to 180px wide (the e2e "responsive" test measures 180/240/360/768/1280 for nothing overflowing or clipped)
  - `table()` is wrapped in `.twrap` (tables wider than the screen → scroll inside the frame, not the whole page) and gets class `grid`
  - ≤640px: `.grid` tables become one card per row · `labelCells()` sets `data-label` from the table headers + wraps values in `.cv` (called in `el()` and `drawStorage()`)
    Headers containing a `<select>` (storage dropdown) still show · `kv` tables stack the name above the value · tabs wrap instead of scrolling sideways · the header is not sticky
  - ≤360px: column names above values, 8px margins, search box / wallet button full width
  - Self-check: open every page and look for elements extending beyond `.panel` without a scroll frame (see the code in the e2e test)
- Every address / hash is clickable + has a copy button (`⧉`)
- Polls `/genesis` every 2 seconds, updating the block number and queue size in the header

### Address / program pages — tabs
`tabs(groups)` + `tabState[location.hash]` remember the selected tab per URL

| Tab (`data-tab`) | Content |
|---|---|
| Events (`event`) / ABI (`abi`) | events decoded per `metadata.abi` (name + type + indexed tag · `eventData()`) · the ABI tab exists only for programs that declare one (`abiView()`) |
| Tokens (`tokens`) | (only wallets holding tokens · first tab) ticker, balance divided by 10^decimals |
| NFTs (`nfts`) | (only addresses holding NFTs / multi-tokens) collection, ERC-721 / ERC-1155, token ID, amount, URI (http(s) as links · ipfs:// etc. as text) · `/address/:a/nfts` |
| Holders (`holders`) | (token programs only) rank, address, balance, % of supply · `/token/:a/holders`, 25 at a time |
| Calls / Incoming (`in`) | `/address/:a/incoming` (including nested, with a "Nested · depth N" badge) · the Status column = status of the whole tx (matches the tx page) · nested calls that failed but were caught by an upper level get an orange "⚠ caught" warning appended · old data without `txStatus` uses `status` instead (the chain must be reset to be correct) |
| Outgoing (`out`) | `/address/:a/txs` |
| Interact (`interact`) | (programs) form — choose a function, input JSON, value |
| Permit (`permit`) | (tokens whose code has `permit` + `nonces` + `eip712Digest(`) form for spender / value (token units per decimals) / deadline (unix seconds, default +1 h) → `eth_signTypedData_v4` (domain `{ name, "1", chainId from /genesis, verifyingContract }`) · Sign permit button (shows the signature `#permit-signature` + the permit input + typed data) · Sign & submit (re-signs with the current nonce, then sends `permit` as a tx → `#permit-out` + `#permit-allowance`) |
| Edit metadata (`meta`) | (wallets) metadata edit form, in the same bar as Interact (previously a button in the information row) |
| Events (`event`) | `/program/:a/events` |
| Storage (`storage`) | split by key depth: Variables / Maps / Lookup (see below) |
| Code (`code`) | source |

Clicking the already-open tab does not redraw (values typed in forms are kept)

The program info box has a **Version** row (`metadata.version`, missing = 1 · with an "Upgrade pending review" / "Upgrade active from block N" tag from `pendingUpgrade` / `scheduledUpgrade`)
**Upgrader** (none = "None (immutable)") and **Template** (only programs created with `cloneProgram`)
Action names in every table / tx page go through `ACTION_LABELS`: `upgrade` → "Upgrade", `setUpgrader` → "Set upgrader", `initUpgrade` → "Approve upgrade", `rejectUpgrade` → "Reject upgrade", `create` → "Create" (the rest show their original name)

### Block / tx pages — EIP-1559 gas
- block: `Base fee` (+ whether the next block goes up / down, comparing gasUsed with target · `baseFeeTrend()`) · `Fee split` burned / block sealer
- tx: `Gas price` = base fee + tip · `Fee limits` (tag EIP-1559 · max fee / max tip) · `Fee split` (`feeRows()`)

### Tx page — Return value / Balance changes
The "Return value" row = the program's full return value, displayed the same way as Read results in Interact (`returnValue()` is shared) · failed txs show "— (failed)"
Balance changes = one line per field: address · received / sent / gas paid · +/− change · new total
The change comes from `before` in `nativeChanges`, which `block.receipt()` fills in (the value before that tx, chained through the block · not part of the block hash)

### Tx page — Program calls
`traceView()` is a compact diagram: one small box per call containing only its sequence number (red border = that call failed · tooltip = program.method())
Laid out as a top-down tree: one row per depth · callees sit under their caller, siblings left→right in order of occurrence · one column per leaf (`slot`), callers centered above their first and last child
The diagram is centered in its frame horizontally and vertically · the top "tx" box (dashed) = the tx sender · SVG arrows from caller → callee (red when that call failed)
Each call's caller = the previous call that is 1 level shallower (`traceParents()`, because the trace comes depth-first)
Clicking a box → `pickCall(i)` shows that call's details below the diagram (`callDetail`: caller → program.method(), gas, value, origin, Input, Result/Error) · the page opens showing #1
Box size follows screen width (`flowSize()`: 28px boxes, 40px columns, 46px rows / ≤260px = 24 / 32 / 40)
Wide screens: the diagram on the left (at most 40% of the width · taller than 70vh scrolls in its frame), details on the right exactly as tall as the diagram (`.calls-body` stretch + `contain:size` on `#call-detail`; longer content scrolls inside the box · rows at least 200px tall) · at ≤720px they stack top-bottom, and diagrams wider than the screen scroll sideways inside the `.flowwrap` frame
Namespace names (shown in details and tooltips) are fetched from `/address/:a?limit=1` for every address in the trace (at most 30) when the tx page opens

### The program "data" tab
Keys are split by depth (`src/node/explorer-api.js` · test `47-explorer-storage`)

| Sub-tab | key | Shows | API |
|---|---|---|---|
| Variables (`info`) | 1 level (`owner`, `price`) | every one with its value | `/program/:a/layout` → `variables` |
| Maps (`storage`) | 2 levels (`balances:<address>`) | a first-key dropdown in the table's first column header → lists second keys + values, 25 at a time with page numbers | `/program/:a/entries?name=&page=` |
| Lookup (`get`) | 3+ levels (`allow:<a>:<b>`) | no list · vertical form: key 1 dropdown, key 2, 3… one per line · `+ key` / `− key` → reads one at a time | `/program/:a/get?key=…&key=…` |

- `layout` scans at most 20,000 keys (`SCAN_LIMIT`), beyond that it answers `truncated: true` and the page says the count is incomplete
- A group can have both 2- and 3-level keys (`mixed:a` and `mixed:a:b`) → appears in both storage and get storage
- `storageView` remembers the tab / selected key / read results while you stay on the same program · `readKeys()` keeps typed values before redrawing (pressing `+` doesn't lose them)
- `/program/:a/groups`, `/program/:a/storage`, `/program/:a/map` (cursor) and the old `/blocks?before` are still there (no longer used by the page)

### Displaying values
- Object/array values everywhere (input, results, events, storage values) → `json(v)`, a black `pre.json` box with JSON coloring · `"123n"` shown as a number
- Multi-level keys → `keyChips(parts)`, chained square badges (instead of `a / b / c`)
- Gas `gas(v)` has a lightning icon · block numbers `blockNo(n)` have a box icon (linking to the block page)
- Token amounts `units(raw, decimals)` · values from storage must always go through `attr()`/`esc()` (keys come from programs)

### Token standard (`src/standards/token.js` · test `48-token-standard`)
Functions `name ticker decimals totalSupply balanceOf allowance transfer approve transferFrom`
Extra functions in `TOKEN_PROGRAM` (not required by the standard): `multiTransfer({ transfers: [{ to, amount }] })` transfers to many wallets in one tx (≈1,400 gas per entry) · error messages are English + `emit("Transfer", {from,to,amount})` / `emit("Approval", {owner,spender,amount})`
Minting at init emits Transfer from the zero address · `checkTokenStandard(code)` checks `return { … }` + `emit(` in the code
`TOKEN_PROGRAM` is the sample program (seed uses 6 decimals) · deploy input: `{ name, ticker, decimals, supply, namespace?, icon?, url?, contact?, description? }`
Tokens held = the `holding:` index (which programs) + `balanceOf` when the page opens (the real balance) → zero balances hidden
Cumulative balances are not derived from events because rebuilding blocks would double count · programs that emit Transfer but don't meet the standard are not shown

### NFT / multi-token / permit / ERC-1271 / multicall standards (`src/standards/*` · tests `62`–`67`)
Every standard is checked with `checkStandard(code, functions, events)` (in `token.js`) — based on the final `return { … }` + `emit("name"` in the code · error messages inside the programs are English
Programs cannot import each other, so they are distributed as source strings (constants interpolated with template strings at module import) · all pass `reviewProgram`

| File | Program | Summary |
|---|---|---|
| `nft.js` | `NFT_PROGRAM` · `checkNftStandard` | ERC-721: `mint({ to, tokenId?, uri? })` (owner / minter · no id = next, starting at 1n) `transferFrom` `safeTransferFrom` (a program recipient must answer `onERC721Received` = `0x150b7a02`) `approve({ to, tokenId })` `setApprovalForAll` `ownerOf` `balanceOf({ owner })` `getApproved` `isApprovedForAll` `tokenURI` (the item's uri or baseURI + id) `burn` `setMinter` `supportsInterface` · events `Transfer {from,to,tokenId}` `Approval {owner,approved,tokenId}` `ApprovalForAll {owner,operator,approved}` · storage `owners:<id>` `owned:<owner>:<id>` `balances:<owner>` |
| `multitoken.js` | `MULTITOKEN_PROGRAM` · `checkMultiTokenStandard` | ERC-1155: `balanceOf({ account, id })` `balanceOfBatch({ accounts, ids })` `safeTransferFrom({ from, to, id, amount, data? })` `safeBatchTransferFrom({ …, ids, amounts })` (hooks `onERC1155Received` / `onERC1155BatchReceived`) `mint` `mintBatch` `burn` `setApprovalForAll` `uri` (template `{id}` or `setURI`) `totalSupply({ id })` · events `TransferSingle {operator,from,to,id,amount}` `TransferBatch {…,ids,amounts}` `ApprovalForAll {account,operator,approved}` `URI {value,id}` · storage `balances:<account>:<id>` |
| `token.js` | `TOKEN_PROGRAM` + permit | `permit({ owner, spender, value, deadline, signature })` `nonces({ owner })` `permitDomain()` `DOMAIN_SEPARATOR()` · `PERMIT_TYPES` (ethers / MetaMask types) · see the "permit (ERC-2612)" section below |
| `wallet.js` | `WALLET_PROGRAM` · `SIGNATURE_CHECKER` · `ERC1271_MAGIC_VALUE` | ERC-1271: `isValidSignature({ hash, signature })` → `"0x1626ba7e"` when the owner (single key) signed that **32-byte digest** directly (`ecrecoverDigest`) · `execute({ target, fn, input, value? })` (the owner calls another program) · `transferOwnership` · can receive NFTs / 1155 via safe transfers |
| `multicall.js` | `MULTICALL_PROGRAM` | (init takes optional `namespace` / `icon` / `url` / `contact` / `description`) `aggregate({ calls: [{ target, fn, input }], readonly? })` in order, one failure fails all · `tryAggregate({ calls, readonly?, requireSuccess? })` → `[{ success, result } \| { success: false, error, code }]` · `readonly: true` = every call is a staticcall · `getBlockNumber` `getChainId` `getNativeBalance` · **targets see sender = multicall** (like Multicall3), so it suits batching "reads" |

### Chain system programs (`src/standards/system.js` · `scripts/deploy-system.js` · test `105-system-programs` + e2e)
The set every dApp / wallet shares (like Multicall3 / WBNB / Gnosis Safe) · deployed once with a **dedicated deployer** wallet (nonce 0 → 13 · all 14 use ~6M gas · deploy txs set gasLimit 1.5M) → addresses known in advance (`programAddressFor(deployer, nonce)`) · names (namespaces) set at initialization → searchable via `/name/wbwsc` · none of the set has an upgrader

| nonce | Name | Program | Summary |
|---|---|---|---|
| 0 | `multicall` | `MULTICALL_PROGRAM` | see the table above |
| 1 | `wbwsc` (`w<symbol>`) | `WCARD_PROGRAM` | full standard token (`TOKEN_CORE` + permit) · `deposit()` with attached value gives WBWSC 1:1 · `depositTo({ to })` · `withdraw({ amount })` / `withdrawTo({ to, amount })` burn and send the native coin back (balance reduced before transfer) · events `Deposit` `Withdrawal` + `Transfer` from / to zero · decimals 18 · named after `SYMBOL` (`W<symbol>`) |
| 2 | `multisig-template` | `MULTISIG_PROGRAM` | m-of-n (1–20 owners) confirmed by each owner's tx: `submit({ target, fn?, input?, value? })` → id (the proposer confirms automatically) · `confirm` / `revoke` / `execute({ id })` (counts only current owners · marks executed before calling out) · empty fn = native transfer · `addOwner` / `removeOwner` / `changeThreshold` / `approveHash` callable only via its own proposals (`sender === ThisAddress()`) · `isValidSignature` = magic when the hash was `approveHash`ed (ERC-1271) · no owners = template (can't do anything) |
| 3–5 | `token-template` `nft-template` `multitoken-template` | `TOKEN_PROGRAM` `NFT_PROGRAM` `MULTITOKEN_PROGRAM` | templates for the factory to clone · all 3 now accept `owner` in init (not sent = the deployer, as before · if sent must be a 42-char address) · tokens with supply 0 don't emit Transfer |
| 6 | `factory` | `FACTORY_PROGRAM` | anyone can create immediately without waiting for an admin (`cloneProgram`): `createToken({ name, ticker, decimals 0–36, supply })` (supply goes to the caller) · `createNft({ name, symbol, baseURI? })` · `createMultiToken({ name?, symbol?, uri? })` (caller = owner) · `createMultisig({ owners, threshold })` · all take `salt?` + `namespace` `icon` `url` `contact` `description` · the real salt = `<caller>:<salt>` (not sent = `#<caller's sequence>` · custom salts must not start with `#`) → `vm.cloneAddressFor(factory, factorySalt(creator, salt), template code)` · reads `templates` `count` `created({ index })` `createdCount({ creator })` `createdBy({ creator, index })` `kindOf({ address })` · event `Created { kind, address, creator }` |
| 7 | `multisender` | `MULTISENDER_PROGRAM` (`multisender.js` · test 108) | `sendNative` / `sendToken` / `sendTokens` / `sendNft` / `sendMultiToken` to many recipients in one tx (≤ 100 entries · one `Sent` event per call) |
| 8 | `token-lock` | `TOKEN_LOCK_PROGRAM` (`tokenlock.js` · test 109) | PinkLock-style token / LP locks: `lock({ token, amount, unlockAt, owner? })` · `vestingLock` (TGE + cycle) · `unlock` · `extendLock` · `increaseLock` · `transferLockOwnership` · `renounceLockOwnership` |
| 9 | `dex-pair-template` | `DEX_PAIR_PROGRAM` (`dex.js` · test 110) | trading pair template (LP token "BWSC-LP") · deployed without tokens = unusable · the router clones it with salt `dexPairSalt(a, b)` |
| 10 | `dex` | `DEX_PROGRAM` | Uniswap V2-style factory + router (init `{ pairTemplate, wrapped }`) · 0.3% fee to liquidity providers, no owner · paths of 2–4 tokens · native via WBWSC · the router holds no funds · no flash swaps |
| 11 | `staking` | `STAKING_PROGRAM` (`staking.js` · test 111) | anyone can create a pool: `createPool` · `stake` / `unstake` / `claim` / `exit` at any time · rewards stream per second · `emergencyWithdraw` · `addRewards` · `recoverUnallocated` |
| 12 | `limit-order` | `LIMIT_ORDER_PROGRAM` (`limitorder.js` · test 112) | `placeOrder` (deposits the token to sell) · `fillOrder` / `fillOrders` (≤ 20) · `cancelOrder` · `cancelExpired` · token ↔ token (the native coin uses WBWSC) |
| 13 | `nft-market` | `NFT_MARKET_PROGRAM` (`nftmarket.js` · test 113) | `list` / `listMulti` / `buy` / `updatePrice` / `cancel` · `makeOffer` / `cancelOffer` / `acceptOffer` · init `{ feeBps 0–1000 (default 0), feeRecipient? }` · fees round down |

```
DEPLOYER_KEY=0x… node scripts/deploy-system.js https://chain.example.com --plan     # preview addresses first (no txs sent)
node scripts/deploy-system.js --plan --deployer 0x… --chain-id 41234                   # no key / node needed
DEPLOYER_KEY=0x… ADMIN_KEY=0x… node scripts/deploy-system.js https://chain.example.com # deploy + approve → deploy/system-programs.json
```
- `systemPrograms({ addressAt, symbol })` = the plan (order / name / input of each · the factory's input gets the template addresses filled in)
- The script: checks names are free · nonces already used must be the planned programs (otherwise it stops) · the deployer must be funded · resends the same tx when the mempool answers "sent too often" · can be rerun (skips existing ones) · no `ADMIN_KEY` = waits for an admin to press Approve
- Explorer: the `#system` page (sidebar "System programs") reads the list from `EXPLORER.systemPrograms` in `explorerscan/config.js` and finds addresses with `/name/<name>`
- All code passes `reviewProgram` — autoreview disallows `obj[key]`, so metadata is set one field at a time

**permit (ERC-2612 + real EIP-712)** — MetaMask `eth_signTypedData_v4` / ethers `Wallet.signTypedData` can sign it directly (tests `62-permit-1271` `78-eip712` + e2e)
```js
domain  = { name: <the token's name()>, version: "1", chainId: ChainId(), verifyingContract: ThisAddress() }
types   = { Permit: [owner address, spender address, value uint256, nonce uint256, deadline uint256] }   // PERMIT_TYPES
digest  = eip712Digest(domain, types, "Permit", { owner, spender, value, nonce, deadline })          // = TypedDataEncoder.hash
DOMAIN_SEPARATOR() = eip712DomainSeparator(domain)                                                   // = TypedDataEncoder.hashDomain
```
- `deadline` is in **seconds (unix seconds), per EIP-2612** · the token compares it with `params.block.timestamp / 1000n` (block time is in milliseconds, rounded down) · block seconds > deadline → `permit expired` (equal is still valid)
  (tokens predating EIP-712 use a millisecond deadline)
- `nonce` = `nonces({ owner })` at signing · incremented by 1 on success (the old signature cannot be reused) · another chain / another token (verifyingContract) / another name → `invalid permit signature`
- owner / spender must be 42-char addresses (`owner and spender must be addresses`) · verifyingContract = the token's address, so it must be a real address (`0x` + 40 hex — the server already generates them this way · name-style programUuids in the testkit can't use permit)
- Owner is a personal wallet → `ecrecoverDigest(digest, signature) === owner` · owner is a program → `isValidSignature({ hash: digest, signature })` with `{ readonly: true }` via `isValidSignatureNow(signer, hash, signature)` (`SIGNATURE_CHECKER` — now takes a **32-byte digest** like OpenZeppelin and no longer hashes text for you)
  — the owner of a `WALLET_PROGRAM` can sign permit typed data with `owner` = the wallet's address directly in MetaMask (= `signWalletHash(permitDigest(…))` signs the digest directly)
  ⚠️ As with ERC-1271 in general: if one owner controls several wallets, a signature over the same digest works for all of them — permit is safe because owner is in the message
- Wallet-side / test helpers: `src/crypto/program-signature.js` (`programvm/program-signature.js`)
  `permitTypedData(fields)` (the whole payload for `eth_signTypedData_v4`, with `EIP712Domain` · numbers as decimal strings) `permitDigest(fields)` `permitDomainSeparator(fields)` `signPermit(fields, key)` (produces a signature byte-identical to ethers)
  `signWalletHash(hash, key)` / `signTypedDataDigest(digest, key)` (sign a digest directly) `recoverTypedDataDigest(digest, sig)` `typedDataDigest(domain, types, primaryType, message)` · the older text-based ones: `signProgramMessage` `recoverProgramMessage` `programMessageHash`
- Passing to ethers: remove `EIP712Domain` from types first (ethers builds it itself and throws if present) · our `eip712Digest` accepts both forms
- **No chain reset needed**: the new APIs are additions · tokens / wallets already deployed keep running their old code (JSON-digest permit + ms deadline · isValidSignature hashing text) until redeployed (or upgraded if they have an upgrader) · the explorer shows the Permit tab only for tokens whose code has `eip712Digest(` · to make the sample (seed) token the new kind, redeploy / reset the chain and seed again
- The `holding:` index counts `Transfer` / `TransferSingle` / `TransferBatch` events (`HOLDING_EVENTS` in the VM) → the explorer can find the NFTs / 1155s an address holds

### Metadata on address / program pages
| Row | Comes from | Shows |
|---|---|---|
| information | `icon` + `namespace` | a square icon (`avatar()`: an https:// or data:image picture · emoji · none = first letter of the name) + name |
| description | `description` | text |
| links | `url` + `contact` | outbound links (`target=_blank rel=noopener noreferrer nofollow`) |

- `safeHref()` allows only `https?://` · `mailto:` · `tel:` and bare emails (→ `mailto:`); anything else is shown as text, not a link (blocks `javascript:`)
- The "Edit metadata" tab exists only on wallet pages (in the same bar as Interact): form for icon / namespace / description / url / contact → `sendTx({ action: "metadata", input })`
  Sends only changed fields · fields cleared to empty = `null` (delete) · the wallet must be that page's address (the VM always uses the signer as the address)
- Programs have no edit tab (the user decided on Oct 9: you can only set your own) → program metadata is set from code with `setMetadata`
  `TOKEN_PROGRAM` accepts `icon` / `url` / `contact` / `description` in its deploy input (seed uses a data:image icon)

### Address icons
Every address rendered through `addr()` has an icon: person = user wallet · computer (purple) = program
Determined by "there is code at that address" (`<address>:code`) or deployed and awaiting init (`pending:<address>`)
`decorate()` runs on every page draw, batching unknown addresses into one `/is-program?addresses=a,b,c` request (≤ 200 per call) · only programs are remembered

### wallet connect
`eth_requestAccounts` → `eth_signTypedData_v4` → `POST /sendtx`
Signs EIP-1559 style (`TX_TYPE_1559` · `maxFeePerGas` = 2 × `baseFee` from `/genesis` · `maxPriorityFeePerGas` 0) · `sendTx({ gasPrice })` = legacy
`callableOf(code)` reads function names from the trailing `return { … }` with a regex
`runQuery()` needs no wallet · `runWrite()` must sign, then jumps to the tx page after 2.5 s

**Interact has 2 input modes** (Fields / JSON buttons · the chosen mode is remembered in localStorage `ix-mode`)
- Programs with `metadata.abi` that declare the selected function → fields come from the ABI `inputs` (type + description · ABI tag) instead of the code-based guessing below
- Fields: `inferInputs(code, fn)` reads the selected function's code (`functionSource()` extracts the body by counting brackets) looking for `params.input.<name>`
  including aliases (`const i = params.input`), destructuring (`const { to, amount } = params.input` / `({ input })`), and following into in-program helpers one level deep (`move(from, to, amount)`)
- Guesses types from usage (`guessShape`): list (for…of / .length / .map) → object (.sub-field) → address (names to/from/who/owner/token… or used as the target of transferNative / runProgram)
  → whole number (arithmetic / compared with `1n`, names like amount…) → yes/no (`=== true`, `|| false`, or only used in if/!/?) → text
- list/object fields are JSON with a placeholder example from `item.<key>` in for…of · numbers in these fields are converted to `"Nn"` for you (`bigints()`)
- An entered number `7` is sent as `"7n"` (the VM doesn't accept JS numbers) · empty field = that key is not sent · wrong-type values raise an error with the field name on Read / Send
- Switching Fields → JSON writes the entered values as JSON (wrong-type values are copied as typed) · JSON → Fields refills the fields; keys without a field are kept and sent too ("Also sent from the JSON")
- State lives in `ix` (program, fn, mode, values, json, extra); changing function / connecting a wallet then redrawing keeps typed values

**Read / Send results** (`#out` = `.ixout`): updated in the same box without redrawing the page; while waiting, the old result fades (`busy()`), then `showResult()` replaces it
- Status line (✓/✗ · Read or Transaction · function · block · gas) → **Return value** (or Error) → "Full response" collapsed (open/closed state remembered)
- Send no longer jumps to the tx page: it waits on `/tx/:hash` until there is a blockNumber (up to 120 s), then reads the receipt and shows the return value + a "View transaction" link
- `outSeq` prevents old results from overwriting newer ones · if the box disappears from the page (page change / redraw) waiting stops immediately

⚠️ The page's `canonical()` **must match the VM's `canonicalJson()` exactly** (sorted keys, bigint → `"123n"`)
and `signingInput()` must lowercase hex in the input the same way as `normalizeTransaction()` in `signature.js`
Mismatch = digest mismatch = every signature is invalid (`test/46-explorer-canonical.test.js` guards this)

---

## 9. autoreview — automated code review

`src/core/autoreview.js` is self-contained (needs only `acorn`) and can be reused anywhere

```js
import { reviewProgram } from "./src/core/autoreview.js";
const r = reviewProgram(code);     // { ok, issues: [{ line, column, message }], message }
```

**Runs at `/sendtx` before the VM**, not inside the VM (the VM has a separate `autoReview` option too, but `server.js` doesn't enable it)
· toggled with env `AUTO_REVIEW` (default on · `0` / `false` / `off` / `no` = off → deploys / upgrades are not code-reviewed, leaving the sandbox + gas in control) · the rules are in `src/core/autoreview.js`

The principle is a **whitelist** — only what is listed is allowed, everything else is rejected, so there is no need to ban `process` / `fetch` / `eval` one by one

| Banned | Reason |
|---|---|
| unknown identifiers (`process`, `require`, `globalThis`, `fetch`, `eval`, `Function`) | not on the whitelist |
| `.constructor` `.prototype` `.__proto__` `.caller` `.arguments` `.stack` | sandbox escape hatches / non-deterministic |
| `obj[key]` (computed member) | can bypass property name checks |
| `class` `async/await` `generator` `this` `for…in` `with` · regex · tagged template | non-deterministic or escapes scope (regex is disabled by the sandbox even with autoreview off — `.match("…")` that passes autoreview still throws) |
| `new` other than `Error` / `Date` | — |
| getters / setters / methods in object literals | — |
| `.sort` `.bind` `.call` `.apply` `.toLocale*` `.normalize` | results vary by locale/engine or rebind `this` (`.repeat` `.padStart` `.padEnd` are allowed now: the sandbox charges gas by result size before running) |
| names starting with `__` | — |
| global methods not in `ALLOWED_MEMBERS` | e.g. `Object.defineProperty`, `Math.sin` |

Real check over HTTP:
```
code: function program() { function evil(p) { return process.env } return { evil } }
→ 400 { "error": "Code failed review",
        "issues": [{ "line": 2, "message": "'process' ไม่รู้จัก (ใช้ได้เฉพาะ API ของ VM และตัวแปรที่ประกาศเอง)" }] }
```
(The issue message comes from `src/core/autoreview.js` and stays in Thai because it is consensus text; it means "'process' is unknown (only VM APIs and your own declared variables are allowed)")

**A limitation to understand**: autoreview blocks code that is *plainly written* to be dangerous, but it is not a sandbox
Programs now run in the sandbox (QuickJS), so even if something slips past review it can't reach Node · `while(true)` ends by running out of gas (the last line of defense is QuickJS's interrupt per `timeoutMs`)
So autoreview is a second layer (guards against non-deterministic / hard-to-read code), no longer the sole security boundary

---

## 10. Tests

`test/` 118 files · 1045 cases · plain `node --test`, no framework
`test/helpers.js` (helpers + asserts on result key sets) · `test/programs.js` (shared sample programs)

Files are ordered by topic `01`–`44`, from basics to complex. The ones worth knowing:

| File | Covers |
|---|---|
| `09-determinism` | replays give the same result (it once broke because `init` wrote `createdAt` from the real clock — a fixed `timestamp` must be passed) |
| `26-signature` `27-metamask-compat` | EIP-712 matches `ethers` |
| `30-block-body-replay` `34-history-replay` | replay / stateAt / rebuildFrom |
| `31-chain-safety` | parentHash, duplicate blocks, timestamps going backwards, duplicate txs |
| `33-limits-admin` | tx quotas per block / per user, init/reject permissions |
| `38-reentrancy` | reentrancy + safe patterns |
| `40-bigint` | numbers are BigInt throughout (no number mode) |
| `43-autoreview` | every rule of the checker |
| `44-complex-scenario` | token + market end to end: approve/transferFrom, native deposit/withdraw, nested rollback, invariant that no funds are lost |
| `56-upgrade` | upgrades: upgrader / transfer-renounce / approve-reject / failing migrate / timelock 0 and N / codeversion / replay / signed txs |
| `105-system-programs` | system programs: planned addresses · names · WBWSC (`WCARD_PROGRAM`) 1:1 deposit-withdraw · factory creates token / NFT / multi-token / multisig (salt, precomputed address, validation) · multisig m-of-n, revoke, owner changes via itself, approveHash (ERC-1271) |
| `107-bluewolfchain` | chain defaults (chainId 41234 · 10,000 gwei · 2 s blocks · 5M gas) + `genesis.json` / the example genesis enable the `bluewolf` fork · the fork's unit prices · native transfer 17,300 gas · names Bluewolfchain / BWSC / WBWSC |
| `114-sign-any-chain` | domain without chainId: signing works while the wallet is on another chain · receipt has `signedOnChainId` · omitted = this chain · mismatched chainId in the message → rejected by the mempool (prevents cross-chain replay) · matches ethers |
| `57-clone` | cloneProgram: CREATE2-style addresses, duplicate salt, unapproved template, rollback, value, gas, create trace (callTracer) |
| `58-sandbox` | sandbox: OUT_OF_MEMORY (uncatchable, across the call chain, deterministic point, included in the block and charged) / stack overflow / host unreachable / out of gas & timeout uncatchable / program isolation / cross-boundary values / all handles released after thousands of calls |
| `62-permit-1271` | permit (EIP-712): DOMAIN_SEPARATOR / digest = ethers · relayer submission · replay · expiry (seconds) · other chain / token / values · program wallets (staticcall-style ERC-1271) · execute / transferOwnership |
| `78-eip712` | eip712Digest / DomainSeparator / encodeType / hashStruct = ethers for every type set (all atomic types, nested structs, nested arrays, salt) on both the host and in programs · keccak256Bytes / ecrecoverDigest · gas · permits signed with ethers signTypedData (person + ERC-1271) · expiry / replay / other chain / verifyingContract |
| `63-nft-standard` `64-multitoken-standard` | NFT / multi-token: mint, permissions (approve / operator / minter), safe transfer + hooks, whole-batch rollback, uri, burn, holdings index |
| `65-multicall` | aggregate (order + all-or-nothing) · tryAggregate (rolls back only the failed ones · requireSuccess) · readonly (staticcall for every call) |
| `66-evm-nft-logs` `67-explorer-nft` | /evm: ERC-721 / ERC-1155 logs + eth_call (decoded with ethers) · explorer: collectionInfo / nftHoldings / program kinds |
| `68-base-fee` | base fee up / down / minimum / configuration · effective price = min(maxFee, baseFee + priority) · burn / tip / totals conserved · legacy · BaseFee() · replay |
| `69-fee-mempool` | 1559 signatures · mempool ordered by effective tip · maxFee < baseFee waits in the queue · replacement must raise both values by 10% |
| `70-header-roots` | receiptsRoot / logsBloom in the header + hash · checked by replay / rebuild / sync · /evm uses the header values |
| `71-indexed-events` | emit indexed (options validation · topic gas) · index + cursor + multiple fields · eth_getLogs by topic · standard tokens |
| `72-abi` | checkAbi (every schema rule) · deploy / setMetadata("abi") · toEvmAbi / programAbi / cardianal_getAbi |
| `73-evm-fees` | /evm: baseFeePerGas · type 0x2 / effectiveGasPrice · eth_gasPrice / eth_maxPriorityFeePerGas / eth_feeHistory |
| `76-gas-bulk-copy` | gas by data size: exponential spread loops run out of gas before 32 MB · every charged path (spread / rest / apply / Set / Map / `+` / built-in methods / ArrayBuffer / typed arrays / RegExp now disabled / runProgram) · bypasses (iterators / lying Proxies / original methods) · OOM pays real gas |
| `77-rejected-once` | a repeatedly rejected tx (same hash) is recorded in one block only · doesn't hold up sealing a new block · `/evm` old blocks don't change later · different txs are still recorded normally |
| `79-rejected-hold` | only rejected txs → no block until `REJECTED_HOLD_MS` (60 s) elapses · real txs present → seals immediately with the rejected ones riding along · the time is not stored in the block · env `REJECTED_HOLD_MS` / `AUTO_REVIEW` |
| `80-load-test` | `dev/load-test.js --quick` (20 tx × 1+2 blocks · native / token / mix × LMDB / memory, ~5 s): exit 0 · every tx included successfully · the JSON report has timings for every phase (add / sim / take / roots / commit / write / close / slot) · LMDB grows · LMDB gas = memory gas · temporary folders removed |
| `81-cpu-gas` | regex: literals fail deploy · RegExp / match / search / matchAll / species split → TypeError even with autoreview off · large BigInts (`2n ** 1e9n`, loops of × ÷ toString parse key join …) run out of gas well before timeout · 8192-bit cap · prices per formula · identical gas every time / on every VM · token / number gas unchanged · operator-rewritten code behaves like plain JS |
| `82-perf-intake` | `mempool.add(item, { verified })` skips re-verifying signatures (same result as verifying itself) · dedup within ttl × 2 by time even before cleanup · expired queued txs are cleaned + recorded as expired when a new tx arrives · `block.hashes()` memoizes / changes when a tx runs or a rejected tx is recorded / matches replay |
| `83-storage-slim` | indexes have no history / are not in blockundo · `isIndexKey` · `rebuildFrom` produces the same indexes as a chain built directly to that block (including target 0) · txn stores no signature / digest but the tx page / wallet list / eth_getTransactionByHash still get everything · txto stores no blockNumber / index / timestamp but the API still has every field · replay / stateAt / snapshotAt give the same results |
| `85-genesis-producer` | `resolveSettings`: genesis before env · differing env = error · no config = use env · `startupProblems` (ADMINS / PRODUCER_KEY / producer not listed · DEV skips) · the real `server.js` refuses to start · producer in the hash + recoverable signature · sync rejects unlisted producers / forged signatures / missing signatures / missing producers · replay / rebuild get the same hash + signature without the key · `replayTimeoutMs`: readers with a short timeout still get matching hashes |
| `86-ops` | `/health` normally 200 · stalled · block sealing failure = 503 · `scripts/monitor.js` check (including unreachable) · `scripts/backup.js` backs up with the DB open / manifest / block chain check / keep · verify catches a mismatched manifest + missing header · restore into an empty folder / requires `--force` |
| `87-sandbox-fuzz` | `fuzzOnce` / `fuzzDecoder` / `runFuzz` (fixed seed, 150 iterations): no INTERNAL · identical results on two VMs · host not contaminated · results are pure data · sandbox remains usable · the generator is reproducible by seed |
| `88-gas-cpu` | `dev/bench-gas.js` (`npm run bench:gas`): ns per gas of ~85 workloads vs. a number loop · workloads that used to be over 8× underpriced (long-string `<` / `===` / switch, long Map / Set keys, deeply nested JSON.stringify, sort, flat, normalize) repriced · identical gas on every VM · JS results unchanged |
| `89-warm-sandbox` | warm image cached / not cached / cache off: every tx result byte-identical (including the OUT_OF_MEMORY point) · no globals left over · second program in a tx works normally · LRU is capped |
| `90-verify-pool` | workers give byte-identical results to `verifyTransaction` · same errors · data that can't cross threads = rejected, no hang · size 0 = main thread · callable again after close · 200 concurrent txs don't block the main thread |
| `91-evm-abi-call` | `eth_call` via `metadata.abi`: ethers can encode / decode every type · by block · from = context.sender · mismatched selector / throw / short calldata / broken JSON = reverted · codec matches ethers |
| `92-sdk` | `client-sdk` doesn't import VM / sandbox / node:* · send with a key / EIP-1193 wallet (ethers signs typed data like MetaMask) → wait until in a block · wrong nonce = `ChainError` with body |
| `93-paymaster` | no sponsor = the original type · with sponsor = digest matches ethers · missing / wrong-signer sponsor signature / sponsor = sender / changed sponsor = rejected · on-chain: a user with 0 balance can send, gas is deducted from the sponsor, sender's nonce · value must be the sender's money |
| `94-evm-send-raw` | ethers sends through `/evm`: native (type 2 + legacy) · ERC-20 transfer of a standard token · ABI functions + estimateGas · receipt by ethers' hash · rejects no chainId / wrong chainId / deploy / type 1 / data to an EOA / broken RLP · decoding matches ethers |
| `96-trie` | Merkle Patricia Trie matches Ethereum (empty trie · doe/dog/dogglesworth · geth TestDelete) · random insert / delete for 200–300 rounds = byte-identical to a fresh build, no leftover nodes (including keys that are prefixes of each other / nodes embedded in parents / values in branches) · proofs of presence / absence · tampered node / wrong root / missing node = fails |
| `97-phase4` | `getProof` against the header's stateRoot · readers get the same trie as the producer, node for node · an old DB without a trie gets one built with the same root · pruning (keeps N blocks · historical lookup / replay only within that range · syncing from a pruned node gives the same result as archive · gradual deletion) · snapshot (load then keep syncing = producer, key for key · export while new blocks arrive + keys deleted · tampered values / missing keys / incomplete / wrong producer / wrong chainId / non-state keys = rejected with nothing left behind · 256 block headers) |
| `98-phase4-server` | real server: `/proof` + `client.verifiedState` (a node lying about proofs = fails) · `cardianal_getProof` / `eth_getProof` · `SNAPSHOT_EVERY` → `/snapshot` (keeps 2 files) · a new node with `startSync({ snapshot: true })` loads then keeps syncing with the same stateRoot |
| `101-block-gas-defer` | not enough gas left in the block → that tx waits for the next block (not rejected · the next-nonce tx follows) · server `mineOnce`: no includable tx + minimum base fee = no empty block · `/health` doesn't report stalled meanwhile |
| `102-evm-explorer-links` | EIP-3091 explorer links under `/evm/explorer` (tx / address / token / block by number or hash) · opening `/evm/explorer` gives the explorer page (for chainlist registration) |
| `103-deploy-preflight` | `scripts/preflight.js` with the files in `deploy/`: unedited example values / development genesis / DEV = fails · fully filled in = passes · `HOST=127.0.0.1` listens locally only · missing `forks` = fails |
| `117-launch-limits` | body over `MAX_BODY_BYTES` = 413 (with / without content-length) · `/evm` batch over `EVM_MAX_BATCH` = rejected · every request in a batch counts toward `EVM_RATE_LIMIT` · ws: batches / subscriptions per connection / connections per IP are capped · `eth_sendRawTransaction` over ws counts toward the `/sendtx` quota |
| `118-system-abi` | ABIs of the 11 bundled programs: pass `checkAbi` · functions match the exports · events match every `emit` (fields + order + indexed) · after deploying the full set, `cardianal_getAbi` / `eth_call` / decoding logs with ethers work · cloned multisigs get the ABI too |
| `100-producer-failover` | `producerSchedule` format / ordering / `producersAt` · not in the genesis hash · key leaked: the old key producing after block N = rejected (blocks before N still sync) · `client.verifiedState` accepts a list function · a backup key can keep producing + a warning when there is only one key · `startupProblems` FOLLOW / nextBlock · `prepareFailover` (still producing = don't start · syncs what's missing · unreachable = warn · incomplete sync = don't start) · real multi-process server: FOLLOW syncs + 503 · FAILOVER_FROM while the old one still produces = exit 1 · old one down → the standby keeps producing with the same DATA · schedule removes a key → `retired` → the new key syncs and keeps producing |
| `99-trie-gas-forks` | `stateKey` charged per first key of a tx · a gas-full block has keys ≤ gas / (write + stateKey) · fork: new rules from the given block · replay before / after the fork gives the same hash · a node without the fork splits at that block · unknown name / bad block = refuses to start · the genesis hash excludes forks |
| `95-client-ip` | `clientIp`: `TRUST_PROXY` 0 / 1 / 2 · counted from the right of X-Forwarded-For (forging the left part has no effect) · the real server behind a proxy keeps per-user quotas · unset = header ignored |
| `84-chain-scale` | `historyfrom` (new chain = 1 · blocks not storing history → recount · old chains computed once) · replayBlock doesn't read blockundo · `pageSnapshotAt` = the result of scanning blockundo (deleted / nested keys) + contiguous complete pages · `rebuildFrom` in batches (batch 1 / 3 / 10,000) yields a DB identical, key for key, to a chain built directly to target · incomplete history → rejected before touching the DB · `parseSize` / `DB.stats()` · server `/health` + `/state?limit&cursor` |
| `59-evm-gaps` | EVM-equivalent APIs: BlockHash (256 blocks, replay) / ChainId / Coinbase / BlockGasLimit / GasPrice / GasLeft / CodeHashOf / CodeSizeOf / sha256 / ripemd160 / blake2b / modexp (values + gas) / runProgram readonly (no state changes at any level, catchable, staticcall trace) / the SDK's fake APIs |

`test/e2e/explorer.e2e.js` (`npm run test:e2e`) opens the explorer in real Chromium against the real `server.js`: walks every page, reads values, signs txs with a mock wallet (including the Permit tab: signs EIP-712 and the chain accepts it)
Uses `playwright` (devDependency) — on machines without the browser yet, run `npx playwright install chromium` first · CI runs it as a separate `e2e` job
`46-explorer-canonical` extracts `canonical()` / `signingInput()` from `explorerscan/core/wallet.js` and compares them with the VM directly — changes to these two functions must pass this test

**If you change result key sets (adding fields to receipts / results), you must also update `test/helpers.js`**, otherwise many test files break at once
`dev/demo-market.js` reads the TOKEN/MARKET source directly from `test/44-complex-scenario.test.js` — change that test and the demo changes with it

### Simulating 200 wallets (`npm run simulate`)

⚠️ `simulate` / `scenario` / `scenario:full` set gas prices of 1–20 gwei and gas budgets per `DEFAULT_GAS` → a server you start yourself must use `GAS_PRICE=1000000000` + a genesis without `"forks"` (`genesis-nofork.json` = `genesis.json` with `forks` removed: `node -e 'const g=require("./genesis.json");delete g.forks;require("fs").writeFileSync("genesis-nofork.json",JSON.stringify(g))'`) · chain defaults (10,000 gwei + fork `bluewolf`) = txs rejected / budgets insufficient · `scenario:full --spawn` sets this up itself · `--spawn` of `simulate` / `scenario` passes env through to the server

`dev/simulate-users.js` sends real txs to a running server, one block at a time following the block cadence (the server's `BLOCK_MS`), then checks that every tx was included

```
RATE_LIMIT=0 GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run dev   # terminal 1 · RATE_LIMIT=0 is required (everything comes from one IP) · BLOCK_MS default 2000
npm run simulate                               # terminal 2 · you can watch the explorer at the same time
GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run simulate -- --spawn   # or let the script start the server itself (closed at the end · BLOCK_MS 1000)
npm run simulate -- --blocks 200 --min 15 --max 25
```

- Phase 1 (~first 10 blocks): genesis → 10 funded wallets → 190 more wallets · ~20 tx/block
- Phase 2 (`--blocks`, default 100): deploys 10 token / market / poll programs (admin inits them automatically) then real usage at 15–25 tx/block: transfers, naming, token airdrops, approve, listing, buying, deposit-withdraw, voting + a few deliberately bad txs (must be rejected at `/sendtx`)
- At the end it summarizes: sent / queued / rejected (by reason) / queued but not included / tx per block / block spacing · full report in `simulate-report.json` · wallet keys in `simulate-report-wallets.json`
- Must start from a fresh chain (block 0) because it uses ~7.7 million from genesis and namespace names can't repeat from a previous run · if the server sets `ADMINS`, pass `--admin-key`

### Scenario: 1000 wallets · 10 tx per block (`npm run scenario`)

`dev/scenario.js` + programs in `dev/scenario-programs.js` (test `50-scenario-programs`)

```
RATE_LIMIT=0 GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run dev   # terminal 1 · fresh chain (uses ~9.1 million from genesis)
npm run scenario                               # terminal 2 · default 60 blocks of usage
GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run scenario -- --spawn --blocks 15   # or start the server itself (MemoryDB)
```

- Each block picks "ready" work (whose prerequisites are already in a block) up to `--per-block` (10) txs: setup work first, then filled with work from wallets that already have funds
- Programs: token `TEST` (6 decimals, icon, namespace `scenario-test`) · `multisend` (native airdrop) · `chain-a`…`chain-f` (steps calling each other 6 hops deep, C / E stop to read balanceOf, D catches errors from lower levels)
  · `router-1`…`router-4` (forward: pull tokens with transferFrom then pass token + native along 4 hops, taking 1% per hop)
- Airdrops: multiSend native 3,500 to 1000 wallets (100 per tx) + 40,000 to 50 power wallets · multiTransfer TEST 1,000 to every wallet (power 50,000)
  `--target` (default 0xF10F…80Cf) gets native 500,000 + TEST 1,000,000 and more along the way from routers / transfers
- Usage: power wallets 3 txs per block (chains of 3–6 hops, 20% of the 6-hop chains make F fail but D catches it · 4-hop routers · multiTransfer to 10–30 people) + regular wallets (transfer TEST / native, set names)
  Estimates each wallet's costs (`COST`, `budget`) and doesn't send work it can't afford · txs failing entirely are absent from this set because simulate at `/sendtx` rejects them before inclusion
- Real run on Oct 9 (BLOCK_MS 3000): 64 blocks × 10 txs every block, 640/640 succeeded, 1,006 TEST holders · report in `scenario-report.json`
- ⚠️ A wallet's Incoming tab counts only txs sent **directly to** that wallet — tokens received via transfer / router and native via transferNative are not in that list (see the Tokens tab / balances)

### Full-coverage scenario (`npm run scenario:full`) — test `74-scenario-full`

`dev/scenario-full.js` + sample programs in `dev/scenario-full-programs.js` (all have `metadata.abi` + namespace → display nicely in both the explorer and Blockscout)
Sends real txs batch by batch then **verifies every result on-chain** (~300 checks, printing ✅ / ❌ per section · a single failure = exit 1 · report `scenario-full-report.json`)

```
RATE_LIMIT=0 GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run dev   # terminal 1 (with the bluewolf fork enabled = gas checks fail · an existing chain with data works too · rerunnable because --tag is randomized each run)
npm run scenario:full                          # terminal 2 · http://localhost:3000 (the latest real run at BLOCK_MS 3000 took ~2 minutes)
npm run scenario:full -- --spawn               # starts the server itself: MemoryDB · BLOCK_MS 1000 · GAS_PRICE 1 gwei · genesis without forks · MAX_BLOCK_GAS 3M · UPGRADE_DELAY_BLOCKS 2 (tests the timelock) · also checks sync
npm run scenario:full -- --spawn --quick       # BLOCK_MS 300 (~15 seconds) — the one test 74 uses
npm run scenario:full -- --url http://host:3000 --admin-key 0x… --blockscout http://localhost   # a server with ADMINS set / print Blockscout links
```

- Sections: wallet setup · deploy → init / reject (refund) · namespace · ABI · 0 transfer / legacy / 1559 / burnedFee / producerFee / base fee up-down
  · replace-by-fee (+10%) / replaced / price too low / rejected txs recorded in blocks · token (transfer / approve / transferFrom / multiTransfer / EIP-712 permit by person + ERC-1271 · DOMAIN_SEPARATOR · expiry)
  · NFT (mint / safeTransferFrom to a person and to WALLET_PROGRAM / approve / operator / tokenURI) · ERC-1155 (mint / batch / operator / uri) · ERC-1271 wallet (execute)
  · multicall · nested runProgram / STATICCALL FORBIDDEN / catch · every API compared against real values (including keccak256Bytes / ecrecoverDigest / eip712Digest · replay gives the same Math.random) · upgrade (reject / approve / timelock / migrate / versions / setUpgrader / renounce)
  · cloneProgram (address predicted with `vm.cloneAddressFor`) · OUT_OF_GAS / OUT_OF_MEMORY at query, at /sendtx and **in a block** · indexed events (REST + eth_getLogs)
  · the /evm parts Blockscout uses (block / tx type 0x0-0x2 / receipt + ERC-20 logs · 4-topic ERC-721 · ERC-1155 / eth_call / feeHistory / failed 0x0 txs / callTracer) · explorer REST · sync
- Txs that fail "in a block" are produced with `GAS_LAB_PROGRAM`'s trap: `arm()` + `loopIfArmed()` + `memoryIfArmed()` sent in the same block (simulate at /sendtx runs on the state before arm, so they pass)
- sync: imports a second `server.js` in the script's process (same env as the spawned server · MemoryDB · miner off) then `syncOnce` from `/sync` until complete → compares head hash / stateRoot
  Works with a server you started yourself via `--sync` (env affecting tx results must match, e.g. `UPGRADE_DELAY_BLOCKS` `GAS_*` `MEMORY_LIMIT_MB`)
- The end of the report prints the sample program addresses + notable txs as links to our `/#address/…` `/#tx/…` and to `<blockscout>/token|address|tx/…`
  (the printed hash is the VM hash = the hash Blockscout sees · `/sendtx` returns the digest the user signed — our explorer can search both)
- **Viewing in Blockscout**: point Blockscout at the same server's `/evm` — `ETHEREUM_JSONRPC_VARIANT=geth` · `ETHEREUM_JSONRPC_HTTP_URL=ETHEREUM_JSONRPC_TRACE_URL=http://<host>:3000/evm`
  · `ETHEREUM_JSONRPC_WS_URL=ws://<host>:3000/evm` · `INDEXER_INTERNAL_TRANSACTIONS_TRACER_TYPE=call_tracer` · chain side `EVM_RATE_LIMIT=0` (full steps in `docs/blockscout.md`)
  `--spawn` uses a random port and MemoryDB → to view in Blockscout, start the server yourself (`RATE_LIMIT=0 EVM_RATE_LIMIT=0 GAS_PRICE=1000000000 GENESIS=genesis-nofork.json npm run dev`) and run without `--spawn`
- Skipped: `TIMEOUT_MS` (3M gas always runs out first, ~60 ms · tests 08 / 58 already cover timeouts)
- Found along the way (fixed · test `75-simulate-block-number`): `simulate` used `number: null` → `BlockNumber()` was null at /sendtx
  Programs computing with the block number were rejected even though they ran fine in a block → now it always simulates as the next block (no commit / no number reserved)
- Found along the way (fixed · test `76-gas-bulk-copy`): spread `[...a, ...a]` wasn't charged gas per element (including implicit array-to-string conversion)
  → previously 32 MB of memory could be allocated for ~230 gas · now 1 per element / 32 bytes (section "Gas"), and the old loop runs out of gas at 3M first
  So `memoryIfArmed` was changed to build a 1 MB string (`s + s`) then loop `keep.push([s].join(""))` (written when `repeat` was still banned by autoreview · it is allowed now) + `gasLimit` 1,500,000 → still OUT_OF_MEMORY in a block (pays ~1.05M gas · the script checks gasUsed is between 500K–1.5M)
- The end of the report prints gasUsed of each notable tx + total gas of every block in the run (`gasByTx` / `gasUsed` in the report file) · `npm run scenario` also prints gas/tx per kind and total gas

### load test — how long does block sealing take (`npm run load:test`) — test `80-load-test`

`dev/load-test.js` measures block sealing time under load **in a single process, without HTTP**, using the real components: `VirtualMachine` (same options as `server.js`: 500 tx / 16 per sender / maxBlockGas and maxTxGas 3M / EIP-1559 / history)
+ `DB` (LMDB in a temporary folder on a real disk) vs `MemoryDB` + `Mempool` + `simulate` (+ `reviewProgram` at deploy) = `/sendtx` minus HTTP
Senders are distinct genesis wallets (1 tx per wallet per block → never hits the 16 cap) · txs are signed before the block (client side is not timed), then each block does what the server's miner does: `mempool.add` one by one → `createBlock` → `mempool.take` → `commit`

```
npm run load:test                                       # full set: native / token / mix × 100 / 250 / 500 tx × LMDB + memory (~10 minutes)
npm run load:test -- --quick                            # small set, ~5 seconds (the one test 80 uses)
npm run load:test -- --db lmdb --workload token --txs 500 --blocks 30 --out load.json   # custom selection + a JSON report of every block
npm run load:test -- --data-dir /var/data/tmp --keep    # put LMDB on the disk you will actually use · keep the folder for inspection
RATE_LIMIT=0 DATA=./data npm run dev                    # end-to-end: terminal 1
npm run load:test -- --url http://localhost:3000 --workload token --txs 250 --blocks 4   # terminal 2 · hits the real /sendtx (signature check + simulate + HTTP)
```

- Options: `--db lmdb|memory|both` · `--workload native,token,mix|all` · `--txs 100,250,500` · `--blocks` (10 · measured) · `--warmup` (2 · not counted) · `--rounds` (200 · MIX.work's loop) · `--seed` · `--out`
  `--url` funds wallets with real txs (funder → intermediate wallets, ≤ 50 txs per intermediate wallet because of the 60 tx/min/address rate limit) then fires concurrently with `--concurrency` (16) · at most 800 txs per round · `--funder-key` / `--admin-key` (server sets `ADMINS`) · requires `RATE_LIMIT=0`
- Workloads: **native** native transfers · **token** `TOKEN_PROGRAM.transfer` (in both, half go to a new address each time) · **mix** token 30% / native 20% / `MIX.work` (200-iteration loop + keccak256 + 3 key writes + emit indexed) 35% / `MIX.probe` (runProgram into the token) 15%
- Columns (ms per block): **add** = `mempool.add` for the whole block (signature check + simulate) · **take** = createBlock + take (runs every tx) · **roots** = `block.hashes()` measured separately (not included in close) · **commit** = all of `block.commit()` · **write** = `db.writeKeys` only
  · **close** = take + commit (what the miner does in `setInterval`) · **slot** = add + close (the server is single-threaded, both must finish within `BLOCK_MS`) · **DB +/tx** = extra LMDB pages used (`lastPageNumber × pageSize`) per tx

**Real measurements, Oct 22** (Xeon 2.8 GHz 4 vCPU · Node 22.22 · LMDB 3.5.7 on `/tmp` = a real virtio disk, not tmpfs · 10 blocks + 2 warmup · every tx succeeded, none rejected)

| workload | tx/block | gas/block | add | take | roots | commit LMDB / mem | write LMDB / mem | **close p50 / p95 LMDB** | close p50 / p95 mem | slot p95 LMDB | LMDB +/tx |
|---|---|---|---|---|---|---|---|---|---|---|---|
| native | 100 | 130,000 | 377 | 22 | 16 | 45 / 26 | 21 / 4 | **66 / 96** | 47 / 67 | 513 | 9.6 KB |
| native | 250 | 325,000 | 983 | 49 | 43 | 114 / 71 | 54 / 11 | **167 / 184** | 120 / 148 | 1,245 | 9.6 KB |
| native | 500 | 650,000 | 2,148 | 103 | 83 | 231 / 146 | 89 / 26 | **329 / 391** | 257 / 315 | 2,855 | 9.6 KB |
| token | 100 | 261,774 | 698 | 300 | 29 | 70 / 53 | 25 / 8 | **367 / 421** | 303 / 363 | 1,151 | 15 KB |
| token | 250 | 654,369 | 1,845 | 683 | 74 | 188 / 134 | 72 / 23 | **886 / 1,007** | 780 / 867 | 2,871 | 14.8 KB |
| token | 500 | 1,308,780 | 3,802 | 1,349 | 148 | 425 / 269 | 197 / 45 | **1,732 / 1,906** | 1,545 / 1,714 | 5,929 | 15 KB |
| mix | 100 | 350,922 | 580 | 189 | 24 | 59 / 46 | 19 / 7 | **251 / 297** | 234 / 303 | 948 | 12.5 KB |
| mix | 250 | 923,705 | 1,691 | 554 | 77 | 174 / 123 | 72 / 18 | **721 / 844** | 636 / 786 | 2,689 | 12.5 KB |
| mix | 500 | 1,815,757 | 3,379 | 955 | 129 | 345 / 252 | 132 / 42 | **1,296 / 1,470** | 1,249 / 1,375 | 4,976 | 12.5 KB |

(add / take / roots are LMDB p50 values — memory is similar, ±5%)
- Block sealing throughput alone (LMDB): native ~1,450–1,500 tx/s (1.9 Mgas/s) · token ~275–285 tx/s (0.75 Mgas/s) · mix ~335–390 tx/s (1.3 Mgas/s) · memory 10–30% faster
  Including tx intake (slot): native ~200 tx/s · token ~90 tx/s · mix ~105 tx/s
- **LMDB is not the bottleneck**: `writeKeys` 90–200 ms per 500-tx block (~12–20 keys per tx) · differs from memory by ~10% of close
  (lmdb-js enables `overlappingSync` by default → fsync happens in the background, outside the write time)
  The rest of commit (~2/3) is assembling header / body / indexes / history + computing roots (`hashes()` ~150 ms per block of 500 token txs, and called again in `header()`)
- **Block sealing time scales with the number of sandbox calls, not with gas**: token transfer ~2.7 ms/tx in a block (simulate ~3.3 ms/tx) · native ~0.2 ms/tx
- end-to-end `--url` (LMDB server `BLOCK_MS=3000` · client on the same machine · concurrency 16):
  token 250 txs/round → **62–70 req/s** · `/sendtx` p50 ~160 ms p95 0.8–1.1 s · 250 txs spread over 2 blocks (~200 + ~50)
  native 500 txs/round → **~113 req/s** · p50 ~118 ms p95 ~260 ms · 500 txs over 2 blocks
- profile (`node --cpu-prof dev/load-test.js --db lmdb --workload token --txs 500 …`, 33 s of CPU):
  `verifyTransaction` 27% (noble's secp256k1 `recoverPublicKey` ~3.5 ms/tx) · sandbox 38% (`evalCode` compiling the factory on every call 17% · `restoreSnapshot` 9% ≈ 0.6 ms per run) · keccak 9% · `Mempool.prune` 2%

**Summary / recommendations**
1. (old result, before switching to 1 s blocks · see the current defaults below) **`BLOCK_MS=3000` is safe for sealing 500-tx blocks** — the worst measured was 500 token txs at p95 1.9 s (every tx calls the sandbox) · don't lower `BLOCK_MS` below ~2,000 if you keep 500 txs per block
   ⚠️ Sealing time depends on how many program calls happen: txs with several `runProgram` hops each (multicall / router) can push 500 txs past 3 s → before raising `maxTransactions` or opening to outsiders, measure with that kind of workload first
2. **What saturates first is tx intake, not block sealing**: accepting 500 token txs takes ~3.8 s in-process (~7.5 s over HTTP) > 3 s, all on the same thread as the miner
   → realistic intake ~65 token / ~110 native tx/s per node (~200–330 txs per 3 s block) · `/sendtx` stalls during block sealing (p95 ~1 s) — nothing breaks, txs just flow to the next block
3. Hotspots (✅ = fixed in PR "perf-intake" · test `82-perf-intake`):
   - ✅ `server.js` `handlePost` called `verifyTransaction` itself and then `mempool.add` called it again → now it passes `mempool.add(item, { verified })`, verifying the signature once
   - noble's `recoverPublicKey` is pure JS (~3.5 ms) → move it to a worker thread (signature checks can run in parallel without touching state) or use a native implementation
   - ✅ `Mempool.prune()` was called on every `add` and iterated all of `#seen` (kept for ttl × 2 = 10 minutes) + `#recent` → per-tx cost grew with the number of txs ever seen:
     measured native 500 × 40 blocks (memory): the non-simulate part went 3.8 → 5.9 ms/tx with `#seen` ~20,000 · at a sustained 500 tx / 3 s for 10 minutes `#seen` ~100,000 → expected +10 ms/tx
     → now `add` does a light cleanup (`#pruneRecent`: walks from the oldest, stops at the first unexpired entry · `#recent` moves the sender to the end on every send) · `#seen` checks time on read · a full cleanup in `prune()` at `take` (once per block)
   - ✅ `Block.hashes()` was called repeatedly in `header()` / `receipt()` / `commit()` → memoized (`#hashesCache`), cleared when a tx runs / `recordRejected` / an upgrade activates
   Before / after measurements (same 4 vCPU machine · LMDB · BLOCK_MS 3000):
   | Measure | Before | After |
   |---|---|---|
   | `/sendtx` over HTTP: token 250 txs/round | ~138 req/s · p50 99 ms | ~202 req/s · p50 68 ms (+46%) |
   | `/sendtx` over HTTP: native 500 txs/round | ~199 req/s · 500 txs spilled into 2 blocks | ~347 req/s · 500 txs in a single block (+75%) |
   | intake of native 500 × 40 consecutive blocks (non-simulate part) | 2.22 → 3.05 ms/tx (keeps growing) | 2.10 → 2.07 ms/tx (flat) |
   | commit p50 (in-process) token / native / mix 500 tx | 219 / 132 / 202 ms | 140 / 77 / 112 ms (−36% to −45%) |
   | close p50 token / native / mix 500 tx | 1,242 / 204 / 1,049 ms | 1,168 / 138 / 944 ms |
   (this set was measured on a faster machine than the table above; read it as a before / after comparison on the same machine)
   - sandbox: compiling the factory on every call + restoring the snapshot ~0.6 ms per run (the existing plan in section 4 "Sandbox")
4. **Disk**: LMDB grows ~9.6 KB (native) – 15 KB (token) per tx (history + indexes + receipts · ~12–20 keys per tx) → 500-token-tx blocks every 3 s sustained ≈ 2.5 MB/s ≈ 200 GB/day
   hits the `DB`'s 100 GB `mapSize` in about 12 hours at full load → a plan for pruning history / monitoring disk is needed before going live (section 11 "When the time comes")
   ✅ `mapSize` now defaults to 1 TB (env `LMDB_MAP_SIZE`, e.g. `2T` · `/health` reports usage) — PR "chain-scale"
   ✅ Duplicate data removed (PR "storage-slim" · test `83`): indexes have no history / are not in blockundo · txn stores no signature / digest · txto stores no blockNumber / index / timestamp
   | Measure (500 tx × 10 blocks + 2 warmup · LMDB) | Before | After |
   |---|---|---|
   | actual data (keys + JSON before compression) token / native | 37.7 / 20.9 MB | 22.6 / 14.3 MB (−40% / −32%) |
   | LMDB file token / native | 88 / 55 MB | 53 / 37 MB |
   | LMDB +/tx token / native | 15.0 / 9.6 KB | 8.9 / 6.3 KB |
   | commit p50 token / native | 142 / 82 ms | 117 / 64 ms |
   | write p50 token / native | 81 / 55 ms | 65 / 39 ms |

**Re-measured Oct 24 after PR #43** (same machine spec as the Oct 22 table · full set, 10 blocks + 2 warmup · every tx succeeded · gas per block unchanged in every set · full table in `/mnt/project-files/cardianal_server/load-test-2026-10-24.md`)
The improvements also include the effects of PRs "perf-intake" and "storage-slim", merged after the Oct 22 measurement · in-process mode verifies signatures on the main thread (workers only show their effect in `--url` mode)

| 500 tx / block · LMDB | add p50 | take p50 | close p50 / p95 | LMDB +/tx |
|---|---|---|---|---|
| native | 2,148 → 1,460 ms | 103 → 77 | 329 / 391 → **170 / 224** | 9.6 → 6.3 KB |
| token | 3,802 → 2,338 ms | 1,349 → 493 | 1,732 / 1,906 → **660 / 804** | 15 → 8.9 KB |
| mix | 3,379 → 2,698 ms | 955 → 842 | 1,296 / 1,470 → **988 / 1,146** | 12.5 → 8.0 KB |

end-to-end `--url` (`BLOCK_MS=3000` · LMDB · concurrency 16 · 4 rounds):

| Set | `VERIFY_WORKERS=0` | 3 workers (the default on a 4 vCPU machine) |
|---|---|---|
| token 250 txs/round | 175–216 req/s · p95 130–184 ms | **338–521 req/s · p95 44–69 ms** |
| native 500 txs/round | 200–310 req/s · spilled into 2 blocks in 2 of 4 rounds | **632–859 req/s · p95 41–51 ms · a single block every round** |

**The bottleneck has moved**: tx intake handles 400–800 req/s, faster than the chain can pack = `maxTransactions` 500 per 3 s `BLOCK_MS` ≈ **167 tx/s per network**
Accepting more requires raising the per-block cap or lowering `BLOCK_MS`
**The defaults at that time (after simulating 0.25–3 s): 1 s blocks · 1M gas (gasTarget 500k) · 500 tx** (now Bluewolfchain: 2 s blocks · 5M gas · gasTarget 2.5M · 500 tx · fork `bluewolf` · for capacity see `deploy/README.md` item 1) — gas per second unchanged (3M / 3 s) · a full mix block seals in 334 ms (p95 489) · below 0.75 s there is no capacity gain (CPU per tx is constant · very small blocks have a fixed per-block cost) · full measurements in the project's block-time-sim.md
**Real HTTP load at those defaults** (Oct 24 · LMDB · DEV · `load-test --url --txs 500 --blocks 3` · client on the same machine): token 253–274 req/s (500 txs included within 2.9–3.3 s · ~216 txs/block = 1M gas full) · mix 168–210 req/s (140–189 txs/block · 3.2–4.0 s) · native 414–553 req/s (1.8–2.0 s) · every tx succeeded, no empty blocks
**Fixed at the same time** (found during real load at 1M gas · test `101-block-gas-defer`):
  - A tx that doesn't fit in the block's remaining gas but would fit in an empty block → `mempool.take` leaves it for the next block (previously rejected → the same sender's next-nonce tx stalled until its 5-minute expiry, and the miner sealed empty blocks every round meanwhile) · txs larger than an empty block are still rejected
  - The miner (`mineOnce`) doesn't seal empty blocks when no tx fits and the base fee is already at the minimum (empty blocks only help lower the base fee) · `minerState.idleAt` → `/health` doesn't count it as stalled
`load-test.js` still uses maxBlockGas 3M so it can measure 500-tx blocks · `scenario:full --spawn` sets `MAX_BLOCK_GAS=3000000` (the OUT_OF_MEMORY trap uses ~1.05M gas in one tx · servers with maxBlockGas < 2M = that section is skipped) · block sealing time still has headroom (500 token txs p95 0.8 s · mix 1.1 s) but must first be measured with multi-hop `runProgram` workloads (called programs still compile every tx)
Not yet measured: sustained load over long periods (fired in rounds of ≤ 800 txs) · client and server on the same machine

---

## 11. ⚠️ Not done yet — ordered by priority

### Blocking outside deploys
1. ~~no real sandbox~~ done: programs run in QuickJS (WebAssembly) — `src/core/sandbox.js` (section 4 "Sandbox")
   Truly isolated from Node · 32 MB memory / 256 KB stack per tx (`MEMORY_LIMIT_MB` / `STACK_LIMIT_KB`) · exceeded = `OUT_OF_MEMORY` · `node:vm` is gone
   ~~speed / fuzz~~ done: per-program warm images (token transfer 2.2 → 0.94 ms/tx) · 20,000 fuzz iterations found no issues · gas prices calibrated against CPU time (`npm run bench:gas`)
2. ~~gas not step-counted~~ done: `src/core/gasmeter.js` injects counters at compile time (1 gas/node) · copying / creating data is charged by size (spread / rest / string `+` / built-in methods · 1 per element or 32 bytes)
   `while(true) {}` ends with OUT_OF_GAS at `maxTxGas` (server = `MAX_BLOCK_GAS` 5M) · the 5 s timeout remains the last line of defense
3. ~~intermediate values in memory not limited~~ done: `memoryLimitBytes` per tx (sandbox) · `maxValueSize` still guards writes / return / emit as before

### Blocking a second node
4. `sync.js` is ready (fetches bodies and executes them itself, compares hashes rather than trusting state) · item 2 is done, so gas results don't depend on machine speed
   ~~the timeout case~~ done: replay / sync use `replayTimeoutMs` · ~~blocks lack producer signatures~~ done: `producer` + `producerSignature` checked against `config.producers` (section 1 "Launching a real network")
   What remains is big work: P2P (currently pulls from a single URL) · multiple producers · finality

### Known loose ends
5. ~~rejected txs never enter a block~~ done: recorded in the block (`rejectedRoot` is in the hash), not executed, state untouched — mempool section
   `GET /tx/:hash` → `rejected` · `/rejected` · explorer tx / block pages / the address Rejected tab · `/evm` sees them as failed txs (requires resetting the old chain)
6. ~~native / gas still `number`~~ done: native is BigInt wei with 18 decimals · gas is step-counted (1 gas/node)
7. ~~`/program/:a/groups` counts at most 5,000 keys~~ done: complete counts in ranges (`scan` ≤ 50,000 keys per request + `cursor`)
8. ~~interactions / event tabs have no pagination~~ done: cursor-based (Newer / Older) on the server side `/program/:a/interactions` · `/program/:a/events?cursor=`
9. **The explorer has never been tested with real MetaMask** — there are Playwright e2e tests now (`npm run test:e2e`, a mock wallet signing with ethers) + ethers can send through `/evm` (test 94)
   but the real MetaMask extension still needs manual testing: `docs/metamask-checklist.md`
   Local testing with test keys: `deploy/README.md` item 0 (RPC over http · `EVM_RATE_LIMIT=0` avoids 429 when everything comes from 127.0.0.1)
10. ~~no load test yet~~ done: `npm run load:test` (section 10 "load test") · sealing 500-tx blocks on LMDB takes 0.3 s (native) – 1.9 s (token, p95), within 3 s
    ~~the bottleneck is tx intake (~65 token / ~110 native tx/s per node)~~ fixed: signatures verified once + in worker threads · lighter `Mempool.prune` · no repeated root computation · sandbox warm images (tests 82 / 89 / 90)
    Re-measured Oct 24: HTTP intake token 338–521 · native 632–859 req/s · sealing 500 token txs p95 0.8 s (3 s blocks at that time) · the defaults then were 1 s blocks · 1M gas → ~216 token txs per block ≈ 216 tx/s (section 10 "load test") · **now 2 s blocks · 5M gas + fork `bluewolf`** (for capacity see `deploy/README.md` item 1)
    ~~history pruning plan~~ done: `HISTORY_KEEP_BLOCKS` (phase 4 · section 4 "Phase 4") · remaining: `runProgram` still compiles called programs every tx
11. ~~the `replaced` status is in memory (lost on restart)~~ done: capped off-chain `replacedLog` (`<DATA>/replaced-tx.jsonl`) survives restarts
    (checked 2026-10-24: the mempool already uses the digest as the hash; replaced txs never ran so they have no VM hash · `/tx/<digest>` can answer replaced — the old line saying "searchable by VM hash only" was wrong)
12. ~~the chain doesn't accept native transfers of 0~~ done: EVM-style 0 transfers work (cancel a stuck tx = send 0 to yourself)
13. ~~the explorer has no deploy / upgrade form~~ done: the `#deploy` page (upgrader optional) · the Upgrade tab (new code + migrate input, transfer / renounce, admin approve / reject) · Approve / Reject buttons in the pending-approval list

### ⛔ Security to fix before going live
No endpoint accepts private keys · `scripts/*` sign locally and send only `{ tx, signature }` (checked 2026-10-24), but they take keys via `--admin-key` / `--funder-key` and contain test keys in code → not for use with real keys
Production signing is client-side only (the explorer uses `eth_signTypedData_v4`) · `ADMINS` keys should live in a hardware wallet / multisig · `PRODUCER_KEY` only on the producer machine
Set `UPGRADE_DELAY_BLOCKS` > 0 in genesis so users have time to withdraw before new code goes live
Behind nginx / Caddy → set `TRUST_PROXY=1` and open the server port only to the proxy (section 1 "Launching a real network") · CORS is still `*`

### When the time comes
fast rollback · P2P · multiple producers / finality · bridge · pruning old block bodies / receipts (EIP-4444-style)
(done in phase 4: Merkle trie + `cardianal_getProof` · history pruning (`HISTORY_KEEP_BLOCKS`) · snapshots + sync from snapshot)
(done, removed from the list 2026-10-24: factory = `cloneProgram` · program upgrades · token / NFT / 1155 standards · holders page)
Full plan: `/mnt/project-files/cardianal_server/dev-plan.md` (phases 1–5) · EVM comparison: `gap-vs-evm.md`

---

## 12. Other docs in the project

| File | Content |
|---|---|
| `README.md` | short overview + layout + getting started |
| `CHECKPOINT.md` | snapshot as of Checkpoint 5: status, defaults, performance numbers of that time (chainId 1 · 1 s blocks — for current values see this file / `deploy/README.md`) |
| `EXPLORER-SPEC.md` | spec for API consumers — **every endpoint's response format is here**, read before building a frontend |
| `program-sdk/README.md` | for outside developers writing programs + testkit |
| `client-sdk/index.js` | client-side SDK (sign + send tx + wait for result · works in the browser) — section 6 |
| `docs/metamask-checklist.md` | step-by-step real MetaMask test (fill in results and send back) |
| `deploy/README.md` | launching a single-machine public chain: genesis / env values, nginx, systemd, backup + monitor, pre-announcement checks (`scripts/preflight.js`, `deploy/check.sh`) |
| `program-sdk/patterns/SAFE-PATTERNS.md` | reentrancy-safe patterns and common mistakes |

Recommended reading order: **this file** → `EXPLORER-SPEC.md` (for frontend work) or the header comment of `virtualmachine.js` (for VM work) → `CHECKPOINT.md`
