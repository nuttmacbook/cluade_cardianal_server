# เขียนโปรแกรมสำหรับ Program VM

```bash
npm install          # ดึง programvm จาก github
npm test             # ทดสอบโปรแกรมในเครื่อง (รันบน VM ตัวจริง)
PRIVATE_KEY=0x… npm run deploy
```

## โครงสร้างโปรแกรม

โปรแกรม 1 ตัว = ไฟล์ JavaScript 1 ไฟล์ ที่มีฟังก์ชันครอบตัวเดียว

```js
export default function program() {
  function initialization(params) {      // รันครั้งเดียวตอนติดตั้ง เรียกจากภายนอกไม่ได้
    writeDB("owner", params.context.sender);
  }

  function helper() {}                   // ไม่อยู่ใน return = ใช้ภายในเท่านั้น

  function greet(params) {
    return "สวัสดี " + params.input.name;
  }

  return { greet };                      // รายชื่อฟังก์ชันที่คนอื่นเรียกได้
}
```

กติกา
- **ทั้งไฟล์อยู่ใน scope เดียว** ห้ามมีอะไรอยู่นอกฟังก์ชันครอบ
- **ห้าม import** โปรแกรมต้องอยู่ได้ด้วยตัวเอง
- `export default` ข้างหน้าใช้เพื่อทดสอบในเครื่องเท่านั้น ตอนส่งขึ้น chain ใช้ `String(program)` ซึ่งไม่มีคำนี้ติดไป

## `params` ที่ทุกฟังก์ชันได้รับ

| ฟิลด์ | ความหมาย |
|---|---|
| `params.input` | ข้อมูลที่ผู้เรียกส่งมา |
| `params.context.sender` | ผู้เรียกชั้นนี้ (เป็นโปรแกรมได้ถ้าถูกเรียกต่อ) |
| `params.context.origin` | ผู้เริ่ม tx เสมอ |
| `params.value` | native ที่แนบมากับการเรียกนี้ |
| `params.block.timestamp` | เวลาของ block |

## API ที่ใช้ได้ในโปรแกรม

```js
readDB(key)                  // อ่านข้อมูลของโปรแกรมตัวเอง
writeDB(key, value)          // เขียน (ค่าต้องเป็น JSON)
deleteDB(key)
map("balances", address)     // ประกอบ key หลายส่วน → "balances:0x…"
runProgram(address, "method", input, { value })   // เรียกโปรแกรมอื่น
runProgram(address, "method", input, { readonly: true })   // เรียกแบบอ่านอย่างเดียว (STATICCALL) — ดูด้านล่าง
cloneProgram(template, initInput, { salt, value })   // สร้างโปรแกรมใหม่จากต้นแบบที่อนุมัติแล้ว → address ใหม่ (แบบ CREATE2)
transferNative(to, amount)   // โอนเงินจากกระเป๋าของโปรแกรมเอง
setMetadata(field, value)    // ตั้ง namespace / description / abi ของโปรแกรม
emit("Transfer", { from, to, amount })   // บันทึก event ให้ explorer (ถูกย้อนถ้ากิ่งนั้นล้ม)
emit("Transfer", { from, to, amount }, { indexed: ["from", "to"] })   // field ที่ค้นด้วยค่าได้ (ไม่เกิน 3) — ดูด้านล่าง
ThisAddress()                // address ของโปรแกรมตัวเอง
keccak256(value)             // hash ของ string หรือ object (object เรียง key ให้เอง)
ecrecover(message, signature) // → address ผู้เซ็น หรือ null ถ้าลายเซ็นใช้ไม่ได้
ThisBalance()                // ยอด native คงเหลือของโปรแกรมตัวเอง
BalanceOf(address)           // ยอด native ของ address อื่น
IsProgram(address)           // address นั้นเป็นโปรแกรมหรือ wallet
MetadataOf(address, field)   // อ่าน metadata เช่น namespace / creator
BlockNumber()                // เลข block ที่ tx นี้อยู่
Date.now()                   // เวลาของ block (เท่ากันทุก tx ใน block เดียว)
Math.random()                // สุ่มแบบ deterministic (รันซ้ำได้ค่าเดิม)

// ---- ข้อมูลของ chain / block / tx (แบบเดียวกับ opcode ของ EVM) ----
BlockHash(n)                 // hash ของ block n (BigInt) ย้อนได้ 256 block · block ปัจจุบัน / อนาคต / เก่ากว่านั้น → null   (BLOCKHASH)
ChainId()                    // chainId ของระบบ (BigInt)                                       (CHAINID)
Coinbase()                   // ผู้ปิด block (feeRecipient) หรือ null ถ้าไม่มี                     (COINBASE)
BlockGasLimit()              // แก๊สสูงสุดต่อ block (BigInt) หรือ null ถ้าไม่จำกัด                (GASLIMIT)
GasPrice()                   // ราคาจริงต่อ 1 gas ของ tx นี้ = min(maxFee, baseFee + tip) (BigInt wei)   (GASPRICE)
BaseFee()                    // base fee ของ block นี้ (BigInt wei · EIP-1559)   (BASEFEE)
GasLeft()                    // แก๊สที่เหลือของ tx (BigInt) หลังหักค่าของตัวเองแล้ว                (GAS)
CodeHashOf(address)          // keccak256 ของโค้ดที่ address นั้นใช้อยู่ · ไม่ใช่โปรแกรม → null       (EXTCODEHASH)
CodeSizeOf(address)          // ความยาวโค้ดเป็น byte (BigInt) · ไม่ใช่โปรแกรม → 0n                 (EXTCODESIZE)

// ---- precompile (ข้อมูลเข้าแบบเดียวกับ keccak256: string หรือ object → hex "0x…") ----
sha256(value)                // SHA-256 (32 byte)
ripemd160(value)             // RIPEMD-160 (20 byte)
blake2b(value)               // BLAKE2b-512 (64 byte)
modexp(base, exponent, modulus)   // (base ** exponent) % modulus แบบ BigInt · modulus = 0n → 0n · แต่ละค่าไม่เกิน 1024 byte

// ---- byte ดิบ + EIP-712 (ลายเซ็นแบบ MetaMask eth_signTypedData_v4) ----
keccak256Bytes("0x…")        // keccak256 ของ byte ดิบ (hex) → "0x…" 32 byte (keccak256(value) ด้านบน hash ข้อความ UTF-8 เสมอ)
ecrecoverDigest(digest, signature)   // ecrecover แบบ EVM จาก digest 32 byte ตรง ๆ → address หรือ null
eip712Digest(domain, types, primaryType, message)   // digest ที่ eth_signTypedData_v4 / ethers signTypedData เซ็น
eip712DomainSeparator(domain, types?)               // domainSeparator ของ EIP-712
```

### EIP-712 ในโปรแกรม (ลายเซ็นจาก MetaMask)

`eip712Digest` คำนวณแบบเดียวกับ ethers `TypedDataEncoder.hash` ทุกไบต์ — รับ `address` `bool` `uint8…uint256` `int8…int256` `bytes1…bytes32` `bytes` `string` struct ซ้อน และ array (`T[]` / `T[3]` ซ้อนกันได้)
`types` ใส่หรือไม่ใส่ `EIP712Domain` ก็ได้ (ไม่ใส่ = ใช้ field ของ domain ที่มีค่า) · ตัวเลขต้องเป็น BigInt · `bytes` / `bytesN` เป็น `"0x…"` · ข้อมูลผิด → error code `INVALID_REQUEST` (catch ได้)

```js
function claim(params) {
  const digest = eip712Digest(
    { name: "Airdrop", version: "1", chainId: ChainId(), verifyingContract: ThisAddress() },
    { Claim: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }] },
    "Claim",
    { to: params.input.to, amount: params.input.amount, nonce: readDB(map("nonce", params.input.to)) || 0n })
  if (ecrecoverDigest(digest, params.input.signature) !== readDB("signer")) throw new Error("bad signature")
  …
}
```
ฝั่งผู้เซ็น: MetaMask `eth_signTypedData_v4` (payload `{ types: { EIP712Domain, Claim }, domain, primaryType, message }`) หรือ ethers `wallet.signTypedData(domain, { Claim }, message)`
หรือตัวช่วยใน `programvm/program-signature.js`: `typedDataDigest(domain, types, primaryType, message)` + `signTypedDataDigest(digest, key)`

### เรียกแบบอ่านอย่างเดียว (`readonly`)

`runProgram(target, fn, input, { readonly: true })` ทำงานแบบ `STATICCALL` ของ EVM: ปลายทาง **และทุกชั้นที่มันเรียกต่อ**
อ่านได้ตามปกติ แต่ `writeDB` / `deleteDB` / `transferNative` / `setMetadata` / `emit` / `cloneProgram` จะ throw
`"writeDB() ใช้ไม่ได้ในการเรียกแบบอ่านอย่างเดียว …"` (code `FORBIDDEN`) ซึ่ง catch ได้เหมือน error ทั่วไป
แนบ `value` ไปด้วยไม่ได้ · ใน trace / `debug_traceTransaction` แสดงเป็น `STATICCALL`

```js
// อ่านราคาจาก oracle โดยมั่นใจว่า oracle แอบแก้ state หรือเรียกกลับมา (reentrancy) ไม่ได้
const price = runProgram(oracle, "price", {}, { readonly: true });
```

### ค่าแก๊สของ API เหล่านี้

| API | แก๊ส |
|---|---|
| `ChainId` / `Coinbase` / `BlockGasLimit` / `GasPrice` / `BaseFee` / `GasLeft` | 10 (`env`) |
| `emit` | 200 (`event`) + 1 ต่อ byte ของ data + 375 (`topic`) ต่อ field ที่ indexed |
| `BlockHash` / `CodeSizeOf` | 100 (`read`) |
| `CodeHashOf` | 100 (`read`) + 100 (`hash`) + 1 ต่อ byte ของโค้ด (ไม่ใช่โปรแกรม = 100) |
| `sha256` / `blake2b` | 100 + 1 ต่อ byte ของข้อมูล |
| `ripemd160` | 300 + 1 ต่อ byte ของข้อมูล |
| `modexp` | 200 + ⌊word² × bit ของ exponent ÷ 3⌋ (word = 8 byte ของตัวที่ยาวสุดระหว่าง base / modulus) |
| `runProgram` แบบ `readonly` | เท่าการเรียกปกติ |
| `keccak256` / `keccak256Bytes` | 100 (`hash`) + 1 ต่อ byte ของข้อมูล (ข้อความ = byte ของ UTF-8 · hex = byte จริง) |
| `ecrecover` | 3000 (`recover`) + 1 ต่อ byte ของข้อความ |
| `ecrecoverDigest` | 3000 (`recover`) |
| `eip712Digest` / `eip712DomainSeparator` | 100 (`hash`) ต่อการ keccak ภายใน 1 ครั้ง + 1 ต่อ byte ที่ถูก hash (typeHash ของแต่ละ struct · string / bytes · array · struct · digest) — digest ของ permit ≈ 1,300 |
| `runProgram` / `cloneProgram` | 100 (`call`) + 1 ต่อ 32 byte (ปัดขึ้น) ของ input (JSON) และอีก 1 ต่อ 32 byte ของค่าที่ return |

### แก๊สตามขนาดข้อมูลที่คัดลอก / สร้าง

นอกจาก 1 gas ต่อ node ของโค้ดที่รันผ่าน ทุกงานที่คัดลอกหรือสร้างข้อมูลทั้งก้อนในคำสั่งเดียวคิด **1 gas ต่อหน่วย** (`builtin`)

- **1 หน่วย = 1 สมาชิก** (สมาชิกของ array / typed array · property ของ object · สมาชิกของ Set / Map · argument)
- **หรือ 32 ตัวอักษร / 32 byte** (string / ArrayBuffer · ปัดขึ้น: 1–32 ตัวอักษร = 1 หน่วย)
- ตัวเลข / BigInt / boolean / null / undefined / function = 1 หน่วย

| ทำอะไร | คิดเท่าไร |
|---|---|
| `[...a]` · `f(...a)` · `new F(...a)` · `const [x, ...rest] = a` · `f.apply(t, a)` · `new Set(a)` / `new Map(a)` | 1 ต่อสมาชิกที่ถูกคัดลอก |
| `{ ...o }` · `const { x, ...rest } = o` | 1 ต่อ property |
| `a + b` / `a += b` ที่ได้ string | 1 ต่อ 32 ตัวอักษรของผลลัพธ์ (ตัวเลข / BigInt บวกกันไม่คิด) |
| template `` `…${x}…` `` | เหมือน `"".concat(…)`: ข้อมูลเข้า + ผลลัพธ์ |
| เมธอดในตัว (`join` `split` `slice` `concat` `map` `filter` `sort` `JSON.stringify` `JSON.parse` `Object.keys` `Object.assign` `repeat` `padStart` `replaceAll` …) | ขนาดของ `this` + ทุก argument (ก่อนทำ) + ขนาดผลลัพธ์ (หลังทำ) |
| `repeat` / `padStart` / `padEnd` / `Array.from({ length: n })` | ขนาดผลลัพธ์คิด**ก่อน**สร้าง → `"x".repeat(1e9)` หมดแก๊สทันทีโดยไม่จองหน่วยความจำ |
| แปลง array เป็น string โดยนัย (`a + ""` · `` `${a}` `` · `String(a)`) | เท่า `a.join()` (+ ส่วนที่ต่อ string) |
| `new ArrayBuffer(n)` | 1 ต่อ 32 byte (คิดก่อนจอง) |
| `new Uint8Array(n)` และ typed array อื่น | 1 ต่อสมาชิก (คิดก่อนจอง) |
| `new RegExp(p)` | 1 ต่อ 32 ตัวอักษรของ pattern |
| `Array(n)` / `new Array(n)` | ไม่คิด (ยังไม่จองที่ให้สมาชิก) — `fill` / `map` / spread … คิดตาม `length` ตอนใช้ |

เรียกทางไหนก็คิดเท่ากัน: `a.join()` · `Array.prototype.join.call(a)` · `Reflect.apply(…)` · เก็บเมธอดใส่ตัวแปรก่อน
ตัวอย่าง: `[...a, ...a]` ของ a 1,000 สมาชิก = 2,000 gas · ลูป `a = [...a, ...a]` จึงหมดแก๊สก่อนถึงเพดานหน่วยความจำ (เดิมจอง 32 MB ได้ด้วย ~230 gas)
หน่วยความจำ 32 MB ≈ 1,000,000 gas (string / ArrayBuffer) · หน่วยความจำเกินก็ยังเสียแก๊สของงานที่ทำไปจริง

ข้อจำกัดที่มากับการคิดแก๊สนี้:
- `...rest` ใน pattern ใช้ได้เฉพาะ `const { a, ...rest } = ค่า` / `const [a, ...rest] = ค่า` (และ `({ a, ...rest } = ค่า)` / `([a, ...rest] = ค่า)`)
  ใส่ในพารามิเตอร์ (`function f({ a, ...rest })`) · `for (const [a, ...rest] of …)` · catch · ซ้อนใน pattern อื่น → deploy ไม่ผ่าน (ไม่มีนิพจน์ให้คิดแก๊ส) · `function f(...args)` ใช้ได้ตามปกติ
- iterator ในตัวของ array / string / Set / Map แก้ไม่ได้ (`Array.prototype[Symbol.iterator] = …` → TypeError)
- ชื่อ `__gas` `__str` `__props` `__spread` `__call` สงวนไว้

### event แบบ indexed

`emit(name, data, { indexed: ["from", "to"] })` สร้างดัชนีต่อ (โปรแกรม, ชื่อ event, field, ค่า) → ค้นได้โดยไม่ต้องไล่ทุก event

- ไม่เกิน 3 field · ต้องมีใน `data` · ห้ามซ้ำ (ผิด = throw)
- `GET /program/<address>/events?name=Transfer&to=0x…` (หลาย field = ต้องตรงทุกตัว) · เครื่องมือ EVM ค้นด้วย `eth_getLogs` ตาม topic ได้
- log แบบ EVM: topic0 = `keccak256("Transfer(address,address,uint256)")` (ชนิดเดาจากค่า: address / uint256 / bool / string …) ตามด้วยค่าของ field ที่ indexed → token ที่ index `from` / `to` อ่านได้เหมือน ERC-20 จริง

### ABI ของโปรแกรม (`metadata.abi` ไม่บังคับ)

ประกาศฟังก์ชัน / event ให้ explorer สร้างฟอร์มและอ่าน event ได้ถูกชนิด (และ `/evm` คืนเป็น JSON ABI ผ่าน `cardianal_getAbi`)

```js
function initialization() {
  setMetadata("abi", {
    functions: [{ name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint" }], outputs: [{ type: "bool" }] },
                { name: "balanceOf", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint" }], readonly: true }],
    events: [{ name: "Transfer", fields: [{ name: "from", type: "address", indexed: true }, { name: "to", type: "address", indexed: true }, { name: "amount", type: "uint" }] }],
  })
}
```

ชนิด: `address` `uint` `int` `bool` `string` `bytes` `object` `array` `any` · ชื่อห้ามซ้ำ · `readonly` กับ `payable` ใช้คู่กันไม่ได้ · ไม่เกิน 64 ฟังก์ชัน / 32 event / 16 field / 16 KB
ส่งพร้อม deploy (`metadata: { abi }`) ก็ได้ — ฟังก์ชันที่ประกาศต้อง export จริง

**ห้ามใช้** `process`, `fetch`, `globalThis`, `performance`, `async`/`await`, `setTimeout` และการ import ทุกชนิด โค้ดที่ใช้สิ่งเหล่านี้จะไม่ผ่านการรีวิว

โปรแกรมรันใน sandbox (QuickJS) แยกจาก server: ไม่มี `eval` / `new Function` / `Intl` · `console.log` เรียกได้แต่ไม่พิมพ์
หน่วยความจำรวมทั้ง tx ไม่เกิน 32 MB (เกิน = `OUT_OF_MEMORY` ทั้ง tx ล้มและเสียค่าแก๊ส) · เรียกฟังก์ชันซ้อนได้ราว 1,400 ชั้น (เกิน = RangeError)

## ตัวเลขเป็น BigInt

ตัวเลขทุกตัวในโปรแกรมต้องเป็น BigInt เสมอ (ไม่มีโหมด number)

```js
const balance = readDB(map("balances", who)) || 0n;   // ✅ 0n ไม่ใช่ 0
writeDB(map("balances", who), balance - params.input.amount);
if (balance < params.input.amount) throw new Error("ยอดไม่พอ");
```

- `params.input` ที่เป็นตัวเลขถูกแปลงเป็น BigInt ให้อัตโนมัติ ไม่ว่า client จะส่ง `30` หรือ `"30n"` มา
- `params.value`, `params.block.timestamp`, `ThisBalance()`, `BalanceOf()`, `BlockNumber()`, `ChainId()`, `GasPrice()`, `GasLeft()`, `CodeSizeOf()`, `modexp()` เป็น BigInt ทั้งหมด (`BlockHash()` ก็รับเลข block เป็น BigInt)
- ค่าที่ return ออกไปและ event จะกลายเป็น string ลงท้าย `n` เช่น `"970n"` เพราะ JSON ไม่มี BigInt
- ใช้ `number` ที่ไหนก็ตามจะถูกปฏิเสธพร้อมข้อความบอกจุดที่ผิด
- `Date.now()` / `Math.*` ในโปรแกรมยังคืน number ตามปกติ ห่อด้วย `BigInt(...)` ก่อนเก็บหรือ return (ทศนิยมต้องปัดก่อน หรือส่งออกเป็น string)
- ยอด native เป็นหน่วยย่อย 18 ทศนิยม (wei) — 1 เหรียญ = `10n ** 18n`

## modifier

ห่อฟังก์ชันด้วยฟังก์ชัน แล้ว return ตัวที่ห่อแล้ว

```js
function onlyOwner(fn) {
  return function (params) {
    if (params.context.sender !== readDB("owner")) throw new Error("ไม่ใช่เจ้าของ");
    return fn(params);
  };
}

const setPrice = onlyOwner(function (params) { writeDB("price", params.input.price); });

return { setPrice };
```

**อ่าน `patterns/SAFE-PATTERNS.md` ก่อนเขียนโปรแกรมที่เกี่ยวกับเงิน** โดยเฉพาะหัวข้อ reentrancy ซึ่งทำให้เงินของคนอื่นหายได้จริง และดูตัวอย่างที่ใช้ pattern ครบใน `patterns/vault.program.js`

## ทดสอบในเครื่อง

```js
import { createChain } from "../lib/testkit.js";
import program from "./hello.program.js";

const hello = createChain().deploy(program, { as: "owner", initInput: { greeting: "สวัสดี" } });

hello.call("greet", { name: "โลก" });              // → "สวัสดี โลก (ครั้งที่ 1)" (ตัวเลขที่ return ออกมาเป็น "123n")
hello.call("greet", {}, { as: "alice" });          // เรียกในนามคนอื่น
hello.callRaw("greet", { name: "โลก" });           // ดู gasUsed / writes / trace
hello.state();                                      // ข้อมูลทั้งหมดที่โปรแกรมเก็บไว้ เช่น { count: "2n" }
hello.address;                                      // address ของโปรแกรม
```

### ทดสอบเร็ว ๆ โดยไม่รัน VM

```js
import { createFakeApi } from "../lib/program-globals.js";
const api = createFakeApi({ self: "0xhello", balances: { "0xhello": 500n }, programs: ["0xtoken"] });
Object.assign(globalThis, api);
const { greet } = program();

greet(api.params({ name: "โลก" }, { sender: "0xalice", value: 0n }));   // ตัวเลขใน input ส่งเป็น BigInt เอง (โหมดนี้ไม่แปลงให้)
api.store / api.native / api.events / api.transfers   // ตรวจผลได้ตรง ๆ
```

รองรับ API ครบทุกตัวยกเว้น `runProgram` และ `cloneProgram` ซึ่งต้องใช้ `createChain()`
(`keccak256` / `ecrecover` / `keccak256Bytes` / `ecrecoverDigest` / `eip712Digest` / `eip712DomainSeparator` / `CodeHashOf` ของโปรแกรมที่มีโค้ดก็ต้องใช้ `createChain()` เพราะ `node:crypto` ไม่มี keccak · `GasLeft()` คืน `null` เพราะโหมดนี้ไม่นับแก๊ส)

ค่าของ block / chain ตั้งได้: `createFakeApi({ blockNumber: 10, blockHashes: { 9: "0x…" }, chainId: 1, coinbase: "0xminer", blockGasLimit: 30_000_000, gasPrice: 10n ** 9n, baseFee: 10n ** 9n, code: { "0xtoken": "function program() { … }" } })`

`createChain()` รันบน VM ตัวจริง พฤติกรรมจึงเหมือนบน chain ทุกอย่าง ทั้งการย้อนข้อมูลเมื่อ throw, ค่าแก๊ส และเวลาของ block

ตัวเลือกเพิ่มเติม

```js
createChain({ chargeGas: true, balances: { alice: 10n ** 18n } });   // ทดสอบเรื่องค่าแก๊ส (ยอด native เป็น wei)
chain.transfer("alice", "bob", 100);
chain.balanceOf("alice");    // { received, sended, consumed, balance } เป็น BigInt
chain.setTime(Date.parse("2025-01-01"));
```

## โปรแกรมมาตรฐาน (ERC) ที่ใช้ได้ทันที

`import { … } from "programvm/standards/<ไฟล์>.js"` แล้ว deploy string ของโค้ดได้เลย (ผ่าน autoreview ทุกตัว)

| ไฟล์ | ใช้ทำ | input ตอน deploy |
|---|---|---|
| `token.js` → `TOKEN_PROGRAM` | เหรียญแบบ ERC-20 + `permit` (ERC-2612) | `{ name, ticker, decimals, supply }` |
| `nft.js` → `NFT_PROGRAM` | NFT แบบ ERC-721 (`mint` / `transferFrom` / `safeTransferFrom` / `approve` / `setApprovalForAll` / `tokenURI`) | `{ name, symbol, baseURI? }` |
| `multitoken.js` → `MULTITOKEN_PROGRAM` | หลาย id ในโปรแกรมเดียวแบบ ERC-1155 (`balanceOfBatch` / `safeBatchTransferFrom` / `mintBatch` / `uri`) | `{ name?, symbol?, uri }` |
| `wallet.js` → `WALLET_PROGRAM` | กระเป๋าโปรแกรมแบบ ERC-1271 (`isValidSignature` / `execute`) | `{ owner? }` |
| `multicall.js` → `MULTICALL_PROGRAM` | `aggregate` / `tryAggregate` หลาย call ใน tx / query เดียว (`readonly: true` = staticcall) | — |

ตัวเลขทุกตัว (tokenId, id, amount, deadline) เป็น BigInt · ข้อความ error เป็นภาษาอังกฤษ

### permit (ERC-2612) — ให้คนอื่นส่ง tx ตั้งวงเงินแทน owner

permit เป็น EIP-712 มาตรฐาน: owner เซ็นด้วย MetaMask `eth_signTypedData_v4` ได้ตรง ๆ (explorer มีแถบ **Permit** ในหน้า token)

```js
import { TOKEN_PROGRAM, PERMIT_TYPES } from "programvm/standards/token.js";
import { signPermit, permitTypedData } from "programvm/program-signature.js";

// token ต้องอยู่ที่ address จริง (0x + 40 hex) เพราะเป็น verifyingContract ของ domain
const fields = { name: "Thai Baht Coin", chainId: 1 /* ChainId() ของเชน */, verifyingContract: tokenAddress, owner, spender,
  value: 500n, nonce: 0n /* nonces({ owner }) */, deadline: BigInt(Math.floor(Date.now() / 1000) + 600) /* unix วินาที */ };
const signature = signPermit(fields, ownerKey);   // = ethers wallet.signTypedData(domain, PERMIT_TYPES, message) = MetaMask
// MetaMask: ethereum.request({ method: "eth_signTypedData_v4", params: [owner, JSON.stringify(permitTypedData(fields))] })
// owner เป็น WALLET_PROGRAM (ERC-1271): เจ้าของกระเป๋าเซ็น typed data เดียวกันโดยใส่ owner = address ของกระเป๋า
send({ action: "call", to: tokenAddress, method: "permit", input: { owner, spender, value: "500n", deadline: `${fields.deadline}n`, signature } });
```

domain = `{ name: name(), version: "1", chainId: ChainId(), verifyingContract: ThisAddress() }` · types = `Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)`
`DOMAIN_SEPARATOR()` = domainSeparator ของ EIP-712 · หมดเวลาเมื่อ `params.block.timestamp / 1000n > deadline` (deadline เป็น**วินาที**) · ใช้แล้ว nonce + 1
token ที่ deploy ก่อนรุ่นนี้ยังใช้แบบเดิม (digest = keccak256 ของ canonical JSON · deadline มิลลิวินาที) จนกว่าจะ deploy ใหม่

### รับลายเซ็นจากกระเป๋าโปรแกรม (ERC-1271) ในโปรแกรมของคุณ

```js
import { SIGNATURE_CHECKER } from "programvm/standards/wallet.js";
const code = `function program() {
  ${SIGNATURE_CHECKER}
  function claim(params) {
    const digest = eip712Digest({ name: "Claims", version: "1", chainId: ChainId(), verifyingContract: ThisAddress() },
      { Claim: [{ name: "nonce", type: "uint256" }] }, "Claim", { nonce: 1n })
    if (!isValidSignatureNow(params.input.signer, digest, params.input.signature)) throw new Error("bad signature")
    …
  }
  return { claim }
}`;
```
`isValidSignatureNow(signer, hash, signature)` (hash = digest 32 byte เช่นจาก `eip712Digest`): กระเป๋าคน → `ecrecoverDigest(hash, signature) === signer` · โปรแกรม → `runProgram(signer, "isValidSignature", { hash, signature }, { readonly: true }) === "0x1626ba7e"`
ฝั่งผู้เซ็น: MetaMask `eth_signTypedData_v4` ของ typed data เดียวกัน หรือ `signTypedDataDigest(digest, key)` · `WALLET_PROGRAM.isValidSignature` ตรวจว่าเจ้าของเซ็น digest นั้นตรง ๆ

## ส่งขึ้น chain

```js
import program from "./hello-world/hello.program.js";
const code = String(program);    // ← สิ่งที่ส่งไปคือ string นี้

const tx = { chainId: 1, action: "deploy", from: me, to: "", method: "",
             input: { greeting: "สวัสดี" }, code, value: 0, nonce, gasLimit: 200000,
             maxFeePerGas: "2000000000", maxPriorityFeePerGas: "0" };   // EIP-1559: จ่ายไม่เกิน 2 gwei · ไม่ให้ tip (แบบเดิม gasPrice ก็ยังใช้ได้)
await fetch("/sendtx", { method: "POST", body: JSON.stringify({ tx, signature: signTransaction(tx, key) }) });
```

เซ็นด้วย MetaMask ก็ได้ (`eth_signTypedData_v4`) โครงสร้างที่ต้องเซ็นสร้างได้จาก `buildTypedData(tx)` ใน `programvm/signature.js`

หลัง deploy โปรแกรมจะอยู่ในสถานะรอรีวิว ใช้งานได้เมื่อทีมงานส่ง tx `init` ให้แล้ว
