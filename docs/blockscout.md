# ใช้ Blockscout ดูเชนนี้ (ในเครื่องตัวเอง)

Blockscout ต่อเข้ากับ `/evm` ของเชน (ตัวแปลง JSON-RPC แบบอ่านอย่างเดียว ดู `HANDOFF.md` หัวข้อ `/evm`)
ใช้ docker-compose ของ Blockscout เอง (repo `blockscout/blockscout` โฟลเดอร์ `docker-compose/`) ไม่ต้อง build อะไร
รันจริงสำเร็จบน Mac + colima กับ image `ghcr.io/blockscout/blockscout:latest` (9.0.x) เมื่อ 2026-10-11 · index ครบทุก block, หน้าเว็บแสดง block / tx / token / ยอดกระเป๋า

## ต้องมี
- Docker ที่รันอยู่: Docker Desktop หรือบน Mac `brew install colima docker docker-compose && colima start` (เช็กด้วย `docker ps`)
- Docker Compose: `docker compose` (v2) หรือ `docker-compose` — คู่มือนี้ใช้ `docker-compose` ถ้าเครื่องมี v2 จะใช้ `docker compose` แทนก็ได้
- พอร์ต 80 ว่าง (หน้าเว็บ Blockscout) · เชนรันที่พอร์ต 3000 ตามเดิม
- RAM ประมาณ 4 GB ขึ้นไปสำหรับ container ทั้งชุด

## 1. รันเชน
```bash
EVM_RATE_LIMIT=0 node server.js  # หรือใส่ EVM_RATE_LIMIT=0 ใน .env แล้ว node --env-file=.env server.js
```
- `EVM_RATE_LIMIT=0` สำคัญ: indexer ยิงถี่มาก ถ้าเปิด limit ไว้ 600/นาที จะโดน 429
- อยากมีข้อมูลให้ดู: อีกหน้าต่างรัน `node scripts/seed.js http://localhost:3000` (หรือ `npm run simulate` / `npm run scenario`)
- จด `CHAIN_ID` ของเชนไว้ (ค่าเริ่มต้น 1) ต้องใส่ให้ตรงกันใน Blockscout

เช็กว่า `/evm` ตอบ:
```bash
curl -s -X POST localhost:3000/evm -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

## 2. เอา Blockscout มา
```bash
git clone --depth 1 https://github.com/blockscout/blockscout.git
cd blockscout/docker-compose
```
คำสั่งทุกตัวจากนี้รันในโฟลเดอร์ `blockscout/docker-compose`

## 3. ตั้งค่า backend: `envs/common-blockscout.env`
แก้บรรทัดที่มีอยู่แล้ว (เอา `#` หน้าบรรทัดออกถ้ามี) บรรทัดที่ไม่มีให้เพิ่มท้ายไฟล์:
```
ETHEREUM_JSONRPC_VARIANT=geth
ETHEREUM_JSONRPC_HTTP_URL=http://host.docker.internal:3000/evm
ETHEREUM_JSONRPC_TRACE_URL=http://host.docker.internal:3000/evm
ETHEREUM_JSONRPC_WS_URL=ws://host.docker.internal:3000/evm
CHAIN_ID=1                                   # ให้ตรงกับ CHAIN_ID ของเชน
COIN=CARD
COIN_NAME=Cardianal
INDEXER_INTERNAL_TRANSACTIONS_TRACER_TYPE=call_tracer   # ค่าเริ่มต้นก็เป็นค่านี้อยู่แล้ว
INDEXER_DISABLE_BLOCK_REWARD_FETCHER=true    # ใช้ trace_block ซึ่ง /evm ไม่มี
ETHEREUM_JSONRPC_HTTP_REQUEST_COMPRESSION_HEAVY_METHODS_ENABLED=false   # Blockscout 9.x บีบ gzip คำขอ debug_* / eth_getBlockReceipts แต่ /evm อ่าน gzip ไม่ได้
ECTO_USE_SSL=false                           # image 9.0.x ใช้ตัวแปรนี้ (ไม่ใช่ ECTO_SSL_MODE ในไฟล์) ไม่งั้น backend ต่อ db ไม่ได้: "ssl not available"
```
- `host.docker.internal` = เครื่องของคุณเอง มองจากใน container (ไฟล์ `services/backend.yml` ตั้ง `host-gateway` ไว้ให้แล้ว)
- Linux: เชนต้องฟังทุก interface ไม่ใช่แค่ 127.0.0.1 (`server.js` ฟังทุก interface อยู่แล้ว)

## 4. ตั้งค่าหน้าเว็บ: `envs/common-frontend.env`
```
NEXT_PUBLIC_NETWORK_NAME=Cardianal
NEXT_PUBLIC_NETWORK_SHORT_NAME=Cardianal
NEXT_PUBLIC_NETWORK_ID=1                     # = CHAIN_ID
NEXT_PUBLIC_NETWORK_CURRENCY_NAME=Cardianal
NEXT_PUBLIC_NETWORK_CURRENCY_SYMBOL=CARD
NEXT_PUBLIC_NETWORK_CURRENCY_DECIMALS=18     # เชนเก็บ native เป็น wei 18 ทศนิยม
NEXT_PUBLIC_NETWORK_RPC_URL=http://localhost:3000/evm   # ไม่มีในไฟล์ → เพิ่มเป็นบรรทัดใหม่ (ใช้กับปุ่ม Add to MetaMask · ไม่ใส่ก็ได้)
NEXT_PUBLIC_IS_TESTNET=false                 # ไฟล์ตั้งไว้ true → หน้าเว็บขึ้นป้าย Testnet
```
- บรรทัดอื่นปล่อยไว้ตามเดิม โดยเฉพาะ `NEXT_PUBLIC_STATS_API_HOST=http://localhost:8080` (service สถิติของ Blockscout เอง **ไม่ใช่** `/evm`)

## 5. Mac + colima: เก็บฐานข้อมูลใน docker volume (ทำครั้งเดียว)
postgres ใน colima เปลี่ยนสิทธิ์โฟลเดอร์ของ Mac ไม่ได้ (`db` วน Restarting + log `initdb: … Operation not permitted`) จึงต้องย้ายข้อมูลไป docker volume:
```bash
sed -i '' 's#\./blockscout-db-data:#blockscout-db-data:#; s#\./stats-db-data:#stats-db-data:#' services/db.yml services/stats.yml
printf '  blockscout-db-data:\n  stats-db-data:\n' >> geth.yml
```
Docker Desktop หรือ Linux ข้ามข้อนี้ได้

## 6. รันครั้งแรก
```bash
docker-compose -f geth.yml up -d             # ใช้ image สำเร็จรูป ไม่ต้อง build
docker-compose -f geth.yml ps                # ทุกตัวต้อง Up (user-ops-indexer วน Restarting ได้ ไม่เกี่ยว)
docker-compose -f geth.yml logs -f backend   # ดู log ของ indexer (Ctrl+C ออก)
```
เปิด http://localhost รอสักพักให้ indexer ไล่ block ตั้งแต่ 0

เช็กว่า index ครบ (จำนวน block ต้องเท่ากับ block ล่าสุดของเชน + 1 และ `missing_block_ranges` ว่าง):
```bash
docker-compose -f geth.yml exec db psql -U blockscout -d blockscout \
  -c "select count(*), min(number), max(number) from blocks;" -c "select * from missing_block_ranges;"
```
log `Index already caught up` แปลว่าไม่มี block ค้างให้ดึง ไม่ใช่ error

## เปิด-ปิดประจำวัน
| ต้องการ | คำสั่ง |
|---|---|
| เปิด | `colima start` (ถ้าปิดไว้) → รันเชน `EVM_RATE_LIMIT=0 node server.js` → `docker-compose -f geth.yml up -d` |
| หน้าเว็บขึ้น 502 หลังเปิด | `docker-compose -f geth.yml restart proxy` |
| ปิด (ข้อมูลที่ index ไว้ยังอยู่) | `docker-compose -f geth.yml down` · ปิด colima ด้วย `colima stop` |
| ปิด + ล้างข้อมูล Blockscout | `docker-compose -f geth.yml down -v` ⚠ ลบข้อมูลที่ index ไว้ทั้งหมด |

- เชนดับระหว่างที่ Blockscout เปิดอยู่ ไม่ต้องทำอะไร เปิดเชนกลับมาแล้ว Blockscout ไล่ดึง block ต่อเอง
- **ล้างเชนใหม่ทุกครั้ง ต้อง `down -v` Blockscout ด้วย** ไม่งั้นจะเห็น block เก่าค้าง (hash ไม่ตรงกับเชนใหม่)

## สิ่งที่ควรเห็น
| หน้าใน Blockscout | มาจาก |
|---|---|
| Blocks / Transactions | `eth_getBlockByNumber`, receipt |
| Token transfers + หน้า token (ชื่อ, symbol, supply, holders) | log `Transfer` + `eth_call` ของ token มาตรฐาน (ERC-20) |
| NFT / multi-token (ERC-721 / ERC-1155) | log `Transfer` / `TransferSingle` / `TransferBatch` แบบ indexed + `eth_call` (`ownerOf` `tokenURI` `uri` …) |
| แท็บ Logs ของ tx / กระเป๋า | **ทุก event** ของทุกโปรแกรม: emit แบบ indexed → topic0 = keccak(`ชื่อ(ชนิด,…)`) + topic ของ field ที่ indexed · ไม่มี indexed → topic0 = keccak(ชื่อ), data = JSON เป็น hex |
| Coin balance history ของกระเป๋า (กราฟยอด) | `eth_getBalance` ตามเลข block |
| Internal txns (เรียกซ้อน, transferNative) | `debug_traceBlockByNumber` / `debug_traceTransaction` |
| Contract code | `eth_getCode` = ซอร์ส JS เป็น hex · กดดูแบบ UTF-8 |
| Input data ของ tx | JSON `{action, method, input}` · กดดูแบบ UTF-8 |
| Base fee / gas price ของ block และ tx (EIP-1559) | `baseFeePerGas` ใน block · tx type `0x2` + `effectiveGasPrice` ใน receipt · burnt fees ที่ Blockscout คำนวณ = baseFee × gasUsed (ตรงกับเชนเมื่อ `BURN_PERCENT=100`) |
| tx ที่ถูกปฏิเสธ | อยู่ใน block ที่บันทึก (ครั้งเดียวต่อ hash) เป็น status `0x0` gasUsed `0` · มีแค่ใบที่ถูกปฏิเสธ เชนจะพักไว้จนมี tx จริงหรือครบ `REJECTED_HOLD_MS` (60 วิ) |

ที่จะไม่เห็น / ใช้ไม่ได้ (ตามที่คาดไว้):
- ปุ่ม Read/Write contract และ verify contract (Blockscout ต้องการ bytecode แบบ EVM + ซอร์ส Solidity) · ABI ของโปรแกรมดูได้ที่ explorer ของเชนเอง หรือ `cardianal_getAbi`
- ชื่อ event ที่ถอดแล้วในแท็บ Logs สำหรับ event ที่ไม่ใช่มาตรฐาน (เห็นเป็น topic / data ดิบ เพราะ Blockscout ถอดได้เฉพาะ ABI ที่ verify แล้ว)
- ส่ง tx ผ่าน Blockscout / MetaMask (`eth_sendRawTransaction`) — เชนรับเฉพาะลายเซ็นแบบของตัวเอง

## ดูว่า Blockscout ถามอะไร /evm ตอบอะไร: `scripts/evm-proxy.mjs`
ตัวดักที่ log ทุกคำขอ JSON-RPC (แตก gzip ให้) แล้วส่งต่อไปที่ `/evm` — ไม่แตะเชน
```bash
node scripts/evm-proxy.mjs   # ฟัง :3001 ส่งต่อไป http://127.0.0.1:3000/evm (แก้ด้วย PORT= / TARGET=)
```
ใน `envs/common-blockscout.env` เปลี่ยน `ETHEREUM_JSONRPC_HTTP_URL` และ `ETHEREUM_JSONRPC_TRACE_URL` เป็น `http://host.docker.internal:3001` แล้ว
```bash
docker-compose -f geth.yml up -d --force-recreate backend
docker-compose -f geth.yml restart proxy
```
ดูเสร็จแล้วเปลี่ยนกลับเป็น `:3000/evm` แล้วรันสองคำสั่งนี้อีกรอบ

## ถ้ามีปัญหา
| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `unknown shorthand flag: 'f' in -f` | ไม่มี Compose v2 → ใช้ `docker-compose` (มีขีดกลาง) · `brew install docker-compose` |
| `failed to connect to the docker API at unix:///var/run/docker.sock` | Docker ยังไม่รัน → เปิด Docker Desktop หรือ `colima start` |
| warning `the attribute version is obsolete` | ข้ามได้ |
| `db` / `stats-db` วน Restarting, log `initdb: … Operation not permitted` | ลืมทำข้อ 5 → `down` แล้วทำข้อ 5 แล้ว `up -d` |
| backend log `Postgrex.Error) ssl not available` | ขาด `ECTO_USE_SSL=false` (ข้อ 3) → เพิ่มแล้ว `up -d --force-recreate backend` |
| หน้าเว็บ "Something went wrong" / "No data", console มี `/api/v2/* 502` | backend ยังไม่ขึ้น (ดู `logs backend`) หรือเพิ่ง recreate backend แล้ว nginx จำ IP เก่า → `docker-compose -f geth.yml restart proxy` |
| `user-ops-indexer` วน Restarting | ไม่เกี่ยว (เชนนี้ไม่มี ERC-4337) · ปิดด้วย `docker-compose -f geth.yml stop user-ops-indexer` |
| log `429` | ลืม `EVM_RATE_LIMIT=0` ตอนรันเชน |
| connection refused ไปที่ `host.docker.internal:3000` | เชนไม่ได้รัน หรือ firewall บล็อกพอร์ต 3000 จาก docker |
| internal txns / receipts ไม่มา, ตัวดักขึ้น `[gzip]` | ขาด `ETHEREUM_JSONRPC_HTTP_REQUEST_COMPRESSION_HEAVY_METHODS_ENABLED=false` (ข้อ 3) |
| หน้าเว็บขึ้นป้าย Testnet | `NEXT_PUBLIC_IS_TESTNET=false` (ข้อ 4) แล้ว `docker-compose -f geth.yml up -d --force-recreate frontend` + `restart proxy` |
| พอร์ต 80 ชน | แก้ `published: 80` ใน `services/nginx.yml` |
| log `deadlock_detected` ตอนสร้าง index | เป็นเรื่องภายในฐานข้อมูลของ Blockscout เอง ไม่กระทบการ index |
