# Checkpoint 5

> เอกสารนี้คือภาพ ณ Checkpoint 5 · ข้อมูลล่าสุด (ไฟล์, env, สิ่งที่ค้าง) อยู่ใน `HANDOFF.md` — ถ้าสองไฟล์ขัดกันให้ยึด `HANDOFF.md`

สถานะ: เสถียร — เทสต์ 550 เคสผ่านทั้งหมด (`npm install` แล้ว `npm test`)

| ไฟล์ | บรรทัด | sha256 (16 ตัวแรก) |
|---|---|---|
| virtualmachine.js | ~2,000 | ca8737c988554f0a |
| db.js | 160 | 640235038481add0 |
| signature.js | 200 | 0032ca5d2f5685bd |
| mempool.js | 160 | 39c0ef6fe71850f7 |

## ไฟล์ในระบบ

```
src/core/virtualmachine.js   VM, Transaction, Block, Compiler
src/storage/db.js            DB (LMDB) + MemoryDB
src/crypto/signature.js      EIP-712 บน secp256k1
src/node/mempool.js          คิว tx: rate limit, TTL, เรียงตาม gasPrice
src/node/sync.js             node ผู้อ่าน + syncRoute()
src/node/simulate.js         ลองรัน tx ก่อนรับเข้าคิว
src/core/autoreview.js       ตรวจโค้ดด้วยบัญชีขาว
server.js                    server จริง (node:http) + ปิด block อัตโนมัติ
public/explorer.html         explorer ไฟล์เดียว
index.js                     จุดเข้าเดียว
scripts/                     demo.js, examples.js, seed.js, demo-market.js, demo-chain.js
program-sdk/ test/           ชุดเขียนโปรแกรมสำหรับคนนอก, เทสต์
```

## ตั้งค่าที่แนะนำสำหรับของจริง

```js
const vm = new VirtualMachine(new DB("./data", { mapSize: 100 * 1024 ** 3 }), {
  chainId: 1,
  requireNonce: true, chargeGas: true, deriveProgramAddress: true, forceOriginFromSender: true,
  recordTransactions: true, recordBlocks: true, recordHistory: true,
  bigintValues: true,
  gas: { call: 100, read: 100, write: 500, byte: 1, event: 200, hash: 100, recover: 3000, code: 10, price: 1 },
  feeRecipient: MINER, burnPercent: 50,
  maxTransactions: 500, maxTransactionsPerSender: 16, maxBlockGas: 3_000_000,
  maxCodeSize: 64 * 1024, maxKeySize: 1000, maxValueSize: 64 * 1024,
  admins: [ADMIN],
});
const mempool = new Mempool(vm, { maxPerSender: 16, maxSize: 5000, ttlMs: 5 * 60_000, rateLimit: 60 });
```

## tx ที่มี

| action | เมธอด | หมายเหตุ |
|---|---|---|
| call | `vm.call` | แนบ `value` ได้ |
| deploy | `vm.deploy` | แนบ `value` / `metadata` ได้, address = keccak256(deployer + nonce) |
| init / reject | `vm.init` / `vm.reject` | ทีมงานเซ็น, จำกัดด้วย `admins` |
| transfer | `vm.transfer` | โอน native ไม่เรียกโปรแกรม |
| metadata | `vm.setMetadata` | namespace / description ของตัวเอง |

## API ในโปรแกรม (18 ตัว)

```
readDB / writeDB / deleteDB / map
runProgram(target, method, input, { value })
transferNative / setMetadata / emit
keccak256 / ecrecover
ThisAddress / ThisBalance / BalanceOf / IsProgram / MetadataOf / BlockNumber
Date (เวลาของ block) / Math (random แบบ deterministic)
```

โครงสร้างโปรแกรม: ฟังก์ชันครอบตัวเดียว + `return { … }` ท้ายฟังก์ชัน รองรับ modifier (const ที่เป็นฟังก์ชัน)

## key ใน DB

```
pending:<id> | <id>:code | <id>:context | <id>:this | <id>:storage:<a>:<b>
<addr>:nonce | <addr>:native:received|sended|consumed | <addr>:metadata:<field>
namespace:<name> | <addr>:txn:<nonce>:<txhash> | txto:<addr>:<n>:<idx>:<callIdx> | event:<program>:<name>:<n>:<idx>:<i>
block:<n> | blockbody:<n> | blockundo:<n> | blockhash:<hash> | latestblock
tx:<txhash> | sigtx:<digest> | history:<dbKey>:<n>
0x000…000:native:received   (เงินที่ถูกเผา)
```

## ตัวเลขที่วัดจริง

| | |
|---|---|
| ปิด block 100 tx | 61ms |
| `replayBlock` block เก่า | 67ms คงที่ทุกระยะ |
| `stateAt` | อ่าน DB ≤3 ครั้ง |
| `rebuildFrom(150)` จาก 300 block | 1.4s |
| ขนาดต่อ block (100 tx เต็ม) | ~190 KB / 664 key |
| deploy โค้ด 1.4 KB | 13,960 gas |
| call ธรรมดา | ~1,300 gas |

## พฤติกรรมที่ล็อกไว้

- ไม่มีอะไรลง DB จนกว่าจะ commit
- timeout / DB พัง / แก๊สหมด → ทั้ง tx ล้ม โปรแกรม catch ไม่ได้
- `runProgram` ปลายทางล้มแล้ว catch → writes กับ event ของกิ่งนั้นถูกย้อน
- nonce ผิด → ไม่เข้า block ไม่กิน nonce ไม่เสียค่าแก๊ส
- tx ที่ล้มจากโปรแกรม → เข้า block กิน nonce และเสียค่าแก๊ส
- เกินเพดาน block → `LIMIT_EXCEEDED` ไม่เข้า block
- เวลาและ `Math.random()` ผูกกับ block + tx hash จึงรันซ้ำได้ผลเดิม
- address เป็นตัวพิมพ์เล็กเสมอ, `origin = sender` สำหรับ tx ของ user

## ⚠️ ที่ยังไม่ได้ทำ

**ก่อนเปิดให้คนนอก deploy**
- ไม่มี sandbox — โปรแกรมเข้าถึง global ของ Node ได้
- ค่ากลางในหน่วยความจำยังไม่ถูกจำกัด (`maxValueSize` กันเฉพาะตอนเขียน / return / emit)

**ก่อนมี node ที่สอง**
- node ผู้อ่านพร้อมแล้ว (`sync.js`) เหลือ gas แบบนับขั้นเพื่อปิดช่อง `while(true)` ที่ไม่แตะ DB

**งานครึ่งวันก่อนรันจริง**
- ~~ต่อ `mempool.js` เข้ากับ API จริง~~ ทำแล้วใน `server.js`
- ~~เปิด `recordHistory` + `bigintValues`~~ เปิดแล้วใน `server.js` (ล้าง DB เริ่มใหม่ถ้ามีข้อมูลเก่า)
- ทดสอบลายเซ็นกับ MetaMask จริง

**เมื่อถึงเวลา**
- rollback เร็ว, merkle tree
- factory (โปรแกรมสร้างโปรแกรม), การอัปเกรดโปรแกรม, มาตรฐานโทเคน
- native เป็น BigInt (ทำพร้อม gas แบบนับขั้น), ตัด history เก่า / snapshot
