# HANDOFF — Program VM + Explorer

เอกสารส่งต่อโปรเจคให้ agent หรือทีมอื่นทำงานต่อ อ่านไฟล์นี้ไฟล์เดียวแล้วทำงานต่อได้ทันที

> **สรุป 30 วินาที**
> blockchain ที่ smart contract เขียนด้วย JavaScript ธรรมดา เซ็น tx ด้วย EIP-712 (MetaMask ใช้ได้)
> VM เป็น sync ทั้งหมด + deterministic, เก็บข้อมูลลง LMDB แบบ key/value แบน
> มี server จริง (node:http) + explorer ไฟล์เดียว + ชุด SDK สำหรับคนเขียนโปรแกรม
> เทสต์ 550 เคสผ่านหมด **แต่ยังไม่มี sandbox จริงและยังไม่มี gas แบบนับขั้น → ยังไม่ควรเปิดให้คนนอก deploy**

| | |
|---|---|
| ภาษา / runtime | JavaScript (ESM), Node 22 เท่านั้น (`engines: >=22 <23`) |
| dependency | `@noble/curves`, `@noble/hashes`, `acorn`, `lmdb` (+`ethers` เป็น dev) |
| โค้ดทั้งหมด | ~4,200 บรรทัด (VM เอง 2,521) |
| ภาษาในโค้ด | comment / error message เป็นภาษาไทย ชื่อตัวแปรเป็นอังกฤษ — **รักษาสไตล์นี้ไว้** |
| เทสต์ | `npm test` → 550 เคส ใช้เวลา ~20 วินาที |

---

## 1. เริ่มต้นใน 2 นาที

```bash
npm install
npm test                         # 550 เคส ควรผ่านหมดก่อนเริ่มแก้อะไร

npm start                        # server + explorer ที่ http://localhost:3000 (ข้อมูลอยู่ใน memory)
node scripts/seed.js             # อีก terminal: สร้างโทเคนตัวอย่าง + tx ทุกประเภท
node scripts/demo-market.js      # ตลาด NFT + โทเคน + native, user 4 คน, ~23 block
```

สองสคริปต์ด้านบนรับ URL เป็น argument ตัวแรก (`node scripts/seed.js http://localhost:3100`)
`npm run seed` / `npm run demo:market` ก็เรียกได้แต่จะยิงไปที่ `http://localhost:3000` เท่านั้น

env ของ server: `PORT` `DATA` `MINER` `ADMINS` `BLOCK_MS` `CHAIN_ID` `TIMEOUT_MS` (ค่าเริ่ม 2000) `RATE_LIMIT` (POST ต่อ IP ต่อนาที ค่าเริ่ม 120, 0 = ไม่จำกัด)
ไม่ใส่ `DATA` = `MemoryDB` (หายเมื่อปิด), ใส่ = LMDB ที่ path นั้น
ยอดเงินตั้งต้นอ่านจาก `genesis.json` — key ของ address `0x7099…79c8` ที่ scripts ใช้คือ
`0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` (key ทดสอบของ Hardhat account #1)

สคริปต์อื่น: `scripts/demo.js` (สนามทดลองใน process เดียว), `scripts/examples.js` (ตัวอย่าง request ทุกประเภท), `scripts/demo-chain.js`

---

## 2. แผนผังไฟล์ — แก้อะไรต้องไปไฟล์ไหน

```
src/core/virtualmachine.js   2,521 บรรทัด  ตรรกะทั้งหมดของ chain (ดูหัวข้อ 4)
src/core/autoreview.js         201        ตรวจโค้ดด้วยบัญชีขาว — standalone ใช้ได้เอง
src/storage/db.js              212        DB (LMDB) + MemoryDB — readKeys / writeKeys / listKeys
src/crypto/signature.js        214        EIP-712 + secp256k1
src/node/mempool.js            140        คิว tx: rate limit, TTL, กันซ้ำ, เรียงตาม gasPrice
src/node/ratelimit.js           55        rate limit ต่อ key (server ใช้จำกัด POST ต่อ IP)
src/node/simulate.js            49        ลองรัน tx ก่อนรับเข้าคิว
src/node/sync.js                89        node ผู้อ่าน: ดึง block มารันเองแล้วเทียบ hash
server.js                      193        server จริง (node:http) — ตัวที่ใช้งานอยู่
public/explorer.html           414        explorer ทั้งหมดในไฟล์เดียว
index.js                         9        จุดเข้าเดียวสำหรับ import เป็น library
```

ทิศทางการพึ่งพาเป็นทางเดียวเสมอ **`node` → `crypto` → `core` → `storage`**
`core` ไม่รู้จักลายเซ็น / HTTP / คิว · `storage` ไม่รู้ความหมายของ key — อย่าทำให้ทิศทางนี้พัง

| อยากแก้เรื่อง | ไปที่ |
|---|---|
| ค่าแก๊ส, ตารางราคา | `DEFAULT_GAS` ท้ายหัวข้อ "ค่าที่ปรับบ่อย" ใน `virtualmachine.js` |
| ค่าตั้งต้นของ VM | `DEFAULT_OPTIONS` ในไฟล์เดียวกัน |
| ข้อความ error | `ERRORS` ในไฟล์เดียวกัน (ทุกข้อความรวมไว้ที่เดียว) |
| รูปแบบ key ใน DB | กลุ่มฟังก์ชัน `*Key()` ประมาณบรรทัด 430–490 + `decodeDbKey()` |
| โครงสร้างโปรแกรมที่ยอมรับ | `PROGRAM_WRAPPER_PATTERN` / `Compiler.parse` |
| API ที่โปรแกรมเรียกได้ | `PROGRAM_API_NAMES` + `createProgramApi()` + `PROGRAM_API` ใน `autoreview.js` (**ต้องแก้ทั้ง 3 ที่**) |
| กฎการตรวจโค้ด | `ALLOWED_NODES` / `ALLOWED_MEMBERS` / `BANNED_*` ใน `autoreview.js` |
| endpoint | `ROUTES` + `DYNAMIC` + `handlePost` ใน `server.js` |
| หน้าเว็บ | `public/explorer.html` |

### ส่วนที่มีสองชุดและต้องระวัง

**canonical JSON**: มีทั้งใน `virtualmachine.js` (`canonicalJson`) และเขียนซ้ำใน `explorer.html` (`canonical`)
**ถ้าแก้ตัวใดตัวหนึ่งแล้วไม่แก้อีกตัว ลายเซ็นจากหน้าเว็บจะใช้ไม่ได้ทั้งหมด**

(`src/node/routes.js` ตัวอย่าง Fastify และโฟลเดอร์ `client/` ที่ซ้ำกับ `program-sdk/` ถูกลบไปแล้ว — server จริงคือ `server.js` ตัวเดียว)

---

## 3. โครงสร้างโปรแกรม (smart contract)

โปรแกรมคือ **JavaScript ที่ valid ทั้งไฟล์ อยู่ใน scope เดียว** ส่งผ่าน API เป็น string ได้ตรง ๆ

```js
function program() {
  function initialization(params) {       // รันครั้งเดียวตอน init — เรียกจากภายนอกไม่ได้เด็ดขาด
    writeDB("owner", params.context.sender)
    writeDB(map("balances", params.context.sender), params.input.supply)
  }

  function helper() {}                    // ไม่อยู่ใน return = internal

  const onlyOwner = (fn) => (params) => { // modifier ใช้ได้ (const ที่มีค่าเป็นฟังก์ชัน)
    if (readDB("owner") !== params.context.sender) throw new Error("ไม่ใช่เจ้าของ")
    return fn(params)
  }

  const mint = onlyOwner(function (params) { /* … */ })

  function transfer(params) {
    const balance = readDB(map("balances", params.context.sender)) || 0n
    if (balance < params.input.amount) throw new Error("ยอดไม่พอ")
    // …
    emit("Transfer", { to: params.input.to, amount: params.input.amount })
    return true
  }

  return { transfer, mint }               // ← บรรทัดสุดท้าย: รายชื่อที่เรียกจากภายนอกได้
}
```

กติกา
- ชื่อฟังก์ชันครอบเป็นอะไรก็ได้ · `const program = () => { … }` ก็ได้ · **ห้าม `import` / `export`**
- `return { … }` ต้องเป็น**บรรทัดสุดท้าย**ของฟังก์ชันครอบ (regex จับท้ายไฟล์)
- ห้าม export `initialization`
- `params` ที่ทุกฟังก์ชันได้รับ: `{ input, context: { sender, origin }, value, block: { timestamp } }`
  (เลข block ไม่ได้อยู่ใน `params` — เรียก `BlockNumber()` แทน)

### params / ค่าที่ส่งกลับ — โหมด BigInt

เมื่อเปิด `bigintValues: true` (ซึ่ง `server.js` เปิดอยู่) **ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น**

- `10` → error `numberNotAllowed` · ต้องเขียน `10n`
- เก็บลง DB เป็น string `"123n"` แปลงกลับเป็น BigInt อัตโนมัติตอนอ่าน
- ค่าที่ออกไปทาง JSON ของ API ก็เป็น `"123n"` → **ฝั่ง client ห้ามใช้ `Number()`** ใช้ `BigInt(v.slice(0,-1))`
- ยกเว้น: ค่าของระบบ (gas, nonce, เลข block, timestamp, ยอด native) ยังเป็น `number` ปกติ
  **นี่คือหนี้ทางเทคนิคที่รู้อยู่** — native ยังติดเพดาน 2^53 (ดูหัวข้อ 9)

### API ในโปรแกรม (18 ตัว)

```
readDB(key) / writeDB(key, value) / deleteDB(key) / map(...parts)
runProgram(target, functionName, input, { value })      เรียกโปรแกรมอื่น
transferNative(to, amount)                              โอนเหรียญหลักจากโปรแกรม
setMetadata(field, value) / emit(name, data)
keccak256(value) / ecrecover(value, signature)
ThisAddress() / ThisBalance() / BalanceOf(addr) / IsProgram(addr) / MetadataOf(addr, field) / BlockNumber()
Date        เวลาของ block (Date.now() ได้ค่าเดียวกันทุก tx ใน block)
Math        random() ผูกกับ tx hash → รันซ้ำได้ผลเดิม
```

**เพิ่ม API ใหม่ต้องแก้ 3 ที่**: `PROGRAM_API_NAMES`, `createProgramApi()` (ทั้งคู่ใน `virtualmachine.js`) และ `PROGRAM_API` ใน `autoreview.js` — ถ้าลืมที่สาม autoreview จะปฏิเสธโค้ดที่ใช้ API ใหม่ว่า "ไม่รู้จัก"

---

## 4. ภายใน virtualmachine.js

4 class ในไฟล์เดียว:

| class | หน้าที่ |
|---|---|
| `VirtualMachine` | เจ้าของ option / DB, เมธอดสาธารณะทั้งหมด, สร้าง Block และ Transaction |
| `Block` | ชุด tx ที่จะ commit พร้อมกัน — คิดค่า hash, ประกอบ header/body, เขียน history |
| `Transaction` | tx หนึ่งใบ: cache การอ่าน, สะสม writes, นับค่าแก๊ส, รองรับ rollback ของกิ่ง |
| `Compiler` | แปลง string โค้ด → ฟังก์ชันที่เรียกได้ (`parse` + `compile`) |

### Compiler ทำงานยังไง (ส่วนที่แก้พลาดง่ายที่สุด)

`Compiler.parse()` ใช้ regex ไม่ใช่ AST:
1. ปฏิเสธถ้าเจอ `import`/`export` ขึ้นต้นบรรทัด
2. `PROGRAM_WRAPPER_PATTERN` ดึงเนื้อในฟังก์ชันครอบออกมาเป็น `body`
3. `RETURN_EXPORT_PATTERN` จับ `return { … }` **ท้ายสุด** → รายชื่อ export แล้วตัดบรรทัดนั้นออกจาก body
4. เก็บชื่อผู้สมัคร (`candidateNames`) จาก `function ชื่อ(` และ `const/let ชื่อ =` (ตัวหลังคือที่ทำให้ modifier ใช้ได้)

แล้วรันด้วย
```js
new Function("api", `"use strict";\nconst { readDB, writeDB, … } = api;\n${body}\n;return { … };`)
```
→ API ถูก destructure เป็น `const` ในขอบเขตเดียวกับโค้ด user (เขียนทับไม่ได้) แต่ **global ของ host realm ยังเอื้อมถึง** (ดูข้อจำกัดข้อ 1 ในหัวข้อ 11)

`isTopLevelDeclaration()` ใช้ trick ที่ควรรู้ก่อนแก้: ต่อ `let <ชื่อ>;` เข้าท้ายโค้ดแล้วคอมไพล์
ถ้า V8 ฟ้อง `'<ชื่อ>' has already been declared` = ชื่อนั้นถูกประกาศในระดับบนสุดจริง — ตรวจได้โดยไม่ต้องรันโค้ด
ผลลัพธ์ compile ถูก cache ตาม string โค้ด (`#cache`)

### วงจรชีวิตของ tx หนึ่งใบ

```
POST /sendtx
  → postLimiter.allow(ip)       จำกัด POST ต่อ IP → เกินตอบ 429
  → verifyTransaction()         ตรวจลายเซ็น → sender มาจากลายเซ็นเท่านั้น (ห้ามเชื่อ tx.from)
  → mempool.add(…, { simulate }) rate limit + โควตา + ลำดับ nonce ก่อน แล้วจึงเรียก simulate:
      reviewProgram(code)       เฉพาะ action deploy
      simulate(vm, verified)    รันใน block ทิ้ง (number:null, ไม่ commit) → ถ้า error ตอบ 400
                                ครั้งที่ simulate ไม่ผ่านก็ถูกนับใน rate limit ต่อ address
  ⏱ ทุก BLOCK_MS (3 วินาที)
  → vm.createBlock() → mempool.take(block) → block.commit()
```

`take()` เรียง tx ด้วย `sortPendingTransactions` (gasPrice มาก่อน) แล้วเช็ค `block.checkTransaction()` ทีละใบ

### เมธอดที่น่าจะต้องใช้

```js
// tx 5 ประเภท
vm.deploy({ programUuid?, code, context, initInput, value, metadata, nonce, gasLimit, gasPrice })
vm.init({ programUuid, context, … })      // ทีมงานอนุมัติ → รัน initialization
vm.reject({ programUuid, context, … })    // ปฏิเสธ + คืนเงิน
vm.call({ programUuid, functionName, input, context, value, … })
vm.transfer({ from, to, amount, … })
vm.setMetadata({ metadata, context, … })

// อ่านข้อมูล
vm.read(dbKey) / vm.listKeys(prefix, opts) / vm.listEntries(prefix, opts)
vm.getBlock(n) / vm.getBlockBody(n) / vm.getBlockByHash(h) / vm.listBlocks(opts) / vm.latestBlockNumber()
vm.getTransaction(hashOrDigest)           // รับได้ทั้ง VM hash และ EIP-712 digest
vm.listTransactionsOf(addr, opts)         // tx ที่ address ส่งออก
vm.listTransactionsTo(addr, opts)         // ใครมา interact (รวม runProgram ซ้อนชั้น)
vm.listEvents({ program, name, limit, start, reverse })
vm.listProgramStorage(addr, opts) / vm.nativeBalanceOf(addr) / vm.getMetadata(addr) / vm.resolveNamespace(name)

// query อ่านค่าโดยไม่เสียแก๊ส (readOnly: true, ไม่ commit)
vm.query({ programUuid, functionName, input, context, value })

// ย้อนหลัง / กู้ระบบ  (ต้องเปิด recordHistory)
vm.stateAt(blockNumber, dbKey)            // ค่าของ key นั้น ณ block นั้น — อ่าน DB ≤3 ครั้ง
vm.snapshotAt(blockNumber, prefix)        // ทั้ง prefix ณ block นั้น
vm.replayBlock(n, { verify })             // รัน block ซ้ำจาก blockbody → receipt เต็ม + เทียบ hash
vm.rebuildFrom(targetBlock, { verify })   // ย้อน state กลับไป block นั้นแล้วรันใหม่ทั้งหมด
vm.getBlockUndo(n)                        // รายชื่อ key ที่ block นั้นแตะ

// ตรวจก่อนรับ
vm.checkTransaction({ from, nonce })      // → { ok, expectedNonce, reason }
vm.applyGenesis(obj) / vm.genesisHash() / vm.checkGenesis(obj)
```

### Block

```js
const block = vm.createBlock({ timestamp, feeRecipient, number?, parentHash?, checkChain?, recordBlocks?, recordHistory? });
block.call(request)                       // และ deploy / init / reject / transfer / setMetadata
block.checkTransaction(request)           // เช็คโควตา + nonce ก่อนใส่จริง
block.header() / block.body() / block.hashes() / block.txHashes()
block.receipt({ number })                 // receipt ของทุก tx
block.writes()                            // writes สุดท้าย (1 รายการต่อ key) + history
block.commit()                            // เขียนทีเดียวผ่าน db.writeKeys (atomic)
```

### ค่าแก๊ส

```
call 100 · read 100 · write 500 · byte 1 · event 200 · hash 100 · recover 3000 · code 10/byte · price 1
```
ผู้จ่ายคือ sender ชั้นนอกสุดเสมอ · `gasLimit` / `gasPrice` ส่งมาเองได้
เผาทิ้ง `burnPercent` (server ใช้ 50) → **โอนเข้า `0x000…000` ไม่ได้หายไปเฉย ๆ** ที่เหลือเข้า `feeRecipient`

### พฤติกรรมที่ล็อกไว้แล้ว (เทสต์คุมอยู่ — อย่าทำให้พัง)

- ไม่มีอะไรลง DB จนกว่าจะ `commit()`
- timeout / DB พัง / แก๊สหมด → ทั้ง tx ล้ม โปรแกรม `catch` ไม่ได้
- `runProgram` ปลายทางล้มแล้วผู้เรียก catch → writes + event ของกิ่งนั้นถูกย้อน
- **nonce ผิด / เกินโควตา / timeout → ไม่เข้า block ไม่กิน nonce ไม่เสียแก๊ส** (`accepted: false`)
- **โปรแกรม throw / เงินไม่พอ → เข้า block กิน nonce เสียแก๊ส** (`status: "throw"`, `accepted: true`)
- `parentHash` ต่อกันเสมอ · เลข block ซ้ำไม่ได้ · timestamp ต้องมากกว่า block ก่อน
- tx ซ้ำ (hash เดิม) เข้าไม่ได้ · rejected tx ไม่เขียนทับ `tx:<hash>` ของใบที่สำเร็จ
- เวลาและ `Math.random()` ผูกกับ block + tx hash → replay ได้ผลเดิมเป๊ะ
- error ของ V8 ถูก sanitize ก่อนเก็บ (ข้อความจริงไปอยู่ใน `debug` ซึ่ง**ไม่ถูกบันทึกลง DB**) เพื่อให้ replay ตรง
- address เป็นตัวพิมพ์เล็กเสมอ · `origin = sender` สำหรับ tx ของ user

---

## 5. key ใน DB ทั้งหมด

LMDB เก็บเป็น key/value แบน key เป็น string คั่นด้วย `:` ค่าเป็น JSON

### state ของ address / โปรแกรม
```
pending:<id>                        โปรแกรมที่ deploy แล้วรอ init  { code, context, initInput, metadata, value }
<id>:code                           โค้ด (string escape แล้ว)
<id>:context                        { sender, origin } ตอน deploy
<id>:this                           address ของตัวเอง — ใช้เช็คว่า address นี้เป็นโปรแกรม
<id>:storage:<a>:<b>:…              ข้อมูลของโปรแกรม (ส่วนที่ map() สร้าง, URI-encode ต่อ part)
<addr>:nonce                        ลำดับ tx ถัดไป
<addr>:native:received|sended|consumed    ตัวนับสะสม เพิ่มได้อย่างเดียว
<addr>:metadata:<field>             namespace / description / type / creator / createdAt
namespace:<name>                    ชื่อ → address (ห้ามซ้ำทั้งระบบ)
```

**ยอดคงเหลือ = received − sended − consumed** (`consumed` = ค่าแก๊สที่จ่ายไป) ไม่มี key ที่เก็บยอดสุทธิ
ออกแบบให้ทุกค่าเพิ่มทางเดียว เพื่อให้ tx ที่ไม่เกี่ยวกันไม่แย่ง key เดียวกัน

### chain / ดัชนี
```
block:<n>              header (เลข n เติมศูนย์ 12 หลัก ทุก key ที่มีเลข block)
blockbody:<n>          tx ดิบทุกใบ [{ action, method, request }] → replay สร้าง state ใหม่ได้ทั้งหมด
blockundo:<n>          รายชื่อ key ที่ block นั้นแตะ
blockhash:<hash>       hash → เลข block
latestblock            เลข block ล่าสุด
tx:<vmhash>            { hash, digest, blockNumber, index, action, status, from, nonce }
sigtx:<digest>         EIP-712 digest → vm hash (ทำให้ค้นด้วย hash ที่ user เซ็นได้)
txto:<addr>:<n>:<idx>:<callIdx>    ดัชนี "ใครมา interact กับ address นี้"
event:<program>:<name>:<n>:<idx>:<i>   ดัชนี event
holding:<addr>:<program>   ดัชนี "address นี้เคยได้/ส่งเหรียญของโปรแกรมนี้" จาก event Transfer (from/to) ของ tx ที่สำเร็จ · ต้อง recordBlocks
history:<dbKey>:<n>    ค่า**ก่อน**เปลี่ยน { existed: false } หรือ { existed: true, before }
0x000…000:native:received    ยอดเหรียญที่ถูกเผาทั้งหมด
```

`txto` ที่ `callIdx > 0` คือการถูกเรียกแบบซ้อนชั้นผ่าน `runProgram` และมี `depth` + `via` เพิ่ม
(นี่คือสิ่งที่ทำให้ explorer เห็นว่าโทเคนถูก `transferFrom` จากตลาด)

`history:` ออกแบบให้ `stateAt(block, key)` ทำงานด้วยการ seek ครั้งเดียว:
หา `history:<key>:<n'>` ตัวแรกที่ `n' > block` ถ้าไม่มี = ค่าปัจจุบัน ถ้ามี = ค่า `before` ของตัวนั้น
→ ไม่ต้องไล่ย้อนทีละ block **ข้อมูลของ chain เอง (block/ดัชนี) ไม่เก็บ history** เพราะสร้างใหม่จาก body ได้

`maxKeySize: 1000` ตั้งไว้เพราะ `history:` ต้องเอา key ไปซ้อนเป็น prefix

ดูขนาดจริง: block ที่มี 100 tx เต็ม ≈ 190 KB / 664 key

---

## 6. ลายเซ็น (EIP-712)

```js
import { signTransaction, verifyTransaction, buildTypedData, hashTypedData, addressOf } from "programvm/signature.js";

const tx = { chainId: 1, action: "call", from, to: program, method: "transfer",
             input: { to: bob, amount: "100n" }, value: 0, nonce, gasLimit: 500000, gasPrice: 1 };
const signature = signTransaction(tx, privateKey);       // ฝั่ง wallet
const { action, method, sender, hash, request } = verifyTransaction({ tx, signature });  // ฝั่ง server
vm[method](request);
```

- domain `{ name: "ProgramVM", version: "1", chainId }`
- field ที่เซ็น **ลำดับห้ามสลับ**: `action, from, to, method, input, value, nonce, gasLimit, gasPrice`
- `input` และ `code` ถูกยุบเป็น string เดียวด้วย `canonicalJson({ input, code })` → เซ็นข้อมูลชนิดไหนก็ได้
- `action` ที่รับ: `call` `deploy` `transfer` `metadata` `init` `reject`
  → `VM_METHOD` map ไปเป็นเมธอดของ VM (`metadata` → `setMetadata`)
- `sender` มาจากการ recover ลายเซ็น**เท่านั้น** `tx.from` ใช้เทียบอย่างเดียว

### tx มี 2 hash ค้นได้ทั้งคู่
| | มาจาก | ใช้ |
|---|---|---|
| `hash` | VM คำนวณจาก request | key ใน DB, `txHashes` ของ block |
| `digest` | EIP-712 ที่ user เซ็น | สิ่งที่ wallet แสดงให้ user เห็น — **ควรโชว์ตัวนี้เป็นเลขที่ tx** |

`GET /tx/:x` และ `vm.getTransaction(x)` รับได้ทั้งสอง (ผ่าน `sigtx:`)

---

## 7. HTTP API (server.js)

ทุก response เป็น JSON · BigInt ถูก serialize เป็น `"123n"` · CORS เปิดกว้าง (`*`)
`limit` สูงสุด 200 (ค่าตั้งต้น 20) · **รูปแบบ response ละเอียดอยู่ใน `EXPLORER-SPEC.md` หัวข้อ 4**

### อ่าน
| endpoint | คืน |
|---|---|
| `GET /genesis` | `{ hash, chainId, latest, pending, burned }` — explorer poll ทุก 3 วิ |
| `GET /blocks?before&limit` | header ย้อนหลัง |
| `GET /block/latest` | header ล่าสุด |
| `GET /block/:n` | header · `?full=1` → `replayBlock()` receipt เต็ม (409 ถ้า hash ไม่ตรง) |
| `GET /tx/:hashOrDigest` | ดัชนี + `record` · ถ้าอยู่ในคิว → `{ status: "pending" }` |
| `GET /tx/:hash/receipt` | receipt จากการ replay block นั้น + `blockNumber` |
| `GET /address/:a` | native, nonce, metadata, isProgram, transactions, incoming |
| `GET /program/:a` | code, context, metadata, native, storage (50 แรก), interactions, events, `token` (null ถ้าไม่ใช่ token ตามมาตรฐาน) |
| `GET /address/:a/tokens` | เหรียญที่ถือ `[{ address, name, ticker, decimals, totalSupply, balance }]` · ยอด 0 ไม่แสดง |
| `GET /token/:a` | `{ address, name, ticker, decimals, totalSupply }` · 404 ถ้าไม่ใช่ token |
| `GET /program/:a/storage?prefix&start&limit` | `{ items, next, prefix }` — cursor pagination |
| `GET /program/:a/groups` | `{ total, groups: [{ name, count }] }` — ⚠️ นับได้สูงสุด 5,000 key |
| `GET /nonce/:a` | nonce ถัดไป **รวมใบที่รออยู่ในคิว** — ใช้ตัวนี้ตอนสร้าง tx |
| `GET /name/:ns` | namespace → address |
| `GET /state/:a?block` | state ของโปรแกรม ณ block นั้น (`snapshotAt`) |
| `GET /events?program&name&limit` | event |
| `GET /pending` | `{ size, transactions }` |
| `GET /sync?from` | `[{ header, body }]` สูงสุด 50 block — ให้ node ผู้อ่านดึง |

**แบบแบ่งหน้า** (explorer ใช้ทุกรายการยาว) · `?page=<เริ่ม 1>&limit=<≤100, ค่าเริ่ม 20>` → `{ items, total, page, pages, limit, truncated }`
page เกินหน้าสุดท้าย → ได้หน้าสุดท้าย · นับ key ไม่เกิน 50,000 ตัวต่อรายการ (`PAGE_SCAN`) เกินแล้ว `truncated: true`
โค้ดอยู่ `src/node/explorer-api.js` (`pageOf` `slicePage` `page*`) · เทสต์ `49-explorer-paging`

| endpoint | รายการ |
|---|---|
| `GET /blocks/page` | header ใหม่ไปเก่า (คำนวณจากเลข block ไม่ไล่ key) |
| `GET /address/:a/txs` | tx ที่ address ส่ง · **เรียงด้วยเลข nonce** (key `txn` ไม่ได้เติม 0 ข้างหน้า เรียงตามตัวอักษรจะผิดตั้งแต่ nonce 10) |
| `GET /address/:a/incoming` | tx ที่เข้ามาหา (ดัชนี `txto:` รวมการเรียกซ้อนชั้น) |
| `GET /program/:a/events?name` | event ใหม่ไปเก่า |
| `GET /program/:a/entries?name` | key 2 ชั้นของกลุ่ม `name` (ข้าม key 3 ชั้น) |
| `GET /token/:a/holders` | ผู้ถือจาก `balances:<address>` ของโปรแกรม · ข้ามยอด 0 · ยอดมากไปน้อย · 404 ถ้าไม่ใช่ token |

**trace ใน receipt** (`/tx/:h/receipt` → `trace[]`): `{ depth, program, method, from, origin, input, value, result, gasUsed, status, error }`
`input` / `value` / `result` / `gasUsed` เพิ่มเมื่อ 9 ต.ค. (เก็บใน `tx.calls` ตอนรัน ไม่ได้เขียนลง DB และไม่เข้า hash ของ block)
`gasUsed` ของชั้นนอกรวมของชั้นในแล้ว · ข้อความ error ของ server เป็นภาษาอังกฤษ (ข้อความ error จาก VM / โปรแกรมยังเป็นไทยตามเดิม)
| `GET /` หรือ `/explorer` | หน้า explorer |

### เขียน
```
POST /sendtx   { tx, signature }
  200 → { queued: true, hash, sender, simulation }
  400 → { queued: false, error | issues | simulation }      ลายเซ็นผิด / autoreview ไม่ผ่าน / simulate ล้ม / คิวไม่รับ

POST /query    { programUuid, functionName, input, context?, value? }
  200 → { status: "success", result, gasUsed, events, calls, loadValues, afterValues, readOnly: true }
  400 → ผลที่ status ไม่ใช่ success
```

`/sendtx` **คืน error ก่อนเข้าคิวเสมอ** ถ้า simulate ไม่ผ่าน (user จะไม่เสียเวลารอใบที่ล้มแน่ ๆ)
`simulate` รันบน state ปัจจุบันของ DB ไม่นับผลของใบที่รออยู่ในคิว → เป็นการ "ประเมิน" ไม่ใช่รับประกัน

---

## 8. Explorer (`public/explorer.html`)

ไฟล์เดียว ~900 บรรทัด **ภาษาอังกฤษทั้งหน้า** (เทสต์ e2e ตรวจว่าไม่มีอักษรไทยนอกจากข้อมูลของผู้ใช้) ไม่มี build step ไม่มี framework ไม่มี dependency ภายนอก
HTML + CSS + JS ในไฟล์เดียว เสิร์ฟจาก `GET /` ของ `server.js`

### โครง
- routing ด้วย `location.hash` → `render(soft)` แยกไปที่ `home()` / `block(n)` / `tx(h)` / `address(a)`
  `soft` = วาดใหม่ในที่เดิม (เปลี่ยนหน้า / แท็บ) ไม่ขึ้น Loading และคงตำแหน่ง scroll
  ทุก render มีเลขลำดับ (`renderSeq`) — มีแค่ render ล่าสุดที่วาดได้ (กันหน้าเก่าที่โหลดช้ามาทับหน้าใหม่)
- `cut()` ย่อ address / hash เป็น `0x1234…abcd` (4 ตัวหน้า 4 ตัวหลัง) ในตาราง · หน้ารายละเอียดแสดงเต็มด้วย `full()` (ตัดบรรทัดบนจอเล็ก)
- แบ่งหน้า: `pager(res, "setPage('id',$)")` ใต้ทุกรายการยาว → ปุ่มเลขหน้า (หน้าแรก / สุดท้าย / ±2 รอบหน้าปัจจุบัน) + ‹ › + ช่อง Go to
  `pageState[hash|id]` จำเลขหน้าต่อหน้า explorer และต่อรายการ · รายการที่มาทั้งก้อน (tx ใน block, เหรียญที่ถือ) ตัดหน้าในเบราว์เซอร์ (`slicePage`)
- helper เล็ก ๆ: `esc` `cut` `num` `when` `ago` `copy` `addr` `txLink` `panel` `table` `kv`
  **`num()` คือตัวแปลง `"123n"` → ตัวเลขอ่านง่าย — ทุกค่าที่มาจากโปรแกรมต้องผ่านตัวนี้**
- ธีม: โทนมืด ดำ/น้ำเงิน/ม่วง ธีมเดียว (`color-scheme:dark`) · `--bg:#070814` `--panel:#0e1026` `--accent:#7aa2ff` `--accent-2:#a78bfa`
  `--grad` (น้ำเงิน→ม่วง) ใช้กับแท็บที่เลือก / ปุ่มหลัก · กล่อง JSON / โค้ด / ผลลัพธ์ = `#04050d`
- responsive รองรับจอกว้าง 180px ขึ้นไป (เทสต์ e2e "responsive" วัด 180/240/360/768/1280 ว่าไม่มีอะไรล้นหรือถูกตัด)
  - `table()` ห่อด้วย `.twrap` (ตารางกว้างกว่าจอ → เลื่อนในกรอบ ไม่ดันทั้งหน้า) และใส่ class `grid`
  - ≤640px: ตาราง `.grid` เป็นการ์ดแถวละใบ · `labelCells()` ใส่ `data-label` จากหัวตาราง + ห่อค่าใน `.cv` (เรียกใน `el()` และ `drawStorage()`)
    หัวตารางที่มี `<select>` (dropdown storage) ยังแสดง · ตาราง `kv` ซ้อนชื่อไว้บนค่า · แท็บขึ้นบรรทัดใหม่แทนเลื่อนข้าง · หัวเว็บไม่ sticky
  - ≤360px: ชื่อคอลัมน์อยู่บนค่า, ระยะขอบ 8px, ช่องค้นหา/ปุ่ม wallet เต็มบรรทัด
  - ตัวช่วยวัดเอง: เปิดทุกหน้าแล้วหา element ที่เลยขอบ `.panel` โดยไม่มีกรอบเลื่อน (ดูโค้ดในเทสต์ e2e)
- ทุก address / hash คลิกได้ + มีปุ่มคัดลอก (`⧉`)
- poll `/genesis` ทุก 3 วินาที อัปเดตเลข block กับขนาดคิวที่หัวเว็บ

### หน้า address / โปรแกรม — แท็บ
`tabs(groups)` + `tabState[location.hash]` จำแท็บที่เลือกต่อ URL

| แท็บ (`data-tab`) | เนื้อหา |
|---|---|
| Tokens (`tokens`) | (เฉพาะกระเป๋าที่ถือเหรียญ · แท็บแรก) ticker, ยอดหารด้วย 10^decimals |
| Holders (`holders`) | (เฉพาะโปรแกรม token) อันดับ, address, ยอด, % ของ supply · `/token/:a/holders` ทีละ 25 |
| Calls / Incoming (`in`) | `/address/:a/incoming` (รวมซ้อนชั้น มี badge "Nested · depth N") |
| Outgoing (`out`) | `/address/:a/txs` |
| Interact (`interact`) | (โปรแกรม) ฟอร์ม — เลือกฟังก์ชัน, input JSON, value |
| Edit metadata (`meta`) | (กระเป๋า) ฟอร์มแก้ metadata อยู่แถบเดียวกับ Interact (เดิมเป็นปุ่มในแถว information) |
| Events (`event`) | `/program/:a/events` |
| Storage (`storage`) | แยกตามจำนวนชั้นของ key: Variables / Maps / Lookup (ดูด้านล่าง) |
| Code (`code`) | source |

กดแท็บที่เปิดอยู่แล้วไม่วาดใหม่ (ค่าที่พิมพ์ในฟอร์มไม่หาย)

### หน้า tx — Program calls
`traceView()` เป็นแผนผังย่อ: กล่องเล็กละ call ในกล่องมีแค่เลขลำดับ (กรอบแดง = call นั้นล้ม · tooltip = program.method())
วางเป็นต้นไม้จากบนลงล่าง: ชั้นละ depth · call ที่ถูกเรียกอยู่ใต้ผู้เรียก พี่น้องเรียงซ้าย→ขวาตามลำดับที่เกิด · ใบไม้ละ 1 คอลัมน์ (`slot`) ผู้เรียกอยู่กึ่งกลางเหนือลูกคนแรกกับคนสุดท้าย
แผนผังอยู่กึ่งกลางกรอบทั้งแนวนอนและแนวตั้ง · กล่องบนสุด "tx" (เส้นประ) = ผู้ส่ง tx · ลูกศร SVG จากผู้เรียก → ผู้ถูกเรียก (เส้นแดงเมื่อ call นั้นล้ม)
ผู้เรียกของแต่ละ call = call ก่อนหน้าที่ตื้นกว่า 1 ชั้น (`traceParents()` เพราะ trace มาเรียงแบบ depth-first)
กดกล่อง → `pickCall(i)` แสดงรายละเอียดของ call นั้นใต้แผนผัง (`callDetail`: caller → program.method(), gas, value, origin, Input, Result/Error) · เปิดหน้ามาแสดง #1
ขนาดกล่องตามความกว้างจอ (`flowSize()`: กล่อง 28px คอลัมน์ 40px แถว 46px / ≤260px = 24 / 32 / 40)
จอกว้าง: แผนผังอยู่ซ้าย (สูงสุด 40% ของความกว้าง · สูงเกิน 70vh เลื่อนในกรอบ) รายละเอียดอยู่ขวาและสูงเท่าแผนผังพอดี (`.calls-body` stretch + `contain:size` บน `#call-detail` เนื้อหายาวกว่าเลื่อนในกล่อง · แถวสูงอย่างน้อย 200px) · จอ ≤720px วางซ้อนกันบน-ล่าง แผนผังที่กว้างกว่าจอเลื่อนข้างในกรอบ `.flowwrap`
ชื่อ namespace (โชวในรายละเอียดและ tooltip) ดึงจาก `/address/:a?limit=1` ของทุก address ใน trace (ไม่เกิน 30) ตอนเปิดหน้า tx

### แถบ "ข้อมูล" ของโปรแกรม
แยก key ตามจำนวนชั้น (`src/node/explorer-api.js` · เทสต์ `47-explorer-storage`)

| แถบย่อย | key | แสดง | API |
|---|---|---|---|
| Variables (`info`) | 1 ชั้น (`owner`, `price`) | ทุกตัวพร้อมค่า | `/program/:a/layout` → `variables` |
| Maps (`storage`) | 2 ชั้น (`balances:<address>`) | dropdown key แรกอยู่ที่หัวคอลัมน์แรกของตาราง → list key ที่ 2 + ค่า ทีละ 25 พร้อมเลขหน้า | `/program/:a/entries?name=&page=` |
| Lookup (`get`) | 3 ชั้นขึ้นไป (`allow:<a>:<b>`) | ไม่ list · ฟอร์มแนวตั้ง: key 1 dropdown, key 2, 3… ช่องละบรรทัด · `+ key` / `− key` → อ่านทีละตัว | `/program/:a/get?key=…&key=…` |

- `layout` ไล่ key ไม่เกิน 20,000 ตัว (`SCAN_LIMIT`) เกินแล้วตอบ `truncated: true` และหน้าเว็บบอกว่านับไม่ครบ
- กลุ่มเดียวกันมีทั้ง 2 และ 3 ชั้นได้ (`mixed:a` กับ `mixed:a:b`) → ขึ้นทั้งใน storage และ get storage
- `storageView` จำแถบ / key ที่เลือก / ผลที่อ่านไว้ ตราบที่ยังอยู่โปรแกรมเดิม · `readKeys()` เก็บค่าที่พิมพ์ก่อนวาดใหม่ (กด `+` แล้วค่าไม่หาย)
- `/program/:a/groups`, `/program/:a/storage`, `/program/:a/map` (cursor) และ `/blocks?before` เดิมยังอยู่ (หน้าเว็บไม่ได้ใช้แล้ว)

### การแสดงค่า
- ค่าที่เป็น object/array ทุกที่ (input, ผลลัพธ์, event, ค่าใน storage) → `json(v)` กล่องดำ `pre.json` ลงสีแบบ JSON · `"123n"` แสดงเป็นตัวเลข
- key หลายชั้น → `keyChips(parts)` badge สี่เหลี่ยมต่อกัน (แทน `a / b / c`)
- ค่าแก๊ส `gas(v)` มีไอคอนสายฟ้า · เลข block `blockNo(n)` มีไอคอนกล่อง (ลิงก์ไปหน้า block)
- ยอดเหรียญ `units(raw, decimals)` · ค่าที่มาจาก storage ต้องผ่าน `attr()`/`esc()` เสมอ (key มาจากโปรแกรม)

### มาตรฐาน token (`src/standards/token.js` · เทสต์ `48-token-standard`)
ฟังก์ชัน `name ticker decimals totalSupply balanceOf allowance transfer approve transferFrom`
ฟังก์ชันเสริมใน `TOKEN_PROGRAM` (ไม่บังคับในมาตรฐาน): `multiTransfer({ transfers: [{ to, amount }] })` โอนหลายกระเป๋าใน tx เดียว (≈1,400 gas ต่อรายการ) · ข้อความ error เป็นภาษาอังกฤษ + `emit("Transfer", {from,to,amount})` / `emit("Approval", {owner,spender,amount})`
mint ตอน init emit Transfer จาก zero address · `checkTokenStandard(code)` ตรวจจาก `return { … }` + `emit(` ในโค้ด
`TOKEN_PROGRAM` คือโปรแกรมตัวอย่าง (seed ใช้ 6 decimals) · input ตอน deploy: `{ name, ticker, decimals, supply, namespace?, icon?, url?, contact?, description? }`
เหรียญที่ถือ = ดัชนี `holding:` (บอกว่าโปรแกรมไหน) + `balanceOf` ตอนเปิดหน้า (ยอดจริง) → ยอด 0 ไม่แสดง
ไม่เก็บยอดสะสมจาก event เพราะ rebuild block แล้วจะนับซ้ำ · โปรแกรมที่ emit Transfer แต่ไม่ผ่านมาตรฐานไม่ถูกแสดง

### metadata ในหน้า address / โปรแกรม
| แถว | มาจาก | แสดง |
|---|---|---|
| information | `icon` + `namespace` | ไอคอนสี่เหลี่ยมจัตุรัส (`avatar()`: รูป https:// หรือ data:image · emoji · ไม่มี = ตัวแรกของชื่อ) + ชื่อ |
| คำอธิบาย | `description` | ข้อความ |
| links | `url` + `contact` | ลิงก์ออกไปข้างนอก (`target=_blank rel=noopener noreferrer nofollow`) |

- `safeHref()` ยอมเฉพาะ `https?://` · `mailto:` · `tel:` และอีเมลล้วน (→ `mailto:`) อย่างอื่นแสดงเป็นข้อความ ไม่ทำลิงก์ (กัน `javascript:`)
- แท็บ "Edit metadata" มีเฉพาะหน้ากระเป๋า (อยู่แถบเดียวกับ Interact): ฟอร์ม icon / namespace / คำอธิบาย / url / contact → `sendTx({ action: "metadata", input })`
  ส่งเฉพาะช่องที่เปลี่ยน · ช่องที่ล้างว่าง = `null` (ลบ) · wallet ต้องเป็น address ของหน้านั้น (VM ใช้ผู้เซ็นเป็น address เสมอ)
- โปรแกรมไม่มีแท็บแก้ไข (ผู้ใช้เลือกไว้ 9 ต.ค.: ตั้งได้เฉพาะของตัวเอง) → metadata ของโปรแกรมตั้งจากโค้ดด้วย `setMetadata`
  `TOKEN_PROGRAM` รับ `icon` / `url` / `contact` / `description` ใน input ตอน deploy (seed ใช้ไอคอน data:image)

### ไอคอน address
ทุก address ที่ผ่าน `addr()` มีไอคอน: คน = กระเป๋าผู้ใช้ · คอมพิวเตอร์ (สีม่วง) = โปรแกรม
วัดจาก "มีโค้ดที่ address นั้น" (`<address>:code`) หรือ deploy แล้วรอ init (`pending:<address>`)
`decorate()` ถูกเรียกทุกครั้งที่วาดหน้า รวบ address ที่ยังไม่รู้ไปถาม `/is-program?addresses=a,b,c` ทีเดียว (ครั้งละ ≤ 200) · จำไว้เฉพาะตัวที่เป็นโปรแกรม

### wallet connect
`eth_requestAccounts` → `eth_signTypedData_v4` → `POST /sendtx`
`callableOf(code)` อ่านชื่อฟังก์ชันจาก `return { … }` ท้ายโค้ดด้วย regex
`runQuery()` ไม่ต้องต่อ wallet · `runWrite()` ต้องเซ็น แล้วเด้งไปหน้า tx หลัง 2.5 วิ

⚠️ `canonical()` ในหน้าเว็บ**ต้องตรงกับ `canonicalJson()` ใน VM เป๊ะ ๆ** (เรียง key, bigint → `"123n"`)
และ `signingInput()` ต้องทำ hex ใน input เป็นตัวพิมพ์เล็กแบบเดียวกับ `normalizeTransaction()` ใน `signature.js`
ไม่ตรง = digest ไม่ตรง = ลายเซ็นใช้ไม่ได้ทุกใบ (`test/46-explorer-canonical.test.js` คุมอยู่)

---

## 9. autoreview — ตรวจโค้ดแทนคน

`src/core/autoreview.js` อยู่ได้ด้วยตัวเอง (ต้องการแค่ `acorn`) ยกไปใช้ที่ไหนก็ได้

```js
import { reviewProgram } from "./src/core/autoreview.js";
const r = reviewProgram(code);     // { ok, issues: [{ line, column, message }], message }
```

**ทำงานที่ `/sendtx` ก่อนเข้า VM** ไม่ใช่ข้างใน VM (VM มี option `autoReview` แยกไว้ด้วยแต่ `server.js` ไม่เปิด)

หลักการคือ **บัญชีขาว** — อนุญาตเฉพาะที่ระบุ ที่เหลือปฏิเสธหมด จึงไม่ต้องไล่ห้าม `process` / `fetch` / `eval` ทีละตัว

| ห้าม | เหตุผล |
|---|---|
| identifier ที่ไม่รู้จัก (`process`, `require`, `globalThis`, `fetch`, `eval`, `Function`) | ไม่อยู่ในบัญชีขาว |
| `.constructor` `.prototype` `.__proto__` `.caller` `.arguments` `.stack` | ประตูหนีออกจาก sandbox / ไม่ deterministic |
| `obj[key]` (computed member) | หลบการตรวจชื่อ property ได้ |
| `class` `async/await` `generator` `this` `for…in` `with` · regex · tagged template | ไม่ deterministic หรือหนีขอบเขต |
| `new` ที่ไม่ใช่ `Error` / `Date` | — |
| getter / setter / method ใน object literal | — |
| `.repeat` `.padStart` `.padEnd` `.sort` `.bind` `.call` `.apply` `.toLocale*` `.normalize` | สร้างข้อมูลใหญ่ด้วยคำสั่งเดียว หรือผลต่างกันตาม locale/engine |
| ชื่อที่ขึ้นต้น `__` | — |
| เมธอดของ global ที่ไม่อยู่ใน `ALLOWED_MEMBERS` | เช่น `Object.defineProperty`, `Math.sin` |

ตรวจจริงผ่าน HTTP:
```
code: function program() { function evil(p) { return process.env } return { evil } }
→ 400 { "error": "โค้ดไม่ผ่านการตรวจ",
        "issues": [{ "line": 2, "message": "'process' ไม่รู้จัก (ใช้ได้เฉพาะ API ของ VM และตัวแปรที่ประกาศเอง)" }] }
```

**ข้อจำกัดที่ต้องเข้าใจ**: autoreview กันโค้ด *ที่เขียนตรง ๆ* ว่าอันตราย แต่ไม่ใช่ sandbox
ถ้ามีช่องที่หลุด (`ALLOWED_NODES` เพิ่มชนิดใหม่โดยไม่คิด, ช่องของ V8 เอง) โปรแกรมยังเข้าถึง global ของ Node ได้
และกัน `while(true)` ที่ไม่แตะ DB ไม่ได้ — มีแค่ `timeoutMs` คุมอยู่

---

## 10. เทสต์

`test/` 44 ไฟล์ · 550 เคส · `node --test` ล้วน ไม่มี framework
`test/helpers.js` (ตัวช่วย + assert ชุด key ของผลลัพธ์) · `test/programs.js` (โปรแกรมตัวอย่างที่ใช้ร่วมกัน)

ไฟล์เรียงตามหัวข้อ `01`–`44` เริ่มจากพื้นฐานไปซับซ้อน ตัวที่ควรรู้:

| ไฟล์ | คุม |
|---|---|
| `09-determinism` | รันซ้ำได้ผลเดิม (เคยพังเพราะ `init` เขียน `createdAt` จากนาฬิกาจริง — ต้องส่ง `timestamp` คงที่) |
| `26-signature` `27-metamask-compat` | EIP-712 ตรงกับ `ethers` |
| `30-block-body-replay` `34-history-replay` | replay / stateAt / rebuildFrom |
| `31-chain-safety` | parentHash, block ซ้ำ, timestamp ถอยหลัง, tx ซ้ำ |
| `33-limits-admin` | โควตา tx ต่อ block / ต่อ user, สิทธิ์ init/reject |
| `38-reentrancy` | reentrancy + pattern ปลอดภัย |
| `40-bigint` | โหมด BigInt ทั้งระบบ |
| `43-autoreview` | กฎทุกข้อของตัวตรวจ |
| `44-complex-scenario` | token + market ครบวงจร: approve/transferFrom, native deposit/withdraw, rollback ซ้อน, invariant ว่าเงินไม่หาย |

`test/e2e/explorer.e2e.js` (`npm run test:e2e`) เปิด explorer ใน Chromium จริงกับ `server.js` จริง: ไล่ทุกหน้า, อ่านค่า, เซ็น tx ด้วย wallet จำลอง
ใช้ `playwright` (devDependency) — ในเครื่องที่ยังไม่มีเบราว์เซอร์ให้รัน `npx playwright install chromium` ก่อน · CI รันเป็น job `e2e` แยก
`46-explorer-canonical` ดึง `canonical()` / `signingInput()` ออกจาก `explorer.html` มาเทียบกับ VM ตรง ๆ — แก้สองฟังก์ชันนี้ต้องผ่านเทสต์นี้

**ถ้าแก้ชุด key ของผลลัพธ์ (เพิ่ม field ใน receipt / result) ต้องแก้ `test/helpers.js` ด้วย** ไม่งั้นเทสต์หลายไฟล์จะพังพร้อมกัน
`scripts/demo-market.js` อ่าน source ของ TOKEN/MARKET ออกมาจาก `test/44-complex-scenario.test.js` ตรง ๆ — แก้เทสต์นั้นแล้ว demo เปลี่ยนตาม

### จำลองผู้ใช้ 200 กระเป๋า (`npm run simulate`)

`scripts/simulate-users.js` ส่ง tx จริงเข้า server ที่รันอยู่ ทีละ block ตามจังหวะปิด block (3 วิ) แล้วตรวจว่าทุกใบเข้า block

```
RATE_LIMIT=0 BLOCK_MS=3000 npm start          # terminal 1 · RATE_LIMIT=0 จำเป็น (ยิงจาก IP เดียว)
npm run simulate                               # terminal 2 · เปิด explorer ดูไปพร้อมกันได้
npm run simulate -- --spawn                    # หรือให้สคริปต์เปิด server เอง (ปิดตอนจบ)
npm run simulate -- --blocks 200 --min 15 --max 25
```

- เฟส 1 (~10 block แรก): genesis → 10 กระเป๋าแจก → อีก 190 กระเป๋า · ~20 tx/block
- เฟส 2 (`--blocks`, ค่าเริ่ม 100): deploy token / market / poll 10 ตัว (admin init ให้อัตโนมัติ) แล้วใช้งานจริง 15–25 tx/block: โอน, ตั้งชื่อ, แจกโทเคน, approve, ประกาศขาย, ซื้อ, ฝาก-ถอน, โหวต + tx ผิดพลาดตั้งใจเล็กน้อย (ต้องโดนปฏิเสธที่ `/sendtx`)
- จบแล้วสรุป: ส่ง / เข้าคิว / ถูกปฏิเสธ (แยกสาเหตุ) / เข้าคิวแต่ไม่เข้า block / tx ต่อ block / ระยะห่าง block · รายงานเต็มที่ `simulate-report.json` · key ของกระเป๋าที่ `simulate-report-wallets.json`
- ต้องเริ่มจาก chain ใหม่ (block 0) เพราะใช้เงินจาก genesis ~7.7 ล้าน และชื่อ namespace ซ้ำกับรอบก่อนไม่ได้ · ถ้า server ตั้ง `ADMINS` ต้องส่ง `--admin-key`

### scenario 1000 กระเป๋า · 10 tx ต่อ block (`npm run scenario`)

`scripts/scenario.js` + โปรแกรมใน `scripts/scenario-programs.js` (เทสต์ `50-scenario-programs`)

```
RATE_LIMIT=0 BLOCK_MS=3000 npm start          # terminal 1 · chain ใหม่ (ใช้เงิน genesis ~9.1 ล้าน)
npm run scenario                               # terminal 2 · ค่าเริ่ม 60 block ของการใช้งาน
npm run scenario -- --spawn --blocks 15        # หรือเปิด server เอง (MemoryDB)
```

- ทุก block หยิบงานที่ "พร้อม" (ของที่ต้องใช้เข้า block แล้ว) ให้ครบ `--per-block` (10) ใบ: งานตั้งต้นก่อน แล้วเติมด้วยงานของกระเป๋าที่ได้เหรียญแล้ว
- โปรแกรม: token `TEST` (6 decimals, ไอคอน, namespace `scenario-test`) · `multisend` (แจก native) · `chain-a`…`chain-f` (step เรียกต่อกัน 6 ทอด, C / E แวะอ่าน balanceOf, D catch ความผิดพลาดของชั้นล่าง)
  · `router-1`…`router-4` (forward: ดึง token ด้วย transferFrom แล้วส่ง token + native ต่อกัน 4 ทอด หักทอดละ 1%)
- แจก: multiSend native 3,500 ให้ 1000 กระเป๋า (100 ต่อ tx) + 40,000 ให้ 50 กระเป๋า power · multiTransfer TEST 1,000 ให้ทุกกระเป๋า (power 50,000)
  `--target` (ค่าเริ่ม 0xF10F…80Cf) ได้ native 500,000 + TEST 1,000,000 และได้เพิ่มระหว่างทางจาก router / การโอน
- ใช้งาน: power 3 ใบต่อ block (chain 3–6 ทอด, 20% ของสาย 6 ทอดให้ F ล้มแต่ D catch ไว้ · router 4 ทอด · multiTransfer 10–30 คน) + กระเป๋าทั่วไป (โอน TEST / native, ตั้งชื่อ)
  ประเมินค่าใช้จ่ายต่อกระเป๋า (`COST`, `budget`) ไม่ส่งงานที่จ่ายไม่ไหว · tx ที่ล้มทั้งใบไม่มีในชุดนี้เพราะ simulate ที่ `/sendtx` ปฏิเสธก่อนเข้า block
- รันจริง 9 ต.ค. (BLOCK_MS 3000): 64 block × 10 tx ทุก block, 640/640 สำเร็จ, ผู้ถือ TEST 1,006 · รายงานที่ `scenario-report.json`
- ⚠️ แท็บ Incoming ของกระเป๋านับเฉพาะ tx ที่ส่ง**ถึง**กระเป๋านั้นตรง ๆ — token ที่ได้จาก transfer / router และ native จาก transferNative ไม่อยู่ในรายการนี้ (ดูได้จากแท็บ Tokens / ยอด)

---

## 11. ⚠️ ที่ยังไม่ได้ทำ — เรียงตามความสำคัญ

### บล็อกการเปิดให้คนนอก deploy
1. **ไม่มี sandbox จริง** — โปรแกรมรันด้วย `new Function` ใน process เดียวกับ server
   `node:vm` ถูกใช้แค่จับเวลา ไม่ได้ใช้แยก context จริง
   autoreview ช่วยกรองได้มาก แต่เป็นชั้นเดียวและไม่ใช่ขอบเขตการรันจริง
   ทางเลือกที่คุยไว้: QuickJS (wasm, แยกจริง + นับขั้นได้), worker thread (แยกครึ่ง), เข้ม autoreview ต่อ (ถูกสุด อ่อนสุด)
2. **gas ยังไม่นับขั้น** — `while(true) {}` ที่ไม่แตะ DB กินได้เต็ม `timeoutMs` (server ตั้งไว้ 2 วิ ผ่าน `TIMEOUT_MS`) โดยเสียแก๊สเท่าเดิม
   ต้องแก้: ฉีดตัวนับเข้าไปใน loop/call ทุกจุด (หรือย้ายไป QuickJS ที่นับ instruction ได้)
3. ค่ากลางในหน่วยความจำยังไม่จำกัด — `maxValueSize` กันเฉพาะตอนเขียน / return / emit

### บล็อกการมี node ที่สอง
4. `sync.js` พร้อมแล้ว (ดึง body มารันเอง เทียบ hash ไม่ใช่เชื่อ state) แต่รอข้อ 2 ก่อน
   ไม่งั้น node สองตัวจะได้ผลต่างกันเมื่อเจอโปรแกรมที่วนนานต่างกัน

### ค้างคาที่รู้อยู่
5. **tx ที่ถูกปฏิเสธไม่เข้า block เลย** (nonce ผิด / โควตาเต็ม / timeout) → explorer แสดงไม่ได้ว่าเคยมีใบนี้
   เป็นการตัดสินใจเชิงออกแบบ ต้องเลือกว่าจะเก็บเป็น "tx ที่ล้ม" ใน chain หรือเก็บ log นอก chain
6. **native / gas ยังเป็น `number`** ติดเพดาน 2^53 ส่วนค่าในโปรแกรมเป็น BigInt แล้ว — ทำพร้อมข้อ 2
7. `/program/:a/groups` นับได้สูงสุด 5,000 key (hard-coded ใน `server.js`)
8. แท็บ interactions / event ยังไม่มี pagination (ต่างจากแท็บ storage ที่มีแล้ว)
9. **explorer ยังไม่เคยถูกเทสต์กับ MetaMask จริง** — มี e2e ด้วย Playwright แล้ว (`npm run test:e2e`, wallet จำลองที่เซ็นด้วย ethers)
   แต่ตัว extension MetaMask จริงยังต้องลองด้วยมือ
10. ยังไม่มี load test (ยังไม่รู้ว่าปิด block 500 tx จริงใช้เวลาเท่าไหร่บน LMDB บนดิสก์จริง)

### ⛔ ความปลอดภัยที่ต้องแก้ก่อนเปิดจริง
**ตอนนี้ `scripts/*` ส่ง private key ไปเซ็นฝั่งเดียวกับ server ได้ เพราะยังเป็นช่วงทดสอบ**
ของจริงต้องเซ็นฝั่ง client เท่านั้น (explorer ทำถูกแล้ว — ใช้ `eth_signTypedData_v4`)
**private key ต้องไม่เดินทางไปถึง server เลย** ส่วน `/sendtx` ต้องรับแค่ `{ tx, signature }` (ซึ่งทำถูกอยู่แล้ว)

### เมื่อถึงเวลา
rollback เร็ว · merkle tree จริง · factory (โปรแกรมสร้างโปรแกรม) · การอัปเกรดโปรแกรม ·
มาตรฐานโทเคน · ตัด history เก่า / snapshot · หน้า holders ใน explorer

---

## 12. เอกสารอื่นในโปรเจค

| ไฟล์ | เนื้อหา |
|---|---|
| `README.md` | ภาพรวมสั้น + โครงสร้าง + วิธีเริ่ม |
| `CHECKPOINT.md` | สถานะ, ค่าตั้งต้นที่แนะนำสำหรับ production, ตัวเลข performance ที่วัดจริง |
| `EXPLORER-SPEC.md` | สเปคฝั่ง API consumer — **รูปแบบ response ของทุก endpoint อยู่ที่นี่** อ่านก่อนทำ frontend |
| `program-sdk/README.md` | สำหรับคนนอกที่จะเขียนโปรแกรม + testkit |
| `program-sdk/patterns/SAFE-PATTERNS.md` | pattern กัน reentrancy และข้อผิดพลาดที่เจอบ่อย |

ลำดับการอ่านที่แนะนำ: **ไฟล์นี้** → `EXPLORER-SPEC.md` (ถ้าทำ frontend) หรือ comment หัว `virtualmachine.js` (ถ้าทำ VM) → `CHECKPOINT.md`
