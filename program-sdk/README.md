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
setMetadata(field, value)    // ตั้ง namespace / description ของโปรแกรม
emit("Transfer", { from, to, amount })   // บันทึก event ให้ explorer (ถูกย้อนถ้ากิ่งนั้นล้ม)
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
GasPrice()                   // ราคาต่อ 1 gas ของ tx นี้ (BigInt wei) — ไม่มี base fee จึงไม่มี BaseFee()   (GASPRICE)
GasLeft()                    // แก๊สที่เหลือของ tx (BigInt) หลังหักค่าของตัวเองแล้ว                (GAS)
CodeHashOf(address)          // keccak256 ของโค้ดที่ address นั้นใช้อยู่ · ไม่ใช่โปรแกรม → null       (EXTCODEHASH)
CodeSizeOf(address)          // ความยาวโค้ดเป็น byte (BigInt) · ไม่ใช่โปรแกรม → 0n                 (EXTCODESIZE)

// ---- precompile (ข้อมูลเข้าแบบเดียวกับ keccak256: string หรือ object → hex "0x…") ----
sha256(value)                // SHA-256 (32 byte)
ripemd160(value)             // RIPEMD-160 (20 byte)
blake2b(value)               // BLAKE2b-512 (64 byte)
modexp(base, exponent, modulus)   // (base ** exponent) % modulus แบบ BigInt · modulus = 0n → 0n · แต่ละค่าไม่เกิน 1024 byte
```

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
| `ChainId` / `Coinbase` / `BlockGasLimit` / `GasPrice` / `GasLeft` | 10 (`env`) |
| `BlockHash` / `CodeSizeOf` | 100 (`read`) |
| `CodeHashOf` | 100 (`read`) + 100 (`hash`) + 1 ต่อ byte ของโค้ด (ไม่ใช่โปรแกรม = 100) |
| `sha256` / `blake2b` | 100 + 1 ต่อ byte ของข้อมูล |
| `ripemd160` | 300 + 1 ต่อ byte ของข้อมูล |
| `modexp` | 200 + ⌊word² × bit ของ exponent ÷ 3⌋ (word = 8 byte ของตัวที่ยาวสุดระหว่าง base / modulus) |
| `runProgram` แบบ `readonly` | เท่าการเรียกปกติ |

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
(`keccak256` / `ecrecover` / `CodeHashOf` ของโปรแกรมที่มีโค้ดก็ต้องใช้ `createChain()` เพราะ `node:crypto` ไม่มี keccak · `GasLeft()` คืน `null` เพราะโหมดนี้ไม่นับแก๊ส)

ค่าของ block / chain ตั้งได้: `createFakeApi({ blockNumber: 10, blockHashes: { 9: "0x…" }, chainId: 1, coinbase: "0xminer", blockGasLimit: 30_000_000, gasPrice: 10n ** 9n, code: { "0xtoken": "function program() { … }" } })`

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

### permit — ให้คนอื่นส่ง tx ตั้งวงเงินแทน owner

```js
import { TOKEN_PROGRAM } from "programvm/standards/token.js";
import { signPermit, permitDigest, signWalletHash } from "programvm/program-signature.js";
import { addressOf } from "programvm/signature.js";

const owner = addressOf(ownerKey);
const token = chain.deploy(TOKEN_PROGRAM, { as: owner, initInput: { name: "Thai Baht Coin", ticker: "THBC", decimals: "6n", supply: "1000000n" } });
const fields = { name: "Thai Baht Coin", chainId: 1 /* ChainId() ของเชน */, verifyingContract: token.address, owner, spender: "bob",
  value: 500n, nonce: 0n /* token.call("nonces", { owner }) */, deadline: BigInt(Date.now() + 600_000) /* มิลลิวินาที */ };
const signature = signPermit(fields, ownerKey);                       // owner เป็นกระเป๋าคน
// const signature = signWalletHash(permitDigest(fields), walletOwnerKey);   // owner เป็น WALLET_PROGRAM (ERC-1271)
token.call("permit", { owner, spender: "bob", value: "500n", deadline: `${fields.deadline}n`, signature }, { as: "relayer" });
```

ข้อความที่ถูกเซ็น (token สร้างซ้ำแล้วส่งให้ `ecrecover`):
`{ domain: { name, version: "1", chainId: ChainId(), verifyingContract: ThisAddress() }, primaryType: "Permit", types: "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)", message: { owner, spender, value, nonce, deadline } }`
→ digest = `keccak256(canonical JSON)` (เรียง key, BigInt เป็น `"123n"`) · หมดเวลาเมื่อ `params.block.timestamp > deadline` · ใช้แล้ว nonce + 1

### รับลายเซ็นจากกระเป๋าโปรแกรม (ERC-1271) ในโปรแกรมของคุณ

```js
import { SIGNATURE_CHECKER } from "programvm/standards/wallet.js";
const code = `function program() {
  ${SIGNATURE_CHECKER}
  function claim(params) {
    if (!isValidSignatureNow(params.input.signer, { action: "claim", nonce: 1n }, params.input.signature)) throw new Error("bad signature")
    …
  }
  return { claim }
}`;
```
`isValidSignatureNow(signer, ข้อความ, signature)`: กระเป๋าคน → `ecrecover(ข้อความ, signature) === signer` · โปรแกรม → `runProgram(signer, "isValidSignature", { hash: keccak256(ข้อความ), signature }, { readonly: true }) === "0x1626ba7e"`
ฝั่งผู้เซ็น: `signProgramMessage(ข้อความ, key)` ได้ลายเซ็นที่ `ecrecover` ในโปรแกรมกู้ได้ตรง

## ส่งขึ้น chain

```js
import program from "./hello-world/hello.program.js";
const code = String(program);    // ← สิ่งที่ส่งไปคือ string นี้

const tx = { chainId: 1, action: "deploy", from: me, to: "", method: "",
             input: { greeting: "สวัสดี" }, code, value: 0, nonce, gasLimit: 200000, gasPrice: "1000000000" };   // 1 gwei
await fetch("/sendtx", { method: "POST", body: JSON.stringify({ tx, signature: signTransaction(tx, key) }) });
```

เซ็นด้วย MetaMask ก็ได้ (`eth_signTypedData_v4`) โครงสร้างที่ต้องเซ็นสร้างได้จาก `buildTypedData(tx)` ใน `programvm/signature.js`

หลัง deploy โปรแกรมจะอยู่ในสถานะรอรีวิว ใช้งานได้เมื่อทีมงานส่ง tx `init` ให้แล้ว
