# Viewing this chain with Blockscout (locally)

Blockscout connects to the chain's `/evm` (a read-only JSON-RPC adapter, see the `/evm` section of `HANDOFF.md`)
It uses Blockscout's own docker-compose (repo `blockscout/blockscout`, folder `docker-compose/`), nothing to build
Successfully run on Mac + colima with image `ghcr.io/blockscout/blockscout:latest` (9.0.x) on 2026-10-11 · indexed every block; the web UI shows blocks / txs / tokens / wallet balances

## Requirements
- Docker running: Docker Desktop, or on Mac `brew install colima docker docker-compose && colima start` (check with `docker ps`)
- Docker Compose: `docker compose` (v2) or `docker-compose` — this guide uses `docker-compose`; with v2 you can use `docker compose` instead
- port 80 free (the Blockscout web UI) · the chain runs on port 3000 as usual
- about 4 GB+ RAM for the whole container set

## 1. Run the chain
```bash
DEV=1 EVM_RATE_LIMIT=0 node server.js  # or put EVM_RATE_LIMIT=0 in .env and run node --env-file=.env server.js
```
- `EVM_RATE_LIMIT=0` matters: the indexer polls very frequently; with the 600/min limit on it gets 429s
- want data to look at: in another window run `node dev/seed.js http://localhost:3000` (or `npm run simulate` / `npm run scenario` — these need the chain started with `GAS_PRICE=1000000000` + a genesis without `forks`, see section 10 of `HANDOFF.md`)
- note the chain's chainId (default + `genesis.json` = 41234); it must match in Blockscout

Check that `/evm` answers:
```bash
curl -s -X POST localhost:3000/evm -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

## 2. Get Blockscout
```bash
git clone --depth 1 https://github.com/blockscout/blockscout.git
cd blockscout/docker-compose
```
All commands from here on run in the `blockscout/docker-compose` folder

## 3. Backend config: `envs/common-blockscout.env`
Edit lines that already exist (remove a leading `#` if present); append any missing lines to the end of the file:
```
ETHEREUM_JSONRPC_VARIANT=geth
ETHEREUM_JSONRPC_HTTP_URL=http://host.docker.internal:3000/evm
ETHEREUM_JSONRPC_TRACE_URL=http://host.docker.internal:3000/evm
ETHEREUM_JSONRPC_WS_URL=ws://host.docker.internal:3000/evm
CHAIN_ID=41234                               # must match the chain's chainId
COIN=BWSC
COIN_NAME=Bluewolfchain
INDEXER_INTERNAL_TRANSACTIONS_TRACER_TYPE=call_tracer   # already the default
INDEXER_DISABLE_BLOCK_REWARD_FETCHER=true    # it uses trace_block, which /evm doesn't have
ETHEREUM_JSONRPC_HTTP_REQUEST_COMPRESSION_HEAVY_METHODS_ENABLED=false   # Blockscout 9.x gzips debug_* / eth_getBlockReceipts requests, but /evm can't read gzip
ECTO_USE_SSL=false                           # image 9.0.x uses this variable (not ECTO_SSL_MODE from the file), otherwise the backend can't reach the db: "ssl not available"
```
- `host.docker.internal` = your own machine as seen from inside the container (`services/backend.yml` already sets `host-gateway`)
- Linux: the chain must listen on all interfaces, not just 127.0.0.1 (`server.js` already listens on all interfaces)

## 4. Frontend config: `envs/common-frontend.env`
```
NEXT_PUBLIC_NETWORK_NAME=Bluewolfchain
NEXT_PUBLIC_NETWORK_SHORT_NAME=Bluewolfchain
NEXT_PUBLIC_NETWORK_ID=41234                 # = CHAIN_ID
NEXT_PUBLIC_NETWORK_CURRENCY_NAME=Bluewolfchain
NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL=BWSC
NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS=18     # the chain stores native as 18-decimal wei
NEXT_PUBLIC_NETWORK_RPC_URL=http://localhost:3000/evm   # not in the file → add it as a new line (used by the Add to MetaMask button · optional)
NEXT_PUBLIC_IS_TESTNET=false                 # the file sets true → the UI shows a Testnet badge
```
- leave the other lines as they are, especially `NEXT_PUBLIC_STATS_API_HOST=http://localhost:8080` (Blockscout's own stats service, **not** `/evm`)

## 5. Mac + colima: keep the databases in docker volumes (once)
postgres in colima can't change permissions on Mac folders (`db` keeps Restarting + log `initdb: … Operation not permitted`), so move the data to docker volumes:
```bash
sed -i '' 's#\./blockscout-db-data:#blockscout-db-data:#; s#\./stats-db-data:#stats-db-data:#' services/db.yml services/stats.yml
printf '  blockscout-db-data:\n  stats-db-data:\n' >> geth.yml
```
Docker Desktop or Linux can skip this step

## 6. First run
```bash
docker-compose -f geth.yml up -d             # uses prebuilt images, no build
docker-compose -f geth.yml ps                # everything must be Up (user-ops-indexer may keep Restarting, unrelated)
docker-compose -f geth.yml logs -f backend   # follow the indexer log (Ctrl+C to exit)
```
Open http://localhost and wait for the indexer to walk blocks from 0

Check indexing is complete (block count must equal the chain's latest block + 1 and `missing_block_ranges` must be empty):
```bash
docker-compose -f geth.yml exec db psql -U blockscout -d blockscout \
  -c "select count(*), min(number), max(number) from blocks;" -c "select * from missing_block_ranges;"
```
The log line `Index already caught up` means there are no blocks left to fetch, not an error

## Daily start / stop
| Want | Command |
|---|---|
| start | `colima start` (if stopped) → run the chain `DEV=1 EVM_RATE_LIMIT=0 node server.js` → `docker-compose -f geth.yml up -d` |
| web UI shows 502 after starting | `docker-compose -f geth.yml restart proxy` |
| stop (indexed data is kept) | `docker-compose -f geth.yml down` · stop colima with `colima stop` |
| stop + wipe Blockscout data | `docker-compose -f geth.yml down -v` ⚠ deletes all indexed data |

- if the chain goes down while Blockscout runs, do nothing; once the chain is back Blockscout resumes fetching blocks by itself
- **every time you wipe the chain, also `down -v` Blockscout**, otherwise stale old blocks remain (hashes don't match the new chain)

## What you should see
| Blockscout page | Comes from |
|---|---|
| Blocks / Transactions | `eth_getBlockByNumber`, receipts |
| Token transfers + token pages (name, symbol, supply, holders) | `Transfer` logs + `eth_call` on standard tokens (ERC-20) |
| NFT / multi-token (ERC-721 / ERC-1155) | indexed `Transfer` / `TransferSingle` / `TransferBatch` logs + `eth_call` (`ownerOf` `tokenURI` `uri` …) |
| Logs tab of a tx / wallet | **every event** of every program: indexed emit → topic0 = keccak(`name(type,…)`) + topics for indexed fields · no indexed → topic0 = keccak(name), data = JSON as hex |
| a wallet's coin balance history (balance chart) | `eth_getBalance` by block number |
| Internal txns (nested calls, transferNative) | `debug_traceBlockByNumber` / `debug_traceTransaction` |
| Contract code (Contract tab) | `eth_getCode` = the JS source as UTF-8 hex · Blockscout (v9.0.2 / frontend 2.3.5) shows hex only, with no UTF-8 toggle · "Contract creation code" = the deploy tx input (JSON) · read the source per "Reading program code" below |
| tx input data | JSON `{action, method, input}` as hex · the tx page has a Hex / UTF-8 option on the Raw input field |
| base fee / gas price of blocks and txs (EIP-1559) | `baseFeePerGas` in blocks · tx type `0x2` + `effectiveGasPrice` in receipts · the burnt fees Blockscout computes = baseFee × gasUsed (matches the chain when `BURN_PERCENT=100`) |
| rejected txs | in the block that recorded them (once per hash) as status `0x0` gasUsed `0` · when there are only rejected txs, the chain holds them until a real tx arrives or `REJECTED_HOLD_MS` (60 s) passes |

What you won't see / can't use (as expected):
- the Read/Write contract and verify contract buttons (Blockscout needs EVM bytecode + Solidity source) · program ABIs are available in the chain's own explorer or via `cardianal_getAbi`
- decoded event names in the Logs tab for non-standard events (shown as raw topics / data, since Blockscout can only decode verified ABIs)
- Blockscout's Write buttons · wallets can send txs via `eth_sendRawTransaction` (native transfers · standard tokens · functions per `metadata.abi`), but not through the Blockscout UI

Reading program code (JS source) when Blockscout shows hex:
- the chain's explorer: `http://localhost:3000/#address/<address>` → Code tab
- `curl -s localhost:3000/program/<address>`
- decode `eth_getCode` yourself:
  ```bash
  curl -s localhost:3000/evm -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["<address>","latest"]}' \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Buffer.from(JSON.parse(s).result.slice(2),"hex").toString("utf8")))'
  ```
- in the browser console (click copy on the Deployed bytecode field in Blockscout and paste it in place of `0x...`):
  ```js
  new TextDecoder().decode(Uint8Array.from("0x...".slice(2).match(/../g), (h) => parseInt(h, 16)))
  ```

## Seeing what Blockscout asks and what /evm answers: `dev/evm-proxy.mjs`
An interceptor that logs every JSON-RPC request (un-gzipping them) and forwards it to `/evm` — doesn't touch the chain
```bash
node dev/evm-proxy.mjs   # listens on :3001, forwards to http://127.0.0.1:3000/evm (change with PORT= / TARGET=)
```
In `envs/common-blockscout.env` change `ETHEREUM_JSONRPC_HTTP_URL` and `ETHEREUM_JSONRPC_TRACE_URL` to `http://host.docker.internal:3001`, then
```bash
docker-compose -f geth.yml up -d --force-recreate backend
docker-compose -f geth.yml restart proxy
```
When done, change them back to `:3000/evm` and run these two commands again

## Troubleshooting
| Symptom | Cause / fix |
|---|---|
| `unknown shorthand flag: 'f' in -f` | no Compose v2 → use `docker-compose` (with a hyphen) · `brew install docker-compose` |
| `failed to connect to the docker API at unix:///var/run/docker.sock` | Docker isn't running → start Docker Desktop or `colima start` |
| warning `the attribute version is obsolete` | ignore it |
| `db` / `stats-db` keep Restarting, log `initdb: … Operation not permitted` | step 5 was skipped → `down`, do step 5, then `up -d` |
| backend log `Postgrex.Error) ssl not available` | missing `ECTO_USE_SSL=false` (step 3) → add it, then `up -d --force-recreate backend` |
| web UI "Something went wrong" / "No data", console shows `/api/v2/* 502` | the backend isn't up yet (check `logs backend`), or the backend was just recreated and nginx remembers the old IP → `docker-compose -f geth.yml restart proxy` |
| `user-ops-indexer` keeps Restarting | unrelated (this chain has no ERC-4337) · stop it with `docker-compose -f geth.yml stop user-ops-indexer` |
| log `429` | forgot `EVM_RATE_LIMIT=0` when starting the chain |
| connection refused to `host.docker.internal:3000` | the chain isn't running, or a firewall blocks port 3000 from docker |
| internal txns / receipts missing, the interceptor shows `[gzip]` | missing `ETHEREUM_JSONRPC_HTTP_REQUEST_COMPRESSION_HEAVY_METHODS_ENABLED=false` (step 3) |
| the web UI shows a Testnet badge | `NEXT_PUBLIC_IS_TESTNET=false` (step 4), then `docker-compose -f geth.yml up -d --force-recreate frontend` + `restart proxy` |
| port 80 conflict | change `published: 80` in `services/nginx.yml` |
| log `deadlock_detected` while building indexes | internal to Blockscout's own database, doesn't affect indexing |
