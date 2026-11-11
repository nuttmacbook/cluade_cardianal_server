# Program VM

VM สำหรับรันโปรแกรม JavaScript บน chain ของตัวเอง พร้อมระบบ block, ค่าแก๊ส, ลายเซ็น และการย้อนดูข้อมูล

```bash
npm install
npm test          # 1045 เคส
npm run demo      # สนามทดลอง
npm run examples  # ตัวอย่าง request ทุกประเภท

npm run dev       # server + explorer ที่ http://localhost:3000 (DEV=1 · เครือข่ายจริงใช้ npm start + ADMINS + PRODUCER_KEY ดู HANDOFF หัวข้อ 1)
npm run seed      # สร้างข้อมูลตัวอย่างผ่าน HTTP (ต้องรัน server ไว้ก่อน)
DEPLOYER_KEY=0x… ADMIN_KEY=0x… npm run deploy:system   # โปรแกรมกลาง 14 ตัว: Multicall, WBWSC, Multisig, Factory + ต้นแบบ token / NFT, Multisender, Token lock, DEX, Staking, Limit order, NFT market (HANDOFF หัวข้อ 8)
```

`server.js` รวมทุกอย่างเข้าด้วยกัน: VM + mempool + autoreview + simulate + ปิด block อัตโนมัติ
และเสิร์ฟหน้า explorer จากโฟลเดอร์ `explorerscan/` (แต่งหน้าตาเองได้ ดู `explorerscan/README.md`) ตั้งค่าผ่าน env: `PORT`, `HOST`, `DATA`, `GENESIS`, `PRODUCER_KEY`, `ADMINS`, `BLOCK_MS`, `CHAIN_ID`, `TRUST_PROXY`, `EVM_RATE_LIMIT` … (ส่วนใหญ่อยู่หัวไฟล์ `server.js` · ค่าที่ genesis ล็อกได้ เช่น `CHAIN_ID` `GAS_PRICE` `PRODUCERS` อยู่ใน `GENESIS_SETTINGS` ของ `src/node/genesis.js`)
ยอดเงินตั้งต้นอ่านจาก `genesis.json`
ค่าเริ่ม = Bluewolfchain (BWSC) · chainId 41234 · block 2 วิ · 5M แก๊ส · ขั้นต่ำ 10,000 gwei · `genesis.json` เปิด fork `bluewolf` ตั้งแต่ block 0

## โครงสร้าง

แบ่งเป็น 3 กลุ่ม: **ใช้กับเชนจริง** (ต้องมีบนเครื่องที่เปิดเชน) · **เครื่องมือของนักพัฒนา** (ไม่ต้องอยู่บนเครื่อง server) · **ทดสอบเท่านั้น** (ลบได้ เชนยังทำงาน)

### 1. ใช้กับเชนจริง

```
server.js                  server จริง (node:http) — VM + mempool + autoreview + simulate + ปิด block + /evm + explorer
src/                       ตัวเชนทั้งหมด (server.js import จากที่นี่)
  core/                    virtualmachine.js (ตรรกะของเชน) · autoreview.js · sandbox.js · gasmeter.js · trie.js · encoding.js
  storage/db.js            LMDB / MemoryDB
  crypto/                  ลายเซ็น EIP-712 บน secp256k1
  node/                    mempool · sync · snapshot · genesis · /evm (evm-rpc / evm-ws / evm-raw / evm-abi) · explorer-api · rate limit
  standards/               โปรแกรมมาตรฐาน + โปรแกรมแถม 14 ตัว (system.js · dex · staking · …) · abi/ = ABI ของโปรแกรมแถม
explorerscan/              หน้า explorer ที่ server เสิร์ฟ · README บอกว่าแก้ตรงไหน
deploy/                    ไฟล์เปิดเชนจริง: genesis.mainnet.example.json · producer / follower env · nginx · systemd · cron · check.sh · README
scripts/                   คำสั่งสำหรับดูแลเชนจริง
  preflight.js             ตรวจ genesis + env ก่อนเปิด (ต้องผ่านทุกครั้ง)
  deploy-system.js         deploy โปรแกรมแถม 14 ตัว (npm run deploy:system)
  set-gas.js               admin ปรับขั้นต่ำของ gas price (npm run gas:set)
  backup.js                สำรอง / ตรวจ / กู้ LMDB (npm run backup)
  snapshot.js              export / import snapshot ของ state (npm run snapshot)
  monitor.js               เฝ้า /health แล้วเตือน (npm run monitor)
package.json · package-lock.json   dependency (เครื่องจริง: npm ci --omit=dev)
```

### 2. เครื่องมือของนักพัฒนา (ใช้กับเชนจริงได้ แต่ไม่ต้องอยู่บนเครื่อง server)

```
client-sdk/                SDK ฝั่ง client: เซ็น + ส่ง tx + รอผล (ใช้ใน browser ได้ · import "programvm/client")
program-sdk/               ชุดแยกสำหรับคนที่จะเขียนโปรแกรมมารันบนเชน (deploy.js อ่าน chainId / ค่าแก๊สจากเชนเอง)
index.js                   จุดเข้าเดียวของไลบรารี — import ทุกอย่างจากที่นี่ได้
docs/                      Blockscout · checklist ลอง MetaMask จริง
README.md · HANDOFF.md     เอกสาร (HANDOFF = รายละเอียดทุกส่วน อ่านก่อนแก้โค้ด)
EXPLORER-SPEC.md           สเปกของ explorer
CHECKPOINT.md              บันทึกเก่า ณ Checkpoint 5 (ค่าในนั้นเป็นของเดิม)
.github/                   CI (test + e2e ทุก PR)
```

### 3. ทดสอบเท่านั้น (ลบได้ · เชนจริงไม่ได้ใช้)

```
test/                      118 ไฟล์ · 1045 เคส + test/e2e (Playwright) — ลบแล้ว npm test / CI ใช้ไม่ได้
dev/                       demo · seed · scenario · simulate · load test · bench แก๊ส · fuzz · evm-proxy (ดู dev/README.md)
genesis.json               genesis ของช่วงพัฒนา (key ทดสอบของ Hardhat มีเงิน) · ห้ามใช้เปิดเชนจริง (preflight ไม่ผ่าน)
```

## แต่ละส่วนทำอะไร

| ส่วน | รับผิดชอบ | ไม่รู้จัก |
|---|---|---|
| `core` | รันโปรแกรม, คิดค่าแก๊ส, ประกอบ block, hash, ย้อนดูข้อมูล | ลายเซ็น, HTTP, คิว |
| `storage` | เก็บและอ่าน key ทั้งหมด | ความหมายของ key |
| `crypto` | EIP-712 และ secp256k1 | DB, block |
| `node` | สิ่งที่อยู่รอบ VM: คิว, การซิงก์, HTTP | ตรรกะภายในของโปรแกรม |

ทิศทางการพึ่งพาเป็นทางเดียวเสมอ คือ `node` → `crypto` → `core` → `storage`

## เริ่มใช้งาน

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

ค่าที่ server ใช้จริงอยู่หัวไฟล์ `server.js` + `src/node/genesis.js` (เปิดเชนจริง: `deploy/README.md`) และวิธีเขียนโปรแกรมใน `program-sdk/README.md`

ดูเชนผ่าน Blockscout (ต่อเข้า `/evm`): `docs/blockscout.md`
