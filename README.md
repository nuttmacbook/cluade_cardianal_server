# Program VM

A VM for running JavaScript programs on its own chain, with blocks, gas fees, signatures, and historical state lookup

```bash
npm install
npm test          # 1045 cases
npm run demo      # playground
npm run examples  # sample requests of every type

npm run dev       # server + explorer at http://localhost:3000 (DEV=1 · a real network uses npm start + ADMINS + PRODUCER_KEY, see HANDOFF section 1)
npm run seed      # create sample data over HTTP (the server must already be running)
DEPLOYER_KEY=0x… ADMIN_KEY=0x… npm run deploy:system   # 14 system programs: Multicall, WBWSC, Multisig, Factory + token / NFT templates, Multisender, Token lock, DEX, Staking, Limit order, NFT market (HANDOFF section 8)
```

`server.js` ties everything together: VM + mempool + autoreview + simulate + automatic block sealing
and serves the explorer from the `explorerscan/` folder (customizable, see `explorerscan/README.md`). Configured via env: `PORT`, `HOST`, `DATA`, `GENESIS`, `PRODUCER_KEY`, `ADMINS`, `BLOCK_MS`, `CHAIN_ID`, `TRUST_PROXY`, `EVM_RATE_LIMIT` … (most are at the top of `server.js` · values genesis can lock, such as `CHAIN_ID` `GAS_PRICE` `PRODUCERS`, are in `GENESIS_SETTINGS` in `src/node/genesis.js`)
Initial balances are read from `genesis.json`
Defaults = Bluewolfchain (BWSC) · chainId 41234 · 2 s blocks · 5M gas · minimum 10,000 gwei · `genesis.json` enables the `bluewolf` fork from block 0

## Layout

Split into 3 groups: **used by the live chain** (must be on the machine running the chain) · **developer tools** (not needed on the server machine) · **tests only** (can be deleted, the chain still runs)

### 1. Used by the live chain

```
server.js                  the real server (node:http) — VM + mempool + autoreview + simulate + block sealing + /evm + explorer
src/                       the whole chain (server.js imports from here)
  core/                    virtualmachine.js (chain logic) · autoreview.js · sandbox.js · gasmeter.js · trie.js · encoding.js
  storage/db.js            LMDB / MemoryDB
  crypto/                  EIP-712 signatures on secp256k1
  node/                    mempool · sync · snapshot · genesis · /evm (evm-rpc / evm-ws / evm-raw / evm-abi) · explorer-api · rate limit
  standards/               standard programs + 14 bundled programs (system.js · dex · staking · …) · abi/ = ABIs of the bundled programs
explorerscan/              the explorer pages the server serves · its README says what to edit where
deploy/                    files for launching a real chain: genesis.mainnet.example.json · producer / follower env · nginx · systemd · cron · check.sh · README
scripts/                   commands for operating the live chain
  preflight.js             checks genesis + env before launch (must pass every time)
  deploy-system.js         deploys the 14 bundled programs (npm run deploy:system)
  set-gas.js               admin adjusts the minimum gas price (npm run gas:set)
  backup.js                back up / verify / restore LMDB (npm run backup)
  snapshot.js              export / import a state snapshot (npm run snapshot)
  monitor.js               watches /health and alerts (npm run monitor)
package.json · package-lock.json   dependencies (real machine: npm ci --omit=dev)
```

### 2. Developer tools (work with the live chain, but not needed on the server machine)

```
client-sdk/                client-side SDK: sign + send tx + wait for result (works in the browser · import "programvm/client")
program-sdk/               separate kit for people writing programs to run on the chain (deploy.js reads chainId / gas settings from the chain itself)
index.js                   single entry point of the library — everything can be imported from here
docs/                      Blockscout · checklist for testing with real MetaMask
README.md · HANDOFF.md     docs (HANDOFF = details of every part, read before changing code)
EXPLORER-SPEC.md           explorer spec
CHECKPOINT.md              old notes as of Checkpoint 5 (values in it are outdated)
.github/                   CI (test + e2e on every PR)
```

### 3. Tests only (can be deleted · not used by the live chain)

```
test/                      118 files · 1045 cases + test/e2e (Playwright) — delete them and npm test / CI stop working
dev/                       demo · seed · scenario · simulate · load test · gas bench · fuzz · evm-proxy (see dev/README.md)
genesis.json               development genesis (Hardhat test keys are funded) · never use it to launch a real chain (preflight fails)
```

## What each part does

| Part | Responsible for | Knows nothing about |
|---|---|---|
| `core` | running programs, gas accounting, assembling blocks, hashing, historical lookup | signatures, HTTP, queues |
| `storage` | storing and reading all keys | what keys mean |
| `crypto` | EIP-712 and secp256k1 | DB, blocks |
| `node` | everything around the VM: queue, sync, HTTP | program internals |

Dependencies always go one way: `node` → `crypto` → `core` → `storage`

## Getting started

```js
import { VirtualMachine, DB, Mempool, signature } from "programvm";

const vm = new VirtualMachine(new DB("./data"), {
  chainId: 1, requireNonce: true, chargeGas: true, recordBlocks: true, recordHistory: true,
});
vm.applyGenesis({ chainId: 1, balances: { "0x…": 1_000_000 } });

const mempool = new Mempool(vm);
mempool.add({ tx, signature: sig });

const block = vm.createBlock({ timestamp: Date.now(), feeRecipient: MINER });
mempool.take(block);
block.commit();
```

The values the server actually uses are at the top of `server.js` + `src/node/genesis.js` (launching a real chain: `deploy/README.md`), and how to write programs is in `program-sdk/README.md`

View the chain through Blockscout (connected to `/evm`): `docs/blockscout.md`
