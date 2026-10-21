# HANDOFF — Program VM + Explorer

เอกสารส่งต่อโปรเจคให้ agent หรือทีมอื่นทำงานต่อ อ่านไฟล์นี้ไฟล์เดียวแล้วทำงานต่อได้ทันที

> **สรุป 30 วินาที**
> blockchain ที่ smart contract เขียนด้วย JavaScript ธรรมดา เซ็น tx ด้วย EIP-712 (MetaMask ใช้ได้)
> VM เป็น sync ทั้งหมด + deterministic, เก็บข้อมูลลง LMDB แบบ key/value แบน
> มี server จริง (node:http) + explorer ไฟล์เดียว + ชุด SDK สำหรับคนเขียนโปรแกรม
> **มีแก๊สนับขั้น + sandbox จริงแล้ว (QuickJS ใน WebAssembly — หัวข้อ 4 "Sandbox")** · ก่อนเปิดให้คนนอก deploy ดูหัวข้อ 11

| | |
|---|---|
| ภาษา / runtime | JavaScript (ESM), Node 22 เท่านั้น (`engines: >=22 <23`) |
| dependency | `@noble/curves`, `@noble/hashes`, `acorn`, `lmdb`, `quickjs-emscripten` (ตรึงเวอร์ชัน 0.32.0 ห้ามขยับเอง ดูหัวข้อ 4) (+`ethers` เป็น dev) |
| โค้ดทั้งหมด | ~4,200 บรรทัด (VM เอง 2,521) |
| ภาษาในโค้ด | comment / error message เป็นภาษาไทย ชื่อตัวแปรเป็นอังกฤษ — **รักษาสไตล์นี้ไว้** |
| เทสต์ | `npm test` → 787 เคส |

---

## 1. เริ่มต้นใน 2 นาที

```bash
npm install
npm test                         # 787 เคส ควรผ่านหมดก่อนเริ่มแก้อะไร

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
src/core/sandbox.js            935        sandbox ของโปรแกรม: QuickJS (WebAssembly) + snapshot ต่อ tx + ตัวแปลงค่าข้ามเขตแดน
src/core/autoreview.js         201        ตรวจโค้ดด้วยบัญชีขาว — standalone ใช้ได้เอง
src/storage/db.js              212        DB (LMDB) + MemoryDB — readKeys / writeKeys / listKeys
src/crypto/signature.js        214        EIP-712 + secp256k1
src/crypto/program-signature.js           ลายเซ็นที่โปรแกรมตรวจด้วย ecrecover: signPermit / signWalletHash / signProgramMessage
src/standards/                            โปรแกรมมาตรฐาน: token (ERC-20 + permit) · nft (ERC-721) · multitoken (ERC-1155)
                                          · wallet (ERC-1271 + SIGNATURE_CHECKER) · multicall (หัวข้อ 8 "มาตรฐาน NFT / …")
src/node/mempool.js            230        คิว tx: rate limit, TTL, กันซ้ำ, เรียงตาม tip จริง (EIP-1559), แทนที่ใบ nonce เดิม
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
| API ที่โปรแกรมเรียกได้ | `PROGRAM_API_NAMES` + `createProgramApi()` + `API_OPS` ใน `sandbox.js` + `PROGRAM_API` ใน `autoreview.js` (**ต้องแก้ทั้ง 4 ที่**) |
| หน่วยความจำ / stack / การแยกโปรแกรม | `src/core/sandbox.js` (หัวข้อ 4 "Sandbox") |
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
- `migrate(params)` (ถ้ามี) รันครั้งเดียวตอนอนุมัติการอัปเกรดเท่านั้น — อยู่ใน `return { … }` ก็ถูกตัดออก **เรียกจากภายนอกไม่ได้** เหมือน `initialization`
- `params` ที่ทุกฟังก์ชันได้รับ: `{ input, context: { sender, origin }, value, block: { timestamp } }`
  (เลข block ไม่ได้อยู่ใน `params` — เรียก `BlockNumber()` แทน)

### อัปเกรดโปรแกรม (upgrade) — เทสต์ `56-upgrade`

**ไม่มี upgrader = แก้ไม่ได้ตลอดไป** · โปรแกรมทุกตัวที่มีอยู่เดิมไม่มี upgrader จึงแก้ไม่ได้
- **ตั้ง upgrader ตอน deploy เท่านั้น**: `vm.deploy({ …, upgrader: "0x…" })` / tx ที่เซ็น `{ action: "deploy", …, upgrader: "0x…" }`
  → เก็บใน `pending:<id>` (field `upgrader` มีเฉพาะเมื่อส่งมา) → ตอน `init` เขียนเป็น `metadata.upgrader`
  (`upgrader` / `version` / `template` เป็นฟิลด์ของระบบ — ผู้ใช้ส่งผ่าน metadata / โปรแกรม `setMetadata` เองไม่ได้)
- **โอนสิทธิ์ / สละสิทธิ์**: `vm.setUpgrader({ programUuid, upgrader, context })` — ต้องเป็น upgrader คนปัจจุบัน · `upgrader: null` = สละ → แก้ไม่ได้อีก
  tx ที่เซ็น: `{ action: "setUpgrader", to: <program>, input: { upgrader: "0x…" | null } }`
- **ส่งโค้ดใหม่**: `vm.upgrade({ programUuid, code, migrateInput, context })` จาก upgrader · ตรวจแบบ deploy ทุกอย่าง (ขนาด / syntax / autoreview / แก๊ส `call + code × byte`)
  → `pending-upgrade:<id>` `{ code, context, migrateInput }` (ทีละ 1 รายการต่อโปรแกรม) · tx ที่เซ็น: `{ action: "upgrade", to, code, input: migrateInput }`
- **ทีมงานอนุมัติ / ปฏิเสธ**: `vm.initUpgrade({ programUuid, context })` / `vm.rejectUpgrade(…)` — **กติกาผู้อนุมัติเหมือน init / reject ทุกอย่าง** (`admins`, ไม่มี context = เรียกภายใน)
  tx ที่เซ็น: `action: "initUpgrade"` / `"rejectUpgrade"` · upgrader ต้องยังเป็นคนที่ส่งโค้ดมา (โอน / สละไปแล้ว → อนุมัติไม่ได้ ให้ reject ทิ้ง)
- **ตอนอนุมัติ** (`applyUpgrade`): แทน `<id>:code` → เก็บ `<id>:codeversion:<n>` `{ version, code, blockNumber, timestamp }`
  (เวอร์ชัน 1 ถูกเก็บตอนถูกแทนที่ครั้งแรก `blockNumber: null`) → `metadata.version` + 1 (ไม่มี = 1)
  → รัน `migrate(params)` ครั้งเดียว (`input = migrateInput`, `sender = upgrader`, เห็นโค้ดใหม่แล้ว) · **migrate throw = อนุมัติล้ม ไม่มีอะไรเปลี่ยน** (pending ยังอยู่)
  storage เดิมอยู่ครบ · cache คอมไพล์ผูกกับเนื้อโค้ด (โค้ดใหม่ = คอมไพล์ใหม่) และลืมโค้ดเก่าด้วย `compiler.forget()`
- **timelock** — option `upgradeDelayBlocks` (server: env `UPGRADE_DELAY_BLOCKS`, ค่าเริ่ม 0)
  - `0` → ใช้โค้ดใหม่ทันทีใน tx ที่อนุมัติ (tx ถัดไปใน block เดียวกันเห็นโค้ดใหม่)
  - `N > 0` → อนุมัติที่ block B: ลบ pending เขียน `scheduled-upgrade:<id>` `{ …, approvedAt: B, activateAt: B + N }` + ดัชนี `upgradeat:<B+N>` `[id…]`
    คืน `{ state: "scheduled", activateAt }` · โค้ดเดิมทำงานต่อ · ส่งโค้ดใหม่ซ้ำไม่ได้จนกว่าจะเปิดใช้
  - **เปิดใช้ตอนสร้าง block B+N** (`Block` constructor → `#activateUpgrades` → `vm.activateUpgrade`) ก่อน tx ใบแรก แม้ block นั้นไม่มี tx
    ไม่ใช่ tx (ไม่มี hash / ผู้จ่าย / ไม่อยู่ใน body) แต่ writes อยู่ใน state ของ block → เข้า stateRoot + history → **replay / rebuild ได้ผลเดิม**
    `header.upgrades = [{ program, status, version, error }]` (มีเฉพาะ block ที่มีการเปิดใช้) · migrate ล้มตอนนั้น → ยกเลิกการอัปเกรด โค้ดเดิมทำงานต่อ
  - ต้องมีเลข block (`recordBlocks` / ส่ง `number`) · อนุมัตินอก block → error · `simulate` ของ `initUpgrade` จำลองเป็น block ถัดไปให้เอง
- อ่านย้อนหลัง: `vm.listCodeVersions(addr)` · `vm.getCodeVersion(addr, n)` · `vm.codeAt(blockNumber, addr)` (= `stateAt` ของ `<id>:code`)
  `replayBlock` ของ block ก่อนอัปเกรดใช้โค้ด ณ ตอนนั้นเสมอ (อ่าน `<id>:code` ผ่าน history)

### cloneProgram — โรงงานสร้างโปรแกรม (แบบ CREATE2) — เทสต์ `57-clone`

```js
const address = cloneProgram(template, initInput, { salt, value })   // ในโปรแกรม (factory)
```
- `template` = โปรแกรมใดก็ได้ที่**อนุมัติแล้ว** (มี `<id>:code`) · pending / rejected / ไม่มี → `NOT_FOUND`
- address = `addressFromHash(hashData({ chainId, factory, salt, codeHash: keccak256(code) }))` — รู้ได้ก่อนสร้างด้วย `vm.cloneAddressFor(factory, salt, code)`
  `salt` = string ที่ไม่ว่าง หรือ BigInt (ใช้ค่าตัวเลขเป็น string) · salt ซ้ำ (address มีอยู่แล้ว) → `INVALID_REQUEST`
- **copy** โค้ดไปไว้ที่ address ใหม่ (อัปเกรด template ภายหลังไม่กระทบ clone) แล้วรัน `initialization` ทันทีใน tx เดียวกัน
  `context.sender = factory` · `origin` เดิม · `value` (ไม่บังคับ) โอน native จาก factory → clone ก่อน initialization (เห็นที่ `params.value`)
- metadata: `type: "program"`, `creator: factory`, `createdAt`, `template` · อนุมัติทันที (มี `<id>:this` → นับใน `/programs/approved`) · ไม่มี upgrader = แก้ไม่ได้
- แก๊ส: `call` (ใน initialization) + `code × byte` ของโค้ด (เหมือน deploy) + `write × 7` + read 1 · ความลึกนับเหมือน `runProgram` (`maxCallDepth`)
- **ล้มที่ไหนย้อนทั้งหมด**: initialization throw / กิ่งที่เรียก clone throw แล้วชั้นบน catch → ไม่เหลือ code / metadata / เงินที่โอน
- trace: รายการของ clone มี `type: "create"` (`tx.calls` → receipt `trace[].type` → `txto` action `create` → callTracer `CREATE`)
  call ธรรมดาไม่มี field `type` (receipt เดิมไม่เปลี่ยน) · template ไม่มี initialization ก็ยังมีรายการ create (`functionName: "create"`)

### params / ค่าที่ส่งกลับ — ตัวเลขเป็น BigInt

**ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น** — VM ทำงานแบบนี้เสมอ (ตัวเลือก `bigintValues` / โหมด number ถูกตัดออกแล้ว)

- `10` → error `numberNotAllowed` · ต้องเขียน `10n`
- เก็บลง DB เป็น string `"123n"` แปลงกลับเป็น BigInt อัตโนมัติตอนอ่าน
- ค่าที่ออกไปทาง JSON ของ API ก็เป็น `"123n"` → **ฝั่ง client ห้ามใช้ `Number()`** ใช้ `BigInt(v.slice(0,-1))`
- ยอด native เป็น BigInt หน่วย wei (18 ทศนิยม, 1 เหรียญ = 10^18) เก็บใน DB / receipt / tx record เป็น `"123n"`
  `value` / `gasPrice` ที่ส่งเข้ามารับได้ทั้ง number, BigInt, `"123"` และ `"123n"` · ราคาแก๊สเริ่มต้น 1 gwei (`GAS_PRICE`)
- ค่าของระบบที่เหลือ (gasUsed, gasLimit, nonce, เลข block, timestamp) ยังเป็น `number` ปกตินอกโปรแกรม
  (ในโปรแกรม `params.block.timestamp` / `BlockNumber()` เป็น BigInt · `Date.now()` ยังเป็น number ต้องห่อ `BigInt()` ก่อนเก็บ)

### API ในโปรแกรม (32 ตัว)

```
readDB(key) / writeDB(key, value) / deleteDB(key) / map(...parts)
runProgram(target, functionName, input, { value })      เรียกโปรแกรมอื่น
runProgram(target, functionName, input, { readonly: true })   แบบ STATICCALL: ปลายทาง + ทุกชั้นที่เรียกต่อแก้ state ไม่ได้
cloneProgram(template, initInput, { salt, value })      สร้างโปรแกรมใหม่จากต้นแบบที่อนุมัติแล้ว → address (ดูหัวข้อ cloneProgram)
transferNative(to, amount)                              โอนเหรียญหลักจากโปรแกรม
setMetadata(field, value) / emit(name, data, { indexed: ["from", "to"] }?)   indexed = field ที่ค้นด้วยค่าได้ (ไม่เกิน 3 · ดูหัวข้อ event แบบ indexed)
keccak256(value) / ecrecover(value, signature)
ThisAddress() / ThisBalance() / BalanceOf(addr) / IsProgram(addr) / MetadataOf(addr, field) / BlockNumber()
Date        เวลาของ block (Date.now() ได้ค่าเดียวกันทุก tx ใน block)
Math        random() ผูกกับ tx hash → รันซ้ำได้ผลเดิม
sha256(value) / ripemd160(value) / blake2b(value)        precompile hash (รับแบบเดียวกับ keccak256 · blake2b = BLAKE2b-512)
modexp(base, exponent, modulus)                          BigInt · modulus 0n → 0n · แต่ละค่า ≤ 1024 byte (MODEXP_MAX_BYTES)
BlockHash(n) / ChainId() / Coinbase() / BlockGasLimit() / GasPrice() / BaseFee() / GasLeft()
CodeHashOf(addr) / CodeSizeOf(addr)                      keccak256 / byte ของโค้ดที่เก็บ · ไม่ใช่โปรแกรม → null / 0n
```

API ที่เทียบกับ EVM (ทุกตัว deterministic · คืน BigInt / string / null):

| API | EVM | พฤติกรรม | แก๊ส |
|---|---|---|---|
| `BlockHash(n)` | BLOCKHASH | `block:<n>.hash` ย้อนได้ 256 block (`BLOCK_HASH_WINDOW`) · block ปัจจุบัน / อนาคต / เก่ากว่า / block 0 → `null` · query นอก block นับ block ถัดจากล่าสุดเป็นปัจจุบัน · `n` ต้องเป็น BigInt | `read` |
| `ChainId()` | CHAINID | `vm.chainId` | `env` 10 |
| `Coinbase()` | COINBASE | `feeRecipient` ของ block (null ถ้าไม่มี) | `env` |
| `BlockGasLimit()` | GASLIMIT | `vm.maxBlockGas` (null = ไม่จำกัด · ใช้ค่าของ VM ไม่ใช่ของ Block จึง replay ได้ผลเดิม) | `env` |
| `GasPrice()` | GASPRICE | `tx.gasPrice` = ราคาจริงต่อแก๊ส `min(maxFee, baseFee + priority)` | `env` |
| `BaseFee()` | BASEFEE | base fee ของ block ที่ tx อยู่ (`tx.baseFee` · query นอก block = base fee ของ block ถัดไป) | `env` |
| `GasLeft()` | GAS | `gasLimit - gasUsed` หลังหัก `env` ของตัวเอง (null ถ้าไม่มีเพดาน) | `env` |
| `CodeHashOf(a)` | EXTCODEHASH | `keccak256(<a>:code)` = codeHash เดียวกับที่ `cloneProgram` ใช้คำนวณ address | `read` + `hash` + `byte` × ขนาดโค้ด |
| `CodeSizeOf(a)` | EXTCODESIZE | byte ของ `<a>:code` | `read` |
| `sha256` / `ripemd160` / `blake2b` | precompile 0x02 / 0x03 / (BLAKE2F) | hex `0x…` | `sha256` 100 / `ripemd160` 300 / `blake2b` 100 + `byte` × ขนาดข้อมูล |
| `modexp` | precompile 0x05 | square-and-multiply | `modexp` 200 + ⌊word² × max(bit ของ exp, 1) ÷ 3⌋ (คิดก่อนคำนวณ) |
| `runProgram(..., { readonly: true })` | STATICCALL | `caller.readonly` ส่งต่อทุกชั้น · `writeDB` / `deleteDB` / `transferNative` / `setMetadata` / `emit` / `cloneProgram` → `ERRORS.readonlyCall` (FORBIDDEN, catch ได้) · แนบ value ไม่ได้ (`readonlyValue`) · trace `type: "staticcall"` → callTracer `STATICCALL` | เท่า call ปกติ |

**เพิ่ม API ใหม่ต้องแก้ 4 ที่**: `PROGRAM_API_NAMES`, `createProgramApi()` (ทั้งคู่ใน `virtualmachine.js`), `API_OPS` ใน `sandbox.js` (ชื่อ + ชนิด argument — ไม่มี = โปรแกรมเรียกไม่ถึง host) และ `PROGRAM_API` ใน `autoreview.js` — ถ้าลืมที่สุดท้าย autoreview จะปฏิเสธโค้ดที่ใช้ API ใหม่ว่า "ไม่รู้จัก" · อย่าลืม API ปลอมใน `program-sdk/lib/program-globals.js` และ README ของ SDK

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

แล้วฉีดตัวนับแก๊ส (`gasmeter.js`) และประกอบเป็น **ซอร์ส** (string) ของ factory
```js
(function (api) { "use strict"; const { readDB, writeDB, …, __gas, __str, __props, __spread } = api; ${body} ;return { … }; })
```
→ API ถูก destructure เป็น `const` ในขอบเขตเดียวกับโค้ด user (เขียนทับไม่ได้) · ซอร์สนี้ถูกรันใน sandbox (QuickJS) ไม่ใช่ใน V8 ของ server
syntax ถูกตรวจทั้งกับ V8 (ข้อความ error เดิม) และกับ QuickJS (`checkGuestSyntax` — ตัวที่รันจริง) ก่อนรับโค้ด

`isTopLevelDeclaration()` ใช้ trick ที่ควรรู้ก่อนแก้: ต่อ `let <ชื่อ>;` เข้าท้ายโค้ดแล้วคอมไพล์
ถ้า V8 ฟ้อง `'<ชื่อ>' has already been declared` = ชื่อนั้นถูกประกาศในระดับบนสุดจริง — ตรวจได้โดยไม่ต้องรันโค้ด
ผลลัพธ์ compile (ซอร์สที่ฉีดตัวนับแล้ว) ถูก cache ตาม string โค้ด (`#cache`)

### Sandbox (`src/core/sandbox.js` · เทสต์ `58-sandbox`)

โค้ดของโปรแกรมรันใน **QuickJS ที่คอมไพล์เป็น WebAssembly** (`quickjs-emscripten` 0.32.0 แบบ sync, QuickJS 2025-09-13)
ไม่ใช่ใน V8 ของ server → โปรแกรมไม่มีทางเห็น `process` / `require` / global ของ Node / object ใด ๆ ของ host

| | |
|---|---|
| ตอน import | โหลด wasm ครั้งเดียว (top-level await) · สร้าง runtime 1 ตัว + context สำรอง 8 ตัวที่โหลด prelude แล้ว · ถ่าย **snapshot** ของ memory ของ wasm (~1.8 MB) · self-check ว่าคืน snapshot ได้จริง (ไม่ผ่าน = import ล้ม) |
| ต้น tx | คืน memory เป็น snapshot (~0.13 ms) → ทุก tx เริ่มจาก heap เดียวกันทุกไบต์ ไม่มีอะไรจาก tx ก่อนค้าง (global ที่แก้ / ขยะของ GC) |
| 1 tx ชั้นนอกสุด | = runtime เดียว · หน่วยความจำ / stack / เวลา นับรวมทั้งสายการเรียก (`runProgram` / init ของ `cloneProgram` ซ้อนรันใน runtime เดียวกัน) |
| 1 โปรแกรมใน tx | = 1 context (global แยกกัน) · factory ถูกเรียกใหม่ทุก call → ตัวแปรระดับบนสุดไม่ค้างข้าม call |
| ค่าข้ามเขตแดน | เป็นข้อความ JSON เสมอ (BigInt / undefined / NaN / -0 / map(...) ติดป้ายด้วย key `"\u0000"`) → ได้สำเนาใหม่ทุกครั้ง · function / symbol / object ที่ไม่ใช่ข้อมูลส่งเป็น "ไม่ใช่ข้อมูล" แล้ว host ปฏิเสธเหมือนเดิม · error ของ host ที่โปรแกรมได้รับเป็น `Error` ของฝั่งโปรแกรม (มี `code`) ถ้า throw ต่อ host ได้ error ตัวเดิมคืน |
| global | built-in มาตรฐานของ JS + `Date` / `Math` ของ block (Math.random ถาม host) · `eval` / `new Function` / constructor ของ async / generator function ถูกปิด (EvalError) เพราะโค้ดที่สร้างตอนรันไม่ผ่านตัวนับแก๊ส · `console.*` เรียกได้แต่ไม่พิมพ์ · ไม่มี `Intl` / `performance` / `setTimeout` / `queueMicrotask` / `structuredClone` / `Atomics` |
| แก๊ส | `__gas(n)` / `__str` / `__props` / `__spread` และเมธอดในตัวที่ถูกห่อไว้ ทำงานในฝั่งโปรแกรม (ไม่ข้ามไป host ทุกครั้ง) · ยอดค้างส่งให้ host ทุกครั้งที่เรียก API · ยอดค้างเกินที่เหลือ → ถาม host ทันที → OUT_OF_GAS ตรงจุดเดิม **ตัวเลขแก๊สเท่าเดิมทุกหน่วย** |
| แก๊สหมด / หมดเวลา / DB พัง / หน่วยความจำเกิน | host ตอบ "ตาย" → ทุก `__gas` / API หลังจากนั้น throw ซ้ำ (ทุก catch / finally ขึ้นต้นด้วย `__gas`) จึง catch ไม่ได้ · ลูปที่ไม่เรียกอะไรเลยถูกหยุดด้วย interrupt handler ของ QuickJS (catch ไม่ได้เช่นกัน) |
| stack | `maxStackBytes` ค่าเริ่ม 256 KB (~1,400 ชั้นของการเรียกซ้อน — V8 เดิม ~10,000) · ล้น = `PROGRAM_ERROR (RangeError)` ที่ catch ได้ · ตั้งได้ 16–256 KB เท่านั้น (512 KB ทำให้ stack ของ Node ล้นจน wasm พัง) |
| หน่วยความจำ | `memoryLimitBytes` ค่าเริ่ม 32 MB ต่อ tx (ตั้งได้ 1 MB–1 GB) · เกิน = **`OUT_OF_MEMORY`** (code ใหม่) |

**หน่วยความจำ — ทำไมไม่ใช้ memory limit ของ QuickJS**: บน emscripten `malloc_usable_size` ใช้ไม่ได้ QuickJS จึงนับแค่ ~8 ไบต์ต่อก้อน (ลองแล้ว ตั้ง 32 MB แต่จองได้ 2 GB · quickjs-ng ก็เหมือนกัน)
จึงคุมที่ WebAssembly memory แทน: instance สำหรับรันโปรแกรมมี `WebAssembly.Memory` ของตัวเองที่ `grow` ถูกห่อไว้
ต้น tx (หลังคืน snapshot) จอง "ลูกโป่ง" ให้เหลือที่ว่างพอดี `memoryLimitBytes` + ที่สำรองของ host 2 MB แล้วล็อกไม่ให้ memory โต
→ malloc ล้มที่จุดเดียวกันทุกเครื่องเสมอ (heap ต้น tx เหมือนกันทุกไบต์ และไม่ขึ้นกับขนาด memory ที่เคยโตไว้) · มีการแตะล็อกเมื่อไร = OUT_OF_MEMORY
OUT_OF_MEMORY ทำตัวเหมือน OUT_OF_GAS: ทั้ง tx ล้ม catch / finally ไม่ได้ ไม่มี writes ของโปรแกรม **เข้า block (`accepted: true`) กิน nonce และเสียค่าแก๊สเท่าที่ใช้ไป**
(ยอดแก๊สที่ยังค้างในฝั่งโปรแกรมตอน malloc ล้มถูกส่งกลับมาด้วย `"f<n>|"` → จอง 32 MB จ่ายจริง ~1,000,000 gas ไม่ใช่แค่ส่วนที่ส่งให้ host ไปแล้ว)
⚠️ ทุก node ในเครือข่ายต้องตั้ง `MEMORY_LIMIT_MB` / `STACK_LIMIT_KB` เท่ากัน ไม่งั้นผลของ tx ที่ใช้หน่วยความจำมากจะต่างกัน

**snapshot — ข้อสมมติที่ต้องรู้ก่อนขยับเวอร์ชัน quickjs-emscripten**: memory ของ wasm = [ข้อมูล static ~90 KB | stack ของ C 5 MB | heap ของ dlmalloc]
snapshot เก็บ 1 MB ล่าง (static) + heap ถึงก้อนว่างก้อนสุดท้าย (`top` ของ dlmalloc ซึ่งหาตำแหน่งจากการทดลองตอน import)
self-check ตอน import ตรวจให้ ถ้าโครงสร้างเปลี่ยนจนคืนสถานะไม่ครบ server จะไม่ start (ไม่รันต่อแบบผิด ๆ) · หา `top` ไม่เจอ = เก็บ memory ทั้งก้อน (ถูกแต่ช้า)
ห้าม `dispose` runtime ทั้งที่ยังมี handle ค้าง (QuickJS abort ทั้ง wasm) — runtime อยู่ตลอดอายุ process และ `Sandbox.dispose()` คืน handle / context ที่สร้างใน tx ทุกตัว

**ต่างจาก V8 เดิมที่โปรแกรมอาจเห็นได้** (ผลของ API / แก๊ส / error code เท่าเดิมหมด — เทียบด้วยชุด probe แล้ว):
`Date()` / `toString()` ของ Date ไม่ต่อท้าย "(Coordinated Universal Time)" · `toLocaleString` / `localeCompare` ไม่ใช้ ICU · ไม่มี `Intl`
ข้อความ error จาก engine ต่างกัน (`cannot read property 'x' of null`) แต่ชื่อเหมือนกัน (error ที่ไม่ใช่ `Error` ธรรมดาถูกเปลี่ยนเป็นชื่ออยู่แล้ว)
stack ล้นเป็น `InternalError` ในฝั่งโปรแกรม (ข้ามเขตแดนแล้วเป็น RangeError เหมือนเดิม) · Promise ไม่มีวันถูก resolve (ไม่มี job queue — async ใช้ไม่ได้อยู่แล้ว)
`debug.at` บอกบรรทัด / คอลัมน์ตาม stack ของ QuickJS

ตัวแปร server: `MEMORY_LIMIT_MB=32` `STACK_LIMIT_KB=256` (`TIMEOUT_MS` ยังเป็นด่านสุดท้ายของเวลา) · option `wallClock: true` ใส่ `performance.now()` จริงให้โปรแกรม — ใช้ในเทสต์เท่านั้น

**บันทึกแผน / ทางที่ยังเปิดอยู่**
- ความเร็ว: token transfer ~1.4 ms/tx (V8 เดิม ~0.6) ส่วนใหญ่คือคอมไพล์ factory ของโปรแกรมใหม่ทุก tx (~0.4 ms) + ตัวแปลภาษาของ QuickJS · งานคำนวณล้วนช้ากว่า V8 ~4–5 เท่า (~50 M gas/s) · วัดซ้ำด้วย `node scripts/bench-vm.js`
- ทางเร่งที่คิดไว้แต่ยังไม่ทำ: เก็บ context ที่คอมไพล์โปรแกรมยอดนิยมไว้แล้วใน snapshot — **ต้องระวัง** snapshot จะต่างกันตามประวัติของแต่ละ node → heap ต้น tx ไม่เหมือนกัน → จุดที่หน่วยความจำเกินอาจต่างกัน ต้องทำให้ชุดโปรแกรมใน snapshot เป็นส่วนหนึ่งของ state ของ chain ก่อน
- bytecode ของ QuickJS ข้าม runtime / snapshot ไม่ได้ใน quickjs-emscripten (ไม่มี API อ่าน / เขียน bytecode) จึง cache เป็นซอร์สที่ฉีดตัวนับแล้วแทน
- ถ้าจะใช้ memory limit ของ QuickJS เองในอนาคต ต้องเป็น build ที่มี `malloc_usable_size`
- ~~`gasmeter.js` แปลง `(255).toString(36)` เป็นโค้ดที่ syntax ผิด~~ หมดไปแล้ว: ไม่มีการแปลงการเรียกเป็น `__call` อีก (เมธอดในตัวถูกห่อใน prelude แทน)

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

`take()` เรียง tx ด้วย `sortPendingTransactions(items, { baseFee: block.baseFee })` (tip จริงมากก่อน) ข้ามใบที่ maxFee < base fee (ยังรอในคิว) แล้วเช็ค `block.checkTransaction()` ทีละใบ

**tx ที่ถูกปฏิเสธ (rejected) ถูกบันทึกใน block** — ใบที่ผ่านการตรวจลายเซ็นแล้วแต่ไม่ได้รัน:
- `stage: "sendtx"` ปฏิเสธตอน `/sendtx` (nonce ผิด / คิวเต็ม / ส่งถี่ / simulate หรือรีวิวโค้ดไม่ผ่าน / แทนที่ด้วยราคาต่ำไป)
- `stage: "block"` VM ไม่รับตอนปิด block (TIMEOUT / แก๊สของ block เต็ม) · `stage: "expired"` ค้างในคิวเกิน `ttlMs`
- ลายเซ็นผิด (hash / sender เชื่อไม่ได้) และส่งซ้ำ (hash มีสถานะจริงอยู่แล้ว) **ไม่**ถูกบันทึก
- mempool จำตามลำดับที่เกิด (`#rejections`, ≤ `maxRejectedQueue` 100,000) → `take()` ใส่ลง block ด้วย `block.recordRejected(entry)`
  ไม่เกิน `maxRejectedPerBlock` (server `REJECTED_PER_BLOCK`, ค่าเริ่ม 1,000) ที่เหลือยกไป block ถัดไป · มีแค่ใบที่ถูกปฏิเสธก็ปิด block ได้
  ส่งใบเดิมใหม่แล้วผ่าน → ถูกลบออกจากรายการที่รอ (ไม่ถูกบันทึกว่าปฏิเสธ)
  **ใบเดิมเป๊ะ (hash เดิม) ที่บันทึกว่าถูกปฏิเสธใน block ก่อนแล้ว และยังไม่เคยเข้า block จริง → ไม่บันทึกซ้ำ** (ผู้ส่งยังได้ error เหมือนเดิม)
  1 hash อยู่ใน block เดียว → explorer กับ `/evm` / Blockscout เห็นตรงกัน และส่งซ้ำรัว ๆ ไม่สร้าง block ใหม่ (เดิม `/evm` ย้าย hash ไป block ล่าสุด แต่ Blockscout index ไปแล้ว → เห็นไม่ตรงกัน)
- entry: `{ hash, sender, nonce, action, to, gasPrice, reason (≤ 500 ตัว), code, stage }` · **ไม่รัน ไม่แตะ state ไม่กิน nonce ไม่เสียค่าแก๊ส** (กติกาเชนเดิม)
- header มี `rejectedCount` + `rejectedRoot` (= hash ของรายการตามลำดับ) **อยู่ใน hash ของ block** · block ที่ไม่มีรายการ hash เหมือนเดิมทุกไบต์
- เก็บเป็นข้อมูล block: `blockrejected:<n>` (รายการ) · `rejtx:<hash>` · `rejfrom:<sender>:<n>:<i>` (ดัชนี อยู่ใน history/undo → `rebuildFrom` ล้างให้)
- `replayBlock` / `rebuildFrom` / `sync` (`applyBlock(vm, { header, body, rejected })`, `/sync` ส่ง `rejected` มาด้วย) ใส่รายการเดิมแล้วเทียบ hash
- `/evm`: ต่อท้าย tx จริงของ block เป็น tx ที่ล้ม (`status 0x0`, `gasUsed 0`, `effectiveGasPrice` จาก tx, ไม่มี log, `cumulativeGasUsed` = ของ tx จริงใบสุดท้าย)
  index = จำนวน tx จริง + ลำดับ · hash ที่ภายหลังเข้า block จริง / ถูกปฏิเสธซ้ำใน block หลัง ไม่ถูกแสดงซ้ำ · `eth_getTransactionCount` ไม่เปลี่ยน
- เทสต์ `60-rejected-in-block` · `61-rejected-server` · `77-rejected-once`
- explorer หน้ารายการ block: block ที่มีใบถูกปฏิเสธแสดงป้าย `Rejected N` (block ที่มีแต่ใบถูกปฏิเสธไม่ขึ้น Empty)

**แทนที่ tx ที่ยังรอในคิว (replace-by-fee)** — `mempool.add()` รับ nonce ในช่วง [nonce บนเชน, nonce บนเชน + จำนวนที่รออยู่]
- nonce = ถัดไป → ต่อท้ายคิวเหมือนเดิม · ข้ามเลข → ปฏิเสธเหมือนเดิม (`nonce ต้องเป็น N`)
- nonce = ใบที่รออยู่ของคนเดิม → แทนที่ได้เมื่อ**ทั้ง** maxFee และ priority ใหม่ ≥ เดิม × 1.1 (`replaceBumpPercent: 10`, คิดด้วย BigInt ปัดขึ้น · gasPrice แบบเดิม = ทั้งสองค่า)
  ไม่ถึง (แบบเดิมทั้งสองใบ) → `ราคาแก๊สต่ำเกินไปสำหรับการแทนที่ (ต้องอย่างน้อย X)` · มีแบบ 1559 → `(ต้อง maxFeePerGas ≥ X และ maxPriorityFeePerGas ≥ Y)` + `minimumMaxFeePerGas` / `minimumMaxPriorityFeePerGas`
  · ไม่ระบุ gasPrice = `vm.gas.price`
- ใบใหม่เป็น action อะไรก็ได้ → **ยกเลิก = แทนที่ด้วยการโอน 0 ให้ตัวเอง** (`{ action: "transfer", to: <ตัวเอง>, value: 0 }`)
  เชนรับโอน native 0 แบบ EVM: ยังคิดค่าแก๊สและกิน nonce · ติดลบ / ไม่ใช่จำนวนเต็ม → `amount ต้องเป็นจำนวนเต็มไม่ติดลบ`
  (`transferNative` ในโปรแกรมยังไม่รับ 0 เหมือนเดิม)
- ไม่กิน `maxPerSender` / `maxSize` เพิ่ม แต่นับ rate limit ต่อ address · ต้องผ่าน simulate ก่อน — ไม่ผ่าน → ใบเดิมยังอยู่
- ใบเดิมออกจากคิวแต่ยังอยู่ใน "เคยเห็น" (ส่งใบเดิมกลับมาไม่ได้) · `mempool.replacedBy(hash)` จำในหน่วยความจำ `ttlMs`
  แล้วถามต่อที่ `replacedLog` (`src/node/txlog.js`, off-chain ไม่เข้า block): server มี `DATA` → ไฟล์ `<DATA>/replaced-tx.jsonl`
  (JSON lines ต่อท้าย · เก็บ ≤ `REPLACED_LOG_MAX` 100,000 รายการ / ≤ `REPLACED_LOG_DAYS` 30 วัน · เขียนไฟล์ใหม่เมื่อบรรทัดเกิน 2 เท่า) → **อยู่รอด restart** · ไม่มี DATA = ในหน่วยความจำมีเพดานเดียวกัน
  → `GET /tx/:hash` ตอบ `{ status: "replaced", hash, replacedBy }` · explorer แสดง "Replaced by …"
- ใบแทนที่ใช้ nonce เดิม → `take()` ยังหยิบของแต่ละ address ตามลำดับ nonce · `/nonce/:address` ไม่ขยับ
- `/evm`: txpool เห็นแค่ใบใหม่ · `eth_getTransactionByHash` ของใบเดิมตอบ `null` (แบบ geth)

### เมธอดที่น่าจะต้องใช้

```js
// tx 5 ประเภท
vm.deploy({ programUuid?, code, context, initInput, value, metadata, nonce, gasLimit, gasPrice })
vm.init({ programUuid, context, … })      // ทีมงานอนุมัติ → รัน initialization
vm.reject({ programUuid, context, … })    // ปฏิเสธ + คืนเงิน
vm.call({ programUuid, functionName, input, context, value, … })
vm.transfer({ from, to, amount, … })
vm.setMetadata({ metadata, context, … })
// อัปเกรด (ดูหัวข้อ "อัปเกรดโปรแกรม") — deploy รับ upgrader เพิ่ม
vm.upgrade({ programUuid, code, migrateInput, context, … })          // upgrader ส่งโค้ดใหม่ → pending-upgrade
vm.setUpgrader({ programUuid, upgrader /* null = สละสิทธิ์ */, context, … })
vm.initUpgrade({ programUuid, context, … }) / vm.rejectUpgrade(…)    // ทีมงาน (กติกาเดียวกับ init / reject)
vm.listCodeVersions(addr) / vm.getCodeVersion(addr, n) / vm.codeAt(blockNumber, addr) / vm.cloneAddressFor(factory, salt, code)

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
block.call(request)                       // และ deploy / init / reject / transfer / setMetadata / upgrade / setUpgrader / initUpgrade / rejectUpgrade
block.upgrades()                          // การอัปเกรดที่ครบ timelock และถูกเปิดใช้ตอนสร้าง block นี้
block.checkTransaction(request)           // เช็คโควตา + nonce ก่อนใส่จริง
block.header() / block.body() / block.hashes() / block.txHashes()
block.receipt({ number })                 // receipt ของทุก tx
block.writes()                            // writes สุดท้าย (1 รายการต่อ key) + history
block.commit()                            // เขียนทีเดียวผ่าน db.writeKeys (atomic)
```

### ค่าแก๊ส

```
call 100 · read 100 · write 500 · byte 1 · event 200 · topic 375 · hash 100 · recover 3000 · code 10/byte · node 1 · builtin 1 · price 1
```
`emit` = `event + byte × ขนาด data + topic × จำนวน field ที่ indexed`
**แก๊สนับขั้น** (`src/core/gasmeter.js`): ตอนคอมไพล์ฉีด `__gas(n)` ไว้ต้นฟังก์ชัน / ต้นทุกรอบลูป / ทุกทางของ if, switch, try
(n = จำนวน node ของ AST ในช่วงนั้น × `node`) · โค้ดใน DB ไม่เปลี่ยน (ฉีดตอนคอมไพล์ทุกครั้ง) · ชื่อ `__gas` `__str` `__props` `__spread` `__call` สงวนไว้

**แก๊สตามขนาดข้อมูลที่คัดลอก / สร้าง** (เทสต์ `76-gas-bulk-copy`): `builtin` (1) ต่อ **หน่วย** · 1 หน่วย = 1 สมาชิก / property / argument หรือ 32 ตัวอักษร / byte (ปัดขึ้น) · ค่าเดี่ยว = 1
- spread / rest: `[...a]` `f(...a)` `new F(...a)` `const [x, ...r] = a` → `__spread` คิด 1 ต่อสมาชิก · `{ ...o }` `const { x, ...r } = o` → `__props` คิด 1 ต่อ property
  (rest ใน pattern ที่ไม่มีนิพจน์ให้ห่อ — พารามิเตอร์ / for-of / catch / ซ้อน → deploy ไม่ผ่าน · `function f(...args)` ใช้ได้)
- `a + b` / `a += b` → `__str` คิดตามความยาวผลลัพธ์ถ้าเป็น string (QuickJS ต่อแบบ rope แล้วค่อยคัดลอก ก้อนใหญ่จึงต้องคิดตอนต่อ) · template ใช้ `"".concat` ที่ถูกห่อแล้ว
- เมธอดในตัว (Array / TypedArray / String / Object / JSON / Reflect / RegExp / Set / Map / Promise / URI …) ถูกห่อใน prelude ก่อนโค้ดของผู้ใช้รัน
  ของจริงอยู่ใน closure เท่านั้น → `a.join()` / `.call` / `Reflect.apply` / เก็บใส่ตัวแปร คิดเท่ากัน · การแปลงเป็น string โดยนัย (`a + ""`, `${a}`) ผ่าน `join` ที่ห่อไว้
  คิด `this` + argument ก่อนทำ และผลลัพธ์หลังทำ · `repeat` `padStart` `padEnd` `Array.from({length})` คิดขนาดผลลัพธ์ก่อนสร้าง
- `ArrayBuffer` / typed array / `RegExp` / `Set` / `Map` / `WeakSet` / `WeakMap` / `AggregateError` ถูกห่อด้วย Proxy (คิดก่อนจอง) · `Array(n)` ไม่คิด (ยังไม่จองจริง)
- iterator ในตัวของ array / string / Set / Map ถูกล็อก (แก้ไม่ได้) → spread ใช้ทางคัดลอกเร็วของ engine และรู้จำนวนสมาชิกแน่นอน · Proxy ที่โปรแกรมสร้างถูกจดไว้ (spread แล้วคัดลอกเองทีละ property)
- `runProgram` / `cloneProgram`: 1 ต่อ 32 byte ของ input (JSON) และของค่าที่ return
- ผล: ลูป `a = [...a, ...a]` จาก ~230 gas ต่อ 32 MB → หมดแก๊สที่ 3M ก่อนถึงเพดานหน่วยความจำ · string / ArrayBuffer 32 MB ≈ 1,050,000 gas
- ยังไม่ได้คิดตามขนาด: CPU ของ regex ที่ backtrack · BigInt ใหญ่ (`**`) · array-like ที่ getter ของ `length` โกหก (จองก่อนคิดหลังทำ — ถูกเพดานหน่วยความจำกันอยู่)
เพดานต่อ tx `maxTxGas` (ค่าเริ่มต้น 10,000,000, server 3,000,000) ใช้แม้ไม่ได้หักค่าแก๊ส → ลูปไม่รู้จบจบด้วย OUT_OF_GAS ไม่ต้องรอ timeout (timeout server 5 วิ เหลือเป็นตัวกันสุดท้าย)
ผู้จ่ายคือ sender ชั้นนอกสุดเสมอ · `gasLimit` / `gasPrice` (หรือ `maxFeePerGas` / `maxPriorityFeePerGas`) ส่งมาเองได้
ส่วนที่เผา → **โอนเข้า `0x000…000` ไม่ได้หายไปเฉย ๆ** ที่เหลือเข้า `feeRecipient` (ดูหัวข้อถัดไป)

### ค่าแก๊สแบบ EIP-1559 (เทสต์ `68-base-fee` `69-fee-mempool` `73-evm-fees`)

| ค่า (option ของ VM · env ของ server) | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `minBaseFee` · `GAS_PRICE` | `gas.price` (server 1 gwei) | base fee ต่ำสุด (และ base fee ของ block แรก) |
| `gasTarget` · `GAS_TARGET` | `maxBlockGas / 2` (server 1,500,000) | แก๊สเป้าหมายต่อ block · ไม่มี `maxBlockGas` และไม่ตั้ง = base fee คงที่ที่ขั้นต่ำ (พฤติกรรมเดิม) |
| `baseFeeChangeDenominator` · `BASE_FEE_DENOMINATOR` | 8 | เปลี่ยนได้ไม่เกิน 1/8 = 12.5% ต่อ block |
| `burnPercent` · `BURN_PERCENT` | 100 | % ของ**ส่วน base fee** ที่เผา (เดิม server ใช้ 50 ของค่าแก๊สทั้งหมด) |

- base fee ของ block n = `nextBaseFee(header n−1)` ตามสูตร EIP-1559: `parent ± parent × |gasUsed − target| ÷ target ÷ denominator` (ขึ้นอย่างน้อย 1 · ไม่ต่ำกว่า `minBaseFee`)
  คำนวณจาก header ก่อนหน้าเสมอ (ผู้ผลิตกำหนดเองไม่ได้) → replay / sync ได้ค่าเดิม · `vm.currentBaseFee()` = ของ block ถัดไป
- tx แบบ 1559 ส่ง `maxFeePerGas` + `maxPriorityFeePerGas` · แบบเดิมส่ง `gasPrice` = ทั้งสองค่า · ไม่ส่งเลย = จ่าย base fee (tip 0)
  · 1559 ไม่ส่ง maxFee = `baseFee + priority` · priority > maxFee → `INVALID_REQUEST` · maxFee / gasPrice < base fee → ปฏิเสธ (ไม่เข้า block)
- **ราคาจริง** `effectiveGasPrice = min(maxFee, baseFee + priority)` = `tx.gasPrice` · ค่าแก๊ส = gasUsed × ราคาจริง
- **แบ่งค่าแก๊ส**: `base = gasUsed × baseFee` (ส่วน base fee) → เผา `base × burnPercent / 100` · tip `fee − base` + base ส่วนที่ไม่เผา → `feeRecipient`
  (ไม่มี feeRecipient = เผาทั้งหมด) · ผลของ tx / receipt มี `baseFee` `burnedFee` `producerFee` (+ `feeType: 2` `maxFeePerGas` `maxPriorityFeePerGas` ของแบบ 1559)
  · ราคาเท่า base fee (tip 0) และ burnPercent 100 = เผาทั้งหมดเหมือนเดิม
- mempool เรียงตาม tip จริงของ block `min(priority, maxFee − baseFee)` · ใบที่ maxFee < baseFee **ยังรอในคิว** ไม่ถูกหยิบจน base fee ลง
  · แทนที่ใบเดิม (nonce เดียวกัน) ต้องเพิ่มทั้ง maxFee และ priority ≥ 10% แบบ geth (แบบเดิม ↔ แบบเดิม ข้อความเดิม)
- header มี `baseFeePerGas` `gasTarget` `burnedFee` `producerFee` (`baseFeePerGas` อยู่ใน hash)

### receiptsRoot / logsBloom ใน header (เทสต์ `70-header-roots`)
- `receiptsRoot` = hash ของ receipt ย่อทุกใบตามลำดับ `{ hash, status, gasUsed, cumulativeGasUsed, effectiveGasPrice, fee, error (code), logs }`
- `logsBloom` = bloom 2048 bit แบบ EVM ของ log ทุกใบ (address + ทุก topic · log จาก `eventLog(event)` ซึ่งไม่ขึ้นกับ state)
- ทั้งคู่ + `baseFeePerGas` + `gasUsed` อยู่ใน `hashBlock` → replay / `rebuildFrom` / sync (`applyBlock`) รันเองแล้วเทียบ hash → ผู้ผลิตปลอม receipt / bloom ไม่ได้
- /evm ใช้ค่าจาก header ตรง ๆ · `eth_getLogs` ข้าม block ที่ bloom ไม่มี address / topic ที่ขอ

### event แบบ indexed (เทสต์ `71-indexed-events`)
- `emit(name, data, { indexed: ["from", "to"] })` · ไม่เกิน 3 field (`MAX_INDEXED` เท่า LOG4) · ต้องมีใน data · ห้ามซ้ำ · event เก็บ `indexed` ไว้ด้วย
- ดัชนี `eventidx:<program>:<name>:<field>:<topic>:<n>:<idx>:<i>` → ค่า = dbKey ของ event · `topic = topicOf(value)` (address = เติม 0 เป็น 32 byte · ตัวเลข = uint256 · bool · string = keccak)
  `eventsig:<topic0>:<program>:<name>` → `{ program, name, indexed }` (ให้ eth_getLogs หาโปรแกรมจาก topic0)
- log แบบ EVM: มี indexed → topic0 = `keccak("Name(type,…)")` ของทุก field ตามลำดับใน data · topics ถัดไป = field ที่ indexed · data = ABI ของ field ที่เหลือ
  · ไม่มี indexed → topic0 = keccak(ชื่อ) + data เป็น JSON (เหมือนเดิม) · token / NFT / multi-token มาตรฐาน index ตาม ERC (Transfer from / to (+ tokenId) · Approval · ApprovalForAll · TransferSingle/Batch · URI · OwnershipTransferred)
- `vm.listIndexedEvents({ program, name, field, value, limit, cursor, fromBlock, toBlock })` · `GET /program/:a/events?name=Transfer&to=0x…` (หลาย field = AND) · `eth_getLogs` ใช้ดัชนีเมื่อมี topic0 + topic อื่น
- ดัชนีอยู่ใน `blockundo` → rebuild ลบ / สร้างใหม่ตาม block

### metadata.abi (เทสต์ `72-abi`)
```js
{ functions: [{ name, inputs: [{ name, type, description? }], outputs: [{ name?, type }], readonly?, payable?, description? }],
  events:    [{ name, fields: [{ name, type, indexed?, description? }], description? }] }
// type ∈ address uint int bool string bytes object array any
```
- ส่งตอน deploy (`metadata: { abi }` · ฟังก์ชันที่ประกาศต้อง export จริง) หรือ `setMetadata("abi", …)` ในโปรแกรม · ตรวจด้วย `checkAbi` (ชื่อ / ชนิด / ห้ามซ้ำ / indexed ≤ 3 / ≤ 64 ฟังก์ชัน · 32 event · 16 field · 16 KB)
- explorer สร้างฟอร์ม Interact จาก inputs (แทนการเดาจากโค้ด) · แท็บ Events บอกชนิด / indexed · แท็บ ABI
- `GET /program/:a/abi` → `{ address, abi, evmAbi }` · `/evm` `cardianal_getAbi(address)` → JSON ABI แบบ Ethereum (`toEvmAbi`: uint → uint256 · object / array / any → string)

### พฤติกรรมที่ล็อกไว้แล้ว (เทสต์คุมอยู่ — อย่าทำให้พัง)

- ไม่มีอะไรลง DB จนกว่าจะ `commit()`
- timeout / DB พัง / แก๊สหมด / หน่วยความจำเกิน → ทั้ง tx ล้ม โปรแกรม `catch` ไม่ได้
- **หน่วยความจำเกิน (`OUT_OF_MEMORY`) → เข้า block กิน nonce เสียค่าแก๊สเท่าที่ใช้** (เหมือนแก๊สหมด · รวมยอดที่ค้างในฝั่งโปรแกรม)
- **คัดลอก / สร้างข้อมูลทั้งก้อนเสียแก๊สตามขนาด** (spread / rest / `+` ที่ได้ string / เมธอดในตัว) เรียกทางไหนก็เท่ากัน (เทสต์ `76`)
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
<addr>:metadata:<field>             namespace / description / type / creator / createdAt / upgrader / version / template
namespace:<name>                    ชื่อ → address (ห้ามซ้ำทั้งระบบ)
pending-upgrade:<id>                โค้ดใหม่ที่ upgrader ส่งมา รอทีมงาน  { code, context, migrateInput }
scheduled-upgrade:<id>              อนุมัติแล้ว รอ timelock  { code, context, migrateInput, approvedAt, activateAt }
upgradeat:<n>                       ดัชนี: โปรแกรมที่ต้องเปิดใช้โค้ดใหม่ตอนสร้าง block n  [id…] (ลบทิ้งเมื่อเปิดใช้)
<id>:codeversion:<n>                โค้ดเวอร์ชัน n  { version, code, blockNumber, timestamp } (เฉพาะโปรแกรมที่เคยอัปเกรด)
```
`pending-upgrade:` / `scheduled-upgrade:` ใช้ขีดกลาง จึงไม่ปนกับ `pending:` (รายการรออนุมัติ deploy นับด้วย prefix `pending:`)

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
eventidx:<program>:<name>:<field>:<topic>:<n>:<idx>:<i>   ดัชนีของ field ที่ emit แบบ indexed → dbKey ของ event
eventsig:<topic0>:<program>:<name>     topic0 แบบ EVM → { program, name, indexed } (eth_getLogs)
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
             input: { to: bob, amount: "100n" }, value: 0, nonce, gasLimit: 500000, gasPrice: "1000000000" };   // 1 gwei
const signature = signTransaction(tx, privateKey);       // ฝั่ง wallet
const { action, method, sender, hash, request } = verifyTransaction({ tx, signature });  // ฝั่ง server
vm[method](request);
```

- domain `{ name: "ProgramVM", version: "1", chainId }`
- field ที่เซ็น **ลำดับห้ามสลับ**: `action, from, to, method, input, value, nonce, gasLimit, gasPrice`
  · tx แบบ EIP-1559 (มี `maxFeePerGas` หรือ `maxPriorityFeePerGas`) ใช้ `TRANSACTION_TYPE_1559` = ชุดเดิมที่ตัด `gasPrice` แล้วต่อท้าย `maxFeePerGas, maxPriorityFeePerGas`
    → tx แบบเดิมได้ digest เดิมทุกไบต์ · ส่ง gasPrice (≠ 0) คู่กับสอง field ใหม่ = ปฏิเสธ · `maxFeePerGas: 0` = ไม่ระบุ
- `input` และ `code` ถูกยุบเป็น string เดียวด้วย `canonicalJson({ input, code })` → เซ็นข้อมูลชนิดไหนก็ได้
- `action` ที่รับ: `call` `deploy` `transfer` `metadata` `init` `reject` `upgrade` `setUpgrader` `initUpgrade` `rejectUpgrade`
  → `VM_METHOD` map ไปเป็นเมธอดของ VM (`metadata` → `setMetadata` · ที่เหลือชื่อเดียวกัน)
  - `upgrade`: `to` = โปรแกรม · `code` = โค้ดใหม่ · `input` = migrateInput · `setUpgrader`: `input = { upgrader: "0x…" | null }`
  - `deploy` มี field `upgrader` เพิ่มได้ → ถูกยุบเข้า string ที่เซ็นเป็น `canonicalJson({ input, code, upgrader })`
    **ไม่ส่ง = ไม่มี key นี้** → tx / ลายเซ็นเดิมทุกใบได้ digest เหมือนเดิม (ใน hash ของ VM ก็เช่นกัน)
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
| `GET /genesis` | `{ hash, chainId, latest, pending, gasPrice, baseFee, gasTarget, maxBlockGas, burnPercent, burned }` — explorer poll ทุก 3 วิ · `baseFee` = ของ block ถัดไป |
| `GET /blocks?before&limit` | header ย้อนหลัง |
| `GET /block/latest` | header ล่าสุด |
| `GET /block/:n` | header · `?full=1` → `replayBlock()` receipt เต็ม (409 ถ้า hash ไม่ตรง) |
| `GET /tx/:hashOrDigest` | ดัชนี + `record` · ถ้าอยู่ในคิว → `{ status: "pending" }` · ถูกแทนที่ → `{ status: "replaced", hash, replacedBy }` (ใช้ hash เท่านั้น ไม่รับ digest) · ถูกปฏิเสธ → `{ status: "rejected", block, blockNumber, index, reason, code, stage, sender, nonce, action, to, gasPrice, timestamp }` (`block: null` = รอ block ถัดไป) |
| `GET /rejected?address&limit&cursor` · `GET /address/:a/rejected` | tx ที่ถูกปฏิเสธ ใหม่ไปเก่า `{ items, next }` · ไม่ระบุ address = ทั้งเชน (ไล่ ≤ 1,000 block ต่อ request) |
| `GET /tx/:hash/receipt` | receipt จากการ replay block นั้น + `blockNumber` |
| `GET /address/:a` | native, nonce, metadata, isProgram, transactions, incoming |
| `GET /program/:a` | code, context, metadata, native, storage (50 แรก), interactions, events, `token` (null ถ้าไม่ใช่ token ตามมาตรฐาน), `collection` (`{ address, standard: "ERC-721" \| "ERC-1155", name, symbol, totalSupply? }` · null ถ้าไม่ใช่ NFT / multi-token), `pendingUpgrade` / `scheduledUpgrade` (null ถ้าไม่มี) |
| `GET /program/:a/versions` | โค้ดทุกเวอร์ชัน `[{ version, code, blockNumber, timestamp }]` (ว่าง = ไม่เคยอัปเกรด) |
| `GET /address/:a/tokens` | เหรียญที่ถือ `[{ address, name, ticker, decimals, totalSupply, balance }]` · ยอด 0 ไม่แสดง |
| `GET /address/:a/nfts` | NFT / multi-token ที่ถือ `[{ program, standard, name, symbol, tokenId, amount, uri }]` (สูงสุด 200) · โปรแกรมจากดัชนี `holding:` · ชิ้นจาก `owned:<a>:<id>` (ERC-721) / `balances:<a>:<id>` (ERC-1155) · ยอด 0 ไม่แสดง |
| `GET /token/:a` | `{ address, name, ticker, decimals, totalSupply }` · 404 ถ้าไม่ใช่ token |
| `GET /program/:a/storage?prefix&start&limit` | `{ items, next, prefix }` — cursor pagination |
| `GET /program/:a/groups?scan&cursor` | นับ key ตามชื่อ key แรก **ทีละช่วง**: `scan` key ต่อ request (ค่าเริ่ม 20,000 · สูงสุด 50,000) → `{ total, groups, scanned, next, complete }` · `next` ไม่ใช่ null → ส่ง `cursor=next` ต่อแล้วบวกผลเอง (นับครบทุก key) |
| `GET /program/:a/interactions?limit&cursor` · `/program/:a/events?cursor=` · `/address/:a/incoming?cursor=` | แบบ cursor (เหมือนแถบ storage) `{ items, next }` อ่านแค่ limit + 1 key ไม่นับทั้งรายการ ไม่มีเพดาน 50,000 · ไม่ส่ง `cursor` = แบบเลขหน้าเดิม |
| `GET /nonce/:a` | nonce ถัดไป **รวมใบที่รออยู่ในคิว** — ใช้ตัวนี้ตอนสร้าง tx |
| `GET /name/:ns` | namespace → address |
| `GET /state/:a?block` | state ของโปรแกรม ณ block นั้น (`snapshotAt`) |
| `GET /events?program&name&limit` | event |
| `GET /pending` | `{ size, transactions, rejectedPending }` (`rejectedPending` = tx ที่ถูกปฏิเสธที่รอลง block) |
| `GET /programs` | `{ approved, pending }` จำนวนโปรแกรมที่อนุมัติแล้ว (มี `<address>:this`) / รออนุมัติ (`pending:<address>`) · ไม่มีดัชนีรวม จึงไล่ 1 key ต่อ address (`approvedProgramAddresses`) |
| `GET /programs/pending` · `/programs/approved` | แบ่งหน้า `?page=&limit=` → `{ items: [{ address, name, deployer \| creator, createdAt, value, codeSize, token, collection? }], total, pages }` (`collection` = `"ERC-721"` / `"ERC-1155"` มีเฉพาะ NFT / multi-token → แสดงเป็น NFT / Multi-token) · หน้า explorer `#programs` (กดจากกล่องในหน้าแรก) |
| `GET /sync?from` | `[{ header, body, rejected }]` สูงสุด 50 block — ให้ node ผู้อ่านดึง |

**แบบแบ่งหน้า** (explorer ใช้ทุกรายการยาว) · `?page=<เริ่ม 1>&limit=<≤100, ค่าเริ่ม 20>` → `{ items, total, page, pages, limit, truncated }`
page เกินหน้าสุดท้าย → ได้หน้าสุดท้าย · นับ key ไม่เกิน 50,000 ตัวต่อรายการ (`PAGE_SCAN`) เกินแล้ว `truncated: true`
โค้ดอยู่ `src/node/explorer-api.js` (`pageOf` `slicePage` `page*`) · เทสต์ `49-explorer-paging`

| endpoint | รายการ |
|---|---|
| `GET /blocks/page` | header ใหม่ไปเก่า (คำนวณจากเลข block ไม่ไล่ key) |
| `GET /address/:a/txs` | tx ที่ address ส่ง · **เรียงด้วยเลข nonce** (key `txn` ไม่ได้เติม 0 ข้างหน้า เรียงตามตัวอักษรจะผิดตั้งแต่ nonce 10) |
| `GET /address/:a/incoming` | tx ที่เข้ามาหา (ดัชนี `txto:` รวมการเรียกซ้อนชั้น · แถวซ้อนชั้นมี `status` = ผลของ call ชั้นนั้น และ `txStatus` = ผลของทั้ง tx) |
| `GET /program/:a/events?name` | event ใหม่ไปเก่า · `&<field>=<value>` (ต้องมี name) = ค้นด้วยดัชนี indexed แบบ cursor |
| `GET /program/:a/abi` | `{ address, abi, evmAbi }` (ไม่ได้ประกาศ = null) |
| `GET /program/:a/entries?name` | key 2 ชั้นของกลุ่ม `name` (ข้าม key 3 ชั้น) |
| `GET /token/:a/holders` | ผู้ถือจาก `balances:<address>` ของโปรแกรม · ข้ามยอด 0 · ยอดมากไปน้อย · 404 ถ้าไม่ใช่ token |

**trace ใน receipt** (`/tx/:h/receipt` → `trace[]`): `{ depth, program, method, from, origin, input, value, result, gasUsed, status, error }`
`input` / `value` / `result` / `gasUsed` เพิ่มเมื่อ 9 ต.ค. (เก็บใน `tx.calls` ตอนรัน ไม่ได้เขียนลง DB และไม่เข้า hash ของ block)
`gasUsed` ของชั้นนอกรวมของชั้นในแล้ว · ข้อความ error ของ server เป็นภาษาอังกฤษ (ข้อความ error จาก VM / โปรแกรมยังเป็นไทยตามเดิม)
`type: "create"` มีเฉพาะรายการที่สร้างโปรแกรมด้วย `cloneProgram` (call ธรรมดาไม่มี field นี้) · หน้า tx แสดงเป็น "Create #n" + tag CREATE · callTracer ของ `/evm` เป็น frame `CREATE`
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

### `/evm` — ตัวแปลงสำหรับกระเป๋า / เครื่องมือ EVM / Blockscout (`src/node/evm-rpc.js` + `evm-ws.js` · เทสต์ `50-evm-rpc` `51-evm-ws` + e2e)
**อ่านอย่างเดียว ไม่เปลี่ยนอะไรในเชน** แค่อ่านข้อมูลเดิมแล้วตอบเป็น JSON-RPC 2.0 แบบ EVM (MetaMask / ethers / viem / Blockscout ต่อได้)
```
POST /evm                      JSON-RPC 2.0 (รองรับ batch) · rate limit แยก EVM_RATE_LIMIT (ค่าเริ่มต้น 600/นาที/IP · 0 = ไม่จำกัด สำหรับ indexer)
ws://host/evm                  เหมือน POST + eth_subscribe("newHeads" | "logs") / eth_unsubscribe (ตรวจ block ใหม่ทุก 1 วินาทีเฉพาะตอนมีคน subscribe)
GET  /evm                      ค่าสำหรับ wallet_addEthereumChain { chainId, chainName, nativeCurrency, rpcUrls, blockExplorerUrls }
GET  /evm/explorer/{tx|address|token|block}/:id   302 → /#tx/… (ลิงก์ "ดูใน explorer" ของกระเป๋า)
```
- รองรับ (`rpc.methods`): `eth_chainId` `net_version` `eth_blockNumber` `eth_getBalance` `eth_getTransactionCount` `eth_getCode` `eth_gasPrice`
  `eth_maxPriorityFeePerGas` `eth_feeHistory` `cardianal_getAbi`
  `eth_getBlockByNumber/ByHash` `eth_getBlockReceipts` `eth_getTransactionByHash` `…ByBlockNumberAndIndex` `…ByBlockHashAndIndex` `eth_getTransactionReceipt`
  `eth_getLogs` (ช่วงไม่เกิน 1000 block) `eth_call` (ERC-20 / ERC-721 / ERC-1155 อ่านอย่างเดียว) `eth_estimateGas`
  `debug_traceTransaction` `debug_traceBlockByNumber` `debug_traceBlockByHash` (เฉพาะ `{ tracer: "callTracer" }`) `txpool_content` `txpool_inspect` `txpool_status` ฯลฯ
- **block tag ย้อนหลัง** (`eth_getBalance` / `eth_getTransactionCount` / `eth_getCode` / `eth_call`) อ่านจาก history ของเชนด้วย `vm.stateAt(n, key)`
  (ต้องเปิด `recordHistory` ซึ่ง server เปิดอยู่) · `eth_call` ย้อนหลังรัน `vm.query` บน state ณ block นั้น (`options.read`) · block ที่ยังไม่มี → error `header not found`
- ผล `vm.replayBlock` เก็บ cache 64 block (key = เลข + hash) → receipt ทุกใบ / `logIndex` (นับต่อเนื่องทั้ง block) / `cumulativeGasUsed` ได้จาก replay ครั้งเดียว
- เชนเก็บ native เป็น wei อยู่แล้ว → `EVM_DECIMALS` ค่าเริ่มต้น 0 (ไม่คูณ) · `nativeCurrency.decimals` = 18 เสมอ · `eth_gasPrice` = base fee ของ block ถัดไป + tip ที่แนะนำ (`eth_maxPriorityFeePerGas` = มัธยฐานของ tip ใน 20 block ล่าสุด)
  · `eth_feeHistory` แบบ geth (≤ 1024 block · baseFeePerGas มีช่องของ block ถัดไป · reward ตาม percentile ถ่วงด้วยแก๊ส) · block มี `baseFeePerGas`
  · tx / receipt แบบ 1559 = `type 0x2` + `maxFeePerGas` `maxPriorityFeePerGas` `accessList: []` · `gasPrice` / `effectiveGasPrice` = ราคาจริง
- timestamp ÷ 1000 · block 0 = genesis (`vm.genesisHash()`, เวลา = เวลาของ block 1) · `gasLimit` = `vm.maxBlockGas` (ไม่ได้ตั้ง → 30M)
- status `0x1/0x0` · `contractAddress` = programUuid ของ deploy · `logsBloom` / `receiptsRoot` ของ block มาจาก header · ของ receipt คำนวณจาก log
- log มาจาก `eventLog(event)` ของ VM (ไม่อ่าน state): event ที่ emit แบบ indexed → topic0 = keccak ของลายเซ็น + topic ของ field ที่ indexed + data แบบ ABI
  (token มาตรฐาน → log ERC-20 ตรงตัว) · event อื่น → topic0 = keccak(ชื่อ), data = JSON เป็น hex
- NFT มาตรฐาน (`checkNftStandard`) → `Transfer` 4 topic (from, to, **tokenId indexed**, data `0x`) + `Approval(address,address,uint256)` + `ApprovalForAll(address,address,bool)` แบบ ERC-721
  multi-token มาตรฐาน (`checkMultiTokenStandard`) → `TransferSingle` (data = id, value) / `TransferBatch` (data = ABI `uint256[]` × 2) / `ApprovalForAll` / `URI` แบบ ERC-1155
  Blockscout แยก ERC-20 / ERC-721 จากจำนวน topic ของ Transfer และรู้จัก ERC-1155 จาก TransferSingle / Batch · ตรวจด้วย ethers `Interface.parseLog` ในเทสต์ `66-evm-nft-logs`
- `eth_call` ของ NFT: `name symbol totalSupply balanceOf ownerOf tokenURI getApproved isApprovedForAll supportsInterface` · ของ multi-token: `name symbol balanceOf(address,uint256) uri totalSupply(uint256) isApprovedForAll supportsInterface`
- tx `input` = JSON `{action, method, input}` เป็น hex (ไม่ใช่ ABI) · `eth_getCode` = ซอร์ส JS ของโปรแกรมเป็น UTF-8 hex (กระเป๋า → `0x`)
- callTracer: root = tx (`CREATE` สำหรับ deploy), `calls[]` = trace ซ้อนตาม depth · native ที่โปรแกรมโอนด้วย `transferNative` (ไม่อยู่ใน trace)
  หาได้จาก `nativeChanges` หลังตัด value ของทุกชั้นและค่าธรรมเนียม (consumed → address ศูนย์ / feeRecipient) → เป็น `CALL` จากโปรแกรมนั้นไปผู้รับ · ค่าแก๊สไม่เป็น internal tx
- txpool: จาก `mempool.list()` (ไม่มี to / value เพราะ mempool ไม่ได้เปิดให้อ่าน)
- **ส่ง tx ไม่ได้**: `eth_sendRawTransaction` ตอบ error (เชนรับเฉพาะ EIP-712 ของตัวเอง) → ส่งผ่าน explorer เหมือนเดิม
- ไม่รองรับ: `eth_getStorageAt`, `eth_getProof`, `eth_newFilter` ฯลฯ, `trace_*`, `eth_call` กับโปรแกรมที่ไม่ใช่ token / NFT / multi-token มาตรฐาน, `balanceOfBatch` ผ่าน eth_call
- chainId มาจาก `CHAIN_ID` ของเชน (ค่าเริ่มต้น 1 = Ethereum mainnet → MetaMask จะมองว่าซ้ำกับ mainnet)
- Blockscout: `ETHEREUM_JSONRPC_VARIANT=geth` · `ETHEREUM_JSONRPC_HTTP_URL` / `ETHEREUM_JSONRPC_TRACE_URL` = `http://host/evm` · `ETHEREUM_JSONRPC_WS_URL=ws://host/evm`
  · `INDEXER_INTERNAL_TRANSACTIONS_TRACER_TYPE=call_tracer` · `INDEXER_DISABLE_BLOCK_REWARD_FETCHER=true` · ฝั่งเชน `EVM_RATE_LIMIT=0`
  · Blockscout 9.x ต้องเพิ่ม `ETHEREUM_JSONRPC_HTTP_REQUEST_COMPRESSION_HEAVY_METHODS_ENABLED=false` (/evm ไม่อ่าน gzip) · ขั้นตอนเต็ม + เปิด-ปิด + แก้ปัญหา: `docs/blockscout.md`
  · ตัวดักดูคำขอที่เข้า /evm: `node scripts/evm-proxy.mjs` (:3001 → :3000/evm)

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
- helper เล็ก ๆ: `esc` `cut` `num` `when` `ago` `utc` `age` `copy` `addr` `txLink` `panel` `table` `kv`
- เวลาแบบ "… ago" ทุกจุดใช้ `age(t)` (หรือ `utc(t)` ต่อท้าย): มีบรรทัดเล็ก `YYYY-MM-DD HH:MM:SS UTC` ใต้ · จอ ≤720px ซ่อนวินาที (`.utc .sec`)
  **`num()` คือตัวแปลง `"123n"` → ตัวเลขอ่านง่าย — ทุกค่าที่มาจากโปรแกรมต้องผ่านตัวนี้**
- ธีม: ม่วงเข้มแบบ data canvas ธีมเดียว (`color-scheme:dark`) ตามรูปอ้างอิง · `--bg:#0a0616` `--chrome:#07050f` `--panel:#1a0b33` `--accent:#c4b5fd` `--accent-2:#a78bfa` · พื้นหลัง gradient ม่วง #2a0a4a → #6b1a9a + เส้นตาราง · แถบข้างซ้าย (มือถือ = drawer ปุ่ม ☰ `#menu-btn`)
  แท็บที่เลือก / ปุ่มหลัก = ม่วงทึบ #6d28d9 · การ์ดมีป้ายชื่อเล็กด้านบน · กล่อง JSON / โค้ด / ผลลัพธ์ = `#04050d` · รายละเอียดดู EXPLORER-SPEC.md ข้อ 9
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
| Events (`event`) / ABI (`abi`) | event ถอดตาม `metadata.abi` (ชื่อ + ชนิด + tag indexed · `eventData()`) · แท็บ ABI มีเฉพาะโปรแกรมที่ประกาศ (`abiView()`) |
| Tokens (`tokens`) | (เฉพาะกระเป๋าที่ถือเหรียญ · แท็บแรก) ticker, ยอดหารด้วย 10^decimals |
| NFTs (`nfts`) | (เฉพาะ address ที่ถือ NFT / multi-token) collection, ERC-721 / ERC-1155, token ID, จำนวน, URI (http(s) เป็นลิงก์ · ipfs:// ฯลฯ เป็นข้อความ) · `/address/:a/nfts` |
| Holders (`holders`) | (เฉพาะโปรแกรม token) อันดับ, address, ยอด, % ของ supply · `/token/:a/holders` ทีละ 25 |
| Calls / Incoming (`in`) | `/address/:a/incoming` (รวมซ้อนชั้น มี badge "Nested · depth N") · คอลัมน์ Status = สถานะของทั้ง tx (ตรงกับหน้า tx) · call ซ้อนที่ล้มแต่ชั้นบน catch ไว้มีข้อความเตือนสีส้ม "⚠ caught" ต่อท้าย · ข้อมูลเก่าที่ไม่มี `txStatus` ใช้ `status` แทน (ต้องล้าง chain ถึงจะถูก) |
| Outgoing (`out`) | `/address/:a/txs` |
| Interact (`interact`) | (โปรแกรม) ฟอร์ม — เลือกฟังก์ชัน, input JSON, value |
| Edit metadata (`meta`) | (กระเป๋า) ฟอร์มแก้ metadata อยู่แถบเดียวกับ Interact (เดิมเป็นปุ่มในแถว information) |
| Events (`event`) | `/program/:a/events` |
| Storage (`storage`) | แยกตามจำนวนชั้นของ key: Variables / Maps / Lookup (ดูด้านล่าง) |
| Code (`code`) | source |

กดแท็บที่เปิดอยู่แล้วไม่วาดใหม่ (ค่าที่พิมพ์ในฟอร์มไม่หาย)

กล่องข้อมูลของโปรแกรมมีแถว **Version** (`metadata.version` ไม่มี = 1 · มี tag "Upgrade pending review" / "Upgrade active from block N" จาก `pendingUpgrade` / `scheduledUpgrade`)
**Upgrader** (ไม่มี = "None (immutable)") และ **Template** (เฉพาะโปรแกรมที่สร้างด้วย `cloneProgram`)
ชื่อ action ในทุกตาราง / หน้า tx ผ่าน `ACTION_LABELS`: `upgrade` → "Upgrade", `setUpgrader` → "Set upgrader", `initUpgrade` → "Approve upgrade", `rejectUpgrade` → "Reject upgrade", `create` → "Create" (ที่เหลือแสดงชื่อเดิม)

### หน้า block / tx — ค่าแก๊สแบบ EIP-1559
- block: `Base fee` (+ block ถัดไปขึ้น / ลง เทียบ gasUsed กับ target · `baseFeeTrend()`) · `Fee split` เผา / ผู้ปิด block
- tx: `Gas price` = base fee + tip · `Fee limits` (tag EIP-1559 · max fee / max tip) · `Fee split` (`feeRows()`)

### หน้า tx — Return value / Balance changes
แถว "Return value" = ค่าที่โปรแกรม return เต็ม ๆ แสดงแบบเดียวกับผล Read ใน Interact (`returnValue()` ใช้ร่วมกัน) · tx ที่ล้มโชว "— (failed)"
Balance changes = บรรทัดละช่อง: address · received / sent / gas paid · +/−จำนวนที่เปลี่ยน · total ใหม่
จำนวนที่เปลี่ยนมาจาก `before` ใน `nativeChanges` ที่ `block.receipt()` ใส่ให้ (ค่าก่อน tx นั้น ไล่ต่อกันใน block · ไม่อยู่ใน block hash)

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

### มาตรฐาน NFT / multi-token / permit / ERC-1271 / multicall (`src/standards/*` · เทสต์ `62`–`67`)
ทุกมาตรฐานตรวจด้วย `checkStandard(code, functions, events)` (ใน `token.js`) — ดูจาก `return { … }` ตัวสุดท้าย + `emit("ชื่อ"` ในโค้ด · ข้อความ error ในโปรแกรมเป็นภาษาอังกฤษ
โปรแกรม import กันไม่ได้ จึงแจกเป็น string ของซอร์ส (แทรกค่าคงที่ด้วย template string ตอน import โมดูล) · ทุกตัวผ่าน `reviewProgram`

| ไฟล์ | โปรแกรม | สรุป |
|---|---|---|
| `nft.js` | `NFT_PROGRAM` · `checkNftStandard` | ERC-721: `mint({ to, tokenId?, uri? })` (owner / minter · ไม่ส่ง id = ถัดไปเริ่ม 1n) `transferFrom` `safeTransferFrom` (ปลายทางเป็นโปรแกรมต้องตอบ `onERC721Received` = `0x150b7a02`) `approve({ to, tokenId })` `setApprovalForAll` `ownerOf` `balanceOf({ owner })` `getApproved` `isApprovedForAll` `tokenURI` (uri ของชิ้น หรือ baseURI + id) `burn` `setMinter` `supportsInterface` · event `Transfer {from,to,tokenId}` `Approval {owner,approved,tokenId}` `ApprovalForAll {owner,operator,approved}` · storage `owners:<id>` `owned:<owner>:<id>` `balances:<owner>` |
| `multitoken.js` | `MULTITOKEN_PROGRAM` · `checkMultiTokenStandard` | ERC-1155: `balanceOf({ account, id })` `balanceOfBatch({ accounts, ids })` `safeTransferFrom({ from, to, id, amount, data? })` `safeBatchTransferFrom({ …, ids, amounts })` (hook `onERC1155Received` / `onERC1155BatchReceived`) `mint` `mintBatch` `burn` `setApprovalForAll` `uri` (template `{id}` หรือ `setURI`) `totalSupply({ id })` · event `TransferSingle {operator,from,to,id,amount}` `TransferBatch {…,ids,amounts}` `ApprovalForAll {account,operator,approved}` `URI {value,id}` · storage `balances:<account>:<id>` |
| `token.js` | `TOKEN_PROGRAM` + permit | `permit({ owner, spender, value, deadline, signature })` `nonces({ owner })` `permitDomain()` `DOMAIN_SEPARATOR()` · ดูหัวข้อ "ข้อความ permit" ด้านล่าง |
| `wallet.js` | `WALLET_PROGRAM` · `SIGNATURE_CHECKER` · `ERC1271_MAGIC_VALUE` | ERC-1271: `isValidSignature({ hash, signature })` → `"0x1626ba7e"` เมื่อเจ้าของ (key เดียว) เซ็น hash นั้น · `execute({ target, fn, input, value? })` (เจ้าของสั่งเรียกโปรแกรมอื่น) · `transferOwnership` · รับ NFT / 1155 แบบ safe ได้ |
| `multicall.js` | `MULTICALL_PROGRAM` | `aggregate({ calls: [{ target, fn, input }], readonly? })` ตามลำดับ ล้มตัวเดียวล้มหมด · `tryAggregate({ calls, readonly?, requireSuccess? })` → `[{ success, result } \| { success: false, error, code }]` · `readonly: true` = ทุก call เป็น staticcall · `getBlockNumber` `getChainId` `getNativeBalance` · **ปลายทางเห็น sender = multicall** (เหมือน Multicall3) จึงเหมาะกับการรวม "อ่าน" |

**ข้อความ permit** (คล้าย ERC-2612 + EIP-712 แต่ hash แบบ JSON เพราะ `keccak256` / `ecrecover` ในโปรแกรมรับข้อความ ไม่ใช่ byte)
```js
{ domain: { name: <name() ของ token>, version: "1", chainId: ChainId(), verifyingContract: ThisAddress() },
  primaryType: "Permit",
  types: "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)",
  message: { owner, spender, value, nonce, deadline } }        // ตัวเลขเป็น bigint → "123n" ใน canonical JSON · address ตัวพิมพ์เล็ก
digest = keccak256(canonicalJson(ข้อความ))   // ค่าเดียวกับที่ ecrecover(ข้อความ, signature) ในโปรแกรม hash · signature = r||s||v 65 byte
```
- `deadline` เป็น**มิลลิวินาที**เหมือน `params.block.timestamp` · `block.timestamp > deadline` → `permit expired` (เท่ากันยังใช้ได้)
- `nonce` = `nonces({ owner })` ตอนส่ง · สำเร็จแล้วเพิ่ม 1 (ลายเซ็นเดิมใช้ซ้ำไม่ได้) · chain อื่น / token อื่น / ชื่ออื่น → `invalid permit signature`
- owner เป็นโปรแกรม → token เรียก `isValidSignature({ hash: digest, signature })` แบบ `{ readonly: true }` ผ่าน `isValidSignatureNow` (`SIGNATURE_CHECKER`)
  — เจ้าของ `WALLET_PROGRAM` เซ็น **string ของ hash** เป็นข้อความ (`signWalletHash`) · โปรแกรมอื่นที่อยากรับลายเซ็นของกระเป๋าโปรแกรม แทรก `${SIGNATURE_CHECKER}` ในโค้ดแล้วเรียก `isValidSignatureNow(signer, ข้อความ, signature)`
- ตัวช่วยฝั่ง wallet / เทสต์: `src/crypto/program-signature.js` (`programvm/program-signature.js`)
  `permitTypedData(fields)` `permitDigest(fields)` `signPermit(fields, key)` `signWalletHash(hash, key)` `signProgramMessage(ข้อความ, key)` `recoverProgramMessage(ข้อความ, sig)` `programMessageHash(ข้อความ)`
- MetaMask `eth_signTypedData_v4` ใช้กับข้อความนี้ไม่ได้ (คนละวิธี hash) · ต้องเซ็น digest ตรง ๆ แบบไม่มี prefix
- ดัชนี `holding:` นับ event `Transfer` / `TransferSingle` / `TransferBatch` (`HOLDING_EVENTS` ใน VM) → explorer หา NFT / 1155 ที่ address ถือได้

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
เซ็นแบบ EIP-1559 (`TX_TYPE_1559` · `maxFeePerGas` = 2 × `baseFee` จาก `/genesis` · `maxPriorityFeePerGas` 0) · `sendTx({ gasPrice })` = แบบเดิม
`callableOf(code)` อ่านชื่อฟังก์ชันจาก `return { … }` ท้ายโค้ดด้วย regex
`runQuery()` ไม่ต้องต่อ wallet · `runWrite()` ต้องเซ็น แล้วเด้งไปหน้า tx หลัง 2.5 วิ

**Input ของ Interact มี 2 แบบ** (ปุ่ม Fields / JSON · จำแบบที่เลือกไว้ใน localStorage `ix-mode`)
- โปรแกรมที่มี `metadata.abi` และประกาศฟังก์ชันที่เลือก → ช่องมาจาก `inputs` ของ ABI (ชนิด + description · tag ABI) แทนการเดาจากโค้ดด้านล่าง
- Fields: `inferInputs(code, fn)` อ่านโค้ดของฟังก์ชันที่เลือก (`functionSource()` ตัด body ด้วยการนับวงเล็บ) หา `params.input.<ชื่อ>`
  รวม alias (`const i = params.input`), destructuring (`const { to, amount } = params.input` / `({ input })`) และตามเข้า helper ในโปรแกรม 1 ชั้น (`move(from, to, amount)`)
- เดาชนิดจากการใช้งาน (`guessShape`): list (for…of / .length / .map) → object (.ย่อย) → address (ชื่อ to/from/who/owner/token… หรือเป็นเป้าของ transferNative / runProgram)
  → whole number (คำนวณ / เทียบกับ `1n`, ชื่อ amount…) → yes/no (`=== true`, `|| false`, หรือใช้แค่ใน if/!/?) → text
- ช่อง list/object เป็น JSON มีตัวอย่างใน placeholder จาก `item.<key>` ใน for…of · ตัวเลขในช่องเหล่านี้แปลงเป็น `"Nn"` ให้ (`bigints()`)
- ตัวเลขที่กรอก `7` ส่งเป็น `"7n"` (VM ไม่รับ number ของ JS) · ช่องว่าง = ไม่ส่ง key นั้น · ค่าไม่ถูกชนิดขึ้น error พร้อมชื่อช่องตอนกด Read / Send
- สลับ Fields → JSON เขียนค่าที่กรอกเป็น JSON (ค่าที่ไม่ถูกชนิดคัดลอกไปตามที่พิมพ์) · JSON → Fields เติมช่องกลับ key ที่ไม่มีช่องจะเก็บไว้แล้วส่งไปด้วย ("Also sent from the JSON")
- state อยู่ใน `ix` (program, fn, mode, values, json, extra) เปลี่ยนฟังก์ชัน / ต่อ wallet แล้ววาดใหม่ค่าที่พิมพ์ไม่หาย

**ผลของ Read / Send** (`#out` = `.ixout`): แก้ในกล่องเดิม ไม่วาดหน้าใหม่ ระหว่างรอผลเก่าจางลง (`busy()`) แล้ว `showResult()` แทนที่
- บรรทัดสถานะ (✓/✗ · Read หรือ Transaction · ฟังก์ชัน · block · gas) → **Return value** (หรือ Error) → "Full response" พับไว้ (จำว่าเปิด/ปิด)
- Send ไม่เด้งไปหน้า tx แล้ว: รอ `/tx/:hash` จนมี blockNumber (สูงสุด 120 วิ) แล้วอ่าน receipt โชวค่าที่ return + ลิงก์ "View transaction"
- `outSeq` กันผลของรอบเก่าทับรอบใหม่ · ถ้ากล่องหายจากหน้า (เปลี่ยนหน้า / วาดใหม่) หยุดรอทันที

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
ตอนนี้โปรแกรมรันใน sandbox (QuickJS) แล้ว ถึงหลุดการตรวจไปก็เอื้อมไม่ถึง Node · `while(true)` จบด้วยแก๊สหมด (ด่านสุดท้ายคือ interrupt ของ QuickJS ตาม `timeoutMs`)
autoreview จึงเป็นชั้นที่สอง (กันโค้ดที่ไม่ deterministic / อ่านยาก) ไม่ใช่ขอบเขตความปลอดภัยชั้นเดียวอีกต่อไป

---

## 10. เทสต์

`test/` 76 ไฟล์ · 787 เคส · `node --test` ล้วน ไม่มี framework
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
| `40-bigint` | ตัวเลขเป็น BigInt ทั้งระบบ (ไม่มีโหมด number) |
| `43-autoreview` | กฎทุกข้อของตัวตรวจ |
| `44-complex-scenario` | token + market ครบวงจร: approve/transferFrom, native deposit/withdraw, rollback ซ้อน, invariant ว่าเงินไม่หาย |
| `56-upgrade` | อัปเกรด: upgrader / โอน-สละสิทธิ์ / อนุมัติ-ปฏิเสธ / migrate ล้ม / timelock 0 และ N / codeversion / replay / tx ที่เซ็น |
| `57-clone` | cloneProgram: address แบบ CREATE2, salt ซ้ำ, ต้นแบบไม่อนุมัติ, rollback, value, แก๊ส, trace create (callTracer) |
| `58-sandbox` | sandbox: OUT_OF_MEMORY (catch ไม่ได้, รวมทั้งสายการเรียก, จุดเกินแน่นอน, เข้า block เสียแก๊ส) / stack ล้น / เอื้อมไม่ถึง host / แก๊สหมด-หมดเวลา catch ไม่ได้ / แยกโปรแกรม / ค่าข้ามเขตแดน / คืน handle ครบหลังหลายพัน call |
| `62-permit-1271` | permit: ลายเซ็นกู้ได้ทั้ง JS / โปรแกรม · relayer ส่งแทน · replay · หมดเวลา · chain / token / ค่าอื่น · กระเป๋าโปรแกรม (ERC-1271 แบบ staticcall) · execute / transferOwnership |
| `63-nft-standard` `64-multitoken-standard` | NFT / multi-token: mint, สิทธิ์ (approve / operator / minter), safe transfer + hook, ย้อนทั้งชุด, uri, burn, ดัชนีของที่ถือ |
| `65-multicall` | aggregate (ลำดับ + all-or-nothing) · tryAggregate (ย้อนเฉพาะตัวที่ล้ม · requireSuccess) · readonly (staticcall ทุก call) |
| `66-evm-nft-logs` `67-explorer-nft` | /evm: log ERC-721 / ERC-1155 + eth_call (ถอดด้วย ethers) · explorer: collectionInfo / nftHoldings / ชนิดโปรแกรม |
| `68-base-fee` | base fee ขึ้น / ลง / ขั้นต่ำ / ตั้งค่า · ราคาจริง = min(maxFee, baseFee + priority) · เผา / tip / ยอดรวมไม่หาย · แบบเดิม · BaseFee() · replay |
| `69-fee-mempool` | ลายเซ็นแบบ 1559 · mempool เรียงตาม tip จริง · maxFee < baseFee รอในคิว · แทนที่ต้องเพิ่มทั้งสองค่า 10% |
| `70-header-roots` | receiptsRoot / logsBloom ใน header + hash · replay / rebuild / sync ตรวจ · /evm ใช้ค่าจาก header |
| `71-indexed-events` | emit indexed (ตรวจ options · แก๊ส topic) · ดัชนี + cursor + หลาย field · eth_getLogs ตาม topic · token มาตรฐาน |
| `72-abi` | checkAbi (schema ทุกข้อ) · deploy / setMetadata("abi") · toEvmAbi / programAbi / cardianal_getAbi |
| `73-evm-fees` | /evm: baseFeePerGas · type 0x2 / effectiveGasPrice · eth_gasPrice / eth_maxPriorityFeePerGas / eth_feeHistory |
| `76-gas-bulk-copy` | แก๊สตามขนาดข้อมูล: ลูป spread ทวีคูณหมดแก๊สก่อน 32 MB · ทุกทางที่คิด (spread / rest / apply / Set / Map / `+` / เมธอดในตัว / ArrayBuffer / typed array / RegExp / runProgram) · ทางเลี่ยง (iterator / Proxy โกหก / เมธอดเดิม) · OOM จ่ายแก๊สจริง |
| `77-rejected-once` | ใบที่ถูกปฏิเสธซ้ำ (hash เดิม) บันทึกใน block เดียว · ไม่ค้างให้ปิด block ใหม่ · `/evm` block เดิมไม่เปลี่ยนภายหลัง · ใบต่างกันยังบันทึกตามปกติ |
| `59-evm-gaps` | API ที่เทียบ EVM: BlockHash (256 block, replay) / ChainId / Coinbase / BlockGasLimit / GasPrice / GasLeft / CodeHashOf / CodeSizeOf / sha256 / ripemd160 / blake2b / modexp (ค่า + แก๊ส) / runProgram readonly (ห้ามแก้ state ทุกชั้น, catch ได้, trace staticcall) / API ปลอมของ SDK |

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

### scenario ครบทุกฟังก์ชัน (`npm run scenario:full`) — เทสต์ `74-scenario-full`

`scripts/scenario-full.js` + โปรแกรมตัวอย่างใน `scripts/scenario-full-programs.js` (ทุกตัวมี `metadata.abi` + namespace → แสดงสวยทั้ง explorer และ Blockscout)
ส่ง tx จริงทีละชุดแล้ว**ตรวจผลบนเชนทุกข้อ** (~300 ข้อ พิมพ์ ✅ / ❌ ทีละหัวข้อ · ล้มข้อเดียว = exit 1 · รายงาน `scenario-full-report.json`)

```
RATE_LIMIT=0 npm start                         # terminal 1 (ใช้ chain เดิมที่มีข้อมูลอยู่แล้วก็ได้ · รันซ้ำได้ เพราะ --tag สุ่มให้ทุกรอบ)
npm run scenario:full                          # terminal 2 · http://localhost:3000 (~2 นาทีที่ BLOCK_MS 3000)
npm run scenario:full -- --spawn               # เปิด server เอง: MemoryDB · BLOCK_MS 1000 · UPGRADE_DELAY_BLOCKS 2 (ทดสอบ timelock) · ตรวจ sync ด้วย
npm run scenario:full -- --spawn --quick       # BLOCK_MS 300 (~15 วินาที) — ตัวที่เทสต์ 74 ใช้
npm run scenario:full -- --url http://host:3000 --admin-key 0x… --blockscout http://localhost   # server ที่ตั้ง ADMINS / พิมพ์ลิงก์ Blockscout
```

- หัวข้อ: เตรียมกระเป๋า · deploy → init / reject (คืนเงิน) · namespace · ABI · โอน 0 / legacy / 1559 / burnedFee / producerFee / base fee ขึ้น-ลง
  · replace-by-fee (+10%) / replaced / ราคาไม่พอ / tx ที่ถูกปฏิเสธลง block · token (transfer / approve / transferFrom / multiTransfer / permit คน + ERC-1271)
  · NFT (mint / safeTransferFrom ไปคนและ WALLET_PROGRAM / approve / operator / tokenURI) · ERC-1155 (mint / batch / operator / uri) · กระเป๋า ERC-1271 (execute)
  · multicall · runProgram ซ้อน / STATICCALL FORBIDDEN / catch · API ทุกตัวเทียบค่าจริง (รวม replay ได้ Math.random เดิม) · upgrade (reject / approve / timelock / migrate / versions / setUpgrader / สละสิทธิ์)
  · cloneProgram (address ทำนายด้วย `vm.cloneAddressFor`) · OUT_OF_GAS / OUT_OF_MEMORY ทั้งตอน query, /sendtx และ**ใน block** · event indexed (REST + eth_getLogs)
  · /evm ที่ Blockscout ใช้ (block / tx type 0x0-0x2 / receipt + log ERC-20 · ERC-721 4 topic · ERC-1155 / eth_call / feeHistory / tx ที่ล้ม 0x0 / callTracer) · REST ของ explorer · sync
- tx ที่ล้ม "ใน block" ทำด้วยกับดักของ `GAS_LAB_PROGRAM`: `arm()` + `loopIfArmed()` + `memoryIfArmed()` ส่งใน block เดียวกัน (simulate ที่ /sendtx รันบน state ก่อน arm จึงผ่าน)
- sync: import `server.js` ตัวที่สองในโปรเซสของสคริปต์ (env เดียวกับ server ที่ spawn · MemoryDB · ปิด miner) แล้ว `syncOnce` จาก `/sync` จนครบ → เทียบ head hash / stateRoot
  ใช้กับ server ที่เปิดเองได้ด้วย `--sync` (env ที่มีผลกับผลของ tx ต้องตรงกัน เช่น `UPGRADE_DELAY_BLOCKS` `GAS_*` `MEMORY_LIMIT_MB`)
- ท้ายรายงานพิมพ์ address ของโปรแกรมตัวอย่าง + tx ที่น่าดู เป็นลิงก์ `/#address/…` `/#tx/…` ของเรา และ `<blockscout>/token|address|tx/…`
  (hash ที่พิมพ์คือ VM hash = hash ที่ Blockscout เห็น · `/sendtx` คืน digest ที่ผู้ใช้เซ็น — explorer ของเราค้นได้ทั้งสอง)
- **ดูใน Blockscout**: ชี้ Blockscout ไปที่ `/evm` ของ server ตัวเดียวกัน — `ETHEREUM_JSONRPC_VARIANT=geth` · `ETHEREUM_JSONRPC_HTTP_URL=ETHEREUM_JSONRPC_TRACE_URL=http://<host>:3000/evm`
  · `ETHEREUM_JSONRPC_WS_URL=ws://<host>:3000/evm` · `INDEXER_INTERNAL_TRANSACTIONS_TRACER_TYPE=call_tracer` · ฝั่งเชน `EVM_RATE_LIMIT=0` (ขั้นตอนเต็มใน `docs/blockscout.md`)
  `--spawn` ใช้ port สุ่มและ MemoryDB → ถ้าจะดูใน Blockscout ให้เปิด server เอง (`RATE_LIMIT=0 EVM_RATE_LIMIT=0 npm start`) แล้วรันแบบไม่มี `--spawn`
- ข้าม: `TIMEOUT_MS` (แก๊ส 3M หมดก่อนเสมอ ~60 ms · เทสต์ 08 / 58 คุม timeout อยู่แล้ว)
- พบระหว่างทำ (แก้แล้ว · เทสต์ `75-simulate-block-number`): `simulate` ใช้ `number: null` → `BlockNumber()` เป็น null ตอน /sendtx
  โปรแกรมที่คำนวณกับเลข block ถูกปฏิเสธทั้งที่ใน block รันได้ → ตอนนี้จำลองเป็น block ถัดไปเสมอ (ไม่ commit / ไม่จองเลข)
- พบระหว่างทำ (แก้แล้ว · เทสต์ `76-gas-bulk-copy`): spread `[...a, ...a]` ไม่ถูกคิดแก๊สตามจำนวนสมาชิก (รวมการแปลง array เป็น string โดยนัย)
  → เดิมจองหน่วยความจำ 32 MB ได้ด้วย ~230 แก๊ส · ตอนนี้คิด 1 ต่อสมาชิก / 32 byte (หัวข้อ "ค่าแก๊ส") ลูปเดิมหมดแก๊สที่ 3M ก่อน
  `memoryIfArmed` จึงเปลี่ยนเป็นสร้าง string 1 MB (`s + s`) แล้ว `keep.push([s].join(""))` วนไป (`repeat` ถูก autoreview ห้าม) + `gasLimit` 1,500,000 → ยัง OUT_OF_MEMORY ใน block (จ่าย ~1.05M gas · สคริปต์ตรวจว่า gasUsed อยู่ระหว่าง 500K–1.5M)
- ท้ายรายงานพิมพ์ gasUsed ของ tx ที่น่าดูแต่ละตัว + แก๊สรวมทุก block ของรอบนั้น (`gasByTx` / `gasUsed` ในไฟล์รายงาน) · `npm run scenario` ก็พิมพ์ gas/tx ต่อชนิดและแก๊สรวม

---

## 11. ⚠️ ที่ยังไม่ได้ทำ — เรียงตามความสำคัญ

### บล็อกการเปิดให้คนนอก deploy
1. ~~ไม่มี sandbox จริง~~ เสร็จแล้ว: โปรแกรมรันใน QuickJS (WebAssembly) — `src/core/sandbox.js` (หัวข้อ 4 "Sandbox")
   แยกจาก Node จริง · หน่วยความจำ 32 MB / stack 256 KB ต่อ tx (`MEMORY_LIMIT_MB` / `STACK_LIMIT_KB`) · เกิน = `OUT_OF_MEMORY` · ไม่มี `node:vm` แล้ว
   ที่เหลือ: ความเร็ว (token transfer ~1.4 ms/tx เทียบ ~0.6 เดิม) และ fuzz / review ความปลอดภัยของตัวแปลงค่าข้ามเขตแดน
2. ~~gas ยังไม่นับขั้น~~ เสร็จแล้ว: `src/core/gasmeter.js` ฉีดตัวนับตอนคอมไพล์ (1 gas/node) · การคัดลอก / สร้างข้อมูลคิดตามขนาด (spread / rest / string `+` / เมธอดในตัว · 1 ต่อสมาชิกหรือ 32 byte)
   `while(true) {}` จบด้วย OUT_OF_GAS ที่ `maxTxGas` (server 3M) · timeout 5 วิเหลือเป็นด่านสุดท้าย
3. ~~ค่ากลางในหน่วยความจำยังไม่จำกัด~~ เสร็จแล้ว: `memoryLimitBytes` ต่อ tx (sandbox) · `maxValueSize` ยังกันตอนเขียน / return / emit เหมือนเดิม

### บล็อกการมี node ที่สอง
4. `sync.js` พร้อมแล้ว (ดึง body มารันเอง เทียบ hash ไม่ใช่เชื่อ state) · ข้อ 2 เสร็จแล้ว ผลแก๊สไม่ขึ้นกับความเร็วเครื่อง
   เหลือแค่กรณี timeout (ด่านสุดท้าย) ที่ tx ไม่เข้า block

### ค้างคาที่รู้อยู่
5. ~~tx ที่ถูกปฏิเสธไม่เข้า block เลย~~ เสร็จแล้ว: บันทึกใน block (`rejectedRoot` อยู่ใน hash) ไม่รัน ไม่แตะ state — หัวข้อ mempool
   `GET /tx/:hash` → `rejected` · `/rejected` · explorer หน้า tx / block / แถบ Rejected ของ address · `/evm` เห็นเป็น tx ที่ล้ม (ต้องล้างเชนเดิม)
6. ~~native / gas ยังเป็น `number`~~ เสร็จแล้ว: native เป็น BigInt wei 18 ทศนิยม · แก๊สนับทีละขั้น (1 gas/node)
7. ~~`/program/:a/groups` นับได้สูงสุด 5,000 key~~ เสร็จแล้ว: นับครบทีละช่วง (`scan` ≤ 50,000 key ต่อ request + `cursor`)
8. ~~แท็บ interactions / event ยังไม่มี pagination~~ เสร็จแล้ว: แบบ cursor (Newer / Older) ฝั่ง server `/program/:a/interactions` · `/program/:a/events?cursor=`
9. **explorer ยังไม่เคยถูกเทสต์กับ MetaMask จริง** — มี e2e ด้วย Playwright แล้ว (`npm run test:e2e`, wallet จำลองที่เซ็นด้วย ethers)
   แต่ตัว extension MetaMask จริงยังต้องลองด้วยมือ
10. ยังไม่มี load test (ยังไม่รู้ว่าปิด block 500 tx จริงใช้เวลาเท่าไหร่บน LMDB บนดิสก์จริง)
11. ~~สถานะ `replaced` อยู่ในหน่วยความจำ (หายเมื่อ restart)~~ เสร็จแล้ว: `replacedLog` off-chain มีเพดาน (`<DATA>/replaced-tx.jsonl`) อยู่รอด restart
    ยังค้นด้วย VM hash เท่านั้น ไม่รับ digest
12. ~~เชนไม่รับโอน native 0~~ เสร็จแล้ว: โอน 0 ได้แบบ EVM (ยกเลิกใบที่ค้าง = โอน 0 ให้ตัวเอง)
13. ~~explorer ไม่มีฟอร์ม deploy / upgrade~~ เสร็จแล้ว: หน้า `#deploy` (upgrader ไม่บังคับ) · แถบ Upgrade (โค้ดใหม่ + migrate input, โอน / สละสิทธิ์, admin อนุมัติ / ปฏิเสธ) · ปุ่ม Approve / Reject ในรายการรออนุมัติ

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
