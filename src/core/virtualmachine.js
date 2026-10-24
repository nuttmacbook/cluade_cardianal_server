import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ripemd160 } from "@noble/hashes/legacy.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { review, reviewMessage } from "./autoreview.js";
import { instrument, METER_FNS } from "./gasmeter.js";
import { Sandbox, SANDBOX_DEFAULTS, SANDBOX_LIMITS, checkGuestSyntax } from "./sandbox.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { eip712Digest, eip712DomainSeparator, hexBytes, recoverAddress } from "../crypto/eip712.js";
import { keccak256Hex, normalizeAddress, normalizeHex, normalizeHexDeep, canonicalJson, headerFields } from "./encoding.js";
import { StateTrie, buildTrie, trieKeyOf, trieValueOf, TRIE_PREFIX, trieNodeKey } from "./trie.js";

export { keccak256Hex, normalizeAddress, normalizeHex, normalizeHexDeep, canonicalJson };

/*
 *  const vm = new VirtualMachine(new DB("./data"), { timeoutMs: 1000, maxCallDepth: 8 })  // ดู db.js
 *
 *  โปรแกรมอยู่ใน scope เดียวทั้งไฟล์ และเป็น JavaScript ที่ถูกต้อง (ส่งผ่าน API เป็น string ได้ตรง ๆ):
 *    function program() {
 *      function initialization(params) {}   รันครั้งเดียวตอน init — เรียกจากภายนอกไม่ได้
 *      function helper() {}                 ไม่อยู่ใน return = ใช้ภายในโปรแกรมเท่านั้น
 *      function transfer(params) {}
 *      return { transfer }                  รายชื่อฟังก์ชันที่ให้เรียกจากภายนอก (บรรทัดสุดท้าย)
 *    }
 *    ชื่อฟังก์ชันครอบจะเป็นอะไรก็ได้ และใช้ `const program = () => { ... }` ก็ได้ ห้าม import / export
 *
 *  vm.deploy({ programUuid, code, context, initInput })   user ส่งโค้ด → pending
 *  vm.init({ programUuid })                               ทีมงานอนุมัติ → รัน initialization ครั้งเดียว
 *  vm.reject({ programUuid })                             ทีมงานปฏิเสธ
 *  vm.call({ programUuid, functionName, input, context }) user เรียกฟังก์ชันที่ export
 *  vm.transfer({ from, to, amount })                      โอน native ระหว่าง address (ไม่เรียกโปรแกรม)
 *
 *  อัปเกรดโปรแกรม (เฉพาะโปรแกรมที่มี upgrader — ไม่มี = แก้ไม่ได้ตลอดไป):
 *    vm.deploy({ ..., upgrader })                            ตั้ง upgrader ตั้งแต่ deploy → เขียนเป็น metadata.upgrader ตอน init
 *    vm.setUpgrader({ programUuid, upgrader, context })      upgrader คนปัจจุบันโอนสิทธิ์ (null = สละสิทธิ์ → แก้ไม่ได้อีก)
 *    vm.upgrade({ programUuid, code, migrateInput, context }) upgrader ส่งโค้ดใหม่ → pending-upgrade:<id> รอรีวิว
 *    vm.initUpgrade({ programUuid }) / vm.rejectUpgrade(...) ทีมงานอนุมัติ / ปฏิเสธ (กติกาเดียวกับ init / reject)
 *       อนุมัติ → เปลี่ยน <id>:code, รัน migrate(params) ครั้งเดียว, metadata.version + 1, เก็บ <id>:codeversion:<n>
 *       upgradeDelayBlocks = N > 0 → โค้ดใหม่เริ่มใช้ตอนสร้าง block (ที่อนุมัติ + N) ดู Block.#activateUpgrades
 *  โคลนโปรแกรม (ในโปรแกรม): cloneProgram(template, initInput, { salt, value }) → address ใหม่ (แบบ CREATE2)
 *
 *  คืนค่า { status: "success", result, calls, loadValues, afterValues, writes }
 *      หรือ { status: "throw", error: { code, message }, calls }
 *  เมื่อ success → vm.commit(res.writes) บันทึกลง DB ผ่าน db.writeKeys (หรือบันทึกเอง)
 *  runProgram error → ผู้เรียก catch ได้ (การเขียนของปลายทางถูกย้อน) ถ้าไม่ catch → throw ต่อขึ้นไปจนทั้ง request ล้ม
 *  timeout / แก๊สหมด / หน่วยความจำเกิน / อ่าน DB ไม่สำเร็จ → ทั้ง request ล้มเสมอ (catch ไม่ได้)
 *
 *  sandbox: โค้ดของโปรแกรมรันใน QuickJS (WebAssembly) ไม่ใช่ใน process ของ server — ดู sandbox.js
 *    1 tx = 1 runtime (หน่วยความจำ memoryLimitBytes / stack maxStackBytes นับรวมทั้งสายการเรียก)
 *    1 โปรแกรม = 1 context (global แยกกัน) · ค่าข้ามเขตแดนเป็นสำเนาเสมอ โปรแกรมแตะ object ของ host ไม่ได้
 *    global ของโปรแกรม: built-in มาตรฐานของ JS + Date / Math ของ block · ไม่มี eval / new Function / process / require
 *
 *  เวลา: ทุก call ใน block เห็นเวลาเดียวกัน (แบบ block.timestamp ของ EVM)
 *    vm.createBlock({ timestamp })  /  vm.call(request, { timestamp })   ไม่ส่ง → Date.now() ครั้งเดียว
 *    ในโปรแกรม: params.block.timestamp, Date.now(), new Date() ได้ค่านี้ทั้งหมด
 *
 *  receipt สำหรับ explorer: vm.buildReceipt(request, result, { index, action }) / block.receipt({ number })
 *    แต่ละ tx มี hash ที่คำนวณจาก request ของ user เท่านั้น (รู้ได้ตั้งแต่ก่อนส่ง, tx ที่ล้มก็มี)
 *    เปลี่ยนไปใช้ keccak256 ได้ด้วย option hashFunction ตอนสร้าง VM
 *
 *  หลาย call แล้ว commit ทีเดียว
 *    const block = vm.createBlock()
 *    block.call({ ... })      // tx1
 *    block.call({ ... })      // tx2 เห็นผลของ tx1
 *    block.loadValues()       // storage key ที่ทั้ง block อ่าน (ค่าก่อน block)
 *    block.afterValues()      // storage key ที่ทั้ง block แตะ (ค่าหลัง block, changed)
 *    block.writes()           // writes รวมของทุก tx ที่ success
 *    block.commit()           // บันทึกทีเดียวผ่าน db.writeKeys
 *
 *  address ของโปรแกรม: ตั้งเองได้ หรือให้ VM คำนวณจาก keccak256(deployer + nonce) ด้วย deriveProgramAddress
 *  Math.random() ในโปรแกรมถูกแทนด้วยตัวสุ่มที่ผูกกับ tx (รันซ้ำได้ผลเดิม)
 *
 *  API ในโปรแกรม: readDB / writeDB / deleteDB / map / runProgram / transferNative / setMetadata / emit
 *                 keccak256 / ecrecover / ThisAddress / ThisBalance / BalanceOf / IsProgram / MetadataOf / BlockNumber
 *                 sha256 / ripemd160 / blake2b / modexp / BlockHash / ChainId / Coinbase / BlockGasLimit / GasPrice / BaseFee / GasLeft
 *                 keccak256Bytes / ecrecoverDigest / eip712Digest / eip712DomainSeparator (byte ดิบ + EIP-712 แบบ eth_signTypedData_v4)
 *                 CodeHashOf / CodeSizeOf · runProgram(..., { readonly: true }) = เรียกแบบอ่านอย่างเดียว (STATICCALL)
 *  ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น เช่น 10n (เก็บใน DB เป็น "123n" แปลงไปกลับให้อัตโนมัติ)
 *    ยอด native (ThisBalance / BalanceOf) / params.value / params.block.timestamp / BlockNumber() เป็น BigInt
 *    Date.now() / Math ยังคืน number → ห่อ BigInt() ก่อนเก็บหรือ return (ทศนิยมต้องปัดก่อน หรือส่งเป็น string)
 *
 *  key ใน DB: pending:<id> | <id>:code | <id>:context | <id>:this | <id>:storage:<a>:<b>...
 *    <id>:this          address ของโปรแกรมเอง (โปรแกรมอ่านได้ด้วย ThisAddress())
 *    <addr>:nonce       ลำดับ tx ของ wallet (กัน tx ซ้ำ) — เปิดด้วย requireNonce
 *    <addr>:native:received / :sended / :consumed   ยอดสะสม (เพิ่มได้อย่างเดียว)
 *       ยอดคงเหลือ = received - sended - consumed  (consumed = ค่าแก๊สที่จ่ายไป)
 *       ค่าแก๊สส่วนที่ "เผา" ถูกโอนไปที่ 0x000…000 ไม่ได้หายไปเฉย ๆ
 *    <addr>:metadata:<field>   ข้อมูลประกอบของ address (namespace, type, creator, ...)
 *    namespace:<name>          ชื่อ → address (ห้ามซ้ำทั้งระบบ)
 *    <addr>:txn:<nonce>:<txhash>  รายการ tx ของ address (สำหรับ explorer) — เปิดด้วย recordTransactions
 *    block:<number> | blockbody:<number> | blockhash:<hash> | latestblock | tx:<txhash> | sigtx:<digest>
 *    history:<dbKey>:<number>   ค่าก่อนเปลี่ยน (ย้อนดู state ณ block ใดก็ได้ด้วยการ seek ครั้งเดียว)
 *    blockundo:<number>         รายชื่อ key ของ state ที่ block นั้นแตะ (ดัชนีไม่มี history — ดู isIndexKey)
 *       blockbody = tx ดิบของทุกใบใน block (ใช้ replay สร้าง state ใหม่ได้ทั้งหมด)
 *                          ข้อมูล block และดัชนีค้น tx จาก hash — เปิดด้วย recordBlocks + ส่ง number ตอน createBlock
 *
 *  ค่าแก๊ส (เมื่อ chargeGas): call 100 + write 500 + read 100 + 1 ต่อ byte ที่อ่าน/เขียน
 *    + 1 ต่อ node ของโค้ดที่รันผ่าน (ฉีดตัวนับตอนคอมไพล์ ดู gasmeter.js) + builtin ต่อหน่วยข้อมูลที่คัดลอก / สร้าง
 *      (1 สมาชิก หรือ 32 ตัวอักษร / byte: เมธอดในตัว · spread · string ที่ต่อกัน · input / ผลของ runProgram — ดู sandbox.js)
 *    เพดานต่อ tx = maxTxGas ใช้แม้ไม่ได้หักค่าแก๊ส → ลูปไม่รู้จบจบด้วย OUT_OF_GAS
 *    ผู้จ่ายคือ sender ของ tx ชั้นนอกสุดเสมอ, หักจาก <sender>:nativebalance
 *    user ส่ง gasLimit มาเองได้ (เพดานสูงสุดคือยอด native ที่เหลือหลังหัก value)
 *    แก๊สไม่พอ → OUT_OF_GAS (โปรแกรม catch ไม่ได้), tx ที่ล้มก็ยังกิน nonce และค่าแก๊ส
 *    ค่าแก๊สแบบ EIP-1559 (ดู resolveFees / nextBaseFee):
 *      แต่ละ block มี baseFeePerGas (ใน header + hash) ปรับตามแก๊สที่ block ก่อนหน้าใช้เทียบกับ gasTarget (±12.5% ต่อ block, ไม่ต่ำกว่า minBaseFee)
 *      tx ส่ง maxFeePerGas + maxPriorityFeePerGas (หรือ gasPrice แบบเดิม = ทั้งสองค่า) → ราคาจริง = min(maxFee, baseFee + priority)
 *      ส่วน base fee (gas × baseFee) เผาทิ้ง burnPercent % (ค่าเริ่มต้น 100) ที่เหลือ + tip ทั้งหมด เข้าผู้ปิด block (feeRecipient)
 *
 *  แนบเงินไปกับ tx: vm.call({ ..., value: 20 })  → โอน native จาก sender ไปยังโปรแกรม
 *    deploy ก็แนบได้: เงินย้ายไปที่โปรแกรมตั้งแต่ deploy, initialization เห็นที่ params.value, reject คืนเงิน
 *    ในโปรแกรม: params.value และแนบต่อได้ด้วย runProgram(target, fn, input, { value: 20 })
 *
 *  address (wallet / program): programUuid, sender, origin → ตัวพิมพ์เล็กเสมอ
 *    string รูปแบบ 0x… hex ใน input และใน key ของ storage → ตัวพิมพ์เล็ก (string อื่นไม่เปลี่ยน)
 */

// ============================================================================
//  ค่าที่ปรับบ่อย
// ============================================================================

export const DEFAULT_OPTIONS = {
  timeoutMs: 1000,     // เวลารวมต่อ 1 request (รวมโปรแกรมที่เรียกต่อกัน)
  maxCallDepth: 8,     // runProgram ซ้อนได้กี่ชั้น
  requireNonce: false, // บังคับให้ทุก tx ของ user ส่ง nonce มาด้วย
  chargeGas: false,    // หักค่าแก๊สจาก <sender>:nativebalance
  burnPercent: 100,    // ส่วนของ base fee ที่เผาทิ้ง (%) ที่เหลือเข้ากระเป๋า feeRecipient · tip (priority fee) เข้า feeRecipient เสมอ
  minBaseFee: null,              // base fee ต่ำสุด (และของ block แรก) — null = gas.price
  gasTarget: null,               // แก๊สเป้าหมายต่อ block (EIP-1559) — null = maxBlockGas / 2 · ไม่มีทั้งคู่ = base fee คงที่ที่ minBaseFee
  baseFeeChangeDenominator: 8,   // base fee เปลี่ยนได้ไม่เกิน 1/8 (12.5%) ต่อ block
  feeRecipient: null,  // ผู้ปิด block (ตั้งต่อ block ได้ที่ createBlock)
  chainId: 1,          // กัน tx ของระบบหนึ่งถูกนำไปใช้ซ้ำในอีกระบบ
  recordTransactions: false, // เขียน <address>:txn:<nonce>:<txhash> ลงไปกับ writes ของ tx ด้วย
  recordBlocks: false,       // เขียน block:<number> / blockhash:<hash> / latestblock / tx:<hash>
  deriveProgramAddress: false, // คำนวณ address ของโปรแกรมจาก keccak256(deployer + nonce) เสมอ
  forceOriginFromSender: true, // tx ของ user: origin = sender เสมอ (กันการปลอม origin)
  maxTransactions: null,          // จำนวน tx สูงสุดต่อ block (null = ไม่จำกัด)
  maxTransactionsPerSender: null, // จำนวน tx สูงสุดต่อ address ใน 1 block
  maxBlockGas: null,              // แก๊สรวมสูงสุดต่อ block
  maxTxGas: 10_000_000,           // แก๊สสูงสุดต่อ tx / query (ลูปไม่รู้จบหยุดที่นี่ด้วย OUT_OF_GAS แม้ไม่ได้หักค่าแก๊ส)
  admins: null,                   // address ที่เรียก init / reject ได้ (null = ใครก็ได้)
  maxCodeSize: 64 * 1024,         // ขนาดโค้ดสูงสุดต่อโปรแกรม
  maxKeySize: 1000,               // ความยาวสูงสุดของ key storage (เหลือที่ให้ history: ซ้อนทับ)
  autoReview: false,              // true = ตรวจโค้ดด้วยบัญชีขาวตอน deploy (แทนการรีวิวด้วยคน)
  maxValueSize: 64 * 1024,        // ขนาดสูงสุดของค่าที่เขียน / return / emit ต่อรายการ
  recordHistory: false,           // เก็บ history:<key>:<block> + blockundo:<block> (ต้องเปิดถ้าจะย้อนดู / กู้ระบบ)
  upgradeDelayBlocks: 0,          // timelock ของการอัปเกรด: 0 = ใช้โค้ดใหม่ทันทีที่อนุมัติ, N = ใช้ตอน block (ที่อนุมัติ + N)
  memoryLimitBytes: SANDBOX_DEFAULTS.memoryLimitBytes, // หน่วยความจำของ sandbox ต่อ tx (รวมทุกโปรแกรมในสายการเรียก) เกิน → OUT_OF_MEMORY
  maxStackBytes: SANDBOX_DEFAULTS.maxStackBytes,       // stack ของ sandbox ต่อ tx (เรียกฟังก์ชันซ้อนลึกเกิน → RangeError ที่ catch ได้)
  wallClock: false,               // ใส่ performance.now() (เวลาจริง) ให้โปรแกรม — ใช้ในเทสต์เท่านั้น ผลไม่แน่นอนข้ามเครื่อง
  producer: null,                 // ผู้ผลิต block ของ node นี้ { address, sign(blockHash) → ลายเซ็น } · null = block ไม่มีผู้ผลิต (แบบเดิม)
  replayTimeoutMs: 60_000,        // เวลาต่อ tx ตอน replay / rebuild / sync — ผู้ผลิตกรอง TIMEOUT ไปแล้ว จึงให้แก๊สหยุดก่อน (เครื่องช้ากว่าไม่ได้ผลต่าง)
  forks: {},                      // ตาราง fork { ชื่อ: block ที่เริ่มใช้ } (genesis.json "forks") · ดู FORKS
  forkRules: {},                  // กติกาของ fork เพิ่มจาก FORKS (ใช้ในเทสต์)
  historyKeep: null,              // pruning: เก็บ history แค่ N block ล่าสุด (ย้อนดู state / replay ได้แค่ช่วงนั้น) · null = เก็บทั้งหมด (archive)
};

/** ความยาวของเลข block ใน key (เติมศูนย์ให้เรียงตามตัวอักษรได้ตรงกับเรียงตามตัวเลข) */
export const BLOCK_NUMBER_WIDTH = 12;

/** address ของโปรแกรม = 20 byte ท้ายของ hash (ไม่มี private key จึงเซ็น tx ในนามโปรแกรมไม่ได้) */
export const addressFromHash = (hash) => `0x${hash.slice(-40)}`;

/** hash เริ่มต้น: keccak256 แบบเดียวกับ EVM (เปลี่ยนได้ด้วย option hashFunction) */
const hexToBytesStrict = (hex) => hexToBytes(String(hex).replace(/^0x/, ""));
/** precompile hash ที่โปรแกรมเรียกได้ (ชื่อ = ชื่อ API = ชื่อในตารางแก๊ส) */
const DIGESTS = { sha256, ripemd160, blake2b };
/** จำนวน bit ของ BigInt ที่ไม่ติดลบ (0n → 0) */
const bitLength = (value) => {
  if (value === 0n) return 0;
  const hex = value.toString(16);
  return (hex.length - 1) * 4 + Number.parseInt(hex[0], 16).toString(2).length;
};

/** ตารางค่าแก๊ส */
export const DEFAULT_GAS = {
  call: 100,   // ต่อการเรียกโปรแกรม 1 ครั้ง (รวมชั้นนอกสุด)
  read: 100,   // ต่อ readDB 1 ครั้ง
  write: 500,  // ต่อ writeDB / deleteDB 1 ครั้ง
  stateKey: 1000, // ต่อ key ของ state ที่ tx เขียน / ลบ ครั้งแรก (ค่าอัปเดต Merkle trie + history ตอนปิด block · เขียน key เดิมซ้ำใน tx เดียวกันไม่คิดซ้ำ)
  byte: 1,     // ต่อ byte ของข้อมูลที่อ่าน / เขียน
  event: 200,  // ต่อ event 1 รายการ (บวกค่า byte ของข้อมูลใน event)
  hash: 100,   // ต่อการเรียก keccak256 (บวกค่า byte ของข้อมูล)
  recover: 3000, // ต่อการเรียก ecrecover (คำนวณหนัก)
  sha256: 100,    // ต่อการเรียก sha256 (บวกค่า byte ของข้อมูล)
  ripemd160: 300, // ต่อการเรียก ripemd160 (บวกค่า byte ของข้อมูล — ช้ากว่า sha256 ราว 3 เท่า)
  blake2b: 100,   // ต่อการเรียก blake2b (บวกค่า byte ของข้อมูล)
  modexp: 200,    // ต่อการเรียก modexp ขั้นต่ำ บวก ⌊word² × bit ของ exponent / 3⌋ (word = 8 byte ของตัวที่ยาวสุดใน base / mod แบบ EIP-2565)
  env: 10,        // ต่อการเรียก ChainId / Coinbase / BlockGasLimit / GasPrice / BaseFee / GasLeft
  topic: 375,     // ต่อ field ที่ emit แบบ indexed (เขียนดัชนีถาวร 1 key ต่อ field — แบบ LOG topic ของ EVM)
  code: 10,    // ต่อ byte ของโค้ดตอน deploy (กินพื้นที่ DB ถาวร)
  node: 1,     // ต่อ node ของ AST ที่โปรแกรมรันผ่าน (ตัวนับที่ฉีดตอนคอมไพล์ ดู gasmeter.js)
  builtin: 1,  // ต่อหน่วยข้อมูลที่ถูกคัดลอก / สร้าง: 1 สมาชิก (array / property / Set / Map / argument) หรือ 32 ตัวอักษร / byte (ปัดขึ้น)
               //   เมธอดในตัว (join, split, slice, JSON.stringify …) · spread [...a] f(...a) { ...o } · a + b ที่ได้ string · template
               //   ArrayBuffer / typed array / RegExp ตามขนาด · input / ผลของ runProgram (ดู sandbox.js "แก๊สตามขนาดข้อมูล")
  price: 1,    // native ต่อ 1 gas
};

/**
 * fork: เปลี่ยนกติกาของเชนตั้งแต่ block ที่กำหนด (แบบ hard fork ของ Ethereum) โดยไม่ต้องล้างเชน
 *   ตาราง (ว่าจะเปิดที่ block ไหน) อยู่ใน genesis.json `"forks": { "<ชื่อ>": <block> }` — ไม่อยู่ใน genesis hash จึงเพิ่มทีหลังได้
 *   กติกาของแต่ละ fork อยู่ในโค้ดตรงนี้ · node ที่โค้ดไม่รู้จักชื่อใน genesis = ไม่ยอมเริ่ม (ต้องอัปเดตโปรแกรมก่อน)
 *   block ก่อนเลขที่กำหนดใช้กติกาเดิม → replay / sync / rebuild block เก่าได้ผลเดิมทุกไบต์
 *   node ที่ตั้งตารางต่างกัน = hash ของ block ไม่ตรงตั้งแต่ block นั้น (sync หยุด) · ทุกเครื่องต้องอัปเดตก่อนถึง block
 *
 *   ชื่อ → { description, gas?: { ชื่อค่าแก๊ส: ค่าใหม่ } }
 *     gas: แทนค่าใน DEFAULT_GAS ตั้งแต่ block นั้น (ยกเว้น price — ราคาขั้นต่ำอยู่ใน genesis.config.minBaseFee)
 *     กติกาแบบอื่น (field ใหม่ใน header, คำสั่งใหม่) → เช็ค vm.forkActive("<ชื่อ>", blockNumber) ในจุดที่เปลี่ยน
 */
export const FORKS = {};

export const ERROR_CODE = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  TIMEOUT: "TIMEOUT",
  OUT_OF_GAS: "OUT_OF_GAS",
  OUT_OF_MEMORY: "OUT_OF_MEMORY",
  PROGRAM_ERROR: "PROGRAM_ERROR",
  INTERNAL: "INTERNAL",
};

const { INVALID_REQUEST, NOT_FOUND, FORBIDDEN, LIMIT_EXCEEDED, TIMEOUT, OUT_OF_GAS, OUT_OF_MEMORY, PROGRAM_ERROR, INTERNAL } = ERROR_CODE;

/** error ทั้งหมด: code + message (message เป็นฟังก์ชันได้) */
export const ERRORS = {
  invalidProgramUuid: [INVALID_REQUEST, "programUuid ต้องเป็น string ที่ไม่ว่างและไม่มี ':'"],
  invalidContext: [INVALID_REQUEST, "context ต้องมี sender และ origin"],
  valueTooLarge: [INVALID_REQUEST, (max, size) => `ค่าใหญ่เกินกำหนด (${size} > ${max} ไบต์)`],
  reviewFailed: [INVALID_REQUEST, (detail) => `โค้ดไม่ผ่านการตรวจอัตโนมัติ:\n${detail}`],
  keyTooLong: [INVALID_REQUEST, (max, size) => `key ของ storage ยาวเกินกำหนด (${size} > ${max} ไบต์)`],
  codeTooLong: [INVALID_REQUEST, (max, size) => `โค้ดยาวเกินกำหนด (${size} > ${max} ไบต์)`],
  invalidCode: [INVALID_REQUEST, "code ต้องเป็น string"],
  invalidKey: [INVALID_REQUEST, "key ต้องเป็น string หรือ map(...)"],
  invalidKeyPart: [INVALID_REQUEST, "แต่ละส่วนของ key ต้องเป็น string ที่ไม่ว่าง จำนวนเต็ม หรือ BigInt"],
  notJson: [INVALID_REQUEST, (label) => `${label} ต้องเป็นข้อมูล JSON`],
  programWrapperMissing: [INVALID_REQUEST, "โปรแกรมต้องอยู่ในรูป 'function program() { ... }' ทั้งไฟล์"],
  importNotAllowed: [INVALID_REQUEST, "โปรแกรมใช้ import / export ไม่ได้ (ต้องอยู่ใน scope เดียวทั้งหมด)"],
  exportMissing: [INVALID_REQUEST, (name) => `export '${name}' แต่ไม่มีฟังก์ชันนี้ในระดับบนสุด`],
  exportInit: [INVALID_REQUEST, (name) => `ห้าม export '${name}'`],
  syntaxError: [INVALID_REQUEST, (detail) => `syntax error: ${detail}`],
  programUuidUsed: [INVALID_REQUEST, (id) => `programUuid '${id}' ถูกใช้แล้ว`],
  writeUndefined: [INVALID_REQUEST, "writeDB ห้ามใช้ undefined (ใช้ deleteDB)"],
  programNotFound: [NOT_FOUND, (id) => `ไม่พบโปรแกรม '${id}'`],
  pendingNotFound: [NOT_FOUND, "ไม่พบโปรแกรมที่รอรีวิว"],
  notCallable: [FORBIDDEN, (name) => `เรียก '${name}' ไม่ได้ (ไม่มีหรือไม่ได้ export)`],
  callDepthExceeded: [LIMIT_EXCEEDED, (max) => `เรียกโปรแกรมซ้อนได้ไม่เกิน ${max} ชั้น`],
  asyncNotSupported: [PROGRAM_ERROR, "ไม่รองรับ async"],
  timeout: [TIMEOUT, "โปรแกรมทำงานเกินเวลาที่กำหนด"],
  dbReadFailed: [INTERNAL, (detail) => `อ่านข้อมูลจาก DB ไม่สำเร็จ: ${detail}`],
  invalidTimestamp: [INVALID_REQUEST, "timestamp ต้องเป็นจำนวนเต็มมิลลิวินาทีที่ไม่ติดลบ"],
  invalidNonce: [INVALID_REQUEST, (expected, got) => `nonce ไม่ถูกต้อง: ต้องเป็น ${expected} แต่ได้ ${got}`],
  invalidAmount: [INVALID_REQUEST, "amount ต้องเป็นจำนวนเต็มบวก"],
  invalidTransferAmount: [INVALID_REQUEST, "amount ต้องเป็นจำนวนเต็มไม่ติดลบ"],   // โอน native (tx) โอน 0 ได้แบบ EVM
  invalidRejected: [INVALID_REQUEST, (field) => `tx ที่ถูกปฏิเสธ: ${field} ไม่ถูกต้อง`],
  invalidAddress: [INVALID_REQUEST, "address ต้องเป็น string ที่ไม่ว่าง"],
  invalidValue: [INVALID_REQUEST, "value ต้องเป็นจำนวนเต็มที่ไม่ติดลบ"],
  invalidGasLimit: [INVALID_REQUEST, "gasLimit ต้องเป็นจำนวนเต็มบวก"],
  invalidGasPrice: [INVALID_REQUEST, (min) => `gasPrice ต้องเป็นจำนวนเต็มและไม่ต่ำกว่า ${min}`],
  invalidBurnPercent: [INVALID_REQUEST, "burnPercent ต้องเป็นจำนวนเต็ม 0-100"],
  invalidFeeFields: [INVALID_REQUEST, "ใช้ gasPrice คู่กับ maxFeePerGas / maxPriorityFeePerGas ไม่ได้ (เลือกแบบเดียว)"],
  invalidFeeValue: [INVALID_REQUEST, (field) => `${field} ต้องเป็นจำนวนเต็มไม่ติดลบ`],
  priorityAboveMax: [INVALID_REQUEST, "maxPriorityFeePerGas ต้องไม่มากกว่า maxFeePerGas"],
  feeBelowBaseFee: [INVALID_REQUEST, (maxFee, baseFee) => `maxFeePerGas (${maxFee}) ต่ำกว่า base fee ของ block (${baseFee})`],
  invalidBaseFeeOption: [INVALID_REQUEST, (name) => `${name} ไม่ถูกต้อง`],
  invalidIndexed: [INVALID_REQUEST, (detail) => `emit: indexed ไม่ถูกต้อง — ${detail}`],
  invalidAbi: [INVALID_REQUEST, (detail) => `metadata.abi ไม่ถูกต้อง: ${detail}`],
  invalidDb: [INTERNAL, "db ต้องมี readKeys(keys) และ writeKeys(writes)"],
  numberNotAllowed: [INVALID_REQUEST, (label) => `${label}: ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เช่น 10n)`],
  invalidSignature: [INVALID_REQUEST, "signature ต้องเป็น hex 65 byte (r + s + v)"],
  invalidDigest: [INVALID_REQUEST, "digest ต้องเป็น hex 32 byte (\"0x\" + 64 ตัว)"],
  invalidBytes: [INVALID_REQUEST, (label) => `${label}: ต้องเป็น hex string "0x…" จำนวนไบต์เต็ม`],
  invalidTypedData: [INVALID_REQUEST, (detail) => `EIP-712: ${detail}`],
  invalidEventName: [INVALID_REQUEST, "ชื่อ event ต้องเป็นตัวอักษรภาษาอังกฤษขึ้นต้น ยาวไม่เกิน 32"],
  invalidMetadata: [INVALID_REQUEST, "metadata ต้องเป็น object ของ field → ค่า"],
  invalidMetadataField: [INVALID_REQUEST, (field) => `ชื่อ field ไม่ถูกต้อง: '${field}'`],
  reservedMetadata: [FORBIDDEN, (field) => `'${field}' เป็นฟิลด์ของระบบ แก้ไม่ได้`],
  invalidNamespace: [INVALID_REQUEST, "namespace ต้องเป็น string ที่ไม่ว่าง ไม่มี ':' และยาวไม่เกิน 64"],
  namespaceTaken: [FORBIDDEN, (name, owner) => `namespace '${name}' ถูกใช้โดย ${owner} แล้ว`],
  listNotSupported: [INTERNAL, "DB ตัวนี้ไม่มี listKeys(prefix) จึงไล่ดูข้อมูลไม่ได้"],
  nativeInsufficient: [PROGRAM_ERROR, (address) => `ยอด native ของ '${address}' ไม่พอ`],
  outOfGas: [OUT_OF_GAS, (used, limit) => `แก๊สไม่พอ: ใช้ ${used} แต่จ่ายได้ ${limit}`],
  outOfMemory: [OUT_OF_MEMORY, (limit) => `โปรแกรมใช้หน่วยความจำเกินกำหนด (${limit} ไบต์ต่อ tx)`],
  blockCommitted: [INVALID_REQUEST, "block นี้ commit ไปแล้ว"],
  blockExists: [INVALID_REQUEST, (number) => `block ${number} ถูกบันทึกไปแล้ว`],
  blockFull: [LIMIT_EXCEEDED, (max) => `block เต็มแล้ว (สูงสุด ${max} tx)`],
  senderLimit: [LIMIT_EXCEEDED, (max) => `address นี้ส่งครบโควตาของ block แล้ว (สูงสุด ${max} tx)`],
  blockGasFull: [LIMIT_EXCEEDED, (max) => `แก๊สของ block เต็มแล้ว (สูงสุด ${max})`],
  notAdmin: [FORBIDDEN, (address) => `'${address}' ไม่มีสิทธิ์ init / reject`],
  historyMissing: [NOT_FOUND, (number) => `ไม่มีข้อมูลย้อนหลังของ block ${number} (ต้องเปิด recordHistory ตั้งแต่ตอนสร้าง block นั้น)`],
  genesisMismatch: [INTERNAL, (current, given) => `genesis ไม่ตรงกัน (ของ node นี้ ${current} / ที่ส่งมา ${given})`],
  blockMissing: [NOT_FOUND, (number) => `ไม่พบ block ${number}`],
  replayMismatch: [INTERNAL, (number) => `รัน block ${number} ใหม่แล้วได้ hash ไม่ตรงกับที่บันทึกไว้`],
  trieStale: [INTERNAL, "trie ของ state เปลี่ยนระหว่างปิด block (มีการ commit อื่นแทรก) — สร้าง block ใหม่"],
  invalidHistoryKeep: [INVALID_REQUEST, "historyKeep ต้องเป็นจำนวนเต็ม ≥ 1 หรือ null"],
  unknownFork: [INVALID_REQUEST, (name) => `ไม่รู้จัก fork '${name}' — โปรแกรมของ node นี้เก่ากว่า genesis (อัปเดตโปรแกรมก่อนเริ่ม)`],
  invalidFork: [INVALID_REQUEST, (name, detail) => `fork '${name}': ${detail}`],
  blockTimestampOrder: [INVALID_REQUEST, (timestamp, previous) => `timestamp ของ block ต้องมากกว่า block ก่อนหน้า (${timestamp} <= ${previous})`],
  immutableProgram: [FORBIDDEN, (id) => `โปรแกรม '${id}' อัปเกรดไม่ได้ (ไม่มี upgrader)`],
  notUpgrader: [FORBIDDEN, (address) => `'${address}' ไม่ใช่ upgrader ของโปรแกรมนี้`],
  invalidUpgrader: [INVALID_REQUEST, "upgrader ต้องเป็น address (string ที่ไม่ว่าง) หรือ null"],
  upgradePending: [INVALID_REQUEST, (id) => `โปรแกรม '${id}' มีการอัปเกรดที่รออยู่แล้ว`],
  upgradeNotFound: [NOT_FOUND, "ไม่พบการอัปเกรดที่รอรีวิว"],
  upgradeNeedsBlock: [INVALID_REQUEST, "upgradeDelayBlocks > 0: ต้องอนุมัติการอัปเกรดใน block ที่มีเลข block"],
  invalidUpgradeDelay: [INVALID_REQUEST, "upgradeDelayBlocks ต้องเป็นจำนวนเต็มที่ไม่ติดลบ"],
  invalidSandboxLimit: [INVALID_REQUEST, (name, [min, max]) => `${name} ต้องเป็นจำนวนเต็มระหว่าง ${min} ถึง ${max}`],
  templateNotActive: [NOT_FOUND, (id) => `โปรแกรมต้นแบบ '${id}' ไม่มีอยู่หรือยังไม่ได้รับอนุมัติ`],
  invalidSalt: [INVALID_REQUEST, "salt ต้องเป็น string ที่ไม่ว่าง หรือ BigInt"],
  invalidReadonly: [INVALID_REQUEST, "readonly ต้องเป็น true / false"],
  readonlyCall: [FORBIDDEN, (name) => `${name}() ใช้ไม่ได้ในการเรียกแบบอ่านอย่างเดียว (runProgram แบบ { readonly: true } ห้ามแก้ state ทุกชั้น)`],
  readonlyValue: [INVALID_REQUEST, "การเรียกแบบอ่านอย่างเดียว (readonly) แนบ value ไม่ได้"],
  invalidBlockNumber: [INVALID_REQUEST, "เลข block ต้องเป็น BigInt ที่ไม่ติดลบ"],
  invalidModexp: [INVALID_REQUEST, (max) => `modexp: base / exponent / modulus ต้องเป็น BigInt ที่ไม่ติดลบ และยาวไม่เกิน ${max} ไบต์`],
};

// ============================================================================
//  ค่าคงที่
// ============================================================================

const INIT_FUNCTION = "initialization";
const MIGRATE_FUNCTION = "migrate";   // รันครั้งเดียวตอนอัปเกรด — เหมือน initialization คือเรียกจากภายนอกไม่ได้
const KEY = { SEPARATOR: ":", PENDING: "pending", CODE: "code", CONTEXT: "context", STORAGE: "storage", THIS: "this", NONCE: "nonce", NATIVE: "native", TXN: "txn",
  METADATA: "metadata", NAMESPACE: "namespace", EVENT: "event", EVENT_INDEX: "eventidx", EVENT_SIG: "eventsig", TX_TO: "txto",
  BLOCK: "block", BLOCK_BODY: "blockbody", BLOCK_HASH: "blockhash", LATEST_BLOCK: "latestblock", TX: "tx", GENESIS: "genesis",
  HISTORY: "history", HISTORY_FROM: "historyfrom", BLOCK_UNDO: "blockundo", SIG_TX: "sigtx", HOLDING: "holding",
  PENDING_UPGRADE: "pending-upgrade", SCHEDULED_UPGRADE: "scheduled-upgrade", UPGRADE_AT: "upgradeat", CODE_VERSION: "codeversion" };
const PROGRAM_API_NAMES = [
  "readDB", "writeDB", "deleteDB", "map", "runProgram", "transferNative", "setMetadata", "emit",
  "keccak256", "ecrecover", "cloneProgram",
  "ThisAddress", "ThisBalance", "BalanceOf", "IsProgram", "MetadataOf", "BlockNumber", "Date", "Math",
  "sha256", "ripemd160", "blake2b", "modexp",
  "BlockHash", "ChainId", "Coinbase", "BlockGasLimit", "GasPrice", "BaseFee", "GasLeft", "CodeHashOf", "CodeSizeOf",
  "keccak256Bytes", "ecrecoverDigest", "eip712Digest", "eip712DomainSeparator",
];

/** BlockHash ย้อนได้กี่ block (เหมือน BLOCKHASH ของ EVM) */
export const BLOCK_HASH_WINDOW = 256;
/** ขนาดสูงสุดของแต่ละค่าใน modexp (เหมือน EIP-7823) */
export const MODEXP_MAX_BYTES = 1024;

/**
 * โปรแกรมอยู่ใน scope เดียวทั้งไฟล์ และเป็น JavaScript ที่ถูกต้อง (editor / prettier ใช้ได้)
 *   function program() {
 *     function initialization(params) {}
 *     function transfer(params) {}
 *     return { transfer }        ← รายชื่อฟังก์ชันที่ให้เรียกจากภายนอก (บรรทัดสุดท้าย)
 *   }
 * เขียนเป็น string ส่งผ่าน API ได้ตรง ๆ หรือใช้ String(program) จากไฟล์จริงก็ได้
 */
const PROGRAM_WRAPPER_PATTERN = /^\s*(?:const|let|var)?\s*(?:program\s*=\s*)?(?:async\s+)?(?:function\s*[A-Za-z_$][\w$]*?\s*\(\s*\)|\(\s*\)\s*=>)\s*\{([\s\S]*)\}\s*;?\s*$/;
const RETURN_EXPORT_PATTERN = /return\s*\{([^}]*)\}\s*;?\s*$/;
const MODULE_KEYWORD_PATTERN = /^[ \t]*(import|export)\b/m;
const FUNCTION_PATTERN = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
// รองรับ modifier: const ชื่อ = onlyOwner(function () {...})  — ค่าต้องเป็นฟังก์ชันตอนรัน
const BINDING_PATTERN = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm;

const STATUS = { SUCCESS: "success", THROW: "throw", RUNNING: "running" };
const STATE = { PENDING: "pending_review", ACTIVE: "active", REJECTED: "rejected", SCHEDULED: "scheduled" };
const WRITE = { PUT: "put", DEL: "del" };

const METADATA_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const NODE_VM_TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";   // โปรแกรม throw { code: ค่านี้ } = TIMEOUT (แบบเดิมของ node:vm)
const MAP_PARTS = Symbol("map parts");

// ============================================================================
//  Error
// ============================================================================

export class VMError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }

  /** VMError.from(ERRORS.notCallable, name) */
  static from([code, message], ...args) {
    return new VMError(code, typeof message === "function" ? message(...args) : message);
  }

  /** แปลง error ใด ๆ ที่เกิดระหว่างรันโปรแกรม */
  static fromProgram(err) {
    if (err instanceof VMError) return err;
    if (err?.code === NODE_VM_TIMEOUT_CODE) return VMError.from(ERRORS.timeout);
    // ข้อความจาก V8 (TypeError ฯลฯ) ต่างกันได้ตามเวอร์ชัน Node → แทนด้วยข้อความคงที่
    if (err instanceof Error) {
      const name = err.constructor?.name ?? "Error";
      const error = new VMError(PROGRAM_ERROR, name === "Error" ? err.message : `โปรแกรมทำงานผิดพลาด (${name})`);
      // รายละเอียดจริงไว้ดีบักเท่านั้น — ไม่ถูกบันทึกลง DB และไม่เข้า hash
      error.detail = { name, message: err.message, at: locateInProgram(err) };
      return error;
    }
    return new VMError(PROGRAM_ERROR, String(err));
  }

  /** error ที่โปรแกรม throw ใน sandbox (ได้มาเป็นชื่อ + ข้อความ) — กติกาเดียวกับ fromProgram */
  static fromGuest({ name, message, stack }) {
    const error = new VMError(PROGRAM_ERROR, name === "Error" ? message : `โปรแกรมทำงานผิดพลาด (${name})`);
    error.detail = { name, message, at: locateInGuest(stack) };
    return error;
  }
}

/** ตำแหน่งจาก stack ของ QuickJS: "at f (program:12:5)" */
function locateInGuest(stack) {
  const match = /\(program:(\d+):(\d+)\)/.exec(stack ?? "");
  return match ? `line ${match[1]}, col ${match[2]}` : null;
}

/** ตำแหน่งคร่าว ๆ ในโค้ดที่คอมไพล์แล้ว (โค้ดถูกเก็บเป็นบรรทัดเดียว ตัวเลขจึงเป็นแค่ตัวช่วย) */
function locateInProgram(err) {
  const match = /<anonymous>:(\d+):(\d+)/.exec(err.stack ?? "");
  return match ? `line ${match[1]}, col ${match[2]}` : null;
}

export function fail(definition, ...args) {
  throw VMError.from(definition, ...args);
}

// ============================================================================
//  ฟังก์ชันช่วย (ไม่มีสถานะ)
// ============================================================================

export const copyValue = (value) => (value === undefined ? undefined : structuredClone(value));
export const isSameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const isNonEmptyString = (value) => typeof value === "string" && value !== "";
export const pickContext = ({ sender, origin }) => ({ sender, origin });

// ---------- address ----------

/** address ของ wallet / program เป็นตัวพิมพ์เล็กเสมอ */
const isWalletAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);

export const normalizeContext = ({ sender, origin }) => ({ sender: normalizeAddress(sender), origin: normalizeAddress(origin) });

/** input ของโปรแกรม: copy แบบ JSON แล้ว normalize address */
export const toInputValue = (value, label) => normalizeHexDeep(toJsonValue(value, label));

/** ขนาดข้อมูลเป็น byte สำหรับคิดค่าแก๊ส (แก๊สตามขนาดข้อมูลภายในโปรแกรมคิดใน sandbox ดู sandbox.js) */
export const valueSize = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(encodeBigints(value)) ?? "", "utf8"));

/** หน่วยข้อมูลของค่าที่คัดลอกข้ามเขตแดนระหว่างโปรแกรม: 1 หน่วยต่อ 32 byte ของ JSON (ปัดขึ้น) — หน่วยเดียวกับ sandbox */
export const copyUnits = (value) => Math.ceil(valueSize(value) / 32);

/** ตัวเลขถูกเก็บเป็น string ลงท้ายด้วย n เช่น "1000n" เพราะ JSON ไม่มี BigInt */
const BIGINT_TEXT = /^-?\d+n$/;

/** BigInt → "123n" (ทั้ง object) สำหรับเก็บลง DB หรือส่งออกเป็น JSON */
export function encodeBigints(value) {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(encodeBigints);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeBigints(item)]));
  }
  return value;
}

/** "123n" → BigInt และตัวเลขจำนวนเต็มจาก JSON → BigInt (ใช้ตอนส่งค่าเข้าโปรแกรม) */
export function decodeBigints(value, label = "ค่า") {
  if (typeof value === "string") return BIGINT_TEXT.test(value) ? BigInt(value.slice(0, -1)) : value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) fail(ERRORS.numberNotAllowed, label);
    return BigInt(value);
  }
  if (Array.isArray(value)) return value.map((item) => decodeBigints(item, label));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeBigints(item, label)]));
  }
  return value;
}

/** จำนวนเงินที่โปรแกรมส่งมาต้องเป็น BigInt (number → numberNotAllowed) */
export function fromProgramAmount(amount, label = "amount") {
  if (typeof amount === "number") fail(ERRORS.numberNotAllowed, label);
  if (typeof amount !== "bigint") fail(ERRORS.invalidAmount);
  return amount;
}

/** options ของ runProgram: { value } เป็น BigInt · { readonly: true } = เรียกแบบอ่านอย่างเดียว (STATICCALL) */
export function fromProgramOptions(options) {
  if (options === undefined || options === null) return undefined;
  const { value, readonly } = options;
  if (readonly !== undefined && readonly !== null && typeof readonly !== "boolean") fail(ERRORS.invalidReadonly);
  return {
    ...(value === undefined ? {} : { value: fromProgramAmount(value, "value") }),
    ...(readonly ? { readonly: true } : {}),
  };
}

/** ค่าเข้า / ออกจากโปรแกรม: "123n" ↔ BigInt แปลงไปกลับให้อัตโนมัติ */
export const toProgram = (value, label) => decodeBigints(value, label);
export const fromProgram = (value, label) => encodeBigints(toProgramValue(value, label));

export function toProgramValue(value, label) {
  if (value === undefined) return undefined;
  if (typeof value === "number") fail(ERRORS.numberNotAllowed, label);
  if (typeof value === "bigint") return value;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => toProgramValue(item, label));
  if (typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, toProgramValue(item, label)]));
  }
  fail(ERRORS.notJson, label);
}

export function toJsonValue(value, label) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    fail(ERRORS.notJson, label);
  }
}

/** แปลงโค้ดเป็นบรรทัดเดียว: ขึ้นบรรทัดใหม่ถูกเก็บเป็น "\n" แบบ escape จึงแปลงกลับได้ครบ */
export function toOneLine(code) {
  const normalized = code.replace(/\r\n?/g, "\n").trim();
  return JSON.stringify(normalized).slice(1, -1).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export const fromOneLine = (line) => JSON.parse(`"${line}"`);

// ---------- key ----------

export const joinKey = (...parts) => parts.join(KEY.SEPARATOR);
export const pendingKey = (programUuid) => joinKey(KEY.PENDING, programUuid);
export const codeKey = (programUuid) => joinKey(programUuid, KEY.CODE);
export const contextKey = (programUuid) => joinKey(programUuid, KEY.CONTEXT);
export const thisKey = (programUuid) => joinKey(programUuid, KEY.THIS);
export const nonceKey = (address) => joinKey(address, KEY.NONCE);
/** ยอดสะสมของ address (เพิ่มได้อย่างเดียว) */
export const NATIVE_FIELD = { RECEIVED: "received", SENDED: "sended", CONSUMED: "consumed" };
export const nativeKey = (address, field) => joinKey(address, KEY.NATIVE, field);
export const metadataKey = (address, field) => joinKey(address, KEY.METADATA, field);
export const namespaceKey = (name) => joinKey(KEY.NAMESPACE, name);
/** การอัปเกรดที่รอรีวิว / อนุมัติแล้วแต่รอ timelock / ดัชนี "block ไหนต้องเปิดใช้โค้ดของใคร" / โค้ดทุกเวอร์ชัน */
export const pendingUpgradeKey = (programUuid) => joinKey(KEY.PENDING_UPGRADE, programUuid);
export const scheduledUpgradeKey = (programUuid) => joinKey(KEY.SCHEDULED_UPGRADE, programUuid);
export const upgradeAtKey = (number) => joinKey(KEY.UPGRADE_AT, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const codeVersionKey = (programUuid, version) => joinKey(programUuid, KEY.CODE_VERSION, String(version));

/** address ปลายทางของเงินที่ถูกเผา (ตรวจยอดที่เผาไปทั้งหมดได้) */
export const BURN_ADDRESS = `0x${"0".repeat(40)}`;

/** ฟิลด์ metadata ที่ระบบใช้เอง ผู้ใช้เขียนทับไม่ได้ */
export const METADATA_FIELD = {
  NAMESPACE: "namespace",   // ชื่อที่อ่านง่าย (ห้ามซ้ำทั้งระบบ)
  TYPE: "type",             // "program" — VM ใส่ให้ตอน init
  CREATOR: "creator",       // ผู้ deploy
  CREATED_AT: "createdAt",  // timestamp ของ block ที่ init
  DESCRIPTION: "description",
  URL: "url",
  ICON: "icon",
  TAGS: "tags",
  UPGRADER: "upgrader",     // ผู้มีสิทธิ์ส่งโค้ดใหม่ (ไม่มี = โปรแกรมแก้ไม่ได้ตลอดไป)
  VERSION: "version",       // เวอร์ชันของโค้ด (ไม่มี = 1) — เพิ่มทีละ 1 ทุกครั้งที่อัปเกรด
  TEMPLATE: "template",     // โปรแกรมต้นแบบ (เฉพาะโปรแกรมที่สร้างด้วย cloneProgram)
  ABI: "abi",               // คำอธิบายฟังก์ชัน / event (ไม่บังคับ · ตรวจด้วย checkAbi) — explorer ใช้สร้างฟอร์มและอ่าน event
};
export const RESERVED_METADATA = [METADATA_FIELD.TYPE, METADATA_FIELD.CREATOR, METADATA_FIELD.CREATED_AT,
  METADATA_FIELD.UPGRADER, METADATA_FIELD.VERSION, METADATA_FIELD.TEMPLATE];
export const txnKey = (address, nonce, hash) => joinKey(address, KEY.TXN, String(nonce), hash);
export const blockKey = (number) => joinKey(KEY.BLOCK, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const blockBodyKey = (number) => joinKey(KEY.BLOCK_BODY, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const blockHashKey = (hash) => joinKey(KEY.BLOCK_HASH, hash);
export const txIndexKey = (hash) => joinKey(KEY.TX, hash);
export const sigTxKey = (digest) => joinKey(KEY.SIG_TX, digest);

/** ดัชนี "ใครมา interact กับ address นี้": txto:<address>:<block>:<index> */
export const txToKey = (address, number, index, callIndex = 0) =>
  joinKey(KEY.TX_TO, address, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"),
    String(index).padStart(4, "0"), String(callIndex).padStart(4, "0"));

/** ดัชนี event: event:<program>:<name>:<block>:<txIndex>:<eventIndex> */
export const eventKey = (program, name, number, txIndex, eventIndex) =>
  joinKey(KEY.EVENT, program, name,
    String(number).padStart(BLOCK_NUMBER_WIDTH, "0"),
    String(txIndex).padStart(4, "0"),
    String(eventIndex).padStart(4, "0"));
/**
 * ดัชนีของ field ที่ emit แบบ indexed (เขียนตอนปิด block · 1 key ต่อ field ต่อ event · ค่า = dbKey ของ event:)
 *   eventidx:<program>:<name>:<field>:<topic>:<block>:<txIndex>:<eventIndex>   topic = topicOf(ค่า) (0x + 64 hex)
 *   eventsig:<topic0>:<program>:<name>  → { program, name, indexed }  (topic0 ของ log แบบ EVM → ชื่อ event / field ที่ indexed · ใช้กับ eth_getLogs)
 */
export const eventIndexPrefix = (program, name, field, topic) => `${joinKey(KEY.EVENT_INDEX, program, name, field, String(topic).toLowerCase())}${KEY.SEPARATOR}`;
export const eventIndexKey = (program, name, field, topic, number, txIndex, eventIndex) =>
  `${eventIndexPrefix(program, name, field, topic)}${joinKey(String(number).padStart(BLOCK_NUMBER_WIDTH, "0"), String(txIndex).padStart(4, "0"), String(eventIndex).padStart(4, "0"))}`;
export const eventSigKey = (topic0, program, name) => joinKey(KEY.EVENT_SIG, String(topic0).toLowerCase(), program, name);
/** ดัชนี "address นี้เคยได้รับเหรียญจากโปรแกรมนี้" (จาก event Transfer) — ยอดจริงอ่านจาก balanceOf ของโปรแกรม */
export const holdingKey = (address, program) => joinKey(KEY.HOLDING, address, program);
/** event ที่ทำดัชนี holding: (มี data.from / data.to) — Transfer ของ token / NFT, TransferSingle / TransferBatch ของ multi-token */
export const HOLDING_EVENTS = new Set(["Transfer", "TransferSingle", "TransferBatch"]);
export const blockUndoKey = (number) => joinKey(KEY.BLOCK_UNDO, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));

/**
 * tx ที่ถูกปฏิเสธ (ผ่านการตรวจลายเซ็นแล้วแต่ไม่ได้รัน) ที่ผู้ผลิตบันทึกไว้ใน block — ไม่รัน ไม่แตะ state ไม่กิน nonce ไม่เสียค่าแก๊ส
 *   blockrejected:<block>             รายการทั้ง block (ตามลำดับที่ถูกปฏิเสธ) · header มี rejectedCount + rejectedRoot (อยู่ใน hash ของ block)
 *   rejtx:<hash>                      ดัชนีค้นจาก hash (ถูกปฏิเสธซ้ำใน block หลัง = ชี้ไปอันล่าสุด)
 *   rejfrom:<sender>:<block>:<index>  ดัชนีตามผู้ส่ง (explorer แบ่งหน้า)
 */
export const REJECTED_KEY = { BLOCK: "blockrejected", TX: "rejtx", FROM: "rejfrom" };
/**
 * ดัชนี: เขียนตอนปิด block อย่างเดียว ตอนรัน tx ไม่มีใครอ่าน และสร้างใหม่ได้จาก blockbody
 *   → ไม่เก็บ history / ไม่อยู่ใน blockundo · rebuildFrom ลบทิ้งแล้วให้ replay สร้างใหม่
 */
const INDEX_KINDS = new Set([KEY.TX, KEY.TXN, KEY.SIG_TX, KEY.TX_TO, KEY.EVENT, KEY.EVENT_INDEX, KEY.EVENT_SIG, KEY.HOLDING]);
const REJECTED_HEADS = new Set(Object.values(REJECTED_KEY));
export const isIndexKey = (dbKey) => INDEX_KINDS.has(decodeDbKey(dbKey).kind) || REJECTED_HEADS.has(dbKey.split(KEY.SEPARATOR, 1)[0]);
/** prefix ของดัชนีที่ขึ้นต้นด้วยชนิด (txn ขึ้นต้นด้วย address จึงลบผ่านดัชนี tx) · blockrejected ลบทีละ block */
const INDEX_PREFIXES = [KEY.TX, KEY.SIG_TX, KEY.TX_TO, KEY.EVENT, KEY.EVENT_INDEX, KEY.EVENT_SIG, KEY.HOLDING, REJECTED_KEY.TX, REJECTED_KEY.FROM]
  .map((head) => `${head}${KEY.SEPARATOR}`);
export const REJECTED_STAGES = ["sendtx", "block", "expired"];
export const MAX_REJECTED_REASON = 500;
export const blockRejectedKey = (number) => joinKey(REJECTED_KEY.BLOCK, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const rejectedTxKey = (hash) => joinKey(REJECTED_KEY.TX, hash);
export const rejectedFromKey = (sender, number, index) =>
  joinKey(REJECTED_KEY.FROM, sender, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"), String(index).padStart(6, "0"));

/** ค่าก่อนเปลี่ยนของ key หนึ่ง ณ block หนึ่ง — เรียงตาม key จึงค้นย้อนหลังได้ด้วยการ seek ครั้งเดียว */
export const historyKey = (dbKey, number) => joinKey(KEY.HISTORY, dbKey, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const historyPrefix = (dbKey) => `${joinKey(KEY.HISTORY, dbKey)}${KEY.SEPARATOR}`;
export const LATEST_BLOCK_KEY = KEY.LATEST_BLOCK;
/** block แรกที่ history ครบต่อเนื่องถึงล่าสุด (replayBlock / snapshotAt เช็คครั้งเดียว ไม่ต้องไล่ blockundo ทุก block) */
export const HISTORY_FROM_KEY = KEY.HISTORY_FROM;
/** ข้อมูลของ chain เอง (block / history) — ไม่ใช่ state: สร้างใหม่ได้จาก body */
const CHAIN_KINDS = new Set([KEY.HISTORY, KEY.BLOCK, KEY.BLOCK_BODY, KEY.BLOCK_UNDO, KEY.BLOCK_HASH, KEY.LATEST_BLOCK]);
/**
 * key ของ state (ที่ tx อ่าน / เขียน) = อยู่ใน trie (stateRoot) · มี history · อยู่ใน snapshot
 * ไม่ใช่ state: block / history / ดัชนี / historyfrom / genesis (hash ของ genesis) / node ของ trie เอง
 */
export const isStateKey = (dbKey) => !dbKey.startsWith(TRIE_PREFIX) && dbKey !== HISTORY_FROM_KEY && dbKey !== KEY.GENESIS
  && !CHAIN_KINDS.has(decodeDbKey(dbKey).kind) && !isIndexKey(dbKey);
const KEY_END = "\uffff";

/** key ซ้อน: map("balances", "alice") */
export const map = (...parts) => ({ [MAP_PARTS]: parts });

export function getKeyParts(key) {
  const parts = typeof key === "string" ? [key] : key?.[MAP_PARTS];
  if (!parts?.length) fail(ERRORS.invalidKey);
  if (!parts.every((part) => isNonEmptyString(part) || Number.isInteger(part) || typeof part === "bigint")) fail(ERRORS.invalidKeyPart);
  return parts.map((part) => normalizeHex(typeof part === "bigint" ? `${part}` : part));
}

/** encode ทุกส่วน: "a:b" กับ map("a", "b") จึงเป็นคนละ key */
export function storageKey(programUuid, key) {
  const encoded = getKeyParts(key).map((part) => encodeURIComponent(String(part)));
  return joinKey(programUuid, KEY.STORAGE, ...encoded);
}

/** เดา action จากหน้าตาของ request (ใช้เมื่อไม่ได้ระบุมา) */
export function guessAction(request = {}) {
  if (request.from !== undefined && request.to !== undefined) return "transfer";
  if (request.code !== undefined) return "deploy";
  if (request.functionName !== undefined) return "call";
  return "unknown";
}

/** key เดียวกันถูกเขียนหลายครั้งใน tx เดียวได้ → เหลือค่าสุดท้ายค่าเดียว (เรียงตามครั้งแรกที่ถูกเขียน) */
export function collapseWrites(writes) {
  const latest = new Map();
  for (const write of writes) {
    latest.set(write.dbKey, { ...decodeDbKey(write.dbKey), value: write.type === WRITE.DEL ? undefined : write.value });
  }
  return [...latest.values()];
}

/** แปลง dbKey เป็นรูปแบบที่อ่านง่าย (ใช้ทำ receipt / explorer) */
export function decodeDbKey(dbKey) {
  const [head, ...rest] = dbKey.split(KEY.SEPARATOR);
  if (head === KEY.PENDING) return { kind: KEY.PENDING, address: rest.join(KEY.SEPARATOR) };
  if (head === KEY.PENDING_UPGRADE || head === KEY.SCHEDULED_UPGRADE) return { kind: head, address: rest.join(KEY.SEPARATOR) };
  if (head === KEY.UPGRADE_AT) return { kind: KEY.UPGRADE_AT, number: Number(rest[0]) };
  if (head === KEY.BLOCK) return { kind: KEY.BLOCK, number: Number(rest[0]) };
  if (head === KEY.BLOCK_BODY) return { kind: KEY.BLOCK_BODY, number: Number(rest[0]) };
  if (head === KEY.BLOCK_HASH) return { kind: KEY.BLOCK_HASH, hash: rest[0] };
  if (head === KEY.TX) return { kind: KEY.TX, hash: rest[0] };
  if (head === KEY.SIG_TX) return { kind: KEY.SIG_TX, digest: rest[0] };
  if (head === KEY.TX_TO) return { kind: KEY.TX_TO, address: rest[0], number: Number(rest[1]), index: Number(rest[2]), callIndex: Number(rest[3] ?? 0) };
  if (head === KEY.EVENT) {
    const [program, name, number, txIndex, eventIndex] = rest;
    return { kind: KEY.EVENT, program, name, number: Number(number), txIndex: Number(txIndex), eventIndex: Number(eventIndex) };
  }
  if (head === KEY.EVENT_INDEX) {
    const [program, name, field, topic, number, txIndex, eventIndex] = rest;
    return { kind: KEY.EVENT_INDEX, program, name, field, topic, number: Number(number), txIndex: Number(txIndex), eventIndex: Number(eventIndex) };
  }
  if (head === KEY.EVENT_SIG) return { kind: KEY.EVENT_SIG, topic: rest[0], program: rest[1], name: rest[2] };
  if (head === KEY.BLOCK_UNDO) return { kind: KEY.BLOCK_UNDO, number: Number(rest[0]) };
  if (head === KEY.HISTORY) {
    const number = Number(rest.at(-1));
    return { kind: KEY.HISTORY, dbKey: rest.slice(0, -1).join(KEY.SEPARATOR), number };
  }
  if (head === KEY.NAMESPACE) return { kind: KEY.NAMESPACE, name: rest.join(KEY.SEPARATOR) };
  if (head === KEY.HOLDING) return { kind: KEY.HOLDING, address: rest[0], program: rest[1] };
  if (dbKey === KEY.LATEST_BLOCK) return { kind: KEY.LATEST_BLOCK };

  const [kind, ...parts] = rest;
  if (kind === KEY.STORAGE) return { kind, address: head, key: parts.map(decodeURIComponent) };
  if (kind === KEY.TXN) return { kind, address: head, nonce: Number(parts[0]), hash: parts[1] };
  if (kind === KEY.NATIVE) return { kind, address: head, field: parts[0] };
  if (kind === KEY.METADATA) return { kind, address: head, field: parts[0] };
  if (kind === KEY.CODE_VERSION) return { kind, address: head, version: Number(parts[0]) };
  return { kind, address: head };
}

// ---------- ตรวจ request ----------

export function checkProgramUuid(programUuid) {
  if (!isNonEmptyString(programUuid) || programUuid.includes(KEY.SEPARATOR)) fail(ERRORS.invalidProgramUuid);
}

export function checkContext(context) {
  if (!isNonEmptyString(context?.sender) || !isNonEmptyString(context?.origin)) fail(ERRORS.invalidContext);
}

/**
 * ยอด native (หน่วยย่อย 18 ทศนิยม) → BigInt
 * รับ BigInt, number ที่เป็นจำนวนเต็มปลอดภัย, "123" หรือ "123n" · อย่างอื่นคืน null
 */
export function parseNative(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && NATIVE_TEXT.test(value)) return BigInt(value.endsWith("n") ? value.slice(0, -1) : value);
  return null;
}
const NATIVE_TEXT = /^-?\d+n?$/;

/** BigInt → "123n" (รูปแบบที่เก็บลง DB / ส่งออกใน response, receipt, header) */
export const encodeNative = (amount) => `${amount}n`;

/** ค่าที่อ่านจาก DB / response กลับเป็น BigInt (ไม่มีค่า = 0) */
export const readNative = (value) => (value === undefined || value === null ? 0n : parseNative(value) ?? 0n);

export function checkValue(value) {
  const amount = parseNative(value);
  if (amount === null || amount < 0n) fail(ERRORS.invalidValue);
  return amount;
}

/** gasPrice ที่ผู้ส่งเสนอ ต้องไม่ต่ำกว่าราคาขั้นต่ำของระบบ (คืน BigInt) */
export function checkGasPrice(gasPrice, minimum) {
  const floor = parseNative(minimum);
  if (gasPrice === undefined || gasPrice === null) return floor;
  const price = parseNative(gasPrice);
  if (price === null || price < floor) fail(ERRORS.invalidGasPrice, minimum);
  return price;
}

/** ฟิลด์ค่าแก๊สแบบ EIP-1559 ของ request (ไม่ส่ง = undefined) */
// sponsor = ผู้จ่ายแก๊สแทน (paymaster) · ไม่ส่ง = ไม่อยู่ใน hash ของ tx (tx เดิมไม่เปลี่ยน)
export const feeFields = (request) => ({ maxFeePerGas: request?.maxFeePerGas ?? undefined, maxPriorityFeePerGas: request?.maxPriorityFeePerGas ?? undefined,
  sponsor: request?.sponsor ? normalizeAddress(request.sponsor) : undefined });

/** request นี้ใช้ค่าแก๊สแบบ EIP-1559 (type 2) ไหม */
export const isFeeMarketRequest = (request) => (request?.maxFeePerGas ?? null) !== null || (request?.maxPriorityFeePerGas ?? null) !== null;

/**
 * ราคาแก๊สของ tx ใน block ที่มี baseFee (BigInt ทั้งหมด)
 *   แบบเดิม: gasPrice = maxFee = priority (ต้อง ≥ baseFee) · ไม่ส่งอะไรเลย = จ่ายเท่า baseFee ไม่มี tip
 *   EIP-1559: maxFeePerGas (ไม่ส่ง = baseFee + priority) + maxPriorityFeePerGas (ไม่ส่ง = 0) · maxFee ต้อง ≥ baseFee และ ≥ priority
 *   ราคาจริง price = min(maxFee, baseFee + priority) · tip = price - baseFee (ต่อแก๊ส)
 * @returns {{ type: 0 | 2, maxFee: bigint, maxPriority: bigint, price: bigint, tip: bigint }}
 */
export function resolveFees({ gasPrice, maxFeePerGas, maxPriorityFeePerGas } = {}, baseFee) {
  const given = (value) => value !== undefined && value !== null;
  if (!given(maxFeePerGas) && !given(maxPriorityFeePerGas)) {
    if (!given(gasPrice)) return { type: 0, maxFee: baseFee, maxPriority: 0n, price: baseFee, tip: 0n };
    const price = parseNative(gasPrice);
    if (price === null || price < baseFee) fail(ERRORS.invalidGasPrice, baseFee);
    return { type: 0, maxFee: price, maxPriority: price, price, tip: price - baseFee };
  }
  if (given(gasPrice)) fail(ERRORS.invalidFeeFields);
  const priority = given(maxPriorityFeePerGas) ? parseNative(maxPriorityFeePerGas) : 0n;
  if (priority === null || priority < 0n) fail(ERRORS.invalidFeeValue, "maxPriorityFeePerGas");
  const maxFee = given(maxFeePerGas) ? parseNative(maxFeePerGas) : baseFee + priority;
  if (maxFee === null || maxFee < 0n) fail(ERRORS.invalidFeeValue, "maxFeePerGas");
  if (priority > maxFee) fail(ERRORS.priorityAboveMax);
  if (maxFee < baseFee) fail(ERRORS.feeBelowBaseFee, maxFee, baseFee);
  const price = maxFee < baseFee + priority ? maxFee : baseFee + priority;
  return { type: 2, maxFee, maxPriority: priority, price, tip: price - baseFee };
}

/**
 * tip ต่อแก๊สที่ผู้ผลิตได้ถ้าใส่ request นี้ใน block ที่มี baseFee (ใช้เรียงคิว) · maxFee < baseFee → null (ยังใส่ไม่ได้)
 * ไม่ระบุราคาเลย = จ่ายเท่า baseFee (tip 0) · แบบเดิม gasPrice = ทั้ง maxFee และ priority
 */
export function effectiveTip(request = {}, baseFee = 0n, { defaultGasPrice = null } = {}) {
  let maxFee;
  let priority;
  if (isFeeMarketRequest(request)) {
    priority = parseNative(request.maxPriorityFeePerGas ?? 0) ?? 0n;
    maxFee = (request.maxFeePerGas ?? null) === null ? baseFee + priority : parseNative(request.maxFeePerGas) ?? 0n;
  } else if ((request.gasPrice ?? null) === null) {
    // ไม่ระบุราคา = จ่ายเท่า baseFee เสมอ (ใส่ได้ทุก block) · นับ tip เท่าราคาตั้งต้นที่เกิน baseFee
    const fallback = parseNative(defaultGasPrice ?? 0) ?? 0n;
    return fallback > baseFee ? fallback - baseFee : 0n;
  } else {
    maxFee = parseNative(request.gasPrice) ?? 0n;
    priority = maxFee;
  }
  if (maxFee < baseFee) return null;
  const room = maxFee - baseFee;
  return priority < room ? priority : room;
}

/**
 * base fee ของ block ถัดไปจาก block ก่อนหน้า (สูตร EIP-1559)
 *   ใช้แก๊สเท่า target → เท่าเดิม · มากกว่า → เพิ่ม base × (used - target) / target / denominator (อย่างน้อย 1)
 *   น้อยกว่า → ลด base × (target - used) / target / denominator · ไม่ต่ำกว่า minimum · ไม่มี target = minimum เสมอ
 */
export function nextBaseFee({ parentBaseFee, parentGasUsed = 0, gasTarget, denominator = 8, minimum = 0n }) {
  if (!gasTarget) return minimum;
  const base = parentBaseFee === null || parentBaseFee === undefined || parentBaseFee < minimum ? minimum : parentBaseFee;
  const used = BigInt(parentGasUsed);
  const target = BigInt(gasTarget);
  const divisor = BigInt(denominator);
  let next = base;
  if (used > target) {
    const delta = (base * (used - target)) / target / divisor;
    next = base + (delta > 1n ? delta : 1n);
  } else if (used < target) {
    next = base - (base * (target - used)) / target / divisor;
  }
  return next < minimum ? minimum : next;
}

// ---------- log แบบ EVM (ใช้ทำ logsBloom / receiptsRoot ใน header และ /evm) ----------

const ADDRESS_TEXT = /^0x[0-9a-f]{40}$/i;
const UINT256 = 2n ** 256n;
/** ชนิดแบบ ABI ของค่าใน event (ค่าที่เก็บแล้ว: BigInt = "123n") — ใช้ทำ topic0 = keccak(ชื่อ(ชนิด,...)) */
export function eventValueType(value) {
  if (typeof value === "string" && BIGINT_TEXT.test(value)) return "uint256";
  if (typeof value === "string" && ADDRESS_TEXT.test(value)) return "address";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "string") return "string";
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && BIGINT_TEXT.test(item))) return "uint256[]";
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && ADDRESS_TEXT.test(item))) return "address[]";
  return "bytes";
}
const word64 = (big) => (((big % UINT256) + UINT256) % UINT256).toString(16).padStart(64, "0");
/** ค่าเดี่ยว (uint256 / address / bool) → 1 word (64 hex) */
const staticWord = (type, value) => (type === "uint256" ? word64(BigInt(value.slice(0, -1)))
  : type === "address" ? value.slice(2).toLowerCase().padStart(64, "0") : word64(value ? 1n : 0n));
/** ABI encode ของ tuple (uint256 / address / bool / string / uint256[] / address[]) แบบ head + tail → hex ไม่มี 0x */
function abiEncode(types, values) {
  const dynamic = (type) => type === "string" || type.endsWith("[]");
  let head = "";
  let tail = "";
  const headSize = types.length * 32;
  types.forEach((type, i) => {
    if (!dynamic(type)) { head += staticWord(type, values[i]); return; }
    head += word64(BigInt(headSize + tail.length / 2));
    if (type === "string") {
      const hex = bytesToHex(utf8ToBytes(values[i]));
      tail += word64(BigInt(hex.length / 2)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");
    } else {
      const itemType = type.slice(0, -2);
      tail += word64(BigInt(values[i].length)) + values[i].map((item) => staticWord(itemType, item)).join("");
    }
  });
  return head + tail;
}
/**
 * ค่า 1 ค่า → topic 32 byte (0x + 64 hex) แบบ indexed ของ EVM
 *   BigInt → uint256 (ติดลบ = two's complement) · address → เติม 0 ซ้าย · bool → 0/1
 *   string → keccak256(ข้อความ) · อย่างอื่น (object / null) → keccak256(canonical JSON)
 */
export function topicOf(value) {
  const type = eventValueType(value);
  if (type === "uint256") return `0x${word64(BigInt(value.slice(0, -1)))}`;
  if (type === "address") return `0x${value.slice(2).toLowerCase().padStart(64, "0")}`;
  if (type === "bool") return `0x${word64(value ? 1n : 0n)}`;
  if (type === "string") return keccak256Hex(value);
  return keccak256Hex(canonicalJson(value ?? null));
}
const jsonHex = (value) => `0x${bytesToHex(utf8ToBytes(JSON.stringify(value ?? null)))}`;

/**
 * event ของเชน → log แบบ EVM { address, topics, data } (ขึ้นกับข้อมูลของ event อย่างเดียว จึงรันซ้ำได้ผลเดิม)
 *   มี indexed: topic0 = keccak("ชื่อ(ชนิดของทุก field ตามลำดับ)") เช่น Transfer(address,address,uint256)
 *               topic1..3 = ค่าของ field ที่ indexed · data = field ที่เหลือ ABI encode (uint256 / address / bool / string / uint256[] / address[])
 *               มี field ชนิดอื่น (object ฯลฯ) → data = JSON ของ field ที่เหลือ
 *   ไม่มี indexed: topic0 = keccak(ชื่อ) · data = JSON ของข้อมูลทั้งก้อน
 */
export function eventLog(event) {
  const data = event?.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {};
  const address = event?.program ?? BURN_ADDRESS;
  const indexed = Array.isArray(event?.indexed) ? event.indexed : [];
  if (!indexed.length) return { address, topics: [keccak256Hex(String(event?.name))], data: jsonHex(event?.data ?? {}) };
  const fields = Object.keys(data);
  const signature = `${event.name}(${fields.map((field) => eventValueType(data[field])).join(",")})`;
  const rest = fields.filter((field) => !indexed.includes(field));
  const encodable = rest.every((field) => eventValueType(data[field]) !== "bytes");
  return {
    address,
    topics: [keccak256Hex(signature), ...indexed.map((field) => topicOf(data[field]))],
    data: !rest.length ? "0x" : encodable ? `0x${abiEncode(rest.map((field) => eventValueType(data[field])), rest.map((field) => data[field]))}`
      : jsonHex(Object.fromEntries(rest.map((field) => [field, data[field]]))),
  };
}

/** byte ของ address / topic ที่ใส่ bloom (address ที่ไม่ใช่ hex เช่นชื่อโปรแกรมในเทสต์ = byte ของข้อความ) */
const bloomBytes = (item) => {
  const text = String(item ?? "");
  return /^0x(?:[0-9a-f]{2})+$/i.test(text) ? hexToBytesStrict(text.toLowerCase()) : utf8ToBytes(text);
};

/** logsBloom แบบ EVM (2048 bit): address + ทุก topic ของทุก log */
export function logsBloom(logs) {
  const bits = new Uint8Array(256);
  for (const log of logs) {
    for (const item of [log.address, ...log.topics]) {
      const hash = keccak_256(bloomBytes(item));
      for (let i = 0; i < 6; i += 2) {
        const bit = ((hash[i] << 8) | hash[i + 1]) & 2047;
        bits[255 - (bit >> 3)] |= 1 << (bit & 7);
      }
    }
  }
  return `0x${bytesToHex(bits)}`;
}

/** bloom นี้อาจมี item (address / topic) อยู่ไหม (false = ไม่มีแน่นอน) */
export function bloomContains(bloom, item) {
  if (typeof bloom !== "string" || bloom.length !== 514) return true;
  const bits = hexToBytesStrict(bloom);
  const hash = keccak_256(bloomBytes(item));
  for (let i = 0; i < 6; i += 2) {
    const bit = ((hash[i] << 8) | hash[i + 1]) & 2047;
    if (!(bits[255 - (bit >> 3)] & (1 << (bit & 7)))) return false;
  }
  return true;
}

// ---------- ABI ของโปรแกรม (metadata.abi) ----------

/** ชนิดที่ใช้ใน metadata.abi */
export const ABI_TYPES = ["address", "uint", "int", "bool", "string", "bytes", "object", "array", "any"];
export const ABI_LIMITS = { functions: 64, events: 32, fields: 16, size: 16 * 1024, description: 200 };
const ABI_NAME = /^[A-Za-z_$][\w$]{0,31}$/;

/**
 * ตรวจ metadata.abi (คำอธิบายฟังก์ชัน / event ให้ explorer สร้างฟอร์มและอ่าน event)
 *   { functions: [{ name, inputs: [{ name, type }], outputs: [{ name?, type }], readonly?, payable?, description? }],
 *     events: [{ name, fields: [{ name, type, indexed? }], description? }] }
 * type ∈ ABI_TYPES · ชื่อห้ามซ้ำ · event มี indexed ได้ไม่เกิน 3 field
 */
export function checkAbi(abi) {
  const bad = (detail) => fail(ERRORS.invalidAbi, detail);
  if (abi === null || typeof abi !== "object" || Array.isArray(abi)) bad("ต้องเป็น object { functions, events }");
  const unknown = Object.keys(abi).find((key) => !["functions", "events"].includes(key));
  if (unknown) bad(`ไม่รู้จัก '${unknown}'`);
  if (valueSize(abi) > ABI_LIMITS.size) bad(`ใหญ่เกิน ${ABI_LIMITS.size} ไบต์`);
  const list = (value, label, max) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) bad(`${label} ต้องเป็น array`);
    if (value.length > max) bad(`${label} มีได้ไม่เกิน ${max} รายการ`);
    return value;
  };
  const description = (item, label) => {
    if (item.description !== undefined && (typeof item.description !== "string" || item.description.length > ABI_LIMITS.description)) {
      bad(`${label}.description ต้องเป็น string ยาวไม่เกิน ${ABI_LIMITS.description}`);
    }
  };
  const fields = (value, label, { named = true, allowIndexed = false } = {}) => {
    const names = new Set();
    for (const [i, field] of list(value, label, ABI_LIMITS.fields).entries()) {
      const where = `${label}[${i}]`;
      if (field === null || typeof field !== "object" || Array.isArray(field)) bad(`${where} ต้องเป็น { name, type }`);
      const extra = Object.keys(field).find((key) => !["name", "type", "description", ...(allowIndexed ? ["indexed"] : [])].includes(key));
      if (extra) bad(`${where}: ไม่รู้จัก '${extra}'`);
      if ((named || field.name !== undefined) && (typeof field.name !== "string" || !ABI_NAME.test(field.name))) bad(`${where}.name ไม่ถูกต้อง`);
      if (field.name !== undefined && names.has(field.name)) bad(`${where}.name '${field.name}' ซ้ำ`);
      names.add(field.name);
      if (!ABI_TYPES.includes(field.type)) bad(`${where}.type ต้องเป็นหนึ่งใน ${ABI_TYPES.join(" / ")}`);
      if (field.indexed !== undefined && typeof field.indexed !== "boolean") bad(`${where}.indexed ต้องเป็น true / false`);
      description(field, where);
    }
    return value ?? [];
  };
  const seen = new Set();
  for (const [i, fn] of list(abi.functions, "functions", ABI_LIMITS.functions).entries()) {
    const where = `functions[${i}]`;
    if (fn === null || typeof fn !== "object" || Array.isArray(fn)) bad(`${where} ต้องเป็น object`);
    const extra = Object.keys(fn).find((key) => !["name", "inputs", "outputs", "readonly", "payable", "description"].includes(key));
    if (extra) bad(`${where}: ไม่รู้จัก '${extra}'`);
    if (typeof fn.name !== "string" || !ABI_NAME.test(fn.name)) bad(`${where}.name ไม่ถูกต้อง`);
    if (seen.has(`f:${fn.name}`)) bad(`ฟังก์ชัน '${fn.name}' ซ้ำ`);
    seen.add(`f:${fn.name}`);
    for (const flag of ["readonly", "payable"]) if (fn[flag] !== undefined && typeof fn[flag] !== "boolean") bad(`${where}.${flag} ต้องเป็น true / false`);
    if (fn.readonly && fn.payable) bad(`${where}: readonly กับ payable ใช้คู่กันไม่ได้`);
    fields(fn.inputs, `${where}.inputs`);
    fields(fn.outputs, `${where}.outputs`, { named: false });
    description(fn, where);
  }
  for (const [i, event] of list(abi.events, "events", ABI_LIMITS.events).entries()) {
    const where = `events[${i}]`;
    if (event === null || typeof event !== "object" || Array.isArray(event)) bad(`${where} ต้องเป็น object`);
    const extra = Object.keys(event).find((key) => !["name", "fields", "description"].includes(key));
    if (extra) bad(`${where}: ไม่รู้จัก '${extra}'`);
    if (typeof event.name !== "string" || !METADATA_FIELD_PATTERN.test(event.name)) bad(`${where}.name ไม่ถูกต้อง`);
    if (seen.has(`e:${event.name}`)) bad(`event '${event.name}' ซ้ำ`);
    seen.add(`e:${event.name}`);
    const declared = fields(event.fields, `${where}.fields`, { allowIndexed: true });
    if (declared.filter((field) => field.indexed).length > MAX_INDEXED) bad(`${where}: indexed ได้ไม่เกิน ${MAX_INDEXED} field`);
    description(event, where);
  }
  return abi;
}

/** ABI ของเชน → JSON ABI แบบ Ethereum (ให้เครื่องมือ EVM อ่าน) */
export function toEvmAbi(abi) {
  const solidity = { address: "address", uint: "uint256", int: "int256", bool: "bool", string: "string", bytes: "bytes", object: "string", array: "string", any: "string" };
  const param = (field) => ({ name: field.name ?? "", type: solidity[field.type] ?? "string" });
  return [
    ...(abi?.functions ?? []).map((fn) => ({ type: "function", name: fn.name, inputs: (fn.inputs ?? []).map(param), outputs: (fn.outputs ?? []).map(param),
      stateMutability: fn.readonly ? "view" : fn.payable ? "payable" : "nonpayable" })),
    ...(abi?.events ?? []).map((event) => ({ type: "event", name: event.name, anonymous: false,
      inputs: (event.fields ?? []).map((field) => ({ ...param(field), indexed: Boolean(field.indexed) })) })),
  ];
}

/** ค่าจาก query string (หรือค่าจริง) → topic ทุกแบบที่เป็นไปได้: "0x…40" = address · ตัวเลข = BigInt หรือ string · true/false = bool หรือ string */
export function indexedTopicCandidates(value) {
  if (typeof value === "bigint") return [topicOf(`${value}n`)];
  if (typeof value === "boolean") return [topicOf(value)];
  const text = String(value ?? "");
  const topics = new Set([topicOf(ADDRESS_TEXT.test(text) ? text.toLowerCase() : text)]);
  if (/^-?\d+n?$/.test(text)) topics.add(topicOf(`${text.replace(/n$/, "")}n`));
  if (text === "true" || text === "false") topics.add(topicOf(text === "true"));
  return [...topics];
}

/** emit แบบ indexed ได้ไม่เกินกี่ field (เท่า LOG4 ของ EVM: topic0 + 3) */
export const MAX_INDEXED = 3;

/** options ของ emit: { indexed: ["field", ...] } — ชื่อต้องไม่ซ้ำ มีอยู่ใน data และไม่เกิน MAX_INDEXED → รายชื่อ (ไม่ส่ง = []) */
export function checkIndexed(options, data) {
  if (options === undefined || options === null) return [];
  if (typeof options !== "object" || Array.isArray(options)) fail(ERRORS.invalidIndexed, "options ต้องเป็น { indexed: [...] }");
  const extra = Object.keys(options).find((key) => key !== "indexed");
  if (extra) fail(ERRORS.invalidIndexed, `ไม่รู้จัก '${extra}'`);
  const { indexed } = options;
  if (indexed === undefined || indexed === null) return [];
  if (!Array.isArray(indexed)) fail(ERRORS.invalidIndexed, "indexed ต้องเป็น array ของชื่อ field");
  if (indexed.length > MAX_INDEXED) fail(ERRORS.invalidIndexed, `ได้ไม่เกิน ${MAX_INDEXED} field`);
  for (const field of indexed) {
    if (typeof field !== "string" || !METADATA_FIELD_PATTERN.test(field)) fail(ERRORS.invalidIndexed, `ชื่อ field ไม่ถูกต้อง: '${field}'`);
    if (!Object.hasOwn(data ?? {}, field)) fail(ERRORS.invalidIndexed, `ไม่มี field '${field}' ใน data`);
  }
  if (new Set(indexed).size !== indexed.length) fail(ERRORS.invalidIndexed, "ชื่อ field ซ้ำ");
  return [...indexed];
}

/** จำนวนแก๊สที่ซื้อได้ (BigInt) → number ไม่เกินเพดานที่ number แทนได้ */
const gasUnits = (units) => Number(units > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : units);

export function checkGasLimit(gasLimit) {
  if (gasLimit === undefined) return Infinity;
  if (!Number.isSafeInteger(gasLimit) || gasLimit <= 0) fail(ERRORS.invalidGasLimit);
  return gasLimit;
}

export function checkBurnPercent(percent) {
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > 100) fail(ERRORS.invalidBurnPercent);
  return percent;
}

export function checkCode(code) {
  if (typeof code !== "string") fail(ERRORS.invalidCode);
}

/** upgrader: address (string ที่ไม่ว่าง ไม่มี ':') · null / undefined = ไม่มี → คืน address ตัวพิมพ์เล็ก หรือ null */
export function checkUpgrader(upgrader) {
  if (upgrader === undefined || upgrader === null) return null;
  if (!isNonEmptyString(upgrader) || upgrader.includes(":")) fail(ERRORS.invalidUpgrader);
  return normalizeAddress(upgrader);
}

// ---------- เวลา ----------

const RealDate = Date;

/** ตัวสุ่มที่ผูกกับ seed: ลำดับค่าที่ได้เหมือนเดิมทุกครั้งเมื่อ seed และลำดับการเรียกเหมือนกัน */
export function createSeededRandom(hashFunction, seed) {
  let counter = 0;
  return () => {
    const hex = hashFunction(`${seed}:${counter++}`).slice(2, 15); // 13 hex = 52 bit
    return Number.parseInt(hex, 16) / 2 ** 52;
  };
}

/** Math ที่โปรแกรมเห็น: เหมือนของเดิมทุกอย่าง ยกเว้น random() */
export function createSeededMath(random) {
  return new Proxy(Math, { get: (target, prop, receiver) => (prop === "random" ? random : Reflect.get(target, prop, receiver)) });
}

export function checkTimestamp(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail(ERRORS.invalidTimestamp);
}

/**
 * Date ที่โปรแกรมเห็น: เวลาปัจจุบันเป็น timestamp ของ block เสมอ
 *   Date.now() / new Date() / Date()  → เวลาของ block
 *   new Date(x), Date.UTC, Date.parse, instanceof Date → ทำงานปกติ
 */
export function createBlockDate(timestamp) {
  return new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [timestamp], newTarget),
    apply: () => new RealDate(timestamp).toString(),
    get: (target, prop, receiver) => (prop === "now" ? () => timestamp : Reflect.get(target, prop, receiver)),
  });
}

// ============================================================================
//  Compiler: ตรวจโค้ด + ฉีดตัวนับแก๊ส → ซอร์สที่พร้อมรันใน sandbox (มี cache ตามเนื้อโค้ด)
// ============================================================================

export class Compiler {
  #cache = new Map(); // oneLineCode → program

  /** โค้ดบรรทัดเดียว → { exports, hasInit, hasMigrate, source } (source = ฟังก์ชัน factory(api) ที่ฉีดตัวนับแก๊สแล้ว) */
  compile(oneLineCode) {
    if (!this.#cache.has(oneLineCode)) {
      const { body, exports, candidateNames } = Compiler.parse(fromOneLine(oneLineCode));
      Compiler.checkSyntax(body);
      const functionNames = candidateNames.filter((name) => Compiler.isTopLevelDeclaration(body, name));
      const callable = Compiler.validateExports(exports, functionNames);
      const source = Compiler.buildFactory(Compiler.meter(body), functionNames);
      const guestError = checkGuestSyntax(source);   // QuickJS รับ syntax ไม่ตรงกับ V8 ทุกข้อ → ตรวจกับตัวที่ใช้รันจริงด้วย
      if (guestError) fail(ERRORS.syntaxError, guestError);
      this.#cache.set(oneLineCode, {
        exports: callable,
        hasInit: functionNames.includes(INIT_FUNCTION),
        hasMigrate: functionNames.includes(MIGRATE_FUNCTION),
        source,
      });
    }
    return this.#cache.get(oneLineCode);
  }

  /** ลืมโค้ดที่คอมไพล์ไว้ (เรียกตอนโค้ดของโปรแกรมถูกแทนที่ด้วยการอัปเกรด — ใช้อีกเมื่อไรก็คอมไพล์ใหม่ได้) */
  forget(oneLineCode) {
    this.#cache.delete(oneLineCode);
  }

  /** แยกโค้ดเป็น body ภายใน scope, รายชื่อที่ return, ชื่อที่ "อาจ" เป็นฟังก์ชัน */
  static parse(code) {
    if (MODULE_KEYWORD_PATTERN.test(code)) fail(ERRORS.importNotAllowed);

    const wrapper = code.match(PROGRAM_WRAPPER_PATTERN);
    if (!wrapper) fail(ERRORS.programWrapperMissing);

    const inner = wrapper[1];
    const returned = inner.match(RETURN_EXPORT_PATTERN);
    const exports = (returned?.[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    const body = returned ? inner.slice(0, returned.index) : inner; // ตัด return ท้ายสุดออก

    const candidateNames = [...new Set([
      ...[...body.matchAll(FUNCTION_PATTERN)].map((m) => m[1]),
      ...[...body.matchAll(BINDING_PATTERN)].map((m) => m[1]),
    ])];
    return { body, exports, candidateNames };
  }

  static source(body, tail = "") {
    return `"use strict";\nconst { ${[...PROGRAM_API_NAMES, ...METER_FNS].join(", ")} } = api;\n${body}\n;${tail}`;
  }

  /** ฉีดตัวนับแก๊สเข้าโค้ด (ดู gasmeter.js) */
  static meter(body) {
    try {
      return instrument(body);
    } catch (err) {
      fail(ERRORS.syntaxError, err.message);
    }
  }

  /** คอมไพล์เพื่อตรวจ syntax ด้วย V8 (ไม่รันโค้ด — แค่สร้างฟังก์ชันโดยไม่เรียก ข้อความ error คงเดิม) */
  static checkSyntax(body) {
    try {
      new Function("api", Compiler.source(body));
    } catch (err) {
      fail(ERRORS.syntaxError, err.message);
    }
  }

  /**
   * name ถูกประกาศในระดับบนสุดของโปรแกรมหรือไม่ (ไม่รันโค้ด)
   * ประกาศ `let name` ต่อท้าย ถ้าชื่อนี้มีอยู่แล้วใน scope เดียวกัน V8 จะแจ้ง SyntaxError ตอนคอมไพล์
   */
  static isTopLevelDeclaration(body, name) {
    try {
      new Function("api", Compiler.source(body, `let ${name};`));
      return false;
    } catch (err) {
      return err instanceof SyntaxError && err.message.includes(`'${name}' has already been declared`);
    }
  }

  /** initialization / migrate ถูกตัดออกจากรายการ export เสมอ (VM เรียกเองตอน init / อัปเกรดเท่านั้น) */
  static validateExports(exports, functionNames) {
    const missing = exports.find((name) => !functionNames.includes(name));
    if (missing) fail(ERRORS.exportMissing, missing);
    return exports.filter((name) => name !== INIT_FUNCTION && name !== MIGRATE_FUNCTION);
  }

  /** ซอร์สของ factory(api) → { ชื่อฟังก์ชัน: function } (รันใน sandbox ทุก call จึงไม่มีตัวแปรค้างข้าม call) */
  static buildFactory(body, functionNames) {
    const returns = functionNames.map((name) => `${name}: typeof ${name} === "function" ? ${name} : undefined`);
    return `(function (api) {\n${Compiler.source(body, `return { ${returns.join(", ")} };`)}\n})`;
  }
}

// ============================================================================
//  Transaction: สถานะของ 1 request
// ============================================================================

export class Transaction {
  #read;
  #readCache = new Map(); // dbKey → ค่าที่อ่านจาก DB แล้ว (อ่านแต่ละ key จาก DB ครั้งเดียวต่อ request)

  #sandbox = null;
  #sandboxOptions;

  constructor({ read, timeoutMs, maxCallDepth, timestamp = RealDate.now(), gas = DEFAULT_GAS, chargeGas = false, feeRecipient = null, burnPercent = 100, blockNumber = null, maxTxGas = Infinity, baseFee,
    memoryLimitBytes = DEFAULT_OPTIONS.memoryLimitBytes, maxStackBytes = DEFAULT_OPTIONS.maxStackBytes, wallClock = false }) {
    checkTimestamp(timestamp);
    this.#read = read;
    this.#sandboxOptions = { memoryLimitBytes, maxStackBytes, wallClock };
    this.blockNumber = blockNumber;           // เลข block ที่ tx นี้อยู่ (null = รันนอก block)
    this.seed = null;                         // seed ของตัวสุ่ม (ตั้งจาก hash ของ tx)
    this.Math = Math;                         // แทนด้วยตัวสุ่มที่ผูกกับ tx เมื่อรู้ seed
    this.gas = gas;                           // ตารางค่าแก๊ส
    this.baseFee = baseFee === undefined || baseFee === null ? readNative(gas.price) : readNative(baseFee);   // base fee ของ block (BigInt)
    this.gasPrice = this.baseFee;             // ราคาจริงต่อ 1 gas ของ tx นี้ = min(maxFee, baseFee + priority) — ตั้งใน preparePayer
    this.fees = null;                         // ผลของ resolveFees (ราคาที่ผู้ส่งเสนอ) — ตั้งใน preparePayer
    this.feeBurned = 0n;                      // ค่าแก๊สส่วนที่เผา (ส่วนของ base fee × burnPercent)
    this.feeReward = 0n;                      // ค่าแก๊สที่เข้าผู้ปิด block (tip + ส่วนของ base fee ที่ไม่ได้เผา)
    this.chargeGas = chargeGas;
    this.gasUsed = 0;
    this.maxTxGas = maxTxGas;                 // เพดานแก๊สต่อ tx ไม่ว่าผู้จ่ายจะมีเงินเท่าไร
    this.gasLimit = maxTxGas;                 // ตั้งตามยอด native ของผู้จ่ายเมื่อรู้ตัวผู้จ่าย
    this.payer = null;                        // { address, nonce } ของ tx ชั้นนอกสุด
    this.transaction = null;                  // ข้อมูลของ tx สำหรับเขียน <addr>:txn:<nonce>:<hash>
    this.feeCharged = 0n;                     // ค่าแก๊สที่เก็บจริง (native BigInt)
    this.feeRecipient = feeRecipient;         // ผู้ปิด block ที่ได้ส่วนแบ่งค่าแก๊ส
    this.burnPercent = burnPercent;
    this.timestamp = timestamp;               // เวลาของ request / block ที่โปรแกรมเห็น
    this.Date = createBlockDate(timestamp);
    this.maxCallDepth = maxCallDepth;
    this.deadline = Date.now() + timeoutMs;
    this.fatal = null;       // error ที่ทั้ง request ต้องล้ม (DB พัง / แก๊สหมด / หมดเวลา / หน่วยความจำเกิน) — โปรแกรม catch ไม่ได้
    this.writes = [];        // [{ type: "put", dbKey, value } | { type: "del", dbKey }]
    this.calls = [];         // log การเรียกโปรแกรม
    this.events = [];        // event ที่โปรแกรม emit (ถูกย้อนพร้อม writes)
    this.before = new Map(); // dbKey → ค่าก่อนรัน
    this.loaded = new Set(); // dbKey ที่โปรแกรมอ่าน
    this.stateKeys = new Set(); // dbKey ที่คิดแก๊ส stateKey ไปแล้ว (ไม่คืนตอน rollback ของกิ่ง — แก๊สที่ใช้ไปแล้วไม่คืน)
  }

  /** แก๊สของ key ของ state ที่ tx เขียนครั้งแรก (writeDB / deleteDB) */
  useStateKeyGas(dbKey) {
    if (this.stateKeys.has(dbKey)) return;
    this.useGas(this.gas.stateKey);
    this.stateKeys.add(dbKey);
  }

  // ---------- DB ----------

  /** อ่าน DB (ครั้งเดียวต่อ key): ถ้าพัง จำ error ไว้เพื่อ throw ซ้ำจนจบ request */
  read(dbKey) {
    this.assertAlive();
    if (this.#readCache.has(dbKey)) return this.#readCache.get(dbKey);
    try {
      const value = this.#read(dbKey);
      this.#readCache.set(dbKey, value);
      return value;
    } catch (err) {
      this.fatal = VMError.from(ERRORS.dbReadFailed, err instanceof Error ? err.message : String(err));
      throw this.fatal;
    }
  }

  /** อ่าน DB โดยไม่สนว่า request ล้มไปแล้ว (ใช้ตอนเก็บค่าแก๊สของ tx ที่ล้ม) */
  readRaw(dbKey) {
    return this.#read(dbKey);
  }

  /** DB พัง / แก๊สหมด → หยุดทุกอย่างและ throw ซ้ำจนจบ request */
  assertAlive() {
    if (this.fatal) throw this.fatal;
  }

  /** นับแก๊ส: เกินยอดที่ผู้จ่ายมี → OUT_OF_GAS (catch ไม่ได้) */
  useGas(amount) {
    this.assertAlive();
    this.gasUsed += amount;
    if (this.gasUsed > this.gasLimit) {
      this.fatal = VMError.from(ERRORS.outOfGas, this.gasUsed, this.gasLimit);
      throw this.fatal;
    }
  }

  /** sandbox ตั้งให้ทั้ง request ล้ม: "timeout" | "memory" (error แรกชนะ) */
  abort(kind) {
    this.fatal ??= kind === "timeout"
      ? VMError.from(ERRORS.timeout)
      : VMError.from(ERRORS.outOfMemory, this.#sandboxOptions.memoryLimitBytes);
    return this.fatal;
  }

  // ---------- sandbox ----------

  /** runtime ของ QuickJS ของ tx นี้ (สร้างตอนรันโปรแกรมครั้งแรก — tx ที่ไม่รันโปรแกรมไม่ต้องจ่าย) */
  sandbox() {
    this.#sandbox ??= new Sandbox(this, {
      ...this.#sandboxOptions,
      nodeGas: this.gas.node,
      builtinGas: this.gas.builtin,
      timestamp: this.timestamp,
      map,
    });
    return this.#sandbox;
  }

  /** คืน runtime / context ทั้งหมด (runAction เรียกเสมอ) */
  dispose() {
    this.#sandbox?.dispose();
  }

  /** ค่าแก๊สที่ต้องจ่ายเป็น native */
  gasFee() {
    return this.chargeGas ? BigInt(Math.min(this.gasUsed, this.gasLimit)) * this.gasPrice : 0n;
  }

  /** ค่าล่าสุด: ถ้าเขียนใน request นี้แล้วใช้ค่านั้น ไม่งั้นอ่าน DB */
  current(dbKey) {
    const lastWrite = this.writes.findLast((write) => write.dbKey === dbKey);
    return copyValue(lastWrite ? lastWrite.value : this.read(dbKey));
  }

  put(dbKey, value) {
    this.writes.push({ type: WRITE.PUT, dbKey, value });
  }

  delete(dbKey) {
    this.writes.push({ type: WRITE.DEL, dbKey });
  }

  /** แปลง key ของโปรแกรมเป็น dbKey และจำค่าก่อนรันไว้ */
  touch(programUuid, key) {
    const dbKey = storageKey(programUuid, key);
    if (!this.before.has(dbKey)) this.before.set(dbKey, copyValue(this.read(dbKey)));
    return dbKey;
  }

  savepoint() {
    return { writes: this.writes.length, events: this.events.length };
  }

  rollbackTo(savepoint) {
    this.writes.length = savepoint.writes;
    this.events.length = savepoint.events;   // event ของกิ่งที่ถูกย้อนหายไปด้วย
  }

  // ---------- เวลา ----------

  remainingTime() {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) fail(ERRORS.timeout);
    return remaining;
  }

  // ---------- log การเรียก ----------

  startCall({ depth, programUuid, functionName, context, input, value = 0, gasStart = this.gasUsed, type }) {
    const record = { depth, programUuid, functionName, ...pickContext(context), input, value: encodeNative(readNative(value)), gasStart, status: STATUS.RUNNING };
    if (type) record.type = type;   // "create" = โปรแกรมถูกสร้างด้วย cloneProgram (ไม่มี = call ปกติ)
    this.calls.push(record);
    return record;
  }

  static finishCall(record, error, gasUsed) {
    record.status = error ? STATUS.THROW : STATUS.SUCCESS;
    if (gasUsed !== undefined) record.gasUsed = gasUsed - record.gasStart;
    if (error) record.error = { code: error.code, message: error.message };
  }

  /** ปิด call ที่ยังค้างทั้งหมดเป็น throw — ใช้ตอน timeout ที่หยุดทุกชั้นพร้อมกัน */
  closeRunningCalls(error) {
    for (const record of this.calls) {
      if (record.status === STATUS.RUNNING) Transaction.finishCall(record, error, this.gasUsed);
    }
  }

  // ---------- สรุปผล ----------

  summary() {
    const loadValues = [...this.loaded].map((dbKey) => ({ dbKey, loadValue: this.before.get(dbKey) }));
    const afterValues = [...this.before].map(([dbKey, before]) => {
      const afterValue = this.current(dbKey);
      return { dbKey, afterValue, changed: !isSameValue(before, afterValue) };
    });
    return { calls: this.calls, loadValues, afterValues, writes: this.writes };
  }
}

// ============================================================================
//  VirtualMachine
// ============================================================================

export class VirtualMachine {
  /**
   * @param {{ readKeys(keys: string[]): any[], writeKeys(writes: object[]): any, listKeys?: Function }} db
   *        DB ที่ใช้เก็บข้อมูล (ดู db.js: DB สำหรับของจริง, MemoryDB สำหรับทดสอบ)
   * @param {object} [options]
   */
  constructor(db, {
    timeoutMs = DEFAULT_OPTIONS.timeoutMs,
    maxCallDepth = DEFAULT_OPTIONS.maxCallDepth,
    requireNonce = DEFAULT_OPTIONS.requireNonce,
    chargeGas = DEFAULT_OPTIONS.chargeGas,
    burnPercent = DEFAULT_OPTIONS.burnPercent,
    feeRecipient = DEFAULT_OPTIONS.feeRecipient,
    minBaseFee = DEFAULT_OPTIONS.minBaseFee,
    gasTarget = DEFAULT_OPTIONS.gasTarget,
    baseFeeChangeDenominator = DEFAULT_OPTIONS.baseFeeChangeDenominator,
    chainId = DEFAULT_OPTIONS.chainId,
    recordTransactions = DEFAULT_OPTIONS.recordTransactions,
    recordBlocks = DEFAULT_OPTIONS.recordBlocks,
    deriveProgramAddress = DEFAULT_OPTIONS.deriveProgramAddress,
    forceOriginFromSender = DEFAULT_OPTIONS.forceOriginFromSender,
    maxTransactions = DEFAULT_OPTIONS.maxTransactions,
    maxTransactionsPerSender = DEFAULT_OPTIONS.maxTransactionsPerSender,
    maxBlockGas = DEFAULT_OPTIONS.maxBlockGas,
    maxTxGas = DEFAULT_OPTIONS.maxTxGas,
    admins = DEFAULT_OPTIONS.admins,
    maxCodeSize = DEFAULT_OPTIONS.maxCodeSize,
    maxKeySize = DEFAULT_OPTIONS.maxKeySize,
    autoReview = DEFAULT_OPTIONS.autoReview,
    maxValueSize = DEFAULT_OPTIONS.maxValueSize,
    recordHistory = DEFAULT_OPTIONS.recordHistory,
    upgradeDelayBlocks = DEFAULT_OPTIONS.upgradeDelayBlocks,
    memoryLimitBytes = DEFAULT_OPTIONS.memoryLimitBytes,
    maxStackBytes = DEFAULT_OPTIONS.maxStackBytes,
    wallClock = DEFAULT_OPTIONS.wallClock,
    producer = DEFAULT_OPTIONS.producer,
    replayTimeoutMs = DEFAULT_OPTIONS.replayTimeoutMs,
    historyKeep = DEFAULT_OPTIONS.historyKeep,
    forks = DEFAULT_OPTIONS.forks,
    forkRules = DEFAULT_OPTIONS.forkRules,
    hashFunction = keccak256Hex,
    gas,
  } = {}) {
    if (typeof db?.readKeys !== "function" || typeof db?.writeKeys !== "function") fail(ERRORS.invalidDb);
    this.db = db;
    this.timeoutMs = timeoutMs;
    this.maxCallDepth = maxCallDepth;
    this.requireNonce = requireNonce;
    this.chargeGas = chargeGas;
    this.burnPercent = checkBurnPercent(burnPercent);
    this.feeRecipient = feeRecipient === null ? null : normalizeAddress(feeRecipient);
    this.chainId = chainId;
    this.recordTransactions = recordTransactions;
    this.recordBlocks = recordBlocks;
    this.deriveProgramAddress = deriveProgramAddress;
    this.forceOriginFromSender = forceOriginFromSender;
    this.maxTransactions = maxTransactions;
    this.maxTransactionsPerSender = maxTransactionsPerSender;
    this.maxBlockGas = maxBlockGas;
    this.maxTxGas = maxTxGas;
    this.admins = admins === null ? null : admins.map(normalizeAddress);
    this.maxCodeSize = maxCodeSize;
    this.maxKeySize = maxKeySize;
    this.autoReview = autoReview;
    this.maxValueSize = maxValueSize;
    this.recordHistory = recordHistory;
    if (!Number.isSafeInteger(upgradeDelayBlocks) || upgradeDelayBlocks < 0) fail(ERRORS.invalidUpgradeDelay);
    this.upgradeDelayBlocks = upgradeDelayBlocks;
    for (const [name, value] of Object.entries({ memoryLimitBytes, maxStackBytes })) {
      const [min, max] = SANDBOX_LIMITS[name];
      if (!Number.isSafeInteger(value) || value < min || value > max) fail(ERRORS.invalidSandboxLimit, name, SANDBOX_LIMITS[name]);
    }
    this.memoryLimitBytes = memoryLimitBytes;
    this.maxStackBytes = maxStackBytes;
    this.wallClock = wallClock;
    this.producer = producer ? { address: normalizeAddress(producer.address), sign: producer.sign } : null;
    this.replayTimeoutMs = replayTimeoutMs;
    if (historyKeep !== null && (!Number.isSafeInteger(historyKeep) || historyKeep < 1)) fail(ERRORS.invalidHistoryKeep);
    this.historyKeep = historyKeep;
    this.hashFunction = hashFunction;
    this.gas = { ...DEFAULT_GAS, ...gas };
    this.#setForks(forks ?? {}, { ...FORKS, ...forkRules });
    // EIP-1559: base fee ต่ำสุด / แก๊สเป้าหมายต่อ block / ตัวหารของการเปลี่ยนต่อ block
    this.minBaseFee = parseNative(minBaseFee ?? this.gas.price);
    if (this.minBaseFee === null || this.minBaseFee < 0n) fail(ERRORS.invalidBaseFeeOption, "minBaseFee");
    const target = gasTarget ?? (Number.isSafeInteger(maxBlockGas) && maxBlockGas > 0 ? Math.max(1, Math.floor(maxBlockGas / 2)) : null);
    if (target !== null && (!Number.isSafeInteger(target) || target <= 0)) fail(ERRORS.invalidBaseFeeOption, "gasTarget");
    this.gasTarget = target;
    if (!Number.isSafeInteger(baseFeeChangeDenominator) || baseFeeChangeDenominator <= 0) fail(ERRORS.invalidBaseFeeOption, "baseFeeChangeDenominator");
    this.baseFeeChangeDenominator = baseFeeChangeDenominator;
    this.compiler = new Compiler();
  }

  /** base fee ของ block ที่ต่อจาก header นี้ (ไม่มี header = block แรก → minBaseFee) */
  baseFeeAfter(header) {
    if (!header) return this.minBaseFee;
    return nextBaseFee({
      parentBaseFee: parseNative(header.baseFeePerGas ?? null) ?? this.minBaseFee,
      parentGasUsed: header.gasUsed ?? 0,
      gasTarget: this.gasTarget,
      denominator: this.baseFeeChangeDenominator,
      minimum: this.minBaseFee,
    });
  }

  /** base fee ของ block ถัดไป (ต่อจาก block ล่าสุดใน DB) */
  currentBaseFee() {
    if (!this.gasTarget) return this.minBaseFee;   // ไม่มีเป้าหมาย = base fee คงที่ ไม่ต้องอ่าน DB
    try {
      const latest = this.latestBlockNumber();
      return this.baseFeeAfter(latest === null ? null : this.getBlock(latest));
    } catch {
      return this.minBaseFee;   // DB อ่านไม่ได้ → tx จะล้มเองตอนอ่าน DB (INTERNAL)
    }
  }

  /** อ่าน 1 key ผ่าน db.readKeys */
  read(dbKey) {
    return this.db.readKeys([dbKey])[0];
  }

  /**
   * บันทึก writes ลง DB ผ่าน db.writeKeys · key ของ state ที่เปลี่ยน → อัปเดต trie (stateRoot) ใน commit เดียวกัน
   *   trie = ผลของ trieUpdate(writes) ที่คำนวณไว้แล้ว (Block ใช้ตัวเดียวกับที่ทำ stateRoot ใน header) · ไม่ส่ง = คำนวณเอง
   */
  commit(writes, { trie } = {}) {
    this.#ensureTrie();
    if (trie && trie.parentRoot !== this.stateRoot()) fail(ERRORS.trieStale);
    const update = trie ?? this.trieUpdate(writes);
    return this.db.writeKeys(update.writes.length ? [...writes, ...update.writes] : writes);
  }

  // ---------- fork (กติกาตาม block height · ดู FORKS) ----------

  #forks = [];          // [{ name, block, rule }] เรียงตาม block
  #gasCache = new Map(); // ชื่อ fork ที่เปิดแล้ว → ตารางแก๊ส

  #setForks(forks, rules) {
    if (typeof forks !== "object" || Array.isArray(forks)) fail(ERRORS.invalidFork, "(ตาราง)", "ต้องเป็น { ชื่อ: block }");
    this.#forks = Object.entries(forks).map(([name, block]) => {
      const rule = Object.hasOwn(rules, name) ? rules[name] : null;
      if (!rule) fail(ERRORS.unknownFork, name);
      if (!Number.isSafeInteger(block) || block < 0) fail(ERRORS.invalidFork, name, `block ต้องเป็นจำนวนเต็ม ≥ 0 (ได้ ${block})`);
      for (const [field, value] of Object.entries(rule.gas ?? {})) {
        if (field === "price" || !Object.hasOwn(DEFAULT_GAS, field)) fail(ERRORS.invalidFork, name, `เปลี่ยนค่าแก๊ส '${field}' ไม่ได้`);
        if (!Number.isSafeInteger(value) || value < 0) fail(ERRORS.invalidFork, name, `ค่าแก๊ส '${field}' ต้องเป็นจำนวนเต็ม ≥ 0`);
      }
      return { name, block, rule };
    }).sort((a, b) => a.block - b.block || (a.name < b.name ? -1 : 1));
    this.#gasCache.clear();
  }

  /** block ที่ tx ที่รันนอก block (query / simulate / mempool) จะได้อยู่ = block ถัดไป */
  #effectiveBlock(blockNumber) {
    return blockNumber ?? (this.latestBlockNumber() ?? 0) + 1;
  }

  /** fork นี้เปิดใช้แล้วที่ block นั้นไหม (ไม่ส่ง = block ถัดไป) */
  forkActive(name, blockNumber = null) {
    const fork = this.#forks.find((item) => item.name === name);
    return Boolean(fork) && this.#effectiveBlock(blockNumber) >= fork.block;
  }

  /** ตาราง fork → [{ name, block, active, description }] (active = เปิดแล้วที่ block ถัดไป) */
  forkSchedule() {
    const next = this.#effectiveBlock(null);
    return this.#forks.map(({ name, block, rule }) => ({ name, block, active: next >= block, description: rule.description ?? null }));
  }

  /** ตารางแก๊สที่ใช้ใน block นั้น = ค่าตั้งต้นของ VM แล้วแทนด้วย fork ที่เปิดแล้วตามลำดับ */
  gasAt(blockNumber = null) {
    if (!this.#forks.length) return this.gas;   // ไม่มี fork = ไม่ต้องอ่านเลข block จาก DB
    const number = this.#effectiveBlock(blockNumber);
    const active = this.#forks.filter((fork) => number >= fork.block && fork.rule.gas);
    if (!active.length) return this.gas;
    const id = active.map((fork) => fork.name).join(",");
    let table = this.#gasCache.get(id);
    if (!table) {
      table = Object.freeze(Object.assign({}, this.gas, ...active.map((fork) => fork.rule.gas)));
      this.#gasCache.set(id, table);
    }
    return table;
  }

  // ---------- trie ของ state (ระยะ 4.3 · src/core/trie.js) ----------

  #trieReady = false;

  /** trie ของ state ล่าสุดใน DB (node อยู่ที่ trie:<path> · เก็บแค่ของล่าสุด) */
  #trie() {
    return new StateTrie({ load: (path) => this.read(trieNodeKey(path)) });
  }

  /** DB ที่มี state แต่ยังไม่มี trie (สร้างก่อนระยะ 4.3 / เขียน state ตรง ๆ) → สร้าง trie จาก state ทั้งหมดครั้งเดียว */
  #ensureTrie() {
    if (this.#trieReady) return;
    this.#trieReady = true;
    if (this.read(trieNodeKey("")) !== undefined || typeof this.db.listKeys !== "function") return;
    this.rebuildTrie();
  }

  /** root ของ trie ของ state ตอนนี้ (= stateRoot ของ block ล่าสุด) */
  stateRoot() {
    this.#ensureTrie();
    return this.#trie().root;
  }

  /** writes → { parentRoot, root, writes: node ของ trie ที่ต้องบันทึก } (ยังไม่บันทึก · เฉพาะ key ของ state) */
  trieUpdate(writes) {
    this.#ensureTrie();
    const trie = this.#trie();
    const parentRoot = trie.root;
    const entries = writes.filter((write) => isStateKey(write.dbKey))
      .map((write) => ({ dbKey: write.dbKey, value: write.type === WRITE.DEL ? undefined : write.value }));
    if (!entries.length) return { parentRoot, root: parentRoot, writes: [] };
    return { parentRoot, ...trie.update(entries) };
  }

  /**
   * สร้าง trie ใหม่จาก state ทั้งหมดใน DB (ลบ node เดิมก่อน) → { root, keys } · ใช้ตอนย้ายข้อมูล / โหลด snapshot
   * อ่าน key ของ state ทั้งหมดมาเรียงในหน่วยความจำ (≈ 150–250 byte ต่อ key) แล้วสร้างทั้งต้นทีเดียว (buildTrie)
   */
  rebuildTrie({ batch = 5_000 } = {}) {
    for (;;) {
      const keys = this.listKeys(TRIE_PREFIX, { limit: batch });
      if (!keys.length) break;
      this.db.writeKeys(keys.map((dbKey) => ({ type: WRITE.DEL, dbKey })));
    }
    const items = [];
    for (let start; ;) {
      const keys = this.listKeys("", { start, limit: batch + 1 });
      const state = keys.slice(0, batch).filter(isStateKey);
      if (state.length) {
        const values = this.db.readKeys(state);
        state.forEach((dbKey, index) => items.push({ key: trieKeyOf(dbKey), bytes: trieValueOf(values[index]) }));
      }
      if (keys.length <= batch) break;
      start = keys[batch];
    }
    items.sort((a, b) => (a.key < b.key ? -1 : 1));
    let pending = [];
    const root = buildTrie(items, (path, enc) => {
      pending.push({ type: WRITE.PUT, dbKey: trieNodeKey(path), value: enc });
      if (pending.length >= batch) { this.db.writeKeys(pending); pending = []; }
    });
    if (pending.length) this.db.writeKeys(pending);
    this.#trieReady = true;
    return { root, keys: items.length };
  }

  /**
   * หลักฐานของ key ใน state ล่าสุด (แบบ eth_getProof · ตรวจได้ด้วย verifyProof ของ src/core/trie.js / client-sdk)
   *   → { blockNumber, blockHash, stateRoot, proofs: [{ dbKey, value, proof: [hex ของ node จากราก] }] }
   * value undefined = ไม่มี key นี้ (หลักฐานพิสูจน์ว่าไม่มีได้เหมือนกัน)
   */
  getProof(dbKeys) {
    if (!Array.isArray(dbKeys) || dbKeys.some((dbKey) => !isNonEmptyString(dbKey))) fail(ERRORS.invalidKey);
    this.#ensureTrie();
    const trie = this.#trie();
    const blockNumber = this.latestBlockNumber();
    return {
      blockNumber,
      blockHash: blockNumber === null ? null : this.getBlock(blockNumber)?.hash ?? null,
      stateRoot: trie.root,
      proofs: dbKeys.map((dbKey) => ({ dbKey, ...trie.proof(dbKey) })),
    };
  }

  /**
   * pruning (ระยะ 4.2): ลบ history ของ block ที่เก่ากว่า historyKeep block ล่าสุด → ย้อนดู state / replay ได้แค่ช่วงนั้น
   * header / body ของ block ยังอยู่ครบ (ซิงก์ให้ node อื่นได้) · ลบทีละไม่เกิน maxKeys key ต่อครั้ง (เปิดบนเชนยาว = ทยอยลบทุก block)
   *   → { from, to, keys } · to = historyfrom ใหม่
   */
  pruneHistory({ keep = this.historyKeep, maxKeys = 50_000 } = {}) {
    const latest = this.latestBlockNumber();
    let from = this.historyFrom() ?? 1;
    const start = from;
    let keys = 0;
    if (keep === null || latest === null) return { from: start, to: from, keys };
    for (const target = latest - keep; from <= target && keys < maxKeys; from += 1) {
      const touched = this.getBlockUndo(from) ?? [];
      this.db.writeKeys([
        ...touched.map((dbKey) => ({ type: WRITE.DEL, dbKey: historyKey(dbKey, from) })),
        { type: WRITE.DEL, dbKey: blockUndoKey(from) },
        { type: WRITE.PUT, dbKey: HISTORY_FROM_KEY, value: from + 1 },
      ]);
      keys += touched.length;
    }
    return { from: start, to: from, keys };
  }

  // ---------- API ของ server ----------

  /** user ส่งโค้ด → ตรวจ syntax → pending รอรีวิว */
  deploy({ programUuid: rawProgramUuid, code, context: rawContext, initInput = {}, metadata = {}, upgrader, nonce, gasLimit, gasPrice, value = 0 } = {}, options) {
    return this.runAction((tx) => {
      const derive = this.deriveProgramAddress || rawProgramUuid === undefined;
      if (!derive) checkProgramUuid(rawProgramUuid);
      checkContext(rawContext);
      checkCode(code);
      const amount = checkValue(value);
      const upgraderAddress = checkUpgrader(upgrader);
      const context = this.userContext(rawContext);
      this.preparePayer(tx, context.sender, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice, value: amount });

      const programUuid = derive
        // address ของโปรแกรม = hash(deployer + nonce) จึงไม่มีใครมี private key ของมัน
        ? this.programAddressFor(context.sender, tx.payer?.nonce ?? tx.current(nonceKey(context.sender)) ?? 0)
        : normalizeAddress(rawProgramUuid);
      this.rememberTransaction(tx, arguments[0], "deploy");
      this.seedRandom(tx, arguments[0], "deploy");
      const oneLineCode = toOneLine(code);
      const codeSize = Buffer.byteLength(oneLineCode, "utf8");
      if (codeSize > this.maxCodeSize) fail(ERRORS.codeTooLong, this.maxCodeSize, codeSize);

      // ค่าพื้นฐานของ tx + ตามขนาดโค้ด (เก็บใน DB ถาวรและถูกคอมไพล์ทุกครั้งที่เรียกใช้)
      if (this.autoReview) {
        const result = review(code, { apiNames: [...PROGRAM_API_NAMES, "params"] });
        if (!result.ok) fail(ERRORS.reviewFailed, reviewMessage(result));
      }
      tx.useGas(tx.gas.call + tx.gas.code * codeSize);
      this.compiler.compile(oneLineCode);

      if (tx.current(pendingKey(programUuid)) || tx.current(codeKey(programUuid))) {
        fail(ERRORS.programUuidUsed, programUuid);
      }

      if (amount > 0n) this.moveNative(tx, context.sender, programUuid, amount); // เงินไปรออยู่ที่โปรแกรมเลย

      this.checkMetadata(metadata);
      // ABI ที่ส่งมาตอน deploy: ฟังก์ชันที่ประกาศต้อง export จริง
      const missing = (metadata?.abi?.functions ?? []).find((fn) => !this.compiler.compile(oneLineCode).exports.includes(fn.name));
      if (missing) fail(ERRORS.invalidAbi, `ฟังก์ชัน '${missing.name}' ไม่ได้ export`);
      tx.put(pendingKey(programUuid), {
        code: oneLineCode,
        context,
        initInput: toInputValue(initInput, "initInput"),
        metadata,
        value: encodeNative(amount),
        // ไม่ระบุ = ไม่มี field นี้เลย (pending ของโปรแกรมที่แก้ไม่ได้หน้าตาเหมือนเดิมทุกไบต์)
        ...(upgraderAddress ? { upgrader: upgraderAddress } : {}),
      });
      return { programUuid, code: oneLineCode, state: STATE.PENDING, value: encodeNative(amount), ...(upgraderAddress ? { upgrader: upgraderAddress } : {}) };
    }, options);
  }

  /** ทีมงานอนุมัติ → รัน initialization ครั้งเดียว → บันทึกโปรแกรม → ลบ pending */
  init({ programUuid: rawProgramUuid, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      const programUuid = normalizeAddress(rawProgramUuid);
      this.prepareAdminAction(tx, arguments[0], "init", { context, nonce, gasLimit, gasPrice });

      const pending = tx.current(pendingKey(programUuid));
      if (!pending) fail(ERRORS.pendingNotFound);
      if (context === undefined) this.seedRandom(tx, arguments[0], "init");

      const { code, initInput } = pending;
      const value = readNative(pending.value);
      const deployer = pending.context;
      const initResult = this.compiler.compile(code).hasInit
        ? this.runFunction(tx, { programUuid, functionName: INIT_FUNCTION, input: initInput, context: deployer, value, code, isInit: true })
        : undefined;

      tx.put(codeKey(programUuid), code);
      tx.put(contextKey(programUuid), deployer);
      tx.put(thisKey(programUuid), programUuid);
      this.writeMetadata(tx, programUuid, {
        ...(pending.metadata ?? {}),
        [METADATA_FIELD.TYPE]: "program",
        [METADATA_FIELD.CREATOR]: deployer.sender,
        [METADATA_FIELD.CREATED_AT]: tx.timestamp,
        ...(pending.upgrader ? { [METADATA_FIELD.UPGRADER]: pending.upgrader } : {}),
      }, { allowReserved: true });
      tx.delete(pendingKey(programUuid));
      return { programUuid, state: STATE.ACTIVE, initResult, value: encodeNative(value) };
    }, options);
  }


  /** ทีมงานปฏิเสธ → ลบ pending */
  reject({ programUuid: rawProgramUuid, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      const programUuid = normalizeAddress(rawProgramUuid);
      this.prepareAdminAction(tx, arguments[0], "reject", { context, nonce, gasLimit, gasPrice });
      const pending = tx.current(pendingKey(programUuid));
      if (!pending) fail(ERRORS.pendingNotFound);

      const refund = readNative(pending.value);
      if (refund > 0n) this.moveNative(tx, programUuid, pending.context.sender, refund); // คืนเงินให้ผู้ deploy

      tx.delete(pendingKey(programUuid));
      return { programUuid, state: STATE.REJECTED, refund: encodeNative(refund) };
    }, options);
  }

  // ---------- อัปเกรดโปรแกรม ----------

  /** โปรแกรมต้องมีอยู่ มี upgrader และ sender ต้องเป็น upgrader คนปัจจุบัน */
  requireUpgrader(tx, programUuid, sender) {
    if (typeof tx.current(codeKey(programUuid)) !== "string") fail(ERRORS.programNotFound, programUuid);
    const upgrader = tx.current(metadataKey(programUuid, METADATA_FIELD.UPGRADER));
    if (upgrader === undefined || upgrader === null) fail(ERRORS.immutableProgram, programUuid);
    if (upgrader !== sender) fail(ERRORS.notUpgrader, sender);
    return upgrader;
  }

  /** upgrader ส่งโค้ดใหม่ → ตรวจแบบเดียวกับ deploy → pending-upgrade:<id> รอทีมงานอนุมัติ */
  upgrade({ programUuid: rawProgramUuid, code, migrateInput = {}, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      checkContext(context);
      checkCode(code);
      const programUuid = normalizeAddress(rawProgramUuid);
      const userContext = this.userContext(context);
      this.preparePayer(tx, userContext.sender, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice });
      this.rememberTransaction(tx, arguments[0], "upgrade");
      this.seedRandom(tx, arguments[0], "upgrade");

      const oneLineCode = toOneLine(code);
      const codeSize = Buffer.byteLength(oneLineCode, "utf8");
      if (codeSize > this.maxCodeSize) fail(ERRORS.codeTooLong, this.maxCodeSize, codeSize);
      if (this.autoReview) {
        const result = review(code, { apiNames: [...PROGRAM_API_NAMES, "params"] });
        if (!result.ok) fail(ERRORS.reviewFailed, reviewMessage(result));
      }
      tx.useGas(tx.gas.call + tx.gas.code * codeSize);   // คิดแบบเดียวกับ deploy
      this.compiler.compile(oneLineCode);

      this.requireUpgrader(tx, programUuid, userContext.sender);
      if (tx.current(pendingUpgradeKey(programUuid)) || tx.current(scheduledUpgradeKey(programUuid))) fail(ERRORS.upgradePending, programUuid);

      tx.put(pendingUpgradeKey(programUuid), { code: oneLineCode, context: userContext, migrateInput: toInputValue(migrateInput, "migrateInput") ?? {} });
      return { programUuid, code: oneLineCode, state: STATE.PENDING, version: this.programVersion(tx, programUuid) + 1 };
    }, options);
  }

  /** upgrader คนปัจจุบันโอนสิทธิ์ให้คนอื่น หรือสละสิทธิ์ (upgrader: null → โปรแกรมแก้ไม่ได้อีกตลอดไป) */
  setUpgrader({ programUuid: rawProgramUuid, upgrader, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      checkContext(context);
      const programUuid = normalizeAddress(rawProgramUuid);
      const next = checkUpgrader(upgrader);
      const userContext = this.userContext(context);
      this.preparePayer(tx, userContext.sender, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice });
      this.rememberTransaction(tx, arguments[0], "setUpgrader");
      this.seedRandom(tx, arguments[0], "setUpgrader");
      tx.useGas(tx.gas.call + tx.gas.write);

      this.requireUpgrader(tx, programUuid, userContext.sender);
      this.writeMetadata(tx, programUuid, { [METADATA_FIELD.UPGRADER]: next }, { allowReserved: true });
      return { programUuid, upgrader: next };
    }, options);
  }

  /**
   * ทีมงานอนุมัติการอัปเกรด (กติกาของผู้อนุมัติเหมือน init ทุกอย่าง)
   *   upgradeDelayBlocks = 0 → เปลี่ยนโค้ด + รัน migrate ทันที (migrate ล้ม = อนุมัติไม่สำเร็จ ไม่มีอะไรเปลี่ยน)
   *   upgradeDelayBlocks = N → นัดเปิดใช้ที่ block (เลข block นี้ + N) โค้ดเดิมยังทำงานจนถึงตอนนั้น
   */
  initUpgrade({ programUuid: rawProgramUuid, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      const programUuid = normalizeAddress(rawProgramUuid);
      this.prepareAdminAction(tx, arguments[0], "initUpgrade", { context, nonce, gasLimit, gasPrice });

      const pending = tx.current(pendingUpgradeKey(programUuid));
      if (!pending) fail(ERRORS.upgradeNotFound);
      if (context === undefined) this.seedRandom(tx, arguments[0], "initUpgrade");
      // upgrader ต้องยังเป็นคนเดิม (โอน / สละสิทธิ์ไปแล้ว → โค้ดที่ส่งค้างไว้ใช้ไม่ได้ ทีมงาน rejectUpgrade ทิ้งได้)
      this.requireUpgrader(tx, programUuid, pending.context.sender);
      tx.delete(pendingUpgradeKey(programUuid));

      if (this.upgradeDelayBlocks > 0) {
        if (tx.blockNumber === null) fail(ERRORS.upgradeNeedsBlock);
        const activateAt = tx.blockNumber + this.upgradeDelayBlocks;
        tx.useGas(2 * tx.gas.write);
        tx.put(scheduledUpgradeKey(programUuid), { ...pending, approvedAt: tx.blockNumber, activateAt });
        tx.put(upgradeAtKey(activateAt), [...(tx.current(upgradeAtKey(activateAt)) ?? []), programUuid]);
        return { programUuid, state: STATE.SCHEDULED, version: this.programVersion(tx, programUuid) + 1, activateAt };
      }
      return { programUuid, state: STATE.ACTIVE, ...this.applyUpgrade(tx, programUuid, pending) };
    }, options);
  }

  /** ทีมงานปฏิเสธการอัปเกรด → ลบ pending-upgrade (โค้ดเดิมทำงานต่อ) */
  rejectUpgrade({ programUuid: rawProgramUuid, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      const programUuid = normalizeAddress(rawProgramUuid);
      this.prepareAdminAction(tx, arguments[0], "rejectUpgrade", { context, nonce, gasLimit, gasPrice });
      if (!tx.current(pendingUpgradeKey(programUuid))) fail(ERRORS.upgradeNotFound);
      if (context === undefined) this.seedRandom(tx, arguments[0], "rejectUpgrade");
      tx.delete(pendingUpgradeKey(programUuid));
      return { programUuid, state: STATE.REJECTED };
    }, options);
  }

  /**
   * เปิดใช้โค้ดที่ครบ timelock — Block เรียกเองตอนสร้าง block ที่ตรงกับ activateAt
   * (ไม่ใช่ tx ของใคร: ไม่มีผู้จ่ายแก๊ส ไม่มี hash ไม่อยู่ใน body · replay สร้าง block เดิมก็ได้ผลเดิม)
   * migrate ล้ม → ผลถูกทิ้ง (Block ลบนัดหมายทิ้งเอง) โค้ดเดิมทำงานต่อ
   */
  activateUpgrade({ programUuid, blockNumber }, options) {
    return this.runAction((tx) => {
      this.seedRandom(tx, { programUuid, blockNumber }, "activateUpgrade");
      const scheduled = tx.current(scheduledUpgradeKey(programUuid));
      if (!scheduled) fail(ERRORS.upgradeNotFound);
      tx.delete(scheduledUpgradeKey(programUuid));
      return { programUuid, state: STATE.ACTIVE, ...this.applyUpgrade(tx, programUuid, scheduled) };
    }, options);
  }

  /** เวอร์ชันปัจจุบันของโค้ด (ไม่มี metadata.version = 1) */
  programVersion(tx, programUuid) {
    return Number(tx.current(metadataKey(programUuid, METADATA_FIELD.VERSION)) ?? 1);
  }

  /** เปลี่ยนโค้ด → เก็บเวอร์ชัน → รัน migrate ครั้งเดียว (throw = ทั้ง tx ล้ม ไม่มีอะไรเปลี่ยน) */
  applyUpgrade(tx, programUuid, { code, migrateInput = {}, context }) {
    const oldCode = tx.current(codeKey(programUuid));
    if (typeof oldCode !== "string") fail(ERRORS.programNotFound, programUuid);
    const version = this.programVersion(tx, programUuid);
    const next = version + 1;
    tx.useGas(3 * tx.gas.write);

    // เวอร์ชันแรกไม่ถูกเก็บแยกตอน init → เก็บตอนถูกแทนที่ครั้งแรก (blockNumber ไม่รู้ = null)
    if (tx.current(codeVersionKey(programUuid, version)) === undefined) {
      tx.put(codeVersionKey(programUuid, version), { version, code: oldCode, blockNumber: null,
        timestamp: tx.current(metadataKey(programUuid, METADATA_FIELD.CREATED_AT)) ?? null });
    }
    tx.put(codeKey(programUuid), code);
    tx.put(codeVersionKey(programUuid, next), { version: next, code, blockNumber: tx.blockNumber, timestamp: tx.timestamp });
    this.writeMetadata(tx, programUuid, { [METADATA_FIELD.VERSION]: next }, { allowReserved: true });

    // migrate เห็นโค้ดใหม่แล้ว (runProgram กลับเข้าตัวเองก็ได้โค้ดใหม่) · context = upgrader ที่ส่งโค้ดมา
    const program = this.compiler.compile(code);
    const migrateResult = program.hasMigrate
      ? this.runFunction(tx, { programUuid, functionName: MIGRATE_FUNCTION, input: migrateInput, context, value: 0n, code, isInit: true })
      : undefined;
    // cache คอมไพล์ผูกกับเนื้อโค้ด จึงไม่มีทางได้โค้ดเก่าจาก address นี้อีก · ลืมของเก่าทิ้ง (replay block เก่าก็คอมไพล์ใหม่ได้)
    if (oldCode !== code) this.compiler.forget(oldCode);
    return { version: next, migrateResult };
  }

  /** โค้ดทุกเวอร์ชันที่ถูกเก็บ (มีเฉพาะโปรแกรมที่เคยอัปเกรด) เก่าไปใหม่ — ต้องมี db.listKeys */
  listCodeVersions(programUuid) {
    const prefix = joinKey(normalizeAddress(programUuid), KEY.CODE_VERSION, "");
    return this.listEntries(prefix).map(({ value }) => value).sort((a, b) => a.version - b.version);
  }

  /** โค้ดเวอร์ชัน n (ไม่มี → null) */
  getCodeVersion(programUuid, version) {
    return this.read(codeVersionKey(normalizeAddress(programUuid), version)) ?? null;
  }

  /** โค้ดที่โปรแกรมใช้ ณ ตอนที่ block <number> ปิด (ต้องเปิด recordHistory) */
  codeAt(number, programUuid) {
    return this.stateAt(number, codeKey(normalizeAddress(programUuid))) ?? null;
  }

  /** user เรียกฟังก์ชันที่ export */
  call({ programUuid, functionName, input = {}, context, nonce, gasLimit, gasPrice, value = 0 } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(programUuid);
      checkContext(context);
      const amount = checkValue(value);

      const target = normalizeAddress(programUuid);
      const userContext = this.userContext(context);
      const sender = userContext.sender;
      this.preparePayer(tx, sender, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice, value: amount });
      this.rememberTransaction(tx, arguments[0], "call");
      this.seedRandom(tx, arguments[0], "call");
      if (amount > 0n) this.moveNative(tx, sender, target, amount); // แนบเงินไปกับ tx

      return this.runFunction(tx, { programUuid: target, functionName, input, context: userContext, value: amount });
    }, options);
  }

  /** โอน native ระหว่าง address โดยไม่เรียกโปรแกรม */
  transfer({ from, to, amount, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      if (!isNonEmptyString(from) || !isNonEmptyString(to)) fail(ERRORS.invalidAddress);
      const value = parseNative(amount);
      // โอน 0 ได้แบบ EVM (ยังคิดแก๊สและกิน nonce) → ยกเลิกใบที่ค้างในคิวด้วยการโอน 0 ให้ตัวเองได้
      if (value === null || value < 0n) fail(ERRORS.invalidTransferAmount);

      const sender = normalizeAddress(from);
      const recipient = normalizeAddress(to);
      this.preparePayer(tx, sender, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice, value });
      this.rememberTransaction(tx, arguments[0], "transfer");
      this.seedRandom(tx, arguments[0], "transfer");

      tx.useGas(tx.gas.call); // ค่าพื้นฐานของ tx
      this.moveNative(tx, sender, recipient, value);
      return { from: sender, to: recipient, amount: encodeNative(value) };
    }, options);
  }

  /**
   * ข้อมูลที่ใช้ทำ hash ของ tx — มาจาก request ของ user เท่านั้น ไม่มีส่วนของผลลัพธ์
   * call / deploy / transfer: from + nonce ทำให้ไม่ซ้ำอยู่แล้ว
   * init / reject: ไม่มี sender / nonce จึงต้องใช้ blockNumber + index ช่วย
   */
  transactionPayload(request = {}, { action = guessAction(request), blockNumber = null, index = null } = {}) {
    const base = { chainId: this.chainId, action };
    // maxFeePerGas / maxPriorityFeePerGas: ไม่ส่ง = ไม่อยู่ใน hash (hash ของ tx แบบเดิมไม่เปลี่ยน · canonicalJson ข้าม undefined)
    const fee = { nonce: request.nonce ?? null, gasLimit: request.gasLimit ?? null, gasPrice: request.gasPrice ?? null,
      ...Object.fromEntries(Object.entries(feeFields(request)).filter(([, value]) => value !== undefined)) };
    if (action === "transfer") {
      return { ...base, from: normalizeAddress(request.from) ?? null, to: normalizeAddress(request.to) ?? null, amount: request.amount ?? 0, ...fee };
    }
    if (action === "metadata") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, metadata: normalizeHexDeep(request.metadata ?? {}), ...fee };
    }
    if (action === "deploy") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, to: normalizeAddress(request.programUuid) ?? null, code: toOneLine(typeof request.code === "string" ? request.code : ""), initInput: normalizeHexDeep(request.initInput ?? {}), value: request.value ?? 0,
        ...(request.upgrader === undefined ? {} : { upgrader: normalizeAddress(request.upgrader) }),   // ไม่ส่ง = ไม่อยู่ใน hash (hash ของ tx เดิมไม่เปลี่ยน)
        ...fee };
    }
    if (action === "call") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, to: normalizeAddress(request.programUuid) ?? null, method: request.functionName ?? null, input: normalizeHexDeep(request.input ?? {}), value: request.value ?? 0, ...fee };
    }
    if (action === "upgrade") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, to: normalizeAddress(request.programUuid) ?? null, code: toOneLine(typeof request.code === "string" ? request.code : ""), input: normalizeHexDeep(request.migrateInput ?? {}), ...fee };
    }
    if (action === "setUpgrader") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, to: normalizeAddress(request.programUuid) ?? null, upgrader: normalizeAddress(request.upgrader) ?? null, ...fee };
    }
    const signer = normalizeAddress(request.context?.sender) ?? null;
    if (signer) return { ...base, from: signer, to: normalizeAddress(request.programUuid) ?? null, ...fee };
    return { ...base, to: normalizeAddress(request.programUuid) ?? null, blockNumber, index };
  }

  /** hash ของ tx (รู้ได้ตั้งแต่ก่อนส่งเข้า VM) */
  hashTransaction(request, meta) {
    return this.hashFunction(canonicalJson(this.transactionPayload(request, meta)));
  }

  /** context ของ tx ที่ user ส่งมา: origin = sender เสมอ (origin เปลี่ยนได้เฉพาะผ่าน runProgram) */
  userContext(rawContext) {
    const context = normalizeContext(rawContext);
    return this.forceOriginFromSender ? { sender: context.sender, origin: context.sender } : context;
  }

  /** address ของโปรแกรมจาก deployer + nonce (แบบเดียวกับ contract address ของ EVM) */
  programAddressFor(deployer, nonce) {
    return addressFromHash(this.hashData({ chainId: this.chainId, deployer: normalizeAddress(deployer), nonce }));
  }

  /** ตั้ง seed ของตัวสุ่มให้ tx (ใช้ hash ของ tx เพื่อให้รันซ้ำได้ผลเดิม) */
  seedRandom(tx, request, action) {
    // ผูกกับ tx และเวลาของ block: tx เดิมใน block เดิมได้ผลเดิม แต่คนละ block ได้ค่าใหม่
    tx.seed = this.hashData({ tx: this.hashTransaction(request, { action }), timestamp: tx.timestamp });
    tx.Math = createSeededMath(createSeededRandom(this.hashFunction, tx.seed));
  }

  /** hash ของข้อมูลใด ๆ แบบเดียวกับที่ใช้ทำ tx hash */
  hashData(value) {
    return this.hashFunction(canonicalJson(value));
  }

  /**
   * hash ของ block
   *   txRoot     = hash ของรายการ tx hash ทั้งหมด (เรียงตาม index)
   *   stateRoot  = root ของ Merkle Patricia Trie ของ state ทั้งหมดหลัง block นี้ (ระยะ 4.3 · Block คำนวณจาก trie ใน DB แล้วส่งมา)
   *   writesRoot = hash ของ writes ของ state ใน block นี้ (เรียงตาม dbKey) — replay block เก่าตรวจผลการรันด้วยตัวนี้ (trie เก็บแค่ของล่าสุด)
   *   receiptsRoot / logsBloom / baseFeePerGas / gasUsed มาจาก Block (ดู Block.receiptEntries) และอยู่ใน hash ด้วย
   */
  hashBlock({ number, parentHash, timestamp, feeRecipient, burnPercent, txHashes, writes, stateRoot, rejected = [],
    baseFeePerGas = null, gasUsed = 0, receiptsRoot = null, logsBloom: bloom = null, producer = null }) {
    const txRoot = this.hashData(txHashes);
    // tx ที่ถูกปฏิเสธ: อยู่ใน hash เฉพาะ block ที่มี
    const rejectedRoot = rejected.length ? this.hashData(rejected) : null;
    const writesRoot = this.hashData([...writes].sort((a, b) => (a.dbKey < b.dbKey ? -1 : 1)).map((write) => [write.type, write.dbKey, write.value ?? null]));
    const hash = this.hashHeader({
      number, parentHash, timestamp, feeRecipient, burnPercent, txCount: txHashes.length, txRoot, stateRoot, writesRoot,
      baseFeePerGas, gasUsed, receiptsRoot, logsBloom: bloom, rejectedCount: rejected.length, rejectedRoot, producer,
    });
    return { hash, txRoot, stateRoot, writesRoot, rejectedRoot };
  }

  /** hash จาก field ของ header (ไม่ต้องมี tx / writes) — header ที่บันทึกไว้ คำนวณกลับได้ hash เดิม (ใช้ตรวจ header ของ snapshot) */
  hashHeader(header) {
    return this.hashData(headerFields(header, this.chainId));
  }


  /**
   * แปลง request + ผลลัพธ์ เป็น receipt สำหรับ explorer
   * @param {object} request  request ที่ส่งเข้า deploy / init / reject / call / transfer
   * @param {object} result   ผลลัพธ์ที่ได้กลับมา
   * @param {{ index?: number, action?: string, nativeBefore?: Map }} [meta]  action = "call" | "deploy" | "init" | "reject" | "transfer"
   *        nativeBefore = dbKey → ค่าก่อน tx นี้ (block.receipt ส่งมา) ทำให้ nativeChanges มี before ด้วย
   */
  buildReceipt(request = {}, result = {}, { index = 0, action = guessAction(request), blockNumber = null, nativeBefore = null } = {}) {
    const changes = collapseWrites(result.writes ?? []);
    const pick = (kind) => changes.filter((change) => change.kind === kind);
    const isTransfer = action === "transfer";

    return {
      hash: this.hashTransaction(request, { action, blockNumber, index }),
      digest: request.digest ?? null,   // hash ที่ผู้ใช้เซ็น (ถ้ามาจาก tx ที่เซ็นแล้ว)
      index,
      action,
      timestamp: result.timestamp ?? null,
      time: result.timestamp === undefined ? null : new Date(result.timestamp).toISOString(),
      status: result.status ?? null,
      from: normalizeAddress(isTransfer ? request.from : request.context?.sender) ?? null,
      to: normalizeAddress(isTransfer ? request.to : request.programUuid) ?? null,
      method: isTransfer ? "transfer" : request.functionName ?? action,
      input: request.input ?? request.migrateInput ?? null,
      value: encodeNative(readNative(isTransfer ? request.amount : request.value)),
      result: result.result ?? null,
      error: result.error ?? null,
      gasUsed: result.gasUsed ?? 0,
      gasPrice: request.gasPrice === undefined || request.gasPrice === null ? null : encodeNative(readNative(request.gasPrice)),
      // EIP-1559: ราคาจริงที่จ่าย · base fee ของ block · ราคาที่ผู้ส่งเสนอ (แบบเดิม = gasPrice ทั้งสองช่อง) · แยกส่วนที่เผา / ผู้ปิด block ได้
      type: isFeeMarketRequest(request) ? 2 : 0,
      effectiveGasPrice: result.gasPrice ?? null,
      baseFeePerGas: result.baseFee ?? null,
      maxFeePerGas: result.maxFeePerGas ?? (isFeeMarketRequest(request) ? null : request.gasPrice ?? null ? encodeNative(readNative(request.gasPrice)) : null),
      maxPriorityFeePerGas: result.maxPriorityFeePerGas ?? (isFeeMarketRequest(request) ? null : request.gasPrice ?? null ? encodeNative(readNative(request.gasPrice)) : null),
      burnedFee: result.burnedFee ?? "0n",
      producerFee: result.producerFee ?? "0n",
      fee: result.fee ?? "0n",
      ...(request.sponsor ? { sponsor: normalizeAddress(request.sponsor) } : {}),   // ผู้จ่ายค่าแก๊สแทนผู้ส่ง (อยู่ใน hash ของ tx แล้ว)
      ...(request.evmRaw ? { evmHash: request.digest } : {}),   // มาจาก eth_sendRawTransaction: hash แบบ Ethereum = keccak(raw)
      nonce: pick(KEY.NONCE)[0]?.value ?? null,
      events: (result.events ?? []).map((event) => ({ ...event })),
      trace: (result.calls ?? []).map((call) => ({
        ...(call.type ? { type: call.type } : {}),   // "create" = โปรแกรมถูกสร้างด้วย cloneProgram
        depth: call.depth,
        program: call.programUuid,
        method: call.functionName,
        from: call.sender,
        origin: call.origin,
        input: call.input ?? null,
        value: call.value ?? "0n",
        result: call.result ?? null,
        gasUsed: call.gasUsed ?? null,
        status: call.status,
        error: call.error ?? null,
      })),
      nativeChanges: pick(KEY.NATIVE).map(({ address, field, value }) => (nativeBefore
        ? { address, field, before: nativeBefore.get(nativeKey(address, field)) ?? "0n", after: value }
        : { address, field, after: value })),
      stateChanges: pick(KEY.STORAGE).map(({ address, key, value }) => ({ program: address, key, after: value })),
      programChanges: changes
        .filter((change) => [KEY.PENDING, KEY.CODE, KEY.CONTEXT, KEY.THIS, KEY.PENDING_UPGRADE, KEY.SCHEDULED_UPGRADE].includes(change.kind))
        .map(({ kind, address, value }) => ({ kind, address, removed: value === undefined })),
    };
  }

  // ---------- metadata ----------

  /** ตรวจ metadata ที่ผู้ใช้ส่งมา (ค่า null = ลบฟิลด์นั้น) */
  checkMetadata(metadata, { allowReserved = false } = {}) {
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) fail(ERRORS.invalidMetadata);
    for (const [field, value] of Object.entries(metadata)) {
      if (!METADATA_FIELD_PATTERN.test(field)) fail(ERRORS.invalidMetadataField, field);
      if (!allowReserved && RESERVED_METADATA.includes(field)) fail(ERRORS.reservedMetadata, field);
      if (value !== null) toJsonValue(value, `metadata.${field}`);
      if (field === METADATA_FIELD.ABI && value !== null) checkAbi(value);   // ABI ต้องตรงตาม schema (ดู checkAbi)
    }
    return metadata;
  }

  /** เขียน metadata ของ address (namespace ห้ามซ้ำ และจะปล่อยชื่อเดิมให้คนอื่นใช้ต่อ) */
  writeMetadata(tx, address, metadata, { allowReserved = false } = {}) {
    this.checkMetadata(metadata, { allowReserved });

    for (const [field, value] of Object.entries(metadata)) {
      if (field === METADATA_FIELD.NAMESPACE) {
        this.updateNamespace(tx, address, value);
        continue;
      }
      if (value === null) tx.delete(metadataKey(address, field));
      else tx.put(metadataKey(address, field), toJsonValue(value, `metadata.${field}`));
    }
  }

  updateNamespace(tx, address, name) {
    const current = tx.current(metadataKey(address, METADATA_FIELD.NAMESPACE));
    if (current !== undefined) tx.delete(namespaceKey(current)); // ปล่อยชื่อเดิม

    if (name === null) {
      tx.delete(metadataKey(address, METADATA_FIELD.NAMESPACE));
      return;
    }
    if (!isNonEmptyString(name) || name.includes(KEY.SEPARATOR) || name.length > 64) fail(ERRORS.invalidNamespace);

    const normalized = name.toLowerCase();
    const owner = tx.current(namespaceKey(normalized));
    if (owner !== undefined && owner !== address) fail(ERRORS.namespaceTaken, normalized, owner);

    tx.put(metadataKey(address, METADATA_FIELD.NAMESPACE), normalized);
    tx.put(namespaceKey(normalized), address);
  }

  /**
   * init / reject: ถ้าส่ง context มา ถือเป็น tx ที่ทีมงานเซ็น (มี nonce / ค่าแก๊ส / hash ของตัวเอง)
   * ไม่ส่ง context = เรียกภายใน (ใช้ตอนทดสอบหรือสคริปต์ของ server เอง)
   */
  prepareAdminAction(tx, request, action, { context, nonce, gasLimit, gasPrice }) {
    if (context === undefined) {
      if (this.admins) fail(ERRORS.notAdmin, "(ไม่มีผู้เซ็น)");
      return;
    }
    checkContext(context);
    const sender = this.userContext(context).sender;
    if (this.admins && !this.admins.includes(sender)) fail(ERRORS.notAdmin, sender);

    this.preparePayer(tx, sender, { ...feeFields(request), nonce, gasLimit, gasPrice });
    this.rememberTransaction(tx, request, action);
    this.seedRandom(tx, request, action);
    tx.useGas(tx.gas.call);
  }

  /** tx ของ user: ตั้ง metadata ของ address ตัวเอง */
  setMetadata({ metadata = {}, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkContext(context);
      const userContext = this.userContext(context);
      const address = userContext.sender;

      this.preparePayer(tx, address, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice });
      this.rememberTransaction(tx, arguments[0], "metadata");
      this.seedRandom(tx, arguments[0], "metadata");
      tx.useGas(tx.gas.call);

      this.writeMetadata(tx, address, metadata);
      return { address, metadata: Object.keys(metadata) };
    }, options);
  }

  /** metadata ทั้งหมดของ address (ต้องมี db.listKeys) */
  getMetadata(address) {
    const account = normalizeAddress(address);
    const prefix = joinKey(account, KEY.METADATA, "");
    return Object.fromEntries(this.listEntries(prefix).map(({ dbKey, value }) => [decodeDbKey(dbKey).field, value]));
  }

  /** ค้น address จาก namespace */
  resolveNamespace(name) {
    return this.read(namespaceKey(String(name).toLowerCase())) ?? null;
  }

  // ---------- อ่านข้อมูลสำหรับ explorer (ต้องมี db.listKeys) ----------

  /** รายชื่อ key ตาม prefix — options: { start, limit, reverse } */
  listKeys(prefix = "", options) {
    if (typeof this.db.listKeys !== "function") fail(ERRORS.listNotSupported);
    return this.db.listKeys(prefix, options);
  }

  /** [{ dbKey, value }] ตาม prefix */
  listEntries(prefix = "", options) {
    return this.listKeys(prefix, options).map((dbKey) => ({ dbKey, value: this.read(dbKey) }));
  }

  /** ยอด native ของ address จาก DB: { received, sended, consumed, balance } */
  nativeBalanceOf(address) {
    const account = normalizeAddress(address);
    const [received, sended, consumed] = this.db.readKeys([
      nativeKey(account, NATIVE_FIELD.RECEIVED),
      nativeKey(account, NATIVE_FIELD.SENDED),
      nativeKey(account, NATIVE_FIELD.CONSUMED),
    ]).map(readNative);
    return { received, sended, consumed, balance: received - sended - consumed };   // BigInt
  }

  /** hash ของ genesis (ไม่รวม "forks" — ตาราง fork เพิ่มทีหลังได้โดย genesis hash เดิม) */
  hashGenesis(genesis = {}) {
    const { forks, ...rest } = genesis ?? {};
    return this.hashData(rest);
  }

  /** hash ของ genesis ที่บันทึกไว้ */
  genesisHash() {
    return this.read(KEY.GENESIS) ?? null;
  }

  /** ตั้งสถานะเริ่มต้นของ chain แล้วบันทึก hash ไว้ให้ node อื่นเทียบ */
  applyGenesis(genesis = {}) {
    const hash = this.hashGenesis(genesis);
    const current = this.genesisHash();
    if (current !== null) {
      if (current !== hash) fail(ERRORS.genesisMismatch, current, hash);
      return { hash, applied: false };
    }
    if (this.latestBlockNumber() !== null) fail(ERRORS.genesisMismatch, "(มี block แล้ว)", hash);

    const writes = Object.entries(genesis.balances ?? {}).map(([address, amount]) =>
      ({ type: WRITE.PUT, dbKey: nativeKey(normalizeAddress(address), NATIVE_FIELD.RECEIVED), value: encodeNative(checkValue(amount)) }));
    writes.push({ type: WRITE.PUT, dbKey: KEY.GENESIS, value: hash });
    this.commit(writes);
    return { hash, applied: true };
  }

  /** เทียบ genesis ที่ node นี้ใช้กับของที่ส่งมา */
  checkGenesis(genesis) {
    const hash = this.hashGenesis(genesis);
    const current = this.genesisHash();
    if (current !== null && current !== hash) fail(ERRORS.genesisMismatch, current, hash);
    return hash;
  }

  /** เลข block ล่าสุด */
  latestBlockNumber() {
    return this.read(LATEST_BLOCK_KEY) ?? null;
  }

  getBlock(number) {
    return this.read(blockKey(number)) ?? null;
  }

  /** tx ที่ส่งมาหา address นี้ (โปรแกรมถูกเรียก หรือได้รับเงิน) — ใหม่ไปเก่า */
  listTransactionsTo(address, { limit = 20, reverse = true, start } = {}) {
    const prefix = `${joinKey(KEY.TX_TO, normalizeAddress(address))}${KEY.SEPARATOR}`;
    const headers = new Map();
    return this.listKeys(prefix, { limit, reverse, start }).map((dbKey) => this.readTransactionTo(dbKey, headers));
  }

  /**
   * รายการ txto เต็ม: blockNumber + index มาจาก key · timestamp มาจาก header (ไม่เก็บซ้ำในค่า)
   * headers = Map ที่ใช้ซ้ำในหน้าเดียวกัน (หลายแถวมักอยู่ block เดียวกัน)
   */
  readTransactionTo(dbKey, headers = new Map()) {
    const value = this.read(dbKey);
    if (!value) return value;
    const { number, index } = decodeDbKey(dbKey);
    if (!headers.has(number)) headers.set(number, this.getBlock(number)?.timestamp ?? null);
    return { ...value, blockNumber: number, index, timestamp: value.timestamp ?? headers.get(number) };
  }

  /** ค้น event ที่โปรแกรมเคย emit — ใหม่ไปเก่า */
  listEvents({ program, name = "", limit = 20, reverse = true, start } = {}) {
    const prefix = program
      ? joinKey(KEY.EVENT, normalizeAddress(program), name ? `${name}${KEY.SEPARATOR}` : "")
      : `${KEY.EVENT}${KEY.SEPARATOR}`;
    return this.listEntries(prefix, { limit, reverse, start }).map((entry) => entry.value);
  }

  /**
   * event ที่ field ที่ indexed มีค่านี้ (ใช้ดัชนี eventidx: ไม่ไล่ event ทั้งหมด) — ใหม่ไปเก่า
   *   value = ค่าที่ต้องการ (string / BigInt / "123n" / bool) หรือ topic = topic 0x…64 hex ตรง ๆ
   *   string ที่เป็นตัวเลข / true / false อาจเป็นได้หลายชนิด → ค้นทุกแบบที่เป็นไปได้แล้วรวมกัน
   * → { items: [event], next } · next = cursor (dbKey ของ event ถัดไป) ส่งกลับมาเป็น cursor
   */
  listIndexedEvents({ program, name, field, value, topic, limit = 20, cursor, fromBlock = null, toBlock = null } = {}) {
    const address = normalizeAddress(program);
    const topics = topic !== undefined ? [String(topic).toLowerCase()] : indexedTopicCandidates(value);
    const refs = [];
    for (const candidate of topics) {
      refs.push(...this.indexedEventRefs({ program: address, name, field, topic: candidate, fromBlock, toBlock }));
    }
    const sorted = [...new Set(refs)].sort().reverse();
    const start = typeof cursor === "string" ? sorted.indexOf(cursor) : 0;
    const page = sorted.slice(Math.max(start, 0), Math.max(start, 0) + limit);
    return { items: page.map((dbKey) => this.read(dbKey)).filter(Boolean), next: sorted[Math.max(start, 0) + limit] ?? null, limit };
  }

  /** dbKey ของ event (event:…) ที่ field = topic ในช่วง block [fromBlock, toBlock] (เก่าไปใหม่) */
  indexedEventRefs({ program, name, field, topic, fromBlock = null, toBlock = null, max = 100_000 }) {
    const prefix = eventIndexPrefix(normalizeAddress(program), name, field, topic);
    const start = fromBlock === null ? undefined : `${prefix}${String(fromBlock).padStart(BLOCK_NUMBER_WIDTH, "0")}`;
    const refs = [];
    for (const dbKey of this.listKeys(prefix, { start, limit: max })) {
      if (toBlock !== null && decodeDbKey(dbKey).number > toBlock) break;
      refs.push(this.read(dbKey));
    }
    return refs.filter(Boolean);
  }

  /** event ที่มี topic0 นี้ (log แบบ EVM) → [{ program, name, indexed }] */
  listEventSignatures(topic0) {
    return this.listEntries(`${joinKey(KEY.EVENT_SIG, String(topic0).toLowerCase())}${KEY.SEPARATOR}`, { limit: 1000 }).map((entry) => entry.value);
  }

  /** tx ดิบของ block (สำหรับ replay / explorer) */
  getBlockBody(number) {
    return this.read(blockBodyKey(number)) ?? null;
  }

  getBlockByHash(hash) {
    const number = this.read(blockHashKey(hash));
    return number === undefined ? null : this.getBlock(number);
  }

  /** header ของหลาย block (ใหม่ไปเก่า) */
  listBlocks({ limit = 20, reverse = true, start } = {}) {
    return this.listEntries(`${KEY.BLOCK}${KEY.SEPARATOR}`, { limit, reverse, start }).map((entry) => entry.value);
  }

  /** ค้น tx จาก hash ของระบบ หรือจาก hash ที่ผู้ใช้เซ็น (EIP-712 digest) ก็ได้ */
  getTransaction(hash, { signature = false } = {}) {
    const entry = this.read(txIndexKey(hash)) ?? this.read(txIndexKey(this.read(sigTxKey(hash)) ?? ""));
    if (!entry) return null;
    const record = entry.from === null ? null : this.read(txnKey(entry.from, entry.nonce, entry.hash)) ?? null;
    // ลายเซ็นเก็บใน blockbody ที่เดียว (txn ไม่เก็บซ้ำ) → อ่านเพิ่มเมื่อขอเท่านั้น
    if (signature && record) return { ...entry, record: { ...record, signature: this.transactionSignature(entry), digest: entry.digest ?? null } };
    return { ...entry, record };
  }

  /** ลายเซ็นของ tx ใน block (จาก blockbody) · { blockNumber, index } ของดัชนี tx */
  transactionSignature({ blockNumber, index }) {
    return this.getBlockBody(blockNumber)?.[index]?.request?.signature ?? null;
  }

  /** โปรแกรม token ที่ address นี้เคยได้รับเหรียญ (จาก event Transfer) */
  listHoldings(address, { limit = 200 } = {}) {
    return this.listEntries(`${joinKey(KEY.HOLDING, normalizeAddress(address))}${KEY.SEPARATOR}`, { limit }).map((entry) => entry.value);
  }

  /** รายการ tx ของ address (ใหม่ไปเก่า) */
  listTransactionsOf(address, { limit = 20, reverse = true, start } = {}) {
    const prefix = joinKey(normalizeAddress(address), KEY.TXN, "");
    return this.listKeys(prefix, { limit, reverse, start }).map((dbKey) => this.readTransactionRecord(dbKey));
  }

  /** รายการ txn + digest จากดัชนี tx (txn ไม่เก็บซ้ำ) · ลายเซ็นอ่านทีละใบด้วย getTransaction(hash, { signature: true }) */
  readTransactionRecord(dbKey) {
    const record = this.read(dbKey);
    if (!record || "digest" in record) return record;   // ข้อมูลรุ่นเก่ายังมี digest ในตัว
    return { ...record, digest: this.read(txIndexKey(record.hash))?.digest ?? null };
  }

  /** storage ทั้งหมดของโปรแกรม → { key: [...], value } */
  listProgramStorage(programUuid, options) {
    const prefix = joinKey(normalizeAddress(programUuid), KEY.STORAGE, "");
    return this.listEntries(prefix, options).map(({ dbKey, value }) => ({ key: decodeDbKey(dbKey).key, value }));
  }

  // ---------- ย้อนดูข้อมูลเก่า (ต้องเปิด recordHistory) ----------

  /** รายชื่อ key ที่ block นั้นแตะ */
  getBlockUndo(number) {
    return this.read(blockUndoKey(number)) ?? null;
  }

  /** tx ที่ถูกปฏิเสธที่บันทึกใน block นี้ (ไม่มี = []) */
  getBlockRejected(number) {
    return this.read(blockRejectedKey(number)) ?? [];
  }

  /** tx ที่ถูกปฏิเสธจาก hash → { hash, blockNumber, index, sender, nonce, action, to, gasPrice, reason, code, stage, timestamp } | null */
  getRejectedTransaction(hash) {
    return this.read(rejectedTxKey(String(hash ?? "").toLowerCase())) ?? null;
  }

  /** tx ที่ถูกปฏิเสธของผู้ส่งคนนี้ (ใหม่ไปเก่า) · start = dbKey ต่อจากหน้าก่อน */
  listRejectedOf(address, { limit = 20, reverse = true, start } = {}) {
    const prefix = `${joinKey(REJECTED_KEY.FROM, normalizeAddress(address))}${KEY.SEPARATOR}`;
    return this.listEntries(prefix, { limit, reverse, start });
  }

  /**
   * ค่าของ key หนึ่ง ณ ตอนที่ block <number> ปิดพอดี
   * อ่านรายการแรกใน history ที่เลข block มากกว่า number (seek ครั้งเดียว ไม่ขึ้นกับความยาวของเชน)
   */
  stateAt(number, dbKey) {
    const prefix = historyPrefix(dbKey);
    const [key] = this.listKeys(prefix, { start: historyKey(dbKey, number + 1), limit: 1 });
    if (key !== undefined) {
      const decoded = decodeDbKey(key);
      if (decoded.dbKey === dbKey && Number.isInteger(decoded.number)) {
        const entry = this.read(key);
        return entry?.existed ? copyValue(entry.before) : undefined;
      }
    }
    return this.read(dbKey); // ไม่มีใครแก้ตั้งแต่ block นั้น → ค่าปัจจุบัน
  }

  /**
   * block แรกที่ย้อนดูได้ (history ครบตั้งแต่ block นี้ถึงล่าสุด) · ไม่มี block = null
   * เชนเก่าที่ยังไม่มี historyfrom → ไล่ blockundo ครั้งเดียว (ช้า) แล้ว block ถัดไปจะบันทึกค่าให้
   */
  historyFrom() {
    const saved = this.read(HISTORY_FROM_KEY);
    if (saved !== undefined) return saved;
    const latest = this.latestBlockNumber();
    if (latest === null) return null;
    let from = latest + 1;
    while (from > 1 && this.getBlockUndo(from - 1)) from -= 1;
    return from;
  }

  /** ย้อนดู state ณ ตอนปิด block number ได้ไหม (ต้องมี history ของทุก block หลังจากนั้น) */
  #checkHistoryAt(number) {
    const latest = this.latestBlockNumber() ?? 0;
    if (!Number.isSafeInteger(number) || number < 0 || number > latest) fail(ERRORS.blockMissing, number);
    if (number < latest && number + 1 < (this.historyFrom() ?? 1)) fail(ERRORS.historyMissing, number + 1);
  }

  /** ข้อมูลตาม prefix ณ block นั้น → { dbKey: value } (ทั้งหมด · ดู pageSnapshotAt สำหรับแบ่งหน้า) */
  snapshotAt(number, prefix = "") {
    return Object.fromEntries(this.pageSnapshotAt(number, prefix).items);
  }

  /**
   * ข้อมูลตาม prefix ณ block นั้น แบบแบ่งหน้า → { items: [[dbKey, value]], next } · next = after ของหน้าถัดไป (null = หมด)
   * key ที่ต้องดู = key ที่มีตอนนี้ ∪ key ที่มี history (ถูกแก้ / ลบหลัง block นั้น)
   * ไล่ history แบบกระโดดทีละ key (ไม่อ่าน history ทุกรายการ) → ต้นทุนตามจำนวน key ไม่ใช่ความยาวเชน
   * ข้อจำกัด: key ลูกที่ส่วนถัดไปเป็นตัวเลขขึ้นต้นด้วย 0 ยาวพอ ๆ กับเลข block 12 หลัก (เช่น map("a", "0000000001")) และถูกลบไปแล้ว อาจไม่ขึ้น
   */
  pageSnapshotAt(number, prefix = "", { limit = Infinity, after } = {}) {
    this.#checkHistoryAt(number);
    const latest = this.latestBlockNumber() ?? 0;
    const chunk = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 1000;

    // key ที่มีอยู่ตอนนี้ (เรียงอยู่แล้ว · start ของ listKeys รวมตัวมันเอง จึงข้าม after)
    function* current(vm) {
      let start = after;
      for (;;) {
        const keys = vm.listKeys(prefix, { start, limit: chunk + 1 });
        for (const key of keys.slice(0, chunk)) if (after === undefined || key > after) yield key;
        if (keys.length <= chunk) return;
        start = keys[chunk];
      }
    }
    // key ที่มี history: เจอ history:<key>:<n> แล้วกระโดดข้าม history ของ key นั้นทั้งหมด
    function* changed(vm) {
      const historyBase = `${KEY.HISTORY}${KEY.SEPARATOR}${prefix}`;
      let start = after === undefined ? historyBase : `${historyKey(after, latest)}\u0000`;
      for (;;) {
        const [key] = vm.listKeys(historyBase, { start, limit: 1 });
        if (key === undefined) return;
        const { dbKey } = decodeDbKey(key);
        if (after === undefined || dbKey > after) yield dbKey;
        start = `${historyKey(dbKey, latest)}\u0000`;
      }
    }

    const a = current(this);
    const b = changed(this);
    let x = a.next();
    let y = b.next();
    const items = [];
    let last;
    while (!x.done || !y.done) {
      let dbKey;
      if (y.done || (!x.done && x.value < y.value)) { dbKey = x.value; x = a.next(); }
      else if (x.done || y.value < x.value) { dbKey = y.value; y = b.next(); }
      else { dbKey = x.value; x = a.next(); y = b.next(); }
      if (dbKey === last) continue;
      last = dbKey;
      if (isIndexKey(dbKey)) continue;   // ดัชนีไม่มี history → ค่าที่อ่านได้คือปัจจุบัน ไม่ใช่ ณ block นั้น
      const value = this.stateAt(number, dbKey);
      if (value === undefined) continue;
      if (items.length === limit) return { items, next: items[items.length - 1][0] };
      items.push([dbKey, value]);
    }
    return { items, next: null };
  }

  /**
   * รัน block เก่าใหม่บนสถานะ ณ ตอนนั้น (ไม่แตะ DB จริง) → receipt เต็มพร้อม trace / stateChanges
   * อ่านเฉพาะ key ที่ block นั้นแตะ จึงเร็วเท่ากันไม่ว่าจะย้อนไกลแค่ไหน
   */
  replayBlock(number, { verify = true } = {}) {
    const header = this.getBlock(number);
    if (!header) fail(ERRORS.blockMissing, number);
    const body = this.getBlockBody(number);
    if (!body) fail(ERRORS.historyMissing, number);

    // ต้องมี history ของทุก block ตั้งแต่ block นี้ ไม่งั้นย้อน state กลับไปไม่ได้ (เช็คครั้งเดียวจาก historyfrom)
    if (number < (this.historyFrom() ?? 1)) fail(ERRORS.historyMissing, number);

    const overlay = new Map();
    const read = (dbKey) => {
      if (!overlay.has(dbKey)) overlay.set(dbKey, this.stateAt(number - 1, dbKey));
      return copyValue(overlay.get(dbKey));
    };

    const block = this.createBlock({
      read,
      number,
      parentHash: header.parentHash,
      parentStateRoot: header.parentStateRoot,
      stateRoot: header.stateRoot,   // trie ใน DB เป็นของล่าสุด → ใช้ root ที่บันทึกไว้ · ผลการรันตรวจด้วย writesRoot / receiptsRoot
      timestamp: header.timestamp,
      feeRecipient: header.feeRecipient,
      burnPercent: header.burnPercent,
      producer: header.producer ?? null,
      producerSignature: header.producerSignature ?? null,
      timeoutMs: this.replayTimeoutMs,
      checkChain: false,
      recordBlocks: false,
      recordHistory: false,
      maxTransactions: null,
      maxTransactionsPerSender: null,
      maxBlockGas: null,
    });
    for (const { method, request } of body) block[method](request);
    for (const entry of this.getBlockRejected(number)) block.recordRejected(entry);

    const receipt = block.receipt({ number });
    if (verify && receipt.hash !== header.hash) fail(ERRORS.replayMismatch, number);
    return receipt;
  }

  /**
   * กู้ระบบ: ย้อน state ไปก่อน block 1 แล้วรัน block 1..target ใหม่จาก blockbody
   * ใช้แทน rollback (ช้ากว่าแต่สร้างจากข้อมูลต้นทาง จึงถูกต้องเสมอ)
   */
  rebuildFrom(target, { verify = true, batch = 10_000 } = {}) {
    const latest = this.latestBlockNumber();
    if (latest === null) fail(ERRORS.blockMissing, target);
    if (!Number.isSafeInteger(target) || target < 0 || target > latest) fail(ERRORS.blockMissing, target);
    if ((this.historyFrom() ?? 1) > 1) fail(ERRORS.historyMissing, this.historyFrom() - 1);
    // ทุกขั้นทำทีละชุด (batch) ไม่ถือทั้งเชนไว้ในหน่วยความจำ · header / body ของ block ที่จะรันใหม่อ่านทีละ block ตอน replay

    // 1) คืนทุก key ที่เคยถูกแตะ กลับไปเป็นสถานะก่อน block 1 = ค่า before ของ history รายการแรกของ key นั้น
    //    (ไล่ history ทั้งหมดตามลำดับ · รายการแรกของ key คือรายการที่ seek จาก history:<key>: แล้วเจอเป็นตัวแรก)
    const historyBase = `${KEY.HISTORY}${KEY.SEPARATOR}`;
    let reverted = 0;
    for (let start = historyBase; ;) {
      const keys = this.listKeys(historyBase, { start, limit: batch + 1 });
      const writes = [];
      for (const key of keys.slice(0, batch)) {
        const { dbKey } = decodeDbKey(key);
        const [first] = this.listKeys(historyPrefix(dbKey), { limit: 1 });
        if (first !== key) continue;
        const entry = this.read(key);
        writes.push(entry?.existed ? { type: WRITE.PUT, dbKey, value: copyValue(entry.before) } : { type: WRITE.DEL, dbKey });
      }
      reverted += writes.length;
      this.commit(writes);
      if (keys.length <= batch) break;
      start = keys[batch];
    }

    // 2) ลบ history ทั้งหมด (replay สร้างใหม่ของ block 1..target) · ดัชนีทั้งหมด (replay สร้างใหม่)
    for (;;) {
      const keys = this.listKeys(historyBase, { limit: batch });
      if (!keys.length) break;
      this.commit(keys.map((dbKey) => ({ type: WRITE.DEL, dbKey })));
    }
    this.commit([{ type: WRITE.PUT, dbKey: HISTORY_FROM_KEY, value: 1 }]);
    this.#deleteIndexes(batch);

    // 3) รัน block 1..target ใหม่ทีละ block · บันทึกทับ header / body / undo เดิม (overwrite) ในการ commit เดียว
    for (let number = 1; number <= target; number += 1) {
      const header = this.getBlock(number);
      if (!header) fail(ERRORS.historyMissing, number);
      const block = this.createBlock({
        number,
        parentHash: header.parentHash,
        parentStateRoot: header.parentStateRoot,
        timestamp: header.timestamp,
        feeRecipient: header.feeRecipient,
        burnPercent: header.burnPercent,
        producer: header.producer ?? null,
        producerSignature: header.producerSignature ?? null,
        timeoutMs: this.replayTimeoutMs,
        checkChain: false,
        overwrite: true,
        maxTransactions: null,
        maxTransactionsPerSender: null,
        maxBlockGas: null,
      });
      for (const { method, request } of this.getBlockBody(number) ?? []) block[method](request);
      for (const entry of this.getBlockRejected(number)) block.recordRejected(entry);
      if (verify && block.header().hash !== header.hash) fail(ERRORS.replayMismatch, number);
      block.commit();
    }

    // 4) ลบ block ที่เกิน target ทีละชุด
    for (let from = target + 1; from <= latest; from += batch) {
      const writes = [];
      for (let number = from; number <= Math.min(latest, from + batch - 1); number += 1) {
        const header = this.getBlock(number);
        writes.push({ type: WRITE.DEL, dbKey: blockKey(number) });
        writes.push({ type: WRITE.DEL, dbKey: blockBodyKey(number) });
        writes.push({ type: WRITE.DEL, dbKey: blockUndoKey(number) });
        writes.push({ type: WRITE.DEL, dbKey: blockRejectedKey(number) });
        if (header) writes.push({ type: WRITE.DEL, dbKey: blockHashKey(header.hash) });
      }
      this.commit(writes);
    }
    this.commit([target === 0
      ? { type: WRITE.DEL, dbKey: LATEST_BLOCK_KEY }
      : { type: WRITE.PUT, dbKey: LATEST_BLOCK_KEY, value: target }]);

    return {
      from: latest,
      to: target,
      blocks: target,
      keys: reverted,
      stateRoot: target === 0 ? null : this.getBlock(target)?.stateRoot ?? null,
    };
  }

  /** ลบดัชนีทั้งหมด (มาจาก block เท่านั้น · genesis ไม่มีดัชนี) ทีละชุด ไม่ต้องถือทั้งหมดไว้ในหน่วยความจำ */
  #deleteIndexes(batch = 10_000) {
    for (const prefix of INDEX_PREFIXES) {
      for (;;) {
        const entries = prefix === INDEX_PREFIXES[0] ? this.listEntries(prefix, { limit: batch }) : this.listKeys(prefix, { limit: batch }).map((dbKey) => ({ dbKey }));
        if (!entries.length) break;
        const writes = [];
        for (const { dbKey, value } of entries) {
          writes.push({ type: WRITE.DEL, dbKey });
          // txn ขึ้นต้นด้วย address → หาจากดัชนี tx (from + nonce + hash ครบ)
          if (value?.from && value.nonce !== null && value.nonce !== undefined) writes.push({ type: WRITE.DEL, dbKey: txnKey(value.from, value.nonce, value.hash) });
        }
        this.commit(writes);
      }
    }
  }

  /**
   * เรียกฟังก์ชันของโปรแกรมแบบอ่านอย่างเดียว: ไม่กิน nonce ไม่เสียค่าแก๊ส ไม่เขียน DB
   * ใช้ทำ endpoint /query ให้แอปอ่านค่าจากโปรแกรมได้โดยไม่ต้องส่ง tx
   */
  query({ programUuid, functionName, input = {}, context, value = 0 } = {}, options = {}) {
    const caller = context ?? { sender: normalizeAddress(programUuid), origin: normalizeAddress(programUuid) };
    const result = this.runAction((tx) => {
      checkProgramUuid(programUuid);
      checkContext(caller);
      this.seedRandom(tx, { programUuid, functionName, input }, "call");
      return this.runFunction(tx, { programUuid, functionName, input, context: caller, value });
    }, { ...options, timestamp: options.timestamp ?? RealDate.now() });

    // ทิ้ง writes ทั้งหมด เหลือเฉพาะข้อมูลที่อ่านได้
    const { writes, ...rest } = result;
    return { ...rest, readOnly: true };
  }

  /** หลาย call แล้ว commit ทีเดียว */
  createBlock(options) {
    return new Block(this, options);
  }

  // ---------- Transaction / Response ----------

  /** options: { read, timestamp } */
  createTransaction({ read = (dbKey) => this.read(dbKey), timestamp, blockNumber = null, feeRecipient = this.feeRecipient, burnPercent = this.burnPercent, baseFee,
    timeoutMs = this.timeoutMs } = {}) {
    return new Transaction({
      read,
      timestamp,
      blockNumber,
      baseFee: baseFee ?? this.currentBaseFee(),   // รันนอก block = base fee ของ block ถัดไป
      timeoutMs,
      maxCallDepth: this.maxCallDepth,
      maxTxGas: this.maxTxGas,
      gas: this.gasAt(blockNumber),   // ตามกติกาของ block ที่ tx อยู่ (fork)
      chargeGas: this.chargeGas,
      feeRecipient: feeRecipient === null || feeRecipient === undefined ? null : normalizeAddress(feeRecipient),
      burnPercent: checkBurnPercent(burnPercent),
      memoryLimitBytes: this.memoryLimitBytes,
      maxStackBytes: this.maxStackBytes,
      wallClock: this.wallClock,
    });
  }

  /** รัน action(tx) แล้วแปลงเป็น response (คืน sandbox ของ tx ทุกกรณี) */
  runAction(action, options) {
    const tx = this.createTransaction(options);
    try {
      return this.#runAction(tx, action);
    } finally {
      tx.dispose();
    }
  }

  #runAction(tx, action) {
    try {
      const result = action(tx);
      const charge = this.chargeOnSuccess(tx); // โปรแกรมโอน native ออกจนจ่ายค่าแก๊สไม่ไหว → OUT_OF_GAS
      const record = this.transactionRecordWrites(tx, { status: STATUS.SUCCESS });
      const summary = tx.summary();
      return {
        status: STATUS.SUCCESS,
        accepted: true,
        timestamp: tx.timestamp,
        gasUsed: tx.gasUsed,
        gasPrice: encodeNative(tx.gasPrice),
        ...this.feeSummary(tx),
        fee: encodeNative(tx.feeCharged),
        result,
        events: tx.events,
        ...summary,
        writes: [...summary.writes, ...charge, ...record],
      };
    } catch (err) {
      const { code, message } = err instanceof VMError ? err : new VMError(INTERNAL, err.message);
      // TIMEOUT ขึ้นกับความเร็วเครื่อง → ไม่รับเข้า block และไม่เก็บค่าใด ๆ
      const accepted = code === TIMEOUT ? false : this.isAccepted(tx);
      const writes = !accepted ? [] : [
        ...this.chargeOnFailure(tx), // tx ที่ล้มก็ยังกิน nonce และค่าแก๊ส
        ...this.transactionRecordWrites(tx, { status: STATUS.THROW, error: { code, message } }),
      ];
      return {
        status: STATUS.THROW,
        // tx ที่ยังไม่ผ่านการตรวจเบื้องต้น (เช่น nonce ผิด) ถือว่าไม่ถูกรับเข้าระบบ จึงไม่เข้า block
        accepted,
        timestamp: tx.timestamp,
        gasUsed: tx.gasUsed,
        gasPrice: encodeNative(tx.gasPrice),
        ...this.feeSummary(tx),
        fee: encodeNative(tx.feeCharged),
        error: { code, message },
        debug: err?.detail ?? null,   // ข้อมูลดีบัก ไม่ถูกบันทึกลง DB และไม่เข้า hash
        calls: tx.calls,
        events: [],   // tx ที่ล้มทั้งใบ = ไม่มี event
        writes,
      };
    }
  }

  /** ค่าแก๊สแยกส่วน (อยู่ในผลของทุก tx): baseFee ของ block · ส่วนที่เผา · ส่วนที่ผู้ปิด block ได้ · type 2 = ส่ง maxFee / priority มา */
  feeSummary(tx) {
    return {
      baseFee: encodeNative(tx.baseFee),
      burnedFee: encodeNative(tx.feeBurned),
      producerFee: encodeNative(tx.feeReward),
      ...(tx.fees?.type === 2 ? { feeType: 2, maxFeePerGas: encodeNative(tx.fees.maxFee), maxPriorityFeePerGas: encodeNative(tx.fees.maxPriority) } : {}),
      ...(tx.payer?.sponsor ? { sponsor: tx.payer.sponsor } : {}),   // ผู้จ่ายค่าแก๊สของใบนี้
    };
  }

  /** tx ถูกรับเข้าระบบแล้วหรือยัง (ผ่าน nonce และมีผู้จ่ายแล้ว) */
  isAccepted(tx) {
    if (tx.payer) return true;
    return !this.requireNonce && !this.chargeGas && !this.recordTransactions;
  }

  /**
   * ตรวจเบื้องต้นก่อนรับ tx เข้าคิว (อ่าน DB แค่ nonce — ไม่รันโปรแกรม)
   * ใช้กรอง tx ซ้ำทิ้งตั้งแต่ก่อนเข้า block
   */
  checkTransaction({ nonce, from, context } = {}, { read = (dbKey) => this.read(dbKey) } = {}) {
    const address = normalizeAddress(from ?? context?.sender);
    if (!isNonEmptyString(address)) return { ok: false, reason: "ไม่มี sender" };
    if (!this.requireNonce) return { ok: true, expectedNonce: null };

    const expectedNonce = read(nonceKey(address)) ?? 0;
    if (nonce !== expectedNonce) return { ok: false, reason: `nonce ต้องเป็น ${expectedNonce}`, expectedNonce };
    return { ok: true, expectedNonce };
  }

  // ---------- nonce / ค่าแก๊ส ----------

  /** ตั้งผู้จ่ายของ tx ชั้นนอกสุด: ตรวจ nonce แล้วกำหนดเพดานแก๊สจากยอด native */
  preparePayer(tx, address, { nonce, gasLimit, gasPrice, maxFeePerGas, maxPriorityFeePerGas, sponsor, value = 0 } = {}) {
    const requestedLimit = Math.min(checkGasLimit(gasLimit), tx.maxTxGas);
    // ราคาจริง = min(maxFee, baseFee + priority) · maxFee ต่ำกว่า baseFee ของ block → ไม่รับ (ไม่กิน nonce)
    tx.fees = resolveFees({ gasPrice, maxFeePerGas, maxPriorityFeePerGas }, tx.baseFee);
    tx.gasPrice = tx.fees.price;
    if (!this.requireNonce && !this.chargeGas && !this.recordTransactions) {
      tx.gasLimit = requestedLimit;
      return;
    }

    const current = tx.current(nonceKey(address)) ?? 0;
    if (this.requireNonce && nonce !== current) fail(ERRORS.invalidNonce, current, nonce);
    // sponsor: จ่ายแก๊สแทนผู้ส่ง (ผู้ส่งยังใช้ nonce ของตัวเองและจ่าย value เอง) · ตรวจลายเซ็นของ sponsor แล้วตอนรับ tx (verifyTransaction)
    tx.payer = sponsor && sponsor !== address ? { address, nonce: current, sponsor } : { address, nonce: current };

    if (tx.chargeGas) {
      if (tx.payer.sponsor && this.nativeBalance(tx, address) < readNative(value)) fail(ERRORS.nativeInsufficient, address);
      // เงินที่จ่ายแก๊สได้ = ยอดของผู้จ่าย (หัก value ที่แนบไปกับ tx เมื่อผู้จ่ายคือผู้ส่งเอง)
      const available = tx.payer.sponsor ? this.nativeBalance(tx, tx.payer.sponsor) : this.nativeBalance(tx, address) - readNative(value);
      if (available < 0n) fail(ERRORS.nativeInsufficient, address);
      tx.gasLimit = tx.gasPrice > 0n ? Math.min(gasUnits(available / tx.gasPrice), requestedLimit) : requestedLimit;
    } else {
      tx.gasLimit = requestedLimit;
    }
  }

  /** จำ request ไว้เพื่อเขียนรายการ tx (เรียกหลัง preparePayer) */
  rememberTransaction(tx, request, action) {
    if (!this.recordTransactions || !tx.payer) return;
    tx.transaction = {
      hash: this.hashTransaction(request, { action }),
      action,
    };
  }

  /** write ของรายการ tx: <address>:txn:<nonce>:<txhash> */
  transactionRecordWrites(tx, { status, error = null }) {
    if (!tx.transaction) return [];
    const { address, nonce } = tx.payer;
    const { hash, action } = tx.transaction;
    return [{
      type: WRITE.PUT,
      dbKey: txnKey(address, nonce, hash),
      value: { hash, action, nonce, status, error, timestamp: tx.timestamp, gasUsed: tx.gasUsed, fee: encodeNative(tx.feeCharged) },
    }];
  }

  /** writes ของ nonce + ค่าแก๊ส (ส่วน base fee เผาตาม burnPercent · tip เข้าผู้ปิด block) */
  buildChargeWrites(tx, balance, raw) {
    const { address, nonce } = tx.payer;
    const feePayer = tx.payer.sponsor ?? address;
    const due = tx.gasFee();
    const fee = due < balance ? due : balance > 0n ? balance : 0n;
    tx.feeCharged = fee;
    const writes = [];
    if (this.requireNonce) writes.push({ type: WRITE.PUT, dbKey: nonceKey(address), value: nonce + 1 });
    if (fee <= 0n) return writes;

    // ค่าแก๊สเข้าช่อง consumed ของผู้จ่าย ส่วนที่ไม่ได้เผาทิ้งเข้าช่อง received ของผู้ปิด block
    writes.push({
      type: WRITE.PUT,
      dbKey: nativeKey(feePayer, NATIVE_FIELD.CONSUMED),
      value: encodeNative(this.nativeField(tx, feePayer, NATIVE_FIELD.CONSUMED, raw) + fee),
    });

    // EIP-1559: ส่วน base fee (แก๊ส × baseFee) เผา burnPercent % · tip (ส่วนที่เกิน baseFee) เข้าผู้ปิด block ทั้งหมด
    const baseDue = BigInt(Math.min(tx.gasUsed, tx.gasLimit)) * tx.baseFee;
    const basePart = baseDue < fee ? baseDue : fee;
    const reward = tx.feeRecipient ? fee - basePart + (basePart * BigInt(100 - tx.burnPercent)) / 100n : 0n;
    tx.feeReward = reward;
    tx.feeBurned = fee - reward;
    if (reward > 0n) {
      writes.push({
        type: WRITE.PUT,
        dbKey: nativeKey(tx.feeRecipient, NATIVE_FIELD.RECEIVED),
        value: encodeNative(this.nativeField(tx, tx.feeRecipient, NATIVE_FIELD.RECEIVED, raw) + reward),
      });
    }

    const burned = fee - reward; // ส่วนที่เผา → ส่งไปที่ 0x000…000
    if (burned > 0n) {
      writes.push({
        type: WRITE.PUT,
        dbKey: nativeKey(BURN_ADDRESS, NATIVE_FIELD.RECEIVED),
        value: encodeNative(this.nativeField(tx, BURN_ADDRESS, NATIVE_FIELD.RECEIVED, raw) + burned),
      });
    }
    return writes;
  }

  chargeOnSuccess(tx) {
    if (!tx.payer) return [];
    const balance = this.nativeBalance(tx, tx.payer.sponsor ?? tx.payer.address);
    if (tx.gasFee() > balance) fail(ERRORS.outOfGas, tx.gasUsed, tx.gasPrice > 0n ? gasUnits(balance / tx.gasPrice) : tx.gasLimit);
    return this.buildChargeWrites(tx, balance, false);
  }

  chargeOnFailure(tx) {
    if (!tx.payer) return [];
    try {
      // ค่าใน DB (writes ของ tx ถูกทิ้งไปแล้ว)
      return this.buildChargeWrites(tx, this.nativeBalance(tx, tx.payer.sponsor ?? tx.payer.address, true), true);
    } catch {
      return []; // DB อ่านไม่ได้ → เก็บค่าแก๊สไม่ได้
    }
  }

  // ---------- รันฟังก์ชันของโปรแกรม ----------

  /** โหลดโปรแกรมจากโค้ดที่ส่งมา หรือจาก DB */
  loadProgram(tx, programUuid, code = tx.current(codeKey(programUuid))) {
    if (typeof code !== "string") fail(ERRORS.programNotFound, programUuid);
    return this.compiler.compile(code);
  }

  /**
   * @param {Transaction} tx
   * @param {object} request  { programUuid, functionName, input, context, depth, code, isInit }
   *   code   โค้ดบรรทัดเดียว (ใช้ตอน init เพราะยังไม่อยู่ใน DB)
   *   isInit อนุญาตให้เรียก initialization
   */
  runFunction(tx, { programUuid: rawProgramUuid, functionName, input = {}, context: rawContext, value = 0, depth = 0, code, isInit = false, callType, readonly = false }) {
    const programUuid = normalizeAddress(rawProgramUuid);
    const context = normalizeContext(rawContext);
    if (depth > tx.maxCallDepth) fail(ERRORS.callDepthExceeded, tx.maxCallDepth);

    const program = this.loadProgram(tx, programUuid, code);
    if (!isInit && !program.exports.includes(functionName)) fail(ERRORS.notCallable, functionName);

    const gasStart = tx.gasUsed;
    tx.useGas(tx.gas.call);
    const record = tx.startCall({ depth, programUuid, functionName, context, input, value, gasStart, type: callType });

    try {
      const api = this.createProgramApi(tx, { programUuid, context, depth, readonly });
      const params = {
        input: toProgram(toInputValue(input, "input") ?? {}, "input"),
        context: pickContext(context),
        value: readNative(value),   // native ที่แนบมากับการเรียกนี้
        block: { timestamp: BigInt(tx.timestamp) },
      };
      const result = this.invokeProgram(tx, program, api, functionName, params, depth, programUuid);
      tx.assertAlive(); // DB พังแต่โปรแกรม catch ไว้ → ยัง throw
      record.result = result;
      Transaction.finishCall(record, undefined, tx.gasUsed);
      return result;
    } catch (err) {
      const error = VMError.fromProgram(err);
      // timeout จริงออกมาที่ชั้นนอกสุดเท่านั้น (catch ของชั้นในไม่ได้ทำงาน) → ปิดทุก call ที่ค้างที่นี่
      if (depth === 0 && error.code === TIMEOUT) tx.closeRunningCalls(error);
      else Transaction.finishCall(record, error, tx.gasUsed);
      throw error;
    }
  }

  /** รันใน sandbox ของ tx (เวลา / หน่วยความจำ / stack นับรวมทั้งสายการเรียก) */
  invokeProgram(tx, program, api, functionName, params, depth, programUuid) {
    if (depth === 0) tx.remainingTime();   // หมดเวลาไปก่อนเริ่มแล้ว → TIMEOUT
    const outcome = tx.sandbox().invoke({ programUuid, source: program.source, functionName, params, api, blockNumber: tx.blockNumber });
    if (outcome.kind === "fatal") throw tx.fatal;
    if (outcome.kind === "async") fail(ERRORS.asyncNotSupported);
    if (outcome.kind === "throw") {
      if (outcome.hostError !== undefined) throw outcome.hostError;   // error ของ host ตัวเดิมที่โปรแกรมไม่ได้ catch
      if (outcome.fakeTimeout) fail(ERRORS.timeout);
      if (outcome.guestError) throw VMError.fromGuest(outcome.guestError);
      throw new VMError(PROGRAM_ERROR, outcome.text);
    }
    // ค่าที่ออกจากโปรแกรม: BigInt ถูกแปลงเป็น "123n" เพื่อให้ส่งเป็น JSON ได้
    return this.checkValueSize(fromProgram(outcome.value, "ค่าที่ return"), "ค่าที่ return");
  }

  // ---------- API ที่โปรแกรมเรียกใช้ ----------

  /**
   * API ฝั่ง host ที่โปรแกรมเรียกผ่าน sandbox (ค่าที่ได้รับเป็นสำเนาจากโปรแกรมเสมอ)
   * __gas / __str / __props / __spread / map / Date / Math / ThisAddress / BlockNumber อยู่ใน sandbox เอง (ดู sandbox.js)
   * ทุกฟังก์ชันหยุดทันทีถ้า DB พังไปแล้วใน request นี้
   * caller.readonly (เรียกด้วย runProgram แบบ { readonly: true } ชั้นใดชั้นหนึ่งด้านบน) → API ที่แก้ state throw (catch ได้)
   */
  createProgramApi(tx, caller) {
    const { programUuid } = caller;
    const guard = (fn) => (...args) => {
      tx.assertAlive();
      return fn(...args);
    };
    const mutating = (name, fn) => guard((...args) => {
      if (caller.readonly) fail(ERRORS.readonlyCall, name);
      return fn(...args);
    });
    const text = (value, label) => (typeof value === "string" ? value : fromProgram(value, label));
    return {
      ThisBalance: guard(() => this.programNativeBalance(tx, programUuid)),
      BalanceOf: guard((address) => this.programNativeBalance(tx, address)),
      IsProgram: guard((address) => this.programIsProgram(tx, address)),
      MetadataOf: guard((address, field) => toProgram(this.programMetadataOf(tx, address, field) ?? null, "metadata")),
      readDB: guard((key) => this.programReadDB(tx, programUuid, key)),
      writeDB: mutating("writeDB", (key, value) => this.programWriteDB(tx, programUuid, key, value)),
      deleteDB: mutating("deleteDB", (key) => this.programDeleteDB(tx, programUuid, key)),
      transferNative: mutating("transferNative", (to, amount) => this.programTransferNative(tx, programUuid, to, fromProgramAmount(amount))),
      setMetadata: mutating("setMetadata", (field, value) => this.programSetMetadata(tx, programUuid, field, value === null ? null : fromProgram(value, "metadata"))),
      emit: mutating("emit", (name, data, options) => this.programEmit(tx, programUuid, caller.depth, name, fromProgram(data ?? {}, "event"), options)),
      keccak256: guard((value) => this.programKeccak(tx, typeof value === "string" ? value : fromProgram(value, "ค่าที่ keccak256"))),
      ecrecover: guard((value, signature) => this.programEcrecover(tx, typeof value === "string" ? value : fromProgram(value, "ค่าที่ ecrecover"), signature)),
      runProgram: guard((target, functionName, input, options) => toProgram(
        this.programRunProgram(tx, caller, target, functionName,
          fromProgram(input ?? {}, "input"), fromProgramOptions(options)) ?? null,
        "ผลลัพธ์")),
      cloneProgram: mutating("cloneProgram", (template, initInput, options) => this.programCloneProgram(tx, caller, template,
        fromProgram(initInput ?? {}, "initInput"), options)),
      // ---- precompile (ข้อมูลเข้าแบบเดียวกับ keccak256: string หรือข้อมูล JSON) ----
      sha256: guard((value) => this.programDigest(tx, "sha256", text(value, "ค่าที่ sha256"))),
      ripemd160: guard((value) => this.programDigest(tx, "ripemd160", text(value, "ค่าที่ ripemd160"))),
      blake2b: guard((value) => this.programDigest(tx, "blake2b", text(value, "ค่าที่ blake2b"))),
      modexp: guard((base, exponent, modulus) => this.programModexp(tx, base, exponent, modulus)),
      // ---- ข้อมูลของ block / tx / โค้ด ----
      BlockHash: guard((number) => this.programBlockHash(tx, number)),
      ChainId: guard(() => this.programEnv(tx, BigInt(this.chainId))),
      Coinbase: guard(() => this.programEnv(tx, tx.feeRecipient ?? null)),
      BlockGasLimit: guard(() => this.programEnv(tx, this.maxBlockGas === null || this.maxBlockGas === undefined ? null : BigInt(this.maxBlockGas))),
      GasPrice: guard(() => this.programEnv(tx, tx.gasPrice)),   // ราคาจริงของ tx นี้ = min(maxFee, baseFee + priority)
      BaseFee: guard(() => this.programEnv(tx, tx.baseFee)),     // base fee ของ block (EIP-1559 · BASEFEE)
      GasLeft: guard(() => {
        tx.useGas(tx.gas.env);   // หักค่าของตัวเองก่อน แล้วค่อยนับที่เหลือ
        const left = tx.gasLimit - tx.gasUsed;
        return Number.isFinite(left) ? BigInt(left) : null;
      }),
      CodeHashOf: guard((address) => this.programCodeOf(tx, address, true)),
      CodeSizeOf: guard((address) => this.programCodeOf(tx, address, false)),
      // ---- byte ดิบ / EIP-712 (ลายเซ็นแบบ eth_signTypedData_v4 ของ MetaMask) ----
      keccak256Bytes: guard((hex) => this.programKeccakBytes(tx, hex)),
      ecrecoverDigest: guard((digest, signature) => this.programEcrecoverDigest(tx, digest, signature)),
      eip712Digest: guard((domain, types, primaryType, message) => this.programEip712(tx, (meter) => eip712Digest(
        toProgramValue(domain, "domain"), toProgramValue(types, "types"), primaryType, toProgramValue(message, "message"), meter))),
      eip712DomainSeparator: guard((domain, types) => this.programEip712(tx, (meter) => eip712DomainSeparator(
        toProgramValue(domain, "domain"), types === undefined || types === null ? undefined : toProgramValue(types, "types"), meter))),
    };
  }

  /** key ต้องไม่ยาวเกินกำหนด (LMDB จำกัด ~1978 ไบต์ และ history: ซ้อนทับอีกชั้น) */
  checkKeySize(dbKey) {
    const size = Buffer.byteLength(dbKey, "utf8");
    if (size > this.maxKeySize) fail(ERRORS.keyTooLong, this.maxKeySize, size);
    return dbKey;
  }

  programReadDB(tx, programUuid, key) {
    const dbKey = this.checkKeySize(tx.touch(programUuid, key));
    tx.loaded.add(dbKey);
    const value = tx.current(dbKey);
    tx.useGas(tx.gas.read + tx.gas.byte * valueSize(value));
    return value === undefined ? undefined : toProgram(value, "ค่าที่อ่านจาก DB");
  }

  programWriteDB(tx, programUuid, key, value) {
    if (value === undefined) fail(ERRORS.writeUndefined);
    const stored = this.checkValueSize(fromProgram(value, "ค่าที่ writeDB"), "writeDB");
    tx.useGas(tx.gas.write + tx.gas.byte * valueSize(stored));
    const dbKey = this.checkKeySize(tx.touch(programUuid, key));
    tx.useStateKeyGas(dbKey);
    tx.put(dbKey, stored);
  }

  programDeleteDB(tx, programUuid, key) {
    tx.useGas(tx.gas.write);
    const dbKey = this.checkKeySize(tx.touch(programUuid, key));
    tx.useStateKeyGas(dbKey);
    tx.delete(dbKey);
  }

  /** ยอดสะสมแต่ละช่อง */
  nativeField(tx, address, field, raw = false) {
    const dbKey = nativeKey(address, field);
    return readNative(raw ? tx.readRaw(dbKey) : tx.current(dbKey));
  }

  /** ยอดคงเหลือ = received - sended - consumed */
  nativeBalance(tx, address, raw = false) {
    const { RECEIVED, SENDED, CONSUMED } = NATIVE_FIELD;
    return this.nativeField(tx, address, RECEIVED, raw)
      - this.nativeField(tx, address, SENDED, raw)
      - this.nativeField(tx, address, CONSUMED, raw);
  }

  /** เพิ่มยอดสะสม (ค่าเหล่านี้ลดลงไม่ได้) */
  addNative(tx, address, field, amount) {
    tx.put(nativeKey(address, field), encodeNative(this.nativeField(tx, address, field) + amount));
  }

  /** โอน native ระหว่าง address (ใช้ทั้ง transferNative และ value ที่แนบมากับ call) */
  moveNative(tx, from, to, amount) {
    tx.useGas(2 * (tx.gas.read + tx.gas.write));
    if (this.nativeBalance(tx, from) < amount) fail(ERRORS.nativeInsufficient, from);

    this.addNative(tx, from, NATIVE_FIELD.SENDED, amount);
    this.addNative(tx, to, NATIVE_FIELD.RECEIVED, amount);
  }

  /** ค่าที่ออกจากโปรแกรมต้องไม่ใหญ่เกินกำหนด (กันการสร้างข้อมูลมหาศาลใส่ DB) */
  checkValueSize(value, label) {
    const size = valueSize(value);
    if (size > this.maxValueSize) fail(ERRORS.valueTooLarge, this.maxValueSize, size);
    return value;
  }

  /** ยอด native คงเหลือของ address (อ่าน 3 ช่อง) */
  programNativeBalance(tx, address) {
    if (!isNonEmptyString(address)) fail(ERRORS.invalidAddress);
    tx.useGas(3 * tx.gas.read);
    return this.nativeBalance(tx, normalizeAddress(address));
  }

  /** address นี้เป็นโปรแกรมหรือ wallet (ใช้กันการโอนเข้าโปรแกรมที่รับเงินไม่เป็น) */
  programIsProgram(tx, address) {
    if (!isNonEmptyString(address)) fail(ERRORS.invalidAddress);
    tx.useGas(tx.gas.read);
    return tx.current(thisKey(normalizeAddress(address))) !== undefined;
  }

  /** อ่าน metadata ของ address ใดก็ได้ เช่น namespace / creator */
  programMetadataOf(tx, address, field) {
    if (!isNonEmptyString(address)) fail(ERRORS.invalidAddress);
    if (!isNonEmptyString(field)) fail(ERRORS.invalidMetadataField, field);
    const value = tx.current(metadataKey(normalizeAddress(address), field));
    tx.useGas(tx.gas.read + tx.gas.byte * valueSize(value));
    return value ?? null;
  }

  /** keccak256 ของ string หรือข้อมูล JSON (object ถูกแปลงแบบ canonical ก่อน) */
  programKeccak(tx, value) {
    const text = typeof value === "string" ? value : canonicalJson(toJsonValue(value, "ค่าที่ keccak256"));
    tx.useGas(tx.gas.hash + tx.gas.byte * Buffer.byteLength(text, "utf8"));
    return keccak256Hex(text);
  }

  /** sha256 / ripemd160 / blake2b (BLAKE2b-512) ของ string หรือข้อมูล JSON → hex 0x… · แก๊ส = ค่าของ hash นั้น + byte ของข้อมูล */
  programDigest(tx, name, value) {
    const text = typeof value === "string" ? value : canonicalJson(toJsonValue(value, `ค่าที่ ${name}`));
    const bytes = utf8ToBytes(text);
    tx.useGas(tx.gas[name] + tx.gas.byte * bytes.length);
    return `0x${bytesToHex(DIGESTS[name](bytes))}`;
  }

  /**
   * (base ** exponent) % modulus แบบ BigInt (precompile MODEXP) · modulus = 0n → 0n
   * แก๊ส = modexp + ⌊word² × max(bit ของ exponent, 1) / 3⌋ — คิดก่อนคำนวณ จึงหยุดได้ก่อนเครื่องทำงานหนัก
   */
  programModexp(tx, base, exponent, modulus) {
    for (const [label, value] of [["base", base], ["exponent", exponent], ["modulus", modulus]]) {
      if (typeof value === "number") fail(ERRORS.numberNotAllowed, `modexp ${label}`);
      if (typeof value !== "bigint" || value < 0n || bitLength(value) > MODEXP_MAX_BYTES * 8) fail(ERRORS.invalidModexp, MODEXP_MAX_BYTES);
    }
    const words = Math.ceil(Math.max(bitLength(base), bitLength(modulus)) / 64);
    tx.useGas(tx.gas.modexp + Math.floor((words * words * Math.max(bitLength(exponent), 1)) / 3));
    if (modulus === 0n) return 0n;
    let result = 1n % modulus;
    let square = base % modulus;
    for (let e = exponent; e > 0n; e >>= 1n) {
      if (e & 1n) result = (result * square) % modulus;
      square = (square * square) % modulus;
    }
    return result;
  }

  /**
   * hash ของ block ก่อนหน้า (เหมือน BLOCKHASH): ย้อนได้ BLOCK_HASH_WINDOW block · block ปัจจุบัน / อนาคต / เก่ากว่านั้น → null
   * รันนอก block (query) → นับ block ถัดจากล่าสุดเป็น block ปัจจุบัน
   */
  programBlockHash(tx, number) {
    if (typeof number === "number") fail(ERRORS.numberNotAllowed, "BlockHash");
    if (typeof number !== "bigint" || number < 0n) fail(ERRORS.invalidBlockNumber);
    tx.useGas(tx.gas.read);
    const current = BigInt(tx.blockNumber ?? (tx.current(LATEST_BLOCK_KEY) ?? 0) + 1);
    if (number >= current || number < current - BigInt(BLOCK_HASH_WINDOW)) return null;
    return tx.current(blockKey(Number(number)))?.hash ?? null;
  }

  /** ค่าของ chain / block / tx ที่รู้อยู่แล้ว (ไม่อ่าน DB) */
  programEnv(tx, value) {
    tx.useGas(tx.gas.env);
    return value;
  }

  /**
   * โค้ดที่ address นั้นใช้อยู่ (โปรแกรมที่ init แล้ว · อัปเกรดแล้ว = โค้ดใหม่)
   *   hash = true  → keccak256 ของโค้ด (ค่าเดียวกับ codeHash ที่ cloneProgram ใช้คำนวณ address) · ไม่ใช่โปรแกรม → null
   *   hash = false → ความยาวโค้ดเป็น byte (BigInt) · ไม่ใช่โปรแกรม → 0n
   */
  programCodeOf(tx, address, hash) {
    if (!isNonEmptyString(address)) fail(ERRORS.invalidAddress);
    tx.useGas(tx.gas.read);
    const code = tx.current(codeKey(normalizeAddress(address)));
    if (typeof code !== "string") return hash ? null : 0n;
    const size = Buffer.byteLength(code, "utf8");
    if (!hash) return BigInt(size);
    tx.useGas(tx.gas.hash + tx.gas.byte * size);
    return keccak256Hex(code);
  }

  /** กู้ address ของผู้เซ็นจากข้อความ + ลายเซ็น (r + s + v เหมือน EIP-191/712) · digest = keccak256(UTF-8 ของข้อความ / canonical JSON) */
  programEcrecover(tx, value, signature) {
    if (!isNonEmptyString(signature) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) fail(ERRORS.invalidSignature);
    const text = typeof value === "string" ? value : canonicalJson(toJsonValue(value, "ค่าที่ ecrecover"));
    tx.useGas(tx.gas.recover + tx.gas.byte * Buffer.byteLength(text, "utf8"));
    return recoverAddress(hexToBytesStrict(keccak256Hex(text)), signature);
  }

  /**
   * ecrecover แบบ EVM: กู้ address จาก digest 32 byte ตรง ๆ (ไม่ hash ซ้ำ) — ใช้กับ eip712Digest / keccak256Bytes
   * ลายเซ็นใช้ไม่ได้ (v ไม่ใช่ 27/28, จุดไม่อยู่บนเส้นโค้ง) → null · รูปแบบผิด → throw (catch ได้) · แก๊ส = recover
   */
  programEcrecoverDigest(tx, digest, signature) {
    if (typeof digest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(digest)) fail(ERRORS.invalidDigest);
    if (!isNonEmptyString(signature) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) fail(ERRORS.invalidSignature);
    tx.useGas(tx.gas.recover);
    return recoverAddress(hexToBytesStrict(digest), signature);
  }

  /** keccak256 ของ byte ดิบ ("0x…" hex) → "0x…" 32 byte · แก๊ส = hash + byte × จำนวน byte (เท่า keccak256 ของข้อความยาวเท่ากัน) */
  programKeccakBytes(tx, hex) {
    let bytes;
    try {
      bytes = hexBytes(hex);
    } catch {
      fail(ERRORS.invalidBytes, "keccak256Bytes");
    }
    tx.useGas(tx.gas.hash + tx.gas.byte * bytes.length);
    return `0x${bytesToHex(keccak_256(bytes))}`;
  }

  /**
   * eip712Digest / eip712DomainSeparator — คำนวณก่อน (งานเป็นเส้นตรงกับขนาดข้อมูลที่โปรแกรมจ่ายแก๊สสร้างมาแล้ว) แล้วคิดแก๊ส
   * แก๊ส = hash × จำนวนครั้งที่ keccak + byte × byte ทั้งหมดที่ถูก hash (typeHash / string / bytes / array / struct / digest)
   * ข้อมูลผิดรูปแบบ → INVALID_REQUEST (catch ได้) คิดแก๊สเท่าที่ทำไปแล้ว
   */
  programEip712(tx, compute) {
    const meter = { hashes: 0, bytes: 0 };
    try {
      return compute(meter);
    } catch (error) {
      if (error instanceof VMError) throw error;
      return fail(ERRORS.invalidTypedData, error.message);
    } finally {
      tx.useGas(tx.gas.hash * Math.max(meter.hashes, 1) + tx.gas.byte * meter.bytes);
    }
  }

  /**
   * บันทึก event ให้ explorer อ่าน (ถูกย้อนพร้อม writes ถ้ากิ่งนั้นล้ม)
   *   emit(name, data, { indexed: ["from", "to"] }) → ค้นด้วยค่าของ field เหล่านั้นได้ (GET /program/:a/events?name=&to= · eth_getLogs ตาม topic)
   */
  programEmit(tx, programUuid, depth, name, data = {}, options) {
    if (!isNonEmptyString(name) || !METADATA_FIELD_PATTERN.test(name)) fail(ERRORS.invalidEventName);
    const value = this.checkValueSize(toInputValue(data, `event '${name}'`) ?? {}, "event");
    const indexed = checkIndexed(options, value);
    // indexed: ต่อ field เขียนดัชนีถาวร 1 key (eventidx:) → คิดเพิ่ม topic ต่อ field
    tx.useGas(tx.gas.event + tx.gas.byte * valueSize(value) + tx.gas.topic * indexed.length);
    tx.events.push({ index: tx.events.length, depth, program: programUuid, name, data: value, ...(indexed.length ? { indexed } : {}) });
    return true;
  }

  /** โปรแกรมตั้ง metadata ของตัวเอง (ฟิลด์ของระบบแก้ไม่ได้) */
  programSetMetadata(tx, programUuid, field, value) {
    tx.useGas(tx.gas.write + tx.gas.byte * valueSize(value));
    this.writeMetadata(tx, programUuid, { [field]: value === undefined ? null : value });
    return true;
  }

  /** โอน native จากกระเป๋าของโปรแกรมนี้ไปยัง address อื่น */
  programTransferNative(tx, programUuid, to, amount) {
    if (!isNonEmptyString(to)) fail(ERRORS.invalidAddress);
    if (amount <= 0n) fail(ERRORS.invalidAmount);
    this.moveNative(tx, programUuid, normalizeAddress(to), amount);
    return true;
  }

  /**
   * sender = โปรแกรมที่เรียก, origin = คงเดิม; ปลายทาง error → ย้อนการเขียนของปลายทางแล้ว throw ให้ผู้เรียกจัดการ
   * { readonly: true } = แบบ STATICCALL: ปลายทางและทุกชั้นที่มันเรียกต่อแก้ state ไม่ได้ (ชั้นที่ readonly อยู่แล้วส่งต่อเสมอ)
   */
  programRunProgram(tx, caller, programUuid, functionName, input, { value = 0n, readonly = false } = {}) {
    value = checkValue(value);
    readonly = readonly || Boolean(caller.readonly);
    if (readonly && value > 0n) fail(ERRORS.readonlyValue);
    const savepoint = tx.savepoint();
    try {
      const target = normalizeAddress(programUuid);
      if (value > 0n) this.moveNative(tx, caller.programUuid, target, value); // แนบเงินไปกับการเรียก
      const context = { sender: caller.programUuid, origin: caller.context.origin };
      // input / ค่าที่ return ถูกคัดลอกข้ามเขตแดน (JSON) → builtin ต่อ 32 byte (ปัดขึ้น) ทั้งขาไปและขากลับ
      tx.useGas(tx.gas.builtin * copyUnits(input));
      const result = this.runFunction(tx, { programUuid: target, functionName, input, context, value, depth: caller.depth + 1,
        readonly, callType: readonly ? "staticcall" : undefined });
      tx.useGas(tx.gas.builtin * copyUnits(result));
      return result;
    } catch (err) {
      tx.rollbackTo(savepoint);
      throw err;
    }
  }

  /** address ของโปรแกรมที่ cloneProgram สร้าง (แบบ CREATE2: factory + salt + hash ของโค้ด) → รู้ได้ก่อนสร้างจริง */
  cloneAddressFor(factory, salt, oneLineCode) {
    return addressFromHash(this.hashData({ chainId: this.chainId, factory: normalizeAddress(factory), salt: String(salt), codeHash: keccak256Hex(oneLineCode) }));
  }

  /**
   * cloneProgram(template, initInput, { salt, value }) → address ใหม่
   *   copy โค้ดของ template (ต้องอนุมัติแล้ว) ไปไว้ที่ address ใหม่ แล้วรัน initialization ทันทีใน tx เดียวกัน
   *   context.sender ของ initialization = โปรแกรมที่เรียก (factory) · value โอนจาก factory ไปโปรแกรมใหม่
   *   โปรแกรมใหม่ได้รับอนุมัติทันที (ไม่มี upgrader = แก้ไม่ได้) · ล้มตรงไหน → ย้อนทั้งหมด
   *   trace: บันทึกเป็น call ชนิด "create" (explorer / callTracer แสดงเป็น CREATE)
   */
  programCloneProgram(tx, caller, template, initInput, options) {
    const { salt, value } = options ?? {};
    if (!isNonEmptyString(template)) fail(ERRORS.invalidAddress);
    const saltText = typeof salt === "bigint" ? `${salt}` : salt;
    if (!isNonEmptyString(saltText)) fail(ERRORS.invalidSalt);
    const amount = value === undefined || value === null ? 0n : checkValue(fromProgramAmount(value, "value"));
    const depth = caller.depth + 1;
    if (depth > tx.maxCallDepth) fail(ERRORS.callDepthExceeded, tx.maxCallDepth);

    const factory = caller.programUuid;
    const source = normalizeAddress(template);
    tx.useGas(tx.gas.read);
    const code = tx.current(codeKey(source));   // มีเฉพาะโปรแกรมที่ init แล้ว (pending / rejected / ไม่มี → ไม่มี code)
    if (typeof code !== "string") fail(ERRORS.templateNotActive, source);

    const address = this.cloneAddressFor(factory, saltText, code);
    if (tx.current(codeKey(address)) !== undefined || tx.current(pendingKey(address)) !== undefined
      || tx.current(thisKey(address)) !== undefined) fail(ERRORS.programUuidUsed, address);

    // ค่าแก๊ส: call (นับใน runFunction) + ตามขนาดโค้ด (เหมือน deploy) + write ของ code / context / this / metadata 4 ช่อง
    const codeSize = Buffer.byteLength(code, "utf8");
    tx.useGas(tx.gas.code * codeSize + 7 * tx.gas.write);

    const savepoint = tx.savepoint();
    try {
      if (amount > 0n) this.moveNative(tx, factory, address, amount);
      const context = { sender: factory, origin: caller.context.origin };
      tx.useGas(tx.gas.builtin * copyUnits(initInput));   // initInput ถูกคัดลอกข้ามเขตแดนเหมือน input ของ runProgram
      if (this.compiler.compile(code).hasInit) {
        this.runFunction(tx, { programUuid: address, functionName: INIT_FUNCTION, input: initInput, context, value: amount, depth, code, isInit: true, callType: "create" });
      } else {
        // ไม่มี initialization ก็ยังต้องมีรายการ create ใน trace
        const record = tx.startCall({ depth, programUuid: address, functionName: "create", context, input: toInputValue(initInput, "initInput") ?? {}, value: amount, type: "create" });
        tx.useGas(tx.gas.call);
        Transaction.finishCall(record, undefined, tx.gasUsed);
      }
      tx.put(codeKey(address), code);
      tx.put(contextKey(address), context);
      tx.put(thisKey(address), address);
      this.writeMetadata(tx, address, {
        [METADATA_FIELD.TYPE]: "program",
        [METADATA_FIELD.CREATOR]: factory,
        [METADATA_FIELD.CREATED_AT]: tx.timestamp,
        [METADATA_FIELD.TEMPLATE]: source,
      }, { allowReserved: true });
      return address;
    } catch (err) {
      tx.rollbackTo(savepoint);
      throw err;
    }
  }
}

/**
 * เรียง tx ที่รออยู่: tip ต่อแก๊สสูงกว่าได้ก่อน แต่ของแต่ละ address ยังเรียงตาม nonce เสมอ
 *   tip = min(maxPriorityFeePerGas, maxFeePerGas - baseFee) (แบบเดิม gasPrice = ทั้งสองค่า) · ดู effectiveTip
 *   baseFee ไม่ส่ง = 0 → เรียงตามราคาที่เสนอตรง ๆ แบบเดิม · ใบที่ maxFee < baseFee นับ tip = -1 (ไปท้ายสุด — Mempool.take ข้ามให้)
 * @param {Array<{ request: object, receivedAt?: number }>} items
 */
export function sortPendingTransactions(items, { defaultGasPrice = DEFAULT_GAS.price, baseFee = 0n } = {}) {
  const senderOf = (request) => normalizeAddress(request.from ?? request.context?.sender) ?? "";
  const priceOf = (request) => effectiveTip(request, readNative(baseFee), { defaultGasPrice }) ?? -1n;

  // ราคาของ address = ใบที่ถูกที่สุดในคิวของคนนั้น (กันการใส่ใบแพงใบเดียวเพื่อลัดคิวทั้งชุด)
  const groups = new Map();
  for (const item of items) {
    const sender = senderOf(item.request);
    const group = groups.get(sender) ?? { sender, items: [], price: null, receivedAt: Infinity };
    group.items.push(item);
    const price = priceOf(item.request);
    if (group.price === null || price < group.price) group.price = price;
    group.receivedAt = Math.min(group.receivedAt, item.receivedAt ?? 0);
    groups.set(sender, group);
  }

  const byPrice = (a, b) => (a.price === b.price ? 0 : b.price > a.price ? 1 : -1);
  return [...groups.values()]
    .sort((a, b) => byPrice(a, b) || a.receivedAt - b.receivedAt || (a.sender < b.sender ? -1 : 1))
    .flatMap((group) => group.items.sort((a, b) => (a.request.nonce ?? 0) - (b.request.nonce ?? 0)));
}

// ============================================================================
//  Block: รันหลาย call ต่อกัน แล้ว commit ทีเดียว
// ============================================================================

/**
 * แต่ละ tx รันตามลำดับ และเห็นผลของ tx ก่อนหน้าใน block (ยังไม่ลง DB)
 * tx ที่ throw ไม่มีผลกับ block, tx อื่นยังทำงานต่อได้
 *
 * ข้อมูลระดับ block (รูปแบบเดียวกับ call):
 *   loadValues()   storage key ที่ tx ที่ success อ่าน + ค่าใน DB ก่อน block
 *   afterValues()  storage key ที่ tx ที่ success แตะ + ค่าหลังทั้ง block + changed เทียบกับก่อน block
 *   writes()       writes สุดท้าย 1 รายการต่อ key
 *   timestamp      เวลาของ block ที่ทุก tx เห็น
 */
export class Block {
  #vm;
  #read;
  #state = new Map();   // dbKey → write ล่าสุด (put / del)
  #dbCache = new Map(); // dbKey → ค่าที่อ่านจาก DB (อ่านแต่ละ key จาก DB ครั้งเดียวต่อ block)
  #loaded = new Set();  // storage key ที่ tx ที่ success อ่าน
  #touched = new Set(); // storage key ที่ tx ที่ success แตะ (อ่าน / เขียน / ลบ)
  #results = [];
  #requests = [];       // { action, request } ของแต่ละ tx สำหรับทำ receipt
  #rejected = [];       // tx ที่ไม่ถูกรับเข้า block (เช่น nonce ผิด)
  #committed = false;
  #timestamp;

  /** options: { read, timestamp } — ไม่ส่ง timestamp → Date.now() ตอนสร้าง block */
  #feeRecipient;
  #burnPercent;
  #maxTransactions;
  #maxTransactionsPerSender;
  #maxBlockGas;
  #recordHistory;
  #gasUsed = 0;
  #countBySender = new Map();
  #number;
  #parentHash;
  #parentStateRoot;
  #recordBlocks;
  #overwrite;
  #upgrades = [];       // การอัปเกรดที่ครบ timelock และถูกเปิดใช้ตอนเริ่ม block นี้
  #rejectedTxs = [];    // tx ที่ผู้ผลิตปฏิเสธไปตั้งแต่ block ก่อน (บันทึกไว้เฉย ๆ ไม่รัน) — ดู recordRejected
  #hashesCache = null;  // ผลของ hashes() ล่าสุด (ล้างเมื่อ block เปลี่ยน)
  #trieCache = null;    // node ของ trie ที่ hashes() คำนวณไว้ (commit ใช้ตัวเดียวกัน)
  #trustedStateRoot;    // replayBlock: stateRoot จาก header ที่บันทึกไว้ (trie ใน DB เป็นของล่าสุด คำนวณของ block เก่าไม่ได้)
  #baseFee;             // base fee ของ block นี้ (BigInt · EIP-1559 คำนวณจาก block ก่อนหน้า)
  #producer;            // address ผู้ผลิต (อยู่ใน hash) · null = block แบบเดิม
  #producerSignature;   // ลายเซ็นของผู้ผลิตบน hash ของ block (ส่งมา = sync / replay · ไม่ส่ง = เซ็นด้วย vm.producer ตอนต้องใช้)
  #timeoutMs;           // เวลาต่อ tx (null = vm.timeoutMs) — replay / sync ใช้ vm.replayTimeoutMs

  constructor(vm, {
    read = (dbKey) => vm.read(dbKey),
    timestamp = RealDate.now(),
    feeRecipient = vm.feeRecipient,
    burnPercent = vm.burnPercent,
    number,
    parentHash,
    parentStateRoot,
    stateRoot = null,
    recordBlocks = vm.recordBlocks,
    recordHistory = vm.recordHistory,
    checkChain = true,
    overwrite = false,     // rebuildFrom: บันทึกทับ block เลขเดิม (header / body / undo) ใน commit เดียว
    maxTransactions = vm.maxTransactions,
    maxTransactionsPerSender = vm.maxTransactionsPerSender,
    maxBlockGas = vm.maxBlockGas,
    producer = vm.producer?.address ?? null,
    producerSignature = null,
    timeoutMs = null,
  } = {}) {
    checkTimestamp(timestamp);
    this.#vm = vm;
    this.#read = read;
    this.#timestamp = timestamp;

    // ไม่ส่งเลข block มา → ต่อจาก block ล่าสุดใน DB ให้เอง
    this.#number = number === undefined ? (recordBlocks ? (vm.latestBlockNumber() ?? 0) + 1 : null) : number;
    const previous = this.#number === null ? null : vm.getBlock(this.#number - 1);

    // parentHash / parentStateRoot ไม่ส่งมา → อ่านจาก block ก่อนหน้า
    this.#parentHash = parentHash ?? previous?.hash ?? null;
    this.#parentStateRoot = parentStateRoot ?? previous?.stateRoot ?? null;
    this.#recordBlocks = recordBlocks && this.#number !== null;
    this.#recordHistory = recordHistory && this.#number !== null;
    this.#overwrite = overwrite;
    this.#maxTransactions = maxTransactions;
    this.#maxTransactionsPerSender = maxTransactionsPerSender;
    this.#maxBlockGas = maxBlockGas;

    if (this.#number !== null && checkChain) {
      if (vm.getBlock(this.#number)) fail(ERRORS.blockExists, this.#number);
      if (previous && timestamp <= previous.timestamp) fail(ERRORS.blockTimestampOrder, timestamp, previous.timestamp);
    }
    this.#feeRecipient = feeRecipient === null || feeRecipient === undefined ? null : normalizeAddress(feeRecipient);
    this.#burnPercent = checkBurnPercent(burnPercent);
    this.#producer = producer === null || producer === undefined ? null : normalizeAddress(producer);
    this.#producerSignature = producerSignature;
    this.#timeoutMs = timeoutMs;
    this.#trustedStateRoot = stateRoot;
    // base fee มาจาก header ของ block ก่อนหน้าเสมอ (ไม่รับจากผู้เรียก) → sync / replay คำนวณเองแล้วเทียบ hash
    // block ที่ไม่มีเลข (simulate) = base fee ของ block ถัดไป
    this.#baseFee = this.#number === null ? vm.currentBaseFee() : vm.baseFeeAfter(previous);
    if (this.#number !== null) this.#activateUpgrades();
  }

  /**
   * timelock ของการอัปเกรด: ก่อน tx ใบแรกของ block N เปิดใช้โค้ดทุกตัวที่นัดไว้ที่ N (upgradeat:<N>)
   * ทำตอนสร้าง block จึงขึ้นกับเลข block อย่างเดียว — replay / rebuild สร้าง block เดิมก็ได้ผลเดิมทุกครั้ง
   * writes เข้า state ของ block (อยู่ใน stateRoot / history) แต่ไม่ใช่ tx: ไม่มี hash ไม่อยู่ใน body
   */
  #activateUpgrades() {
    const dueKey = upgradeAtKey(this.#number);
    const due = this.read(dueKey);
    if (!Array.isArray(due) || due.length === 0) return;
    for (const programUuid of due) {
      const result = this.#vm.activateUpgrade({ programUuid, blockNumber: this.#number }, {
        read: (dbKey) => this.read(dbKey),
        timestamp: this.#timestamp,
        blockNumber: this.#number,
        feeRecipient: this.#feeRecipient,
        burnPercent: this.#burnPercent,
        baseFee: this.#baseFee,
      });
      if (result.status === STATUS.SUCCESS) {
        for (const write of result.writes ?? []) this.#state.set(write.dbKey, copyValue(write));
      }
      // ล้ม (migrate throw) → ทิ้งนัดหมาย โค้ดเดิมทำงานต่อ
      this.#state.set(scheduledUpgradeKey(programUuid), { type: WRITE.DEL, dbKey: scheduledUpgradeKey(programUuid) });
      this.#upgrades.push({ program: programUuid, status: result.status, version: result.result?.version ?? null, error: result.error ?? null });
    }
    this.#state.set(dueKey, { type: WRITE.DEL, dbKey: dueKey });
    this.#hashesCache = null;
  }

  /** โปรแกรมที่ถูกเปิดใช้โค้ดใหม่ตอนเริ่ม block นี้ (timelock ครบ) */
  upgrades() {
    return this.#upgrades.map(copyValue);
  }

  /** base fee ของ block นี้ (BigInt wei ต่อแก๊ส) */
  get baseFee() {
    return this.#baseFee;
  }

  /** ผู้ปิด block ที่ได้ส่วนแบ่งค่าแก๊ส */
  get feeRecipient() {
    return this.#feeRecipient;
  }

  get number() {
    return this.#number;
  }

  get parentHash() {
    return this.#parentHash;
  }

  /** stateRoot ของ block ก่อนหน้า (สายของ state ต่อกัน) */
  get parentStateRoot() {
    return this.#parentStateRoot;
  }

  /** เวลาของ block: ทุก tx เห็นค่านี้ */
  get timestamp() {
    return this.#timestamp;
  }

  deploy(request) {
    return this.#execute("deploy", request);
  }

  init(request) {
    return this.#execute("init", request);
  }

  reject(request) {
    return this.#execute("reject", request);
  }

  call(request) {
    return this.#execute("call", request);
  }

  transfer(request) {
    return this.#execute("transfer", request);
  }

  setMetadata(request) {
    return this.#execute("setMetadata", request, "metadata");
  }

  upgrade(request) {
    return this.#execute("upgrade", request);
  }

  setUpgrader(request) {
    return this.#execute("setUpgrader", request);
  }

  initUpgrade(request) {
    return this.#execute("initUpgrade", request);
  }

  rejectUpgrade(request) {
    return this.#execute("rejectUpgrade", request);
  }

  /** ผลของทุก tx ที่เข้า block (copy) */
  results() {
    return this.#results.map(copyValue);
  }

  /** ตรวจเบื้องต้นโดยนับ tx ที่อยู่ใน block นี้แล้วด้วย (ใช้กรองคิวก่อนเรียกจริง) */
  checkTransaction(request) {
    const quotaError = this.#quotaError(request);
    if (quotaError) return { ok: false, reason: quotaError.message };
    return this.#vm.checkTransaction(request, { read: (dbKey) => this.read(dbKey) });
  }

  /** โควตาที่เหลือของ block นี้ */
  capacity(address) {
    const sender = address === undefined ? null : normalizeAddress(address);
    return {
      transactions: this.#maxTransactions === null ? Infinity : this.#maxTransactions - this.#results.length,
      perSender: this.#maxTransactionsPerSender === null || sender === null
        ? Infinity
        : this.#maxTransactionsPerSender - (this.#countBySender.get(sender) ?? 0),
      gas: this.#maxBlockGas === null ? Infinity : this.#maxBlockGas - this.#gasUsed,
    };
  }

  /** tx ที่ถูกปฏิเสธก่อนเข้า block (nonce ผิด ฯลฯ) */
  rejected() {
    return this.#rejected.map(copyValue);
  }

  /** storage key ที่ถูกอ่าน พร้อมค่าใน DB ก่อน block */
  loadValues() {
    return [...this.#loaded].map((dbKey) => ({ dbKey, loadValue: this.#beforeBlock(dbKey) }));
  }

  /** storage key ที่ถูกแตะ พร้อมค่าหลังทั้ง block และเปลี่ยนจากก่อน block หรือไม่ */
  afterValues() {
    return [...this.#touched].map((dbKey) => {
      const afterValue = this.read(dbKey);
      return { dbKey, afterValue, changed: !isSameValue(this.#beforeBlock(dbKey), afterValue) };
    });
  }

  /** writes ของ tx ทั้งหมด (ยังไม่รวมข้อมูล block) */
  stateWrites() {
    return [...this.#state.values()].map(copyValue);
  }

  /** writes สุดท้ายของทั้ง block (1 รายการต่อ key) สำหรับบันทึกทีเดียว */
  writes() {
    const stateWrites = this.stateWrites();
    const blockWrites = this.blockWrites();
    return [...stateWrites, ...blockWrites, ...this.historyWrites([...stateWrites, ...blockWrites])];
  }

  /** ค่าก่อนเปลี่ยนของ key หนึ่ง (อ่านจาก cache ของ block ถ้ามี ไม่งั้นอ่าน DB) */
  #beforeValue(dbKey) {
    if (!this.#dbCache.has(dbKey)) this.#dbCache.set(dbKey, this.#read(dbKey));
    return this.#dbCache.get(dbKey);
  }

  /** history:<key>:<block> ของทุก key ที่ block นี้แตะ + blockundo:<block> */
  historyWrites(writes = this.writes()) {
    if (!this.#recordHistory) return [];

    // ข้อมูลของ chain เอง (block / ดัชนี) ไม่ต้องเก็บ history เพราะสร้างใหม่ได้จาก body
    const keys = [...new Set(writes.map((write) => write.dbKey))].filter(isStateKey);
    const history = keys.map((dbKey) => {
      const before = this.#beforeValue(dbKey);
      return {
        type: WRITE.PUT,
        dbKey: historyKey(dbKey, this.#number),
        value: before === undefined ? { existed: false } : { existed: true, before: copyValue(before) },
      };
    });
    return [...history, { type: WRITE.PUT, dbKey: blockUndoKey(this.#number), value: keys }];
  }

  /** hash ของ block: { hash, parentHash, txRoot, stateRoot, writesRoot, ... } */
  hashes() {
    // ผลเดิมจนกว่า block จะเปลี่ยน (รัน tx / บันทึกใบที่ถูกปฏิเสธ / เปิดใช้อัปเกรด) — header() / receipt() / commit() เรียกหลายรอบ
    if (this.#hashesCache) return { ...this.#hashesCache };
    this.#hashesCache = this.#computeHashes();
    return { ...this.#hashesCache };
  }

  #computeHashes() {
    const writes = this.stateWrites();
    const txHashes = this.txHashes();
    const { receiptsRoot, logsBloom: bloom } = this.receiptRoots(txHashes);
    // stateRoot = root ของ trie หลังใส่ writes ของ block นี้ลงบน trie ล่าสุดใน DB (= state ก่อน block นี้)
    this.#trieCache = this.#trustedStateRoot === null ? this.#vm.trieUpdate(writes) : null;
    const { hash, txRoot, stateRoot, writesRoot, rejectedRoot } = this.#vm.hashBlock({
      number: this.#number,
      parentHash: this.#parentHash,
      stateRoot: this.#trustedStateRoot ?? this.#trieCache.root,
      timestamp: this.#timestamp,
      feeRecipient: this.#feeRecipient,
      burnPercent: this.#burnPercent,
      txHashes,
      writes,
      rejected: this.#rejectedTxs,
      baseFeePerGas: encodeNative(this.#baseFee),
      gasUsed: this.#gasUsed,
      receiptsRoot,
      logsBloom: bloom,
      producer: this.#producer,
    });
    return { hash, parentHash: this.#parentHash, parentStateRoot: this.#parentStateRoot, txRoot, stateRoot, writesRoot, rejectedRoot, receiptsRoot, logsBloom: bloom };
  }

  /**
   * receipt ย่อของทุก tx (ข้อมูลที่ได้จากการรัน — ไม่มีใน txRoot) เรียงตาม index
   *   { hash, status, gasUsed, cumulativeGasUsed, effectiveGasPrice, fee, error, logs: [{ address, topics, data }] }
   * receiptsRoot = hash ของรายการนี้ · logsBloom = bloom ของทุก log (แบบ EVM) → อยู่ใน header และ hash ของ block
   */
  receiptEntries(txHashes = this.txHashes()) {
    let cumulative = 0;
    return this.#results.map((result, index) => {
      cumulative += result.gasUsed ?? 0;
      return {
        hash: txHashes[index],
        status: result.status,
        gasUsed: result.gasUsed ?? 0,
        cumulativeGasUsed: cumulative,
        effectiveGasPrice: result.gasPrice ?? null,
        fee: result.fee ?? "0n",
        error: result.error?.code ?? null,
        logs: (result.events ?? []).map(eventLog),
      };
    });
  }

  /** { receiptsRoot, logsBloom } ของ block นี้ */
  receiptRoots(txHashes = this.txHashes()) {
    const entries = this.receiptEntries(txHashes);
    return { receiptsRoot: this.#vm.hashData(entries), logsBloom: logsBloom(entries.flatMap((entry) => entry.logs)) };
  }

  /**
   * บันทึก tx ที่ถูกปฏิเสธลง block (ไม่รัน ไม่แตะ state ไม่กิน nonce ไม่เสียค่าแก๊ส) → entry ที่เก็บ
   *   { hash, sender, nonce, action, to, gasPrice, reason, code, stage }   stage: "sendtx" | "block" | "expired"
   * อยู่ใน hash ของ block (rejectedRoot) → replay / sync ต้องใส่รายการเดิมตามลำดับเดิมจึงได้ hash ตรง
   */
  recordRejected({ hash, sender, nonce = null, action = "call", to = null, gasPrice = null, reason = "", code = null, stage } = {}) {
    if (this.#committed) fail(ERRORS.blockCommitted);
    if (typeof hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(hash)) fail(ERRORS.invalidRejected, "hash");
    if (!isNonEmptyString(sender)) fail(ERRORS.invalidRejected, "sender");
    if (!REJECTED_STAGES.includes(stage)) fail(ERRORS.invalidRejected, "stage");
    const text = String(reason ?? "");
    const entry = {
      hash: hash.toLowerCase(),
      sender: normalizeAddress(sender),
      nonce: Number.isSafeInteger(nonce) ? nonce : null,
      action: String(action ?? "call"),
      to: isNonEmptyString(to) ? normalizeAddress(to) : null,
      gasPrice: gasPrice === null || gasPrice === undefined ? null : String(gasPrice),
      reason: text.length > MAX_REJECTED_REASON ? text.slice(0, MAX_REJECTED_REASON) : text,
      code: code === null || code === undefined ? null : String(code),
      stage,
    };
    this.#rejectedTxs.push(entry);
    this.#hashesCache = null;
    return { ...entry };
  }

  /** tx ที่ถูกปฏิเสธที่บันทึกใน block นี้ (copy) */
  rejectedTransactions() {
    return this.#rejectedTxs.map((entry) => ({ ...entry }));
  }

  /** hash ของทุก tx ใน block เรียงตามลำดับ */
  txHashes() {
    return this.#results.map((result, index) => {
      const { action, request } = this.#requests[index];
      return this.#vm.hashTransaction(request, { action, blockNumber: this.#number, index });
    });
  }

  /** ข้อมูล block ที่จะบันทึกลง DB (block:<number>, blockhash:<hash>, latestblock, tx:<hash>) */
  blockWrites() {
    if (!this.#recordBlocks) return [];

    const header = this.header();
    const writes = [
      { type: WRITE.PUT, dbKey: blockKey(this.#number), value: header },
      { type: WRITE.PUT, dbKey: blockBodyKey(this.#number), value: this.body() },
      { type: WRITE.PUT, dbKey: blockHashKey(header.hash), value: this.#number },
      { type: WRITE.PUT, dbKey: LATEST_BLOCK_KEY, value: this.#number },
    ];

    // tx ที่ถูกปฏิเสธ: รายการของ block + ดัชนีจาก hash / ผู้ส่ง
    if (this.#rejectedTxs.length) {
      writes.push({ type: WRITE.PUT, dbKey: blockRejectedKey(this.#number), value: this.rejectedTransactions() });
      this.#rejectedTxs.forEach((entry, index) => {
        const value = { ...entry, blockNumber: this.#number, index, timestamp: this.#timestamp };
        writes.push({ type: WRITE.PUT, dbKey: rejectedTxKey(entry.hash), value });
        writes.push({ type: WRITE.PUT, dbKey: rejectedFromKey(entry.sender, this.#number, index), value });
      });
    }

    const signatures = new Set();   // eventsig: เขียนครั้งเดียวต่อ block
    header.txHashes.forEach((hash, index) => {
      const { request, action } = this.#requests[index];
      const result = this.#results[index];
      const digest = request.digest ?? null;
      writes.push({
        type: WRITE.PUT,
        dbKey: txIndexKey(hash),
        value: {
          hash,
          digest,
          blockNumber: this.#number,
          index,
          action,
          status: result.status,
          from: normalizeAddress(action === "transfer" ? request.from : request.context?.sender) ?? null,
          nonce: request.nonce ?? null,
          // ค่าแก๊ส (eth_feeHistory อ่านจากตรงนี้โดยไม่ต้อง replay)
          gasUsed: result.gasUsed ?? 0,
          gasPrice: result.gasPrice ?? null,
          tip: encodeNative(readNative(result.gasPrice) > this.#baseFee ? readNative(result.gasPrice) - this.#baseFee : 0n),
        },
      });
      // ค้นจาก hash ที่ผู้ใช้เซ็น (EIP-712) กลับมาหา tx ได้ด้วย
      if (digest) writes.push({ type: WRITE.PUT, dbKey: sigTxKey(digest), value: hash });

      // ดัชนี "ใครมา interact กับ address นี้" (โปรแกรมที่ถูกเรียก หรือผู้รับเงิน)
      const target = normalizeAddress(action === "transfer" ? request.to : request.programUuid ?? result.result?.programUuid);
      if (target) {
        writes.push({
          type: WRITE.PUT,
          dbKey: txToKey(target, this.#number, index),
          value: {
            hash, action, status: result.status,
            from: normalizeAddress(action === "transfer" ? request.from : request.context?.sender) ?? null,
            method: request.functionName ?? null,
            value: request.value ?? request.amount ?? 0,
            // blockNumber / index อยู่ใน key · timestamp อ่านจาก header (readTransactionTo)
          },
        });
      }

      // โปรแกรมที่ถูกเรียกซ้อน (runProgram) ก็ต้องเห็นว่ามีใครมาเรียกเหมือนกัน
      (result.calls ?? []).forEach((call, callIndex) => {
        if (call.depth === 0) return;   // ชั้นนอกสุดถูกบันทึกไปแล้วด้านบน
        writes.push({
          type: WRITE.PUT,
          dbKey: txToKey(call.programUuid, this.#number, index, callIndex + 1),
          value: {
            // status = ผลของการเรียกชั้นนี้ · txStatus = ผลของทั้ง tx (ชั้นนี้ล้มได้ แต่ชั้นบนอาจ catch ไว้)
            hash, action: call.type === "create" ? "create" : "call", status: call.status, txStatus: result.status,
            from: normalizeAddress(call.sender ?? call.context?.sender) ?? null,
            method: call.functionName ?? null,
            depth: call.depth, via: normalizeAddress(request.programUuid) ?? null, value: 0,
          },
        });
      });

      // ดัชนี event: ค้นได้ว่าโปรแกรมนี้ emit อะไรไว้บ้าง
      for (const event of result.events ?? []) {
        writes.push({
          type: WRITE.PUT,
          dbKey: eventKey(event.program, event.name, this.#number, index, event.index),
          value: { ...event, blockNumber: this.#number, txIndex: index, txHash: hash, timestamp: this.#timestamp },
        });
        // field ที่ indexed → eventidx:<program>:<name>:<field>:<topic>:… (ค้นด้วยค่าได้ไม่ต้องไล่ทุก event) + eventsig: (topic0 → ชื่อ)
        if (event.indexed?.length) {
          const ref = eventKey(event.program, event.name, this.#number, index, event.index);
          for (const field of event.indexed) {
            writes.push({ type: WRITE.PUT, dbKey: eventIndexKey(event.program, event.name, field, topicOf(event.data?.[field]), this.#number, index, event.index), value: ref });
          }
          const sigKey = eventSigKey(eventLog(event).topics[0], event.program, event.name);
          if (!signatures.has(sigKey)) {
            signatures.add(sigKey);
            writes.push({ type: WRITE.PUT, dbKey: sigKey, value: { program: event.program, name: event.name, indexed: event.indexed } });
          }
        }
        // event Transfer ของ token / NFT และ TransferSingle / TransferBatch ของ multi-token → จำว่า address นี้ถือของของโปรแกรมนี้
        // (ยอดจริงอ่านจากโปรแกรมตอนแสดง)
        if (HOLDING_EVENTS.has(event.name) && result.status === STATUS.SUCCESS) {
          for (const holder of [event.data?.to, event.data?.from]) {
            if (!isWalletAddress(holder) || /^0x0{40}$/i.test(holder)) continue;
            writes.push({ type: WRITE.PUT, dbKey: holdingKey(normalizeAddress(holder), event.program),
              value: { program: event.program, lastBlock: this.#number } });
          }
        }
      }
    });
    // history ครบตั้งแต่ block ไหน: block นี้ไม่เก็บ history → นับใหม่จาก block ถัดไป · ยังไม่มีค่า → block แรกที่เก็บ
    if (!this.#recordHistory) writes.push({ type: WRITE.PUT, dbKey: HISTORY_FROM_KEY, value: this.#number + 1 });
    else if (this.#vm.read(HISTORY_FROM_KEY) === undefined) writes.push({ type: WRITE.PUT, dbKey: HISTORY_FROM_KEY, value: this.#vm.historyFrom() ?? this.#number });
    return writes;
  }

  /** tx ดิบของทุกใบใน block ตามลำดับ (ใช้ replay ได้) */
  body() {
    return this.#requests.map(({ action, method, request }) => ({ action, method, request: copyValue(request) }));
  }

  /** header ของ block (ไม่มีรายละเอียด tx) */
  header() {
    const txHashes = this.txHashes();
    const { hash, txRoot, stateRoot, writesRoot, receiptsRoot, logsBloom: bloom } = this.hashes();
    const statuses = this.#results.map((result) => result.status);
    const sum = (field) => encodeNative(this.#results.reduce((total, result) => total + readNative(result[field]), 0n));
    return {
      number: this.#number,
      hash,
      parentHash: this.#parentHash,
      timestamp: this.#timestamp,
      feeRecipient: this.#feeRecipient,
      burnPercent: this.#burnPercent,
      txCount: txHashes.length,
      successCount: statuses.filter((status) => status === STATUS.SUCCESS).length,
      failedCount: statuses.filter((status) => status === STATUS.THROW).length,
      gasUsed: this.#results.reduce((sum, result) => sum + (result.gasUsed ?? 0), 0),
      fee: encodeNative(this.#results.reduce((sum, result) => sum + readNative(result.fee), 0n)),
      baseFeePerGas: encodeNative(this.#baseFee),   // EIP-1559 (อยู่ใน hash)
      gasTarget: this.#vm.gasTarget,                // แก๊สเป้าหมายต่อ block (null = base fee คงที่)
      burnedFee: sum("burnedFee"),                  // ค่าแก๊สที่เผาทั้ง block
      producerFee: sum("producerFee"),              // ค่าแก๊สที่ผู้ปิด block ได้ (tip + base fee ส่วนที่ไม่ได้เผา)
      parentStateRoot: this.#parentStateRoot,
      txRoot,
      stateRoot,                                     // root ของ trie ของ state ทั้งหมดหลัง block นี้ (ตรวจค่าด้วย getProof ได้)
      writesRoot,                                    // hash ของ writes ของ state ใน block นี้
      receiptsRoot,                                  // hash ของ receipt ย่อทุกใบ (อยู่ใน hash)
      logsBloom: bloom,                              // bloom ของ log ทุกใบแบบ EVM (อยู่ใน hash)
      txHashes,
      ...(this.#rejectedTxs.length ? { rejectedCount: this.#rejectedTxs.length, rejectedRoot: this.hashes().rejectedRoot } : {}),
      ...(this.#upgrades.length ? { upgrades: this.upgrades() } : {}),   // timelock ครบใน block นี้ (ไม่เข้า hash — ผลอยู่ใน stateRoot แล้ว)
      ...(this.#producer ? { producer: this.#producer, producerSignature: this.producerSignature() } : {}),
    };
  }

  /**
   * ลายเซ็นของผู้ผลิตบน hash ของ block → "0x" + r + s + v · null = ไม่มีผู้ผลิต หรือ node นี้ไม่ใช่ผู้ผลิตของ block
   * node ผู้ผลิตเซ็นด้วย vm.producer.sign (ได้ค่าเดิมทุกครั้งต่อ hash เดียวกัน) · sync / replay ใช้ลายเซ็นที่มากับ header
   */
  producerSignature() {
    if (!this.#producer) return null;
    const { hash } = this.hashes();
    if (this.#producerSignature?.hash === hash) return this.#producerSignature.signature;
    if (typeof this.#producerSignature === "string") return this.#producerSignature;
    const signer = this.#vm.producer;
    if (!signer || signer.address !== this.#producer) return null;
    this.#producerSignature = { hash, signature: signer.sign(hash) };
    return this.#producerSignature.signature;
  }

  get producer() {
    return this.#producer;
  }

  /** receipt ของทั้ง block สำหรับ explorer */
  receipt({ number = this.#number, feeRecipient = this.#feeRecipient } = {}) {
    // ค่า native ก่อน tx แต่ละใบ (ไล่ตามลำดับใน block) → receipt บอกได้ว่าแต่ละช่องเปลี่ยนไปเท่าไร
    const running = new Map();
    const transactions = this.#results.map((result, index) => {
      const { action, request } = this.#requests[index];
      const nativeBefore = new Map();
      for (const write of result.writes ?? []) {
        if (nativeBefore.has(write.dbKey) || decodeDbKey(write.dbKey).kind !== KEY.NATIVE) continue;
        nativeBefore.set(write.dbKey, running.has(write.dbKey) ? running.get(write.dbKey) : this.#beforeValue(write.dbKey));
      }
      for (const write of result.writes ?? []) {
        if (nativeBefore.has(write.dbKey)) running.set(write.dbKey, write.type === WRITE.DEL ? undefined : write.value);
      }
      return this.#vm.buildReceipt(request, result, { index, action, blockNumber: number, nativeBefore });
    });
    const { hash, txRoot, stateRoot } = this.hashes();

    return {
      number,
      hash,
      parentHash: this.#parentHash,
      txRoot,
      stateRoot,
      timestamp: this.#timestamp,
      time: new Date(this.#timestamp).toISOString(),
      feeRecipient,
      burnPercent: this.#burnPercent,
      baseFeePerGas: encodeNative(this.#baseFee),
      gasTarget: this.#vm.gasTarget,
      burnedFee: encodeNative(transactions.reduce((sum, tx) => sum + readNative(tx.burnedFee), 0n)),
      producerFee: encodeNative(transactions.reduce((sum, tx) => sum + readNative(tx.producerFee), 0n)),
      receiptsRoot: this.hashes().receiptsRoot,
      logsBloom: this.hashes().logsBloom,
      txCount: transactions.length,
      successCount: transactions.filter((tx) => tx.status === STATUS.SUCCESS).length,
      failedCount: transactions.filter((tx) => tx.status === STATUS.THROW).length,
      gasUsed: transactions.reduce((sum, tx) => sum + tx.gasUsed, 0),
      fee: encodeNative(transactions.reduce((sum, tx) => sum + readNative(tx.fee), 0n)),
      transactions,
      rejected: this.rejectedTransactions(),   // tx ที่ถูกปฏิเสธ (ไม่ได้รัน) ที่บันทึกไว้ใน block นี้
      // event ของทั้ง block เรียงตามลำดับ tx (ใช้ทำฟีดของ explorer)
      events: transactions.flatMap((tx) => tx.events.map((event) => ({ ...event, txIndex: tx.index, txHash: tx.hash }))),
      stateChanges: this.afterValues()
        .filter((value) => value.changed)
        .map(({ dbKey, afterValue }) => {
          const { address, key } = decodeDbKey(dbKey);
          return { program: address, key, after: afterValue };
        }),
      nativeChanges: collapseWrites(this.writes())
        .filter((change) => change.kind === KEY.NATIVE)
        .map(({ address, field, value }) => ({ address, field, after: value })),
      writeCount: this.writes().length,
    };
  }

  /** สรุปทั้ง block ในรูปแบบเดียวกับผลของ call */
  summary() {
    return {
      timestamp: this.#timestamp,
      results: this.results(),
      loadValues: this.loadValues(),
      afterValues: this.afterValues(),
      writes: this.writes(),
    };
  }

  /** บันทึก writes ของทั้ง block ลง DB ครั้งเดียว แล้วปิด block */
  commit() {
    if (this.#committed) fail(ERRORS.blockCommitted);
    if (this.#recordBlocks && !this.#overwrite && this.#vm.getBlock(this.#number)) fail(ERRORS.blockExists, this.#number);
    const writes = this.writes();   // คำนวณ hashes (+ trie) ถ้ายังไม่ได้ทำ
    const result = this.#vm.commit(writes, this.#trieCache ? { trie: this.#trieCache } : {});
    this.#committed = true;
    if (this.#recordBlocks && this.#recordHistory && this.#vm.historyKeep !== null) this.#vm.pruneHistory();
    return result;
  }

  get committed() {
    return this.#committed;
  }

  /** ค่าปัจจุบันของ block: สถานะของ block → ค่าที่เคยอ่านจาก DB → อ่าน DB */
  read(dbKey) {
    if (this.#state.has(dbKey)) {
      const write = this.#state.get(dbKey);
      return write.type === WRITE.DEL ? undefined : copyValue(write.value);
    }
    if (!this.#dbCache.has(dbKey)) this.#dbCache.set(dbKey, this.#read(dbKey));
    return copyValue(this.#dbCache.get(dbKey));
  }

  /** ค่าใน DB ก่อน block (key ที่ถูกแตะโดย tx ที่ success ถูกอ่านจาก DB แล้วเสมอ) */
  #beforeBlock(dbKey) {
    return copyValue(this.#dbCache.get(dbKey));
  }

  /** address ผู้ส่งของ request (ใช้จำกัดจำนวนต่อคน) */
  #senderOf(request) {
    return normalizeAddress(request?.from ?? request?.context?.sender) ?? null;
  }

  /** เหลือโควตาให้ tx ใบนี้ไหม — คืน error ถ้าเต็ม */
  #quotaError(request) {
    if (this.#maxTransactions !== null && this.#results.length >= this.#maxTransactions) {
      return VMError.from(ERRORS.blockFull, this.#maxTransactions);
    }
    const sender = this.#senderOf(request);
    if (sender && this.#maxTransactionsPerSender !== null
      && (this.#countBySender.get(sender) ?? 0) >= this.#maxTransactionsPerSender) {
      return VMError.from(ERRORS.senderLimit, this.#maxTransactionsPerSender);
    }
    return null;
  }

  /** ผลลัพธ์ของ tx ที่ไม่ถูกรับเข้า block (ไม่ได้รันโปรแกรม) */
  #rejection(error) {
    return {
      status: STATUS.THROW,
      accepted: false,
      timestamp: this.#timestamp,
      gasUsed: 0,
      gasPrice: null,
      fee: "0n",
      error: { code: error.code, message: error.message },
      calls: [],
      writes: [],
    };
  }

  #execute(method, request, action = method) {
    if (this.#committed) fail(ERRORS.blockCommitted);
    this.#hashesCache = null;

    const quotaError = this.#quotaError(request);
    if (quotaError) {
      const rejected = this.#rejection(quotaError);
      this.#rejected.push({ action, request: copyValue(request) ?? {}, error: rejected.error });
      return rejected;
    }

    const result = this.#vm[method](request, {
      read: (dbKey) => this.read(dbKey),
      timestamp: this.#timestamp,
      blockNumber: this.#number,
      feeRecipient: this.#feeRecipient,
      burnPercent: this.#burnPercent,
      baseFee: this.#baseFee,
      ...(this.#timeoutMs === null ? {} : { timeoutMs: this.#timeoutMs }),
    });
    if (result.accepted === false) {
      this.#rejected.push({ action, request: copyValue(request) ?? {}, error: result.error });
      return result; // ไม่เข้า block เลย: ไม่มี writes / hash / ดัชนี
    }

    // แก๊สของ block เต็ม → ไม่รับใบนี้ (ผลที่รันไปถูกทิ้ง)
    if (this.#maxBlockGas !== null && this.#gasUsed + (result.gasUsed ?? 0) > this.#maxBlockGas) {
      const rejected = this.#rejection(VMError.from(ERRORS.blockGasFull, this.#maxBlockGas));
      this.#rejected.push({ action, request: copyValue(request) ?? {}, error: rejected.error });
      return rejected;
    }

    this.#gasUsed += result.gasUsed ?? 0;
    const sender = this.#senderOf(request);
    if (sender) this.#countBySender.set(sender, (this.#countBySender.get(sender) ?? 0) + 1);

    for (const write of result.writes ?? []) this.#state.set(write.dbKey, copyValue(write));
    if (result.status === STATUS.SUCCESS) {
      for (const { dbKey } of result.loadValues) this.#loaded.add(dbKey);
      for (const { dbKey } of result.afterValues) this.#touched.add(dbKey);
    }
    this.#results.push(copyValue(result)); // เก็บ copy: ผู้เรียกแก้ result ที่ได้คืนไปก็ไม่กระทบ block
    this.#requests.push({ action, method, request: copyValue(request) ?? {} });
    return result;
  }
}
