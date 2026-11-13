# deploy: launching a public chain on a single machine

Single machine = block production + RPC + explorer on one machine, with no standby that syncs along.
Machine down = the chain stops until restored from backup, so **backups must be better than usual** (step 5).

Files in this folder:

| File | Purpose |
|---|---|
| `genesis.mainnet.example.json` | copy to `genesis.mainnet.json`, then edit the `0xADDRESS_…` values (step 1) · no secrets, can be committed, and every machine must use the same file |
| `producer.env.example` | copy to `producer.env` (step 2) · contains a key · listed in .gitignore |
| `follower.env.example` | standby machine (if you add one later) |
| `nginx.conf` | HTTPS in front (step 3) |
| `cardianal.service` | systemd (step 4) · checked with preflight before every start |
| `crontab.example` | backup + monitor (step 5) |
| `check.sh` | external check after launch (step 6) |
| `../scripts/preflight.js` | checks genesis + env before launch, doesn't touch data |

Quick sequence:
```
cp deploy/genesis.mainnet.example.json deploy/genesis.mainnet.json   # edit addresses
cp deploy/producer.env.example deploy/producer.env && chmod 600 deploy/producer.env   # add the key
node --env-file=deploy/producer.env scripts/preflight.js            # must say "passed"
sudo cp deploy/cardianal.service /etc/systemd/system/ && sudo systemctl enable --now cardianal
./deploy/check.sh https://chain.example.com 41234
```

---

## 0. Try it locally first (test keys · never for a real chain)

```
# 5 keys: admin1 admin2 producer spare rich (rich = receives the initial coins)
node -e 'import("./src/crypto/signature.js").then(s=>{const out={};for(const n of ["admin1","admin2","producer","spare","rich"]){const k=s.randomPrivateKey();out[n]={key:k,address:s.addressOf(k)}}console.log(JSON.stringify(out,null,2))})' > deploy/test-keys.json

# genesis from the example (replace 0xADDRESS_… with the addresses above)
node -e 'const fs=require("fs");const k=require("./deploy/test-keys.json");let t=fs.readFileSync("deploy/genesis.mainnet.example.json","utf8").replace("0xADDRESS_RECEIVING_INITIAL_COINS",k.rich.address).replace("0xADDRESS_ADMIN_1",k.admin1.address).replace("0xADDRESS_ADMIN_2",k.admin2.address).replace("0xADDRESS_PRIMARY_PRODUCER",k.producer.address).replace("0xADDRESS_BACKUP_PRODUCER",k.spare.address);fs.writeFileSync("deploy/genesis.mainnet.json",t)'

# env: producer key + data stored in ./data-test
node -e 'const fs=require("fs");const k=require("./deploy/test-keys.json");fs.writeFileSync("deploy/producer.env",fs.readFileSync("deploy/producer.env.example","utf8").replace("0x<primary producer key>",k.producer.key).replace("/var/lib/cardianal","./data-test"))'

node --env-file=deploy/producer.env scripts/preflight.js                    # "passed · ready to launch" (a TRUST_PROXY warning is fine)
EVM_RATE_LIMIT=0 node --env-file=deploy/producer.env server.js              # http://127.0.0.1:3000
curl 127.0.0.1:3000/genesis                                                 # chainId 41234 · role producer · producers 2
```

- MetaMask: RPC `http://127.0.0.1:3000/evm` (**http**, not https · the server has no TLS of its own) · easiest is the Add network button on `http://127.0.0.1:3000/` · import `rich.key` for test transfers
- `EVM_RATE_LIMIT=0` only locally: everything comes from the single IP 127.0.0.1 (MetaMask + Blockscout), so above 600/min you get 429 → MetaMask shows "This RPC provider is limiting requests" · a real machine behind nginx counts per user, no need to set it
- an old MetaMask network whose chain ID isn't 41234 can't use this RPC; delete it and add it again
- start over: stop the server, then `rm -rf data-test` · `deploy/test-keys.json` and `data-test/` are already in .gitignore
- create real keys on an offline machine · admins use hardware wallets

---

## 1. genesis.mainnet.json (locked forever · changing it after launch = wiping the chain)

| Value | Set to | Why |
|---|---|---|
| `chainId` | 41234 (Bluewolfchain) | must not collide with another chain; prevents cross-chain txs |
| `balances` | your address → initial balance (wei + `n`) | all coins that exist at launch · no further minting |
| `config.admins` | 2 addresses (hardware wallets) | approve program deploys / upgrades · 2 in case one is lost |
| `config.producers` | primary key + backup key | **add a backup key even with a single machine**: primary key lost = keep producing with the backup key, no chain wipe |
| `blockMs` | 2000 | a block every 2 s · full blocks use about 20–30% of CPU time (multicall-full blocks ~65%) |
| `maxBlockGas` | 5000000 | ~200 token txs / block · batch token transfers fit ~735 entries per tx (`gasTarget` 2500000) |
| `gasTarget` | 2500000 | using more than half raises the base fee |
| `minBaseFee` | "10000000000000" (10,000 gwei · a native transfer costs ~0.173 BWSC) | minimum gas price at launch · **can be changed later without wiping the chain** (section 8) |
| `burnPercent` | 100 | the whole base fee is burned, producers get only the tip · lower it if producers should earn gas fees too |
| `upgradeDelayBlocks` | 3600 | approved upgrades wait 1 hour, giving users time to see them before the new code goes live |
| `memoryLimitMb` / `stackLimitKb` | 32 / 256 | the existing, tested values |

## 2. Machine env (`deploy/producer.env` · chmod 600 · never commit)

```
GENESIS=deploy/genesis.mainnet.json
DATA=/var/lib/cardianal
HOST=127.0.0.1
PORT=3000
PRODUCER_KEY=0x<primary key>
TRUST_PROXY=1
SNAPSHOT_EVERY=3600
EVM_NAME=Bluewolfchain
EVM_SYMBOL=BWSC
```

| Value | Why |
|---|---|
| `HOST=127.0.0.1` | listens only locally, so only nginx can reach it · outsiders can't hit port 3000 directly (which would bypass HTTPS · allow forging X-Forwarded-For to dodge rate limits · allow unlimited body sizes) |
| `TRUST_PROXY=1` | behind nginx · unset = the rate limiter sees everyone as one IP (127.0.0.1) and blocks everyone at once |
| `SNAPSHOT_EVERY=3600` | hourly snapshots, for restores / bringing up new machines faster than syncing from block 1 |
| `EVM_NAME` / `EVM_SYMBOL` | the name MetaMask shows on Add network · must match the chainlist entry |
| `DEV` unset | DEV=1 disables admin / key enforcement |
| `HISTORY_KEEP_BLOCKS` unset | keep the full history for now (disk ~7–9 KB per tx), can be pruned later |
| defaults you needn't touch | `RATE_LIMIT=120` POSTs per IP per minute · `EVM_RATE_LIMIT=600` (a batch counts every item) · `EVM_MAX_BATCH=1000` · `MAX_BODY_BYTES=1048576` · `TIMEOUT_MS=5000` · `MAX_TX_PER_BLOCK=500` |

## 3. nginx (HTTPS in front)

File `deploy/nginx.conf` → `/etc/nginx/conf.d/cardianal.conf`, replace the domain, then `nginx -t && systemctl reload nginx`
- certificate: `certbot --nginx -d chain.example.com`
- `/snapshot` is downloadable by anyone; to keep outsiders from pulling it, use `location /snapshot { allow <your IP>; deny all; proxy_pass … }`
- firewall: open only 80, 443, 22 (`ufw allow 22,80,443/tcp`) · with `HOST=127.0.0.1` port 3000 is already closed from outside; the firewall is a second layer

Resulting URLs: RPC `https://chain.example.com/evm` · explorer `https://chain.example.com/` (or `/evm/explorer` for chainlist)

## 4. systemd (starts at boot / restarts after a crash)

File `deploy/cardianal.service` → `/etc/systemd/system/`, then `sudo systemctl enable --now cardianal` · logs: `journalctl -u cardianal -f`
`scripts/preflight.js` runs before every start; if the configuration is wrong the server won't start (see the reason in the log)
With a single machine, automatic restarts are safe (no other machine producing at the same time)

## 5. backup + monitor (more important than usual since there is no standby)

Example cron in `deploy/crontab.example`: backup every 6 h shipped off the machine · monitor every minute from **another machine** (a dead chain machine can't alert about itself)
- rehearse a restore at least once before announcing: `node scripts/backup.js --verify <set>`, then `--restore` on a test machine
- machine dies: new machine + restore the latest set + the same `PRODUCER_KEY` → production continues from the latest block in the backup (txs in blocks after the backup are lost · the more frequent the backups, the less is lost)

## 6. Check before announcing

```
./deploy/check.sh https://chain.example.com 41234
```
Checks /health, chainId, the explorer, that the Add network button's rpcUrl is https, and that port 3000 is closed from outside · keep the printed genesis hash for the announcement
Then add the chain to MetaMask from the button on the explorer page · make 1 transfer · look it up in the explorer

## 7. System programs (after launch · once)

14 programs: Multicall, WBWSC (wrapped native coin), Factory (anyone can create tokens / NFTs / multisigs instantly) + 4 templates, Multisender, Token lock, DEX + pair template, Staking, Limit order, NFT market · use a **fresh deployer wallet** that has never sent a tx (program addresses are bound to this wallet's nonces 0–13)
```
node scripts/deploy-system.js --plan --deployer 0x<deployer> --chain-id 41234     # addresses in advance (fine to publish in docs / announcements)
# send the deployer ~130 BWSC first (deploying all 14 uses ~6M gas · the script pays 2× the 10,000 gwei base fee ≈ 120 BWSC)
DEPLOYER_KEY=0x… ADMIN_KEY=0x<admin> node scripts/deploy-system.js https://chain.example.com
```
- produces `deploy/system-programs.json` (addresses + names) · the explorer's "System programs" menu shows them automatically
- don't want the admin key on this machine (admin is a hardware wallet): omit `ADMIN_KEY` and click Approve for each one on the explorer's Programs page with the admin wallet
- native coin isn't BWSC: the script reads the server's `EVM_SYMBOL` (or set `SYMBOL=…`) → names become `w<symbol>` · update `systemPrograms` in `explorerscan/config.js` to match

## 8. Adjusting the minimum gas price later (native coin gets pricier / cheaper)

An admin (an address in `config.admins`) sends a `setGasConfig` tx · takes effect from the next block · no fork / chain wipe / restart · followers sync it automatically
```
node scripts/set-gas.js https://chain.example.com                                              # show current values
ADMIN_KEY=0x<admin> node scripts/set-gas.js https://chain.example.com --min-base-fee 1000gwei  # every tx 10× cheaper (from 10,000 gwei)
ADMIN_KEY=0x<admin> node scripts/set-gas.js https://chain.example.com --reset                  # back to the genesis value
```
- admin on a hardware wallet: open the explorer's **Gas settings** menu → connect the admin wallet → enter the new value → Send change
- lowering the minimum = every tx fee (in coins) gets proportionally cheaper · gas per tx and block capacity stay the same · the base fee still rises on its own when blocks are full · it falls toward the new value by ≤ 12.5% per block (10,000 → 1,000 gwei takes about 18 blocks)
- per-unit prices (call / write …) can't be changed this way, only by a fork (so a leaked admin key can't make txs free)

## Recommended machine

Past measurements used 4 vCPUs (the main thread at ~70% when full at 1M gas/s) → **4 vCPU, 8 GB RAM, 200 GB+ SSD** is enough to start · disk grows with tx count (~7–9 KB per tx); check real usage 1–2 weeks after launch
