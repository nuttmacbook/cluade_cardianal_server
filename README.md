# Program VM

VM สำหรับรันโปรแกรม JavaScript บน chain ของตัวเอง พร้อมระบบ block, ค่าแก๊ส, ลายเซ็น และการย้อนดูข้อมูล

```bash
npm install
npm test          # 907 เคส
npm run demo      # สนามทดลอง
npm run examples  # ตัวอย่าง request ทุกประเภท

npm run dev       # server + explorer ที่ http://localhost:3000 (DEV=1 · เครือข่ายจริงใช้ npm start + ADMINS + PRODUCER_KEY ดู HANDOFF หัวข้อ 1)
npm run seed      # สร้างข้อมูลตัวอย่างผ่าน HTTP (ต้องรัน server ไว้ก่อน)
```

`server.js` รวมทุกอย่างเข้าด้วยกัน: VM + mempool + autoreview + simulate + ปิด block อัตโนมัติ
และเสิร์ฟหน้า explorer จากโฟลเดอร์ `explorerscan/` (แต่งหน้าตาเองได้ ดู `explorerscan/README.md`) ตั้งค่าผ่าน env: `PORT`, `HOST`, `DATA`, `GENESIS`, `PRODUCER_KEY`, `ADMINS`, `BLOCK_MS`, `CHAIN_ID`, `TRUST_PROXY`, `EVM_RATE_LIMIT` … (ครบทุกตัวอยู่หัวไฟล์ `server.js`)
ยอดเงินตั้งต้นอ่านจาก `genesis.json`

## โครงสร้าง

```
src/
  core/virtualmachine.js   VM, Transaction, Block, Compiler — ตรรกะทั้งหมดของ chain
  core/autoreview.js       ตรวจโค้ดที่ผู้ใช้ส่งมาด้วยบัญชีขาว (ใช้แทนการรีวิวด้วยคน)
  storage/db.js            DB (LMDB) และ MemoryDB — readKeys / writeKeys / listKeys
  crypto/signature.js      EIP-712 บน secp256k1 — เซ็นและตรวจลายเซ็น
  node/
    mempool.js             คิว tx: rate limit, TTL, กัน tx ซ้ำ, เรียงตาม gasPrice
    sync.js                node ผู้อ่าน: ดึง block มารันเองแล้วเทียบ hash (เริ่มจาก snapshot ได้)
    snapshot.js            snapshot ของ state ณ block N (export / โหลดแบบตรวจกับ stateRoot)
  core/trie.js             Merkle Patricia Trie แบบ Ethereum — stateRoot + หลักฐาน (getProof / verifyProof)

server.js                  server จริง (node:http ไม่มี dependency เพิ่ม)
explorerscan/              หน้า explorer: theme/ (สี) · ui/ (หน้าตา) · core/ (ระบบ อ่านเชน / กระเป๋า) · README บอกว่าแก้ตรงไหน
genesis.json               ยอดเงินตั้งต้น (ช่วงพัฒนา · เปิดจริงใช้ deploy/genesis.mainnet.example.json)
deploy/                    เปิดเชนสาธารณะเครื่องเดียว: genesis + env ตัวอย่าง, nginx, systemd, cron, check.sh · อ่าน deploy/README.md
index.js                   จุดเข้าเดียว — import ทุกอย่างจากที่นี่ได้
scripts/                   demo.js, examples.js
program-sdk/               ชุดแยกสำหรับคนที่จะเขียนโปรแกรมมารันบน VM
client-sdk/                SDK ฝั่ง client: เซ็น + ส่ง tx + รอผล (ใช้ใน browser ได้ · import "programvm/client")
docs/                      Blockscout · checklist ลอง MetaMask จริง
test/                      104 ไฟล์ · 907 เคส
HANDOFF.md                 เอกสารส่งต่อโปรเจค — อ่านไฟล์นี้ก่อน
CHECKPOINT.md              ภาพ ณ Checkpoint 5 (ข้อมูลล่าสุดอยู่ใน HANDOFF.md)
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

ดูค่าตั้งต้นที่แนะนำทั้งหมดใน `CHECKPOINT.md` และวิธีเขียนโปรแกรมใน `program-sdk/README.md`

ดูเชนผ่าน Blockscout (ต่อเข้า `/evm`): `docs/blockscout.md`
