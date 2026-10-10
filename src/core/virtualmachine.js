import nodeVm from "node:vm";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { review, reviewMessage } from "./autoreview.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

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
 *  คืนค่า { status: "success", result, calls, loadValues, afterValues, writes }
 *      หรือ { status: "throw", error: { code, message }, calls }
 *  เมื่อ success → vm.commit(res.writes) บันทึกลง DB ผ่าน db.writeKeys (หรือบันทึกเอง)
 *  runProgram error → ผู้เรียก catch ได้ (การเขียนของปลายทางถูกย้อน) ถ้าไม่ catch → throw ต่อขึ้นไปจนทั้ง request ล้ม
 *  timeout / อ่าน DB ไม่สำเร็จ → ทั้ง request ล้มเสมอ (catch ไม่ได้)
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
 *  bigintValues: true → ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เก็บใน DB เป็น "123n" แปลงไปกลับให้อัตโนมัติ)
 *                 ThisAddress / ThisBalance / BalanceOf / IsProgram / MetadataOf / BlockNumber / Date / Math
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
 *    blockundo:<number>         รายชื่อ key ที่ block นั้นแตะ
 *       blockbody = tx ดิบของทุกใบใน block (ใช้ replay สร้าง state ใหม่ได้ทั้งหมด)
 *                          ข้อมูล block และดัชนีค้น tx จาก hash — เปิดด้วย recordBlocks + ส่ง number ตอน createBlock
 *
 *  ค่าแก๊ส (เมื่อ chargeGas): call 100 + write 500 + read 100 + 1 ต่อ byte ที่อ่าน/เขียน
 *    ผู้จ่ายคือ sender ของ tx ชั้นนอกสุดเสมอ, หักจาก <sender>:nativebalance
 *    user ส่ง gasLimit มาเองได้ (เพดานสูงสุดคือยอด native ที่เหลือหลังหัก value)
 *    แก๊สไม่พอ → OUT_OF_GAS (โปรแกรม catch ไม่ได้), tx ที่ล้มก็ยังกิน nonce และค่าแก๊ส
 *    ค่าแก๊สแบ่งให้ผู้ปิด block (feeRecipient) ตามสัดส่วน ที่เหลือเผาทิ้ง (burnPercent)
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
  burnPercent: 100,    // ค่าแก๊สที่เผาทิ้ง (%) ที่เหลือเข้ากระเป๋า feeRecipient
  feeRecipient: null,  // ผู้ปิด block (ตั้งต่อ block ได้ที่ createBlock)
  chainId: 1,          // กัน tx ของระบบหนึ่งถูกนำไปใช้ซ้ำในอีกระบบ
  recordTransactions: false, // เขียน <address>:txn:<nonce>:<txhash> ลงไปกับ writes ของ tx ด้วย
  recordBlocks: false,       // เขียน block:<number> / blockhash:<hash> / latestblock / tx:<hash>
  deriveProgramAddress: false, // คำนวณ address ของโปรแกรมจาก keccak256(deployer + nonce) เสมอ
  forceOriginFromSender: true, // tx ของ user: origin = sender เสมอ (กันการปลอม origin)
  maxTransactions: null,          // จำนวน tx สูงสุดต่อ block (null = ไม่จำกัด)
  maxTransactionsPerSender: null, // จำนวน tx สูงสุดต่อ address ใน 1 block
  maxBlockGas: null,              // แก๊สรวมสูงสุดต่อ block
  admins: null,                   // address ที่เรียก init / reject ได้ (null = ใครก็ได้)
  maxCodeSize: 64 * 1024,         // ขนาดโค้ดสูงสุดต่อโปรแกรม
  maxKeySize: 1000,               // ความยาวสูงสุดของ key storage (เหลือที่ให้ history: ซ้อนทับ)
  autoReview: false,              // true = ตรวจโค้ดด้วยบัญชีขาวตอน deploy (แทนการรีวิวด้วยคน)
  bigintValues: false,            // true = ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เก็บใน DB เป็น "123n")
  maxValueSize: 64 * 1024,        // ขนาดสูงสุดของค่าที่เขียน / return / emit ต่อรายการ
  recordHistory: false,           // เก็บ history:<key>:<block> + blockundo:<block> (ต้องเปิดถ้าจะย้อนดู / กู้ระบบ)
};

/** ความยาวของเลข block ใน key (เติมศูนย์ให้เรียงตามตัวอักษรได้ตรงกับเรียงตามตัวเลข) */
export const BLOCK_NUMBER_WIDTH = 12;

/** address ของโปรแกรม = 20 byte ท้ายของ hash (ไม่มี private key จึงเซ็น tx ในนามโปรแกรมไม่ได้) */
export const addressFromHash = (hash) => `0x${hash.slice(-40)}`;

/** hash เริ่มต้น: keccak256 แบบเดียวกับ EVM (เปลี่ยนได้ด้วย option hashFunction) */
export const keccak256Hex = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;
const hexToBytesStrict = (hex) => hexToBytes(String(hex).replace(/^0x/, ""));

/** ตารางค่าแก๊ส */
export const DEFAULT_GAS = {
  call: 100,   // ต่อการเรียกโปรแกรม 1 ครั้ง (รวมชั้นนอกสุด)
  read: 100,   // ต่อ readDB 1 ครั้ง
  write: 500,  // ต่อ writeDB / deleteDB 1 ครั้ง
  byte: 1,     // ต่อ byte ของข้อมูลที่อ่าน / เขียน
  event: 200,  // ต่อ event 1 รายการ (บวกค่า byte ของข้อมูลใน event)
  hash: 100,   // ต่อการเรียก keccak256 (บวกค่า byte ของข้อมูล)
  recover: 3000, // ต่อการเรียก ecrecover (คำนวณหนัก)
  code: 10,    // ต่อ byte ของโค้ดตอน deploy (กินพื้นที่ DB ถาวร)
  price: 1,    // native ต่อ 1 gas
};

export const ERROR_CODE = {
  INVALID_REQUEST: "INVALID_REQUEST",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  LIMIT_EXCEEDED: "LIMIT_EXCEEDED",
  TIMEOUT: "TIMEOUT",
  OUT_OF_GAS: "OUT_OF_GAS",
  PROGRAM_ERROR: "PROGRAM_ERROR",
  INTERNAL: "INTERNAL",
};

const { INVALID_REQUEST, NOT_FOUND, FORBIDDEN, LIMIT_EXCEEDED, TIMEOUT, OUT_OF_GAS, PROGRAM_ERROR, INTERNAL } = ERROR_CODE;

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
  invalidAddress: [INVALID_REQUEST, "address ต้องเป็น string ที่ไม่ว่าง"],
  invalidValue: [INVALID_REQUEST, "value ต้องเป็นจำนวนเต็มที่ไม่ติดลบ"],
  invalidGasLimit: [INVALID_REQUEST, "gasLimit ต้องเป็นจำนวนเต็มบวก"],
  invalidGasPrice: [INVALID_REQUEST, (min) => `gasPrice ต้องเป็นจำนวนเต็มและไม่ต่ำกว่า ${min}`],
  invalidBurnPercent: [INVALID_REQUEST, "burnPercent ต้องเป็นจำนวนเต็ม 0-100"],
  invalidDb: [INTERNAL, "db ต้องมี readKeys(keys) และ writeKeys(writes)"],
  numberNotAllowed: [INVALID_REQUEST, (label) => `${label}: ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เช่น 10n)`],
  invalidSignature: [INVALID_REQUEST, "signature ต้องเป็น hex 65 byte (r + s + v)"],
  invalidEventName: [INVALID_REQUEST, "ชื่อ event ต้องเป็นตัวอักษรภาษาอังกฤษขึ้นต้น ยาวไม่เกิน 32"],
  invalidMetadata: [INVALID_REQUEST, "metadata ต้องเป็น object ของ field → ค่า"],
  invalidMetadataField: [INVALID_REQUEST, (field) => `ชื่อ field ไม่ถูกต้อง: '${field}'`],
  reservedMetadata: [FORBIDDEN, (field) => `'${field}' เป็นฟิลด์ของระบบ แก้ไม่ได้`],
  invalidNamespace: [INVALID_REQUEST, "namespace ต้องเป็น string ที่ไม่ว่าง ไม่มี ':' และยาวไม่เกิน 64"],
  namespaceTaken: [FORBIDDEN, (name, owner) => `namespace '${name}' ถูกใช้โดย ${owner} แล้ว`],
  listNotSupported: [INTERNAL, "DB ตัวนี้ไม่มี listKeys(prefix) จึงไล่ดูข้อมูลไม่ได้"],
  nativeInsufficient: [PROGRAM_ERROR, (address) => `ยอด native ของ '${address}' ไม่พอ`],
  outOfGas: [OUT_OF_GAS, (used, limit) => `แก๊สไม่พอ: ใช้ ${used} แต่จ่ายได้ ${limit}`],
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
  blockTimestampOrder: [INVALID_REQUEST, (timestamp, previous) => `timestamp ของ block ต้องมากกว่า block ก่อนหน้า (${timestamp} <= ${previous})`],
};

// ============================================================================
//  ค่าคงที่
// ============================================================================

const INIT_FUNCTION = "initialization";
const KEY = { SEPARATOR: ":", PENDING: "pending", CODE: "code", CONTEXT: "context", STORAGE: "storage", THIS: "this", NONCE: "nonce", NATIVE: "native", TXN: "txn",
  METADATA: "metadata", NAMESPACE: "namespace", EVENT: "event", TX_TO: "txto",
  BLOCK: "block", BLOCK_BODY: "blockbody", BLOCK_HASH: "blockhash", LATEST_BLOCK: "latestblock", TX: "tx", GENESIS: "genesis",
  HISTORY: "history", BLOCK_UNDO: "blockundo", SIG_TX: "sigtx", HOLDING: "holding" };
const PROGRAM_API_NAMES = [
  "readDB", "writeDB", "deleteDB", "map", "runProgram", "transferNative", "setMetadata", "emit",
  "keccak256", "ecrecover",
  "ThisAddress", "ThisBalance", "BalanceOf", "IsProgram", "MetadataOf", "BlockNumber", "Date", "Math",
];

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
const STATE = { PENDING: "pending_review", ACTIVE: "active", REJECTED: "rejected" };
const WRITE = { PUT: "put", DEL: "del" };

const HEX_PATTERN = /^0x[0-9a-f]+$/i;
const METADATA_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const NODE_VM_TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";
const MAP_PARTS = Symbol("map parts");

// node:vm ใช้แค่จับเวลา
const timerContext = nodeVm.createContext({ task: null });
const timerScript = new nodeVm.Script("task()");

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
export const normalizeAddress = (value) => (typeof value === "string" ? value.toLowerCase() : value);

/** string รูปแบบ 0x… hex → ตัวพิมพ์เล็ก, string อื่นไม่เปลี่ยน */
export const normalizeHex = (value) => (typeof value === "string" && HEX_PATTERN.test(value) ? value.toLowerCase() : value);

/** เดินทั้ง object / array: ค่าและชื่อ key ที่เป็น 0x… hex → ตัวพิมพ์เล็ก */
export function normalizeHexDeep(value) {
  if (Array.isArray(value)) return value.map(normalizeHexDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [normalizeHex(key), normalizeHexDeep(item)]));
  }
  return normalizeHex(value);
}

export const normalizeContext = ({ sender, origin }) => ({ sender: normalizeAddress(sender), origin: normalizeAddress(origin) });

/** input ของโปรแกรม: copy แบบ JSON แล้ว normalize address */
export const toInputValue = (value, label) => normalizeHexDeep(toJsonValue(value, label));

/** ขนาดข้อมูลเป็น byte สำหรับคิดค่าแก๊ส */
export const valueSize = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(encodeBigints(value)) ?? "", "utf8"));

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

/** ค่าที่โปรแกรมส่งออกมา: ห้ามเป็น number (ต้องใช้ BigInt) และต้องเป็นข้อมูลธรรมดา */
/** BigInt ที่โปรแกรมส่งมา → number สำหรับใช้ภายใน VM (ต้องไม่เกินช่วงที่ปลอดภัย) */
export function fromProgramAmount(amount, label = "amount") {
  if (typeof amount === "number") fail(ERRORS.numberNotAllowed, label);
  if (typeof amount !== "bigint") fail(ERRORS.invalidAmount);
  if (amount > BigInt(Number.MAX_SAFE_INTEGER) || amount < BigInt(-Number.MAX_SAFE_INTEGER)) fail(ERRORS.invalidAmount);
  return Number(amount);
}

/** options ของ runProgram: { value } เป็น BigInt */
export function fromProgramOptions(options) {
  if (options === undefined || options === null) return undefined;
  const { value } = options;
  return value === undefined ? {} : { value: fromProgramAmount(value, "value") };
}

/** โหมดปกติใช้ JSON ธรรมดา โหมด BigInt แปลงค่าไปกลับให้อัตโนมัติ */
export const toProgram = (value, label, bigint) => (bigint ? decodeBigints(value, label) : value);
export const fromProgram = (value, label, bigint) =>
  (bigint ? encodeBigints(toProgramValue(value, label)) : toJsonValue(value, label));

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
};
export const RESERVED_METADATA = [METADATA_FIELD.TYPE, METADATA_FIELD.CREATOR, METADATA_FIELD.CREATED_AT];
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
/** ดัชนี "address นี้เคยได้รับเหรียญจากโปรแกรมนี้" (จาก event Transfer) — ยอดจริงอ่านจาก balanceOf ของโปรแกรม */
export const holdingKey = (address, program) => joinKey(KEY.HOLDING, address, program);
export const blockUndoKey = (number) => joinKey(KEY.BLOCK_UNDO, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));

/** ค่าก่อนเปลี่ยนของ key หนึ่ง ณ block หนึ่ง — เรียงตาม key จึงค้นย้อนหลังได้ด้วยการ seek ครั้งเดียว */
export const historyKey = (dbKey, number) => joinKey(KEY.HISTORY, dbKey, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const historyPrefix = (dbKey) => `${joinKey(KEY.HISTORY, dbKey)}${KEY.SEPARATOR}`;
export const LATEST_BLOCK_KEY = KEY.LATEST_BLOCK;

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

/**
 * แปลงข้อมูลเป็น string แบบเดียวกันทุกเครื่อง (เรียงชื่อ key, ไม่มีช่องว่าง)
 * ใช้ทำ hash ของ tx จึงต้องไม่ขึ้นกับลำดับที่ user ใส่ field มา
 */
export function canonicalJson(value) {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  try {
    const json = JSON.stringify(value === undefined ? null : value);
    return json === undefined ? JSON.stringify(String(value)) : json; // function / symbol
  } catch {
    return JSON.stringify(String(value)); // bigint ฯลฯ — ค่าจริงจะถูกปฏิเสธตอนตรวจ input อยู่แล้ว
  }
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
  return { kind, address: head };
}

// ---------- ตรวจ request ----------

export function checkProgramUuid(programUuid) {
  if (!isNonEmptyString(programUuid) || programUuid.includes(KEY.SEPARATOR)) fail(ERRORS.invalidProgramUuid);
}

export function checkContext(context) {
  if (!isNonEmptyString(context?.sender) || !isNonEmptyString(context?.origin)) fail(ERRORS.invalidContext);
}

export function checkValue(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail(ERRORS.invalidValue);
  return value;
}

/** gasPrice ที่ผู้ส่งเสนอ ต้องไม่ต่ำกว่าราคาขั้นต่ำของระบบ */
export function checkGasPrice(gasPrice, minimum) {
  if (gasPrice === undefined) return minimum;
  if (!Number.isSafeInteger(gasPrice) || gasPrice < minimum) fail(ERRORS.invalidGasPrice, minimum);
  return gasPrice;
}

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

// ---------- timeout ----------

/** รัน fn และหยุดทันทีเมื่อเกินเวลา (ใช้ที่ชั้นนอกสุด โปรแกรมซ้อนอยู่ใต้เวลาเดียวกัน) */
export function runWithTimeout(fn, timeoutMs) {
  timerContext.task = fn;
  try {
    return timerScript.runInContext(timerContext, { timeout: Math.max(1, Math.floor(timeoutMs)) });
  } finally {
    timerContext.task = null;
  }
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
//  Compiler: แปลงโค้ดเป็นฟังก์ชัน (มี cache)
// ============================================================================

export class Compiler {
  #cache = new Map(); // oneLineCode → program

  /** โค้ดบรรทัดเดียว → { exports, hasInit, create(api) } */
  compile(oneLineCode) {
    if (!this.#cache.has(oneLineCode)) {
      const { body, exports, candidateNames } = Compiler.parse(fromOneLine(oneLineCode));
      Compiler.checkSyntax(body);
      const functionNames = candidateNames.filter((name) => Compiler.isTopLevelDeclaration(body, name));
      const callable = Compiler.validateExports(exports, functionNames);
      this.#cache.set(oneLineCode, {
        exports: callable,
        hasInit: functionNames.includes(INIT_FUNCTION),
        create: Compiler.buildFactory(body, functionNames),
      });
    }
    return this.#cache.get(oneLineCode);
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
    return `"use strict";\nconst { ${PROGRAM_API_NAMES.join(", ")} } = api;\n${body}\n;${tail}`;
  }

  /** คอมไพล์เพื่อตรวจ syntax (ไม่รันโค้ด) */
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

  /** initialization ถูกตัดออกจากรายการ export เสมอ (VM เรียกเองตอน init เท่านั้น) */
  static validateExports(exports, functionNames) {
    const missing = exports.find((name) => !functionNames.includes(name));
    if (missing) fail(ERRORS.exportMissing, missing);
    return exports.filter((name) => name !== INIT_FUNCTION);
  }

  /** factory(api) → { ชื่อฟังก์ชัน: function } */
  static buildFactory(body, functionNames) {
    const returns = functionNames.map((name) => `${name}: typeof ${name} === "function" ? ${name} : undefined`);
    return new Function("api", Compiler.source(body, `return { ${returns.join(", ")} };`));
  }
}

// ============================================================================
//  Transaction: สถานะของ 1 request
// ============================================================================

export class Transaction {
  #read;
  #readCache = new Map(); // dbKey → ค่าที่อ่านจาก DB แล้ว (อ่านแต่ละ key จาก DB ครั้งเดียวต่อ request)

  constructor({ read, timeoutMs, maxCallDepth, timestamp = RealDate.now(), gas = DEFAULT_GAS, chargeGas = false, feeRecipient = null, burnPercent = 100, blockNumber = null }) {
    checkTimestamp(timestamp);
    this.#read = read;
    this.blockNumber = blockNumber;           // เลข block ที่ tx นี้อยู่ (null = รันนอก block)
    this.seed = null;                         // seed ของตัวสุ่ม (ตั้งจาก hash ของ tx)
    this.Math = Math;                         // แทนด้วยตัวสุ่มที่ผูกกับ tx เมื่อรู้ seed
    this.gas = gas;                           // ตารางค่าแก๊ส
    this.gasPrice = gas.price;                // ราคาต่อ 1 gas ของ tx นี้ (ผู้ส่งเสนอสูงกว่าได้)
    this.chargeGas = chargeGas;
    this.gasUsed = 0;
    this.gasLimit = Infinity;                 // ตั้งตามยอด native ของผู้จ่ายเมื่อรู้ตัวผู้จ่าย
    this.payer = null;                        // { address, nonce } ของ tx ชั้นนอกสุด
    this.transaction = null;                  // ข้อมูลของ tx สำหรับเขียน <addr>:txn:<nonce>:<hash>
    this.feeCharged = 0;                      // ค่าแก๊สที่เก็บจริง (native)
    this.feeRecipient = feeRecipient;         // ผู้ปิด block ที่ได้ส่วนแบ่งค่าแก๊ส
    this.burnPercent = burnPercent;
    this.timestamp = timestamp;               // เวลาของ request / block ที่โปรแกรมเห็น
    this.Date = createBlockDate(timestamp);
    this.maxCallDepth = maxCallDepth;
    this.deadline = Date.now() + timeoutMs;
    this.fatal = null;       // error ที่ทั้ง request ต้องล้ม (DB พัง / แก๊สหมด) — โปรแกรม catch ไม่ได้
    this.writes = [];        // [{ type: "put", dbKey, value } | { type: "del", dbKey }]
    this.calls = [];         // log การเรียกโปรแกรม
    this.events = [];        // event ที่โปรแกรม emit (ถูกย้อนพร้อม writes)
    this.before = new Map(); // dbKey → ค่าก่อนรัน
    this.loaded = new Set(); // dbKey ที่โปรแกรมอ่าน
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

  /** ค่าแก๊สที่ต้องจ่ายเป็น native */
  gasFee() {
    return this.chargeGas ? Math.min(this.gasUsed, this.gasLimit) * this.gasPrice : 0;
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

  startCall({ depth, programUuid, functionName, context, input, value = 0, gasStart = this.gasUsed }) {
    const record = { depth, programUuid, functionName, ...pickContext(context), input, value, gasStart, status: STATUS.RUNNING };
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
    chainId = DEFAULT_OPTIONS.chainId,
    recordTransactions = DEFAULT_OPTIONS.recordTransactions,
    recordBlocks = DEFAULT_OPTIONS.recordBlocks,
    deriveProgramAddress = DEFAULT_OPTIONS.deriveProgramAddress,
    forceOriginFromSender = DEFAULT_OPTIONS.forceOriginFromSender,
    maxTransactions = DEFAULT_OPTIONS.maxTransactions,
    maxTransactionsPerSender = DEFAULT_OPTIONS.maxTransactionsPerSender,
    maxBlockGas = DEFAULT_OPTIONS.maxBlockGas,
    admins = DEFAULT_OPTIONS.admins,
    maxCodeSize = DEFAULT_OPTIONS.maxCodeSize,
    maxKeySize = DEFAULT_OPTIONS.maxKeySize,
    autoReview = DEFAULT_OPTIONS.autoReview,
    bigintValues = DEFAULT_OPTIONS.bigintValues,
    maxValueSize = DEFAULT_OPTIONS.maxValueSize,
    recordHistory = DEFAULT_OPTIONS.recordHistory,
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
    this.admins = admins === null ? null : admins.map(normalizeAddress);
    this.maxCodeSize = maxCodeSize;
    this.maxKeySize = maxKeySize;
    this.autoReview = autoReview;
    this.bigintValues = bigintValues;
    this.maxValueSize = maxValueSize;
    this.recordHistory = recordHistory;
    this.hashFunction = hashFunction;
    this.gas = { ...DEFAULT_GAS, ...gas };
    this.compiler = new Compiler();
  }

  /** อ่าน 1 key ผ่าน db.readKeys */
  read(dbKey) {
    return this.db.readKeys([dbKey])[0];
  }

  /** บันทึก writes ลง DB ผ่าน db.writeKeys */
  commit(writes) {
    return this.db.writeKeys(writes);
  }

  // ---------- API ของ server ----------

  /** user ส่งโค้ด → ตรวจ syntax → pending รอรีวิว */
  deploy({ programUuid: rawProgramUuid, code, context: rawContext, initInput = {}, metadata = {}, nonce, gasLimit, gasPrice, value = 0 } = {}, options) {
    return this.runAction((tx) => {
      const derive = this.deriveProgramAddress || rawProgramUuid === undefined;
      if (!derive) checkProgramUuid(rawProgramUuid);
      checkContext(rawContext);
      checkCode(code);
      checkValue(value);
      const context = this.userContext(rawContext);
      this.preparePayer(tx, context.sender, { nonce, gasLimit, gasPrice, value });

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

      if (value > 0) this.moveNative(tx, context.sender, programUuid, value); // เงินไปรออยู่ที่โปรแกรมเลย

      this.checkMetadata(metadata);
      tx.put(pendingKey(programUuid), {
        code: oneLineCode,
        context,
        initInput: toInputValue(initInput, "initInput"),
        metadata,
        value,
      });
      return { programUuid, code: oneLineCode, state: STATE.PENDING, value };
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

      const { code, initInput, value = 0 } = pending;
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
      }, { allowReserved: true });
      tx.delete(pendingKey(programUuid));
      return { programUuid, state: STATE.ACTIVE, initResult, value: pending.value ?? 0 };
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

      const refund = pending.value ?? 0;
      if (refund > 0) this.moveNative(tx, programUuid, pending.context.sender, refund); // คืนเงินให้ผู้ deploy

      tx.delete(pendingKey(programUuid));
      return { programUuid, state: STATE.REJECTED, refund };
    }, options);
  }

  /** user เรียกฟังก์ชันที่ export */
  call({ programUuid, functionName, input = {}, context, nonce, gasLimit, gasPrice, value = 0 } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(programUuid);
      checkContext(context);
      checkValue(value);

      const target = normalizeAddress(programUuid);
      const userContext = this.userContext(context);
      const sender = userContext.sender;
      this.preparePayer(tx, sender, { nonce, gasLimit, gasPrice, value });
      this.rememberTransaction(tx, arguments[0], "call");
      this.seedRandom(tx, arguments[0], "call");
      if (value > 0) this.moveNative(tx, sender, target, value); // แนบเงินไปกับ tx

      return this.runFunction(tx, { programUuid: target, functionName, input, context: userContext, value });
    }, options);
  }

  /** โอน native ระหว่าง address โดยไม่เรียกโปรแกรม */
  transfer({ from, to, amount, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      if (!isNonEmptyString(from) || !isNonEmptyString(to)) fail(ERRORS.invalidAddress);
      if (!Number.isSafeInteger(amount) || amount <= 0) fail(ERRORS.invalidAmount);

      const sender = normalizeAddress(from);
      const recipient = normalizeAddress(to);
      this.preparePayer(tx, sender, { nonce, gasLimit, gasPrice, value: amount });
      this.rememberTransaction(tx, arguments[0], "transfer");
      this.seedRandom(tx, arguments[0], "transfer");

      tx.useGas(tx.gas.call); // ค่าพื้นฐานของ tx
      this.moveNative(tx, sender, recipient, amount);
      return { from: sender, to: recipient, amount };
    }, options);
  }

  /**
   * ข้อมูลที่ใช้ทำ hash ของ tx — มาจาก request ของ user เท่านั้น ไม่มีส่วนของผลลัพธ์
   * call / deploy / transfer: from + nonce ทำให้ไม่ซ้ำอยู่แล้ว
   * init / reject: ไม่มี sender / nonce จึงต้องใช้ blockNumber + index ช่วย
   */
  transactionPayload(request = {}, { action = guessAction(request), blockNumber = null, index = null } = {}) {
    const base = { chainId: this.chainId, action };
    const fee = { nonce: request.nonce ?? null, gasLimit: request.gasLimit ?? null, gasPrice: request.gasPrice ?? null };
    if (action === "transfer") {
      return { ...base, from: normalizeAddress(request.from) ?? null, to: normalizeAddress(request.to) ?? null, amount: request.amount ?? 0, ...fee };
    }
    if (action === "metadata") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, metadata: normalizeHexDeep(request.metadata ?? {}), ...fee };
    }
    if (action === "deploy") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, to: normalizeAddress(request.programUuid) ?? null, code: toOneLine(typeof request.code === "string" ? request.code : ""), initInput: normalizeHexDeep(request.initInput ?? {}), value: request.value ?? 0, ...fee };
    }
    if (action === "call") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null, to: normalizeAddress(request.programUuid) ?? null, method: request.functionName ?? null, input: normalizeHexDeep(request.input ?? {}), value: request.value ?? 0, ...fee };
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
   *   txRoot    = hash ของรายการ tx hash ทั้งหมด (เรียงตาม index)
   *   stateRoot = hash ของ stateRoot ก่อนหน้า + writes ทั้งหมดของ block นี้ (เรียงตาม dbKey)
   */
  hashBlock({ number, parentHash, parentStateRoot = null, timestamp, feeRecipient, burnPercent, txHashes, writes }) {
    const txRoot = this.hashData(txHashes);
    // สะสมจาก block ก่อนหน้า: แก้ข้อมูลย้อนหลังแล้ว root ของทุก block ถัดไปจะไม่ตรงทันที
    const stateRoot = this.hashData({
      parentStateRoot,
      writes: [...writes].sort((a, b) => (a.dbKey < b.dbKey ? -1 : 1)).map((write) => [write.type, write.dbKey, write.value ?? null]),
    });
    const hash = this.hashData({
      chainId: this.chainId, number, parentHash: parentHash ?? null, timestamp,
      feeRecipient: feeRecipient ?? null, burnPercent, txCount: txHashes.length, txRoot, stateRoot,
    });
    return { hash, txRoot, stateRoot };
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
      input: request.input ?? null,
      value: (isTransfer ? request.amount : request.value) ?? 0,
      result: result.result ?? null,
      error: result.error ?? null,
      gasUsed: result.gasUsed ?? 0,
      gasPrice: request.gasPrice ?? null,
      fee: result.fee ?? 0,
      nonce: pick(KEY.NONCE)[0]?.value ?? null,
      events: (result.events ?? []).map((event) => ({ ...event })),
      trace: (result.calls ?? []).map((call) => ({
        depth: call.depth,
        program: call.programUuid,
        method: call.functionName,
        from: call.sender,
        origin: call.origin,
        input: call.input ?? null,
        value: call.value ?? 0,
        result: call.result ?? null,
        gasUsed: call.gasUsed ?? null,
        status: call.status,
        error: call.error ?? null,
      })),
      nativeChanges: pick(KEY.NATIVE).map(({ address, field, value }) => (nativeBefore
        ? { address, field, before: nativeBefore.get(nativeKey(address, field)) ?? 0, after: value }
        : { address, field, after: value })),
      stateChanges: pick(KEY.STORAGE).map(({ address, key, value }) => ({ program: address, key, after: value })),
      programChanges: changes
        .filter((change) => [KEY.PENDING, KEY.CODE, KEY.CONTEXT, KEY.THIS].includes(change.kind))
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

    this.preparePayer(tx, sender, { nonce, gasLimit, gasPrice });
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

      this.preparePayer(tx, address, { nonce, gasLimit, gasPrice });
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
    const [received = 0, sended = 0, consumed = 0] = this.db.readKeys([
      nativeKey(account, NATIVE_FIELD.RECEIVED),
      nativeKey(account, NATIVE_FIELD.SENDED),
      nativeKey(account, NATIVE_FIELD.CONSUMED),
    ]).map((value) => value ?? 0);
    return { received, sended, consumed, balance: received - sended - consumed };
  }

  /** hash ของ genesis ที่บันทึกไว้ */
  genesisHash() {
    return this.read(KEY.GENESIS) ?? null;
  }

  /** ตั้งสถานะเริ่มต้นของ chain แล้วบันทึก hash ไว้ให้ node อื่นเทียบ */
  applyGenesis(genesis = {}) {
    const hash = this.hashData(genesis);
    const current = this.genesisHash();
    if (current !== null) {
      if (current !== hash) fail(ERRORS.genesisMismatch, current, hash);
      return { hash, applied: false };
    }
    if (this.latestBlockNumber() !== null) fail(ERRORS.genesisMismatch, "(มี block แล้ว)", hash);

    const writes = Object.entries(genesis.balances ?? {}).map(([address, amount]) =>
      ({ type: WRITE.PUT, dbKey: nativeKey(normalizeAddress(address), NATIVE_FIELD.RECEIVED), value: amount }));
    writes.push({ type: WRITE.PUT, dbKey: KEY.GENESIS, value: hash });
    this.commit(writes);
    return { hash, applied: true };
  }

  /** เทียบ genesis ที่ node นี้ใช้กับของที่ส่งมา */
  checkGenesis(genesis) {
    const hash = this.hashData(genesis);
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
    return this.listEntries(prefix, { limit, reverse, start }).map((entry) => entry.value);
  }

  /** ค้น event ที่โปรแกรมเคย emit — ใหม่ไปเก่า */
  listEvents({ program, name = "", limit = 20, reverse = true, start } = {}) {
    const prefix = program
      ? joinKey(KEY.EVENT, normalizeAddress(program), name ? `${name}${KEY.SEPARATOR}` : "")
      : `${KEY.EVENT}${KEY.SEPARATOR}`;
    return this.listEntries(prefix, { limit, reverse, start }).map((entry) => entry.value);
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
  getTransaction(hash) {
    const entry = this.read(txIndexKey(hash)) ?? this.read(txIndexKey(this.read(sigTxKey(hash)) ?? ""));
    if (!entry) return null;
    const record = entry.from === null ? null : this.read(txnKey(entry.from, entry.nonce, entry.hash)) ?? null;
    return { ...entry, record };
  }

  /** โปรแกรม token ที่ address นี้เคยได้รับเหรียญ (จาก event Transfer) */
  listHoldings(address, { limit = 200 } = {}) {
    return this.listEntries(`${joinKey(KEY.HOLDING, normalizeAddress(address))}${KEY.SEPARATOR}`, { limit }).map((entry) => entry.value);
  }

  /** รายการ tx ของ address (ใหม่ไปเก่า) */
  listTransactionsOf(address, { limit = 20, reverse = true, start } = {}) {
    const prefix = joinKey(normalizeAddress(address), KEY.TXN, "");
    return this.listEntries(prefix, { limit, reverse, start }).map((entry) => entry.value);
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

  /** ข้อมูลตาม prefix ณ block นั้น (ใช้ blockundo หาว่ามี key อะไรเปลี่ยนไปบ้าง) */
  snapshotAt(number, prefix = "") {
    const keys = new Set(this.listKeys(prefix));
    for (let n = this.latestBlockNumber() ?? 0; n > number; n -= 1) {
      for (const dbKey of this.getBlockUndo(n) ?? []) if (dbKey.startsWith(prefix)) keys.add(dbKey);
    }

    const snapshot = {};
    for (const dbKey of [...keys].sort()) {
      const value = this.stateAt(number, dbKey);
      if (value !== undefined) snapshot[dbKey] = value;
    }
    return snapshot;
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

    // ต้องมี blockundo ของทุก block ที่ใหม่กว่า ไม่งั้นย้อน state กลับไปไม่ได้
    const latest = this.latestBlockNumber() ?? number;
    for (let n = number; n <= latest; n += 1) {
      if (!this.getBlockUndo(n)) fail(ERRORS.historyMissing, n);
    }

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
      timestamp: header.timestamp,
      feeRecipient: header.feeRecipient,
      burnPercent: header.burnPercent,
      checkChain: false,
      recordBlocks: false,
      recordHistory: false,
      maxTransactions: null,
      maxTransactionsPerSender: null,
      maxBlockGas: null,
    });
    for (const { method, request } of body) block[method](request);

    const receipt = block.receipt({ number });
    if (verify && receipt.hash !== header.hash) fail(ERRORS.replayMismatch, number);
    return receipt;
  }

  /**
   * กู้ระบบ: ย้อน state ไปก่อน block 1 แล้วรัน block 1..target ใหม่จาก blockbody
   * ใช้แทน rollback (ช้ากว่าแต่สร้างจากข้อมูลต้นทาง จึงถูกต้องเสมอ)
   */
  rebuildFrom(target, { verify = true } = {}) {
    const latest = this.latestBlockNumber();
    if (latest === null) fail(ERRORS.blockMissing, target);
    if (!Number.isSafeInteger(target) || target < 0 || target > latest) fail(ERRORS.blockMissing, target);

    // เก็บ header + body ของ block ที่จะรันใหม่ไว้ก่อน (ของ block ที่ทิ้งเอาไว้ลบ)
    const kept = [];
    const touched = new Set();
    for (let number = 1; number <= latest; number += 1) {
      const header = this.getBlock(number);
      const undo = this.getBlockUndo(number);
      if (!header || !undo) fail(ERRORS.historyMissing, number);
      for (const dbKey of undo) touched.add(dbKey);
      if (number <= target) kept.push({ header, body: this.getBlockBody(number) ?? [] });
    }

    // 1) คืนทุก key ที่เคยถูกแตะ กลับไปเป็นสถานะก่อน block 1
    const writes = [...touched].map((dbKey) => {
      const before = this.stateAt(0, dbKey);
      return before === undefined ? { type: WRITE.DEL, dbKey } : { type: WRITE.PUT, dbKey, value: before };
    });

    // 2) ลบข้อมูลของ block ทั้งหมด (จะถูกสร้างใหม่ตอน replay ยกเว้นที่เกิน target)
    for (let number = 1; number <= latest; number += 1) {
      for (const dbKey of this.getBlockUndo(number) ?? []) writes.push({ type: WRITE.DEL, dbKey: historyKey(dbKey, number) });
      const header = this.getBlock(number);
      writes.push({ type: WRITE.DEL, dbKey: blockKey(number) });
      writes.push({ type: WRITE.DEL, dbKey: blockBodyKey(number) });
      writes.push({ type: WRITE.DEL, dbKey: blockUndoKey(number) });
      if (header) writes.push({ type: WRITE.DEL, dbKey: blockHashKey(header.hash) });
    }
    writes.push({ type: WRITE.DEL, dbKey: LATEST_BLOCK_KEY });
    this.commit(writes);

    // 3) รัน block 1..target ใหม่
    for (const { header, body } of kept) {
      const block = this.createBlock({
        number: header.number,
        parentHash: header.parentHash,
        parentStateRoot: header.parentStateRoot,
        timestamp: header.timestamp,
        feeRecipient: header.feeRecipient,
        burnPercent: header.burnPercent,
        checkChain: false,
        maxTransactions: null,
        maxTransactionsPerSender: null,
        maxBlockGas: null,
      });
      for (const { method, request } of body) block[method](request);
      if (verify && block.header().hash !== header.hash) fail(ERRORS.replayMismatch, header.number);
      block.commit();
    }

    return {
      from: latest,
      to: target,
      blocks: kept.length,
      keys: touched.size,
      stateRoot: target === 0 ? null : this.getBlock(target)?.stateRoot ?? null,
    };
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
  createTransaction({ read = (dbKey) => this.read(dbKey), timestamp, blockNumber = null, feeRecipient = this.feeRecipient, burnPercent = this.burnPercent } = {}) {
    return new Transaction({
      read,
      timestamp,
      blockNumber,
      timeoutMs: this.timeoutMs,
      maxCallDepth: this.maxCallDepth,
      gas: this.gas,
      chargeGas: this.chargeGas,
      feeRecipient: feeRecipient === null || feeRecipient === undefined ? null : normalizeAddress(feeRecipient),
      burnPercent: checkBurnPercent(burnPercent),
    });
  }

  /** รัน action(tx) แล้วแปลงเป็น response */
  runAction(action, options) {
    const tx = this.createTransaction(options);
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
        gasPrice: tx.gasPrice,
        fee: tx.feeCharged,
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
        gasPrice: tx.gasPrice,
        fee: tx.feeCharged,
        error: { code, message },
        debug: err?.detail ?? null,   // ข้อมูลดีบัก ไม่ถูกบันทึกลง DB และไม่เข้า hash
        calls: tx.calls,
        events: [],   // tx ที่ล้มทั้งใบ = ไม่มี event
        writes,
      };
    }
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
  preparePayer(tx, address, { nonce, gasLimit, gasPrice, value = 0 } = {}) {
    const requestedLimit = checkGasLimit(gasLimit);
    tx.gasPrice = checkGasPrice(gasPrice, this.gas.price); // จ่ายแพงกว่าได้ เพื่อให้ถูกเลือกก่อน
    if (!this.requireNonce && !this.chargeGas && !this.recordTransactions) {
      tx.gasLimit = requestedLimit;
      return;
    }

    const current = tx.current(nonceKey(address)) ?? 0;
    if (this.requireNonce && nonce !== current) fail(ERRORS.invalidNonce, current, nonce);
    tx.payer = { address, nonce: current };

    if (tx.chargeGas) {
      const available = this.nativeBalance(tx, address) - value; // เงินที่เหลือหลังแนบ value ไปกับ tx
      if (available < 0) fail(ERRORS.nativeInsufficient, address);
      tx.gasLimit = Math.min(Math.floor(available / tx.gasPrice), requestedLimit);
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
      signature: request?.signature ?? null,
      digest: request?.digest ?? null, // hash ที่ผู้ใช้เซ็น (EIP-712) — ใช้ค้นย้อนกลับได้
    };
  }

  /** write ของรายการ tx: <address>:txn:<nonce>:<txhash> */
  transactionRecordWrites(tx, { status, error = null }) {
    if (!tx.transaction) return [];
    const { address, nonce } = tx.payer;
    const { hash, action, signature, digest } = tx.transaction;
    return [{
      type: WRITE.PUT,
      dbKey: txnKey(address, nonce, hash),
      value: { hash, action, nonce, status, error, timestamp: tx.timestamp, gasUsed: tx.gasUsed, fee: tx.feeCharged, signature, digest },
    }];
  }

  /** writes ของ nonce + ค่าแก๊ส (แบ่งให้ผู้ปิด block ตาม burnPercent) */
  buildChargeWrites(tx, balance, raw) {
    const { address, nonce } = tx.payer;
    const fee = Math.min(tx.gasFee(), balance);
    tx.feeCharged = fee;
    const writes = [];
    if (this.requireNonce) writes.push({ type: WRITE.PUT, dbKey: nonceKey(address), value: nonce + 1 });
    if (fee <= 0) return writes;

    // ค่าแก๊สเข้าช่อง consumed ของผู้จ่าย ส่วนที่ไม่ได้เผาทิ้งเข้าช่อง received ของผู้ปิด block
    writes.push({
      type: WRITE.PUT,
      dbKey: nativeKey(address, NATIVE_FIELD.CONSUMED),
      value: this.nativeField(tx, address, NATIVE_FIELD.CONSUMED, raw) + fee,
    });

    const reward = tx.feeRecipient ? Math.floor((fee * (100 - tx.burnPercent)) / 100) : 0;
    if (reward > 0) {
      writes.push({
        type: WRITE.PUT,
        dbKey: nativeKey(tx.feeRecipient, NATIVE_FIELD.RECEIVED),
        value: this.nativeField(tx, tx.feeRecipient, NATIVE_FIELD.RECEIVED, raw) + reward,
      });
    }

    const burned = fee - reward; // ส่วนที่เผา → ส่งไปที่ 0x000…000
    if (burned > 0) {
      writes.push({
        type: WRITE.PUT,
        dbKey: nativeKey(BURN_ADDRESS, NATIVE_FIELD.RECEIVED),
        value: this.nativeField(tx, BURN_ADDRESS, NATIVE_FIELD.RECEIVED, raw) + burned,
      });
    }
    return writes;
  }

  chargeOnSuccess(tx) {
    if (!tx.payer) return [];
    const balance = this.nativeBalance(tx, tx.payer.address);
    if (tx.gasFee() > balance) fail(ERRORS.outOfGas, tx.gasUsed, Math.floor(balance / tx.gasPrice));
    return this.buildChargeWrites(tx, balance, false);
  }

  chargeOnFailure(tx) {
    if (!tx.payer) return [];
    try {
      // ค่าใน DB (writes ของ tx ถูกทิ้งไปแล้ว)
      return this.buildChargeWrites(tx, this.nativeBalance(tx, tx.payer.address, true), true);
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
  runFunction(tx, { programUuid: rawProgramUuid, functionName, input = {}, context: rawContext, value = 0, depth = 0, code, isInit = false }) {
    const programUuid = normalizeAddress(rawProgramUuid);
    const context = normalizeContext(rawContext);
    if (depth > tx.maxCallDepth) fail(ERRORS.callDepthExceeded, tx.maxCallDepth);

    const program = this.loadProgram(tx, programUuid, code);
    if (!isInit && !program.exports.includes(functionName)) fail(ERRORS.notCallable, functionName);

    const gasStart = tx.gasUsed;
    tx.useGas(tx.gas.call);
    const record = tx.startCall({ depth, programUuid, functionName, context, input, value, gasStart });

    try {
      const api = this.createProgramApi(tx, { programUuid, context, depth });
      const params = {
        input: toProgram(toInputValue(input, "input") ?? {}, "input", this.bigintValues),
        context: pickContext(context),
        value: this.bigintValues ? BigInt(value) : value,   // native ที่แนบมากับการเรียกนี้
        block: { timestamp: this.bigintValues ? BigInt(tx.timestamp) : tx.timestamp },
      };
      const result = this.invokeProgram(tx, program, api, functionName, params, depth);
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

  /** ชั้นนอกสุดจับเวลา, ชั้นในรันตรงภายใต้เวลาเดียวกัน */
  invokeProgram(tx, program, api, functionName, params, depth) {
    const invoke = () => program.create(api)[functionName](params);
    const result = depth === 0 ? runWithTimeout(invoke, tx.remainingTime()) : invoke();
    if (typeof result?.then === "function") fail(ERRORS.asyncNotSupported);
    // ค่าที่ออกจากโปรแกรม: BigInt ถูกแปลงเป็น "123n" เพื่อให้ส่งเป็น JSON ได้
    return this.checkValueSize(fromProgram(result, "ค่าที่ return", this.bigintValues), "ค่าที่ return");
  }

  // ---------- API ที่โปรแกรมเรียกใช้ ----------

  /** ทุกฟังก์ชันหยุดทันทีถ้า DB พังไปแล้วใน request นี้ */
  createProgramApi(tx, caller) {
    const { programUuid } = caller;
    const guard = (fn) => (...args) => {
      tx.assertAlive();
      return fn(...args);
    };
    return {
      map,
      Date: tx.Date,
      Math: tx.Math,
      ThisAddress: () => programUuid,
      ThisBalance: guard(() => this.toAmount(this.programNativeBalance(tx, programUuid))),
      BalanceOf: guard((address) => this.toAmount(this.programNativeBalance(tx, address))),
      IsProgram: guard((address) => this.programIsProgram(tx, address)),
      MetadataOf: guard((address, field) => toProgram(this.programMetadataOf(tx, address, field) ?? null, "metadata", this.bigintValues)),
      BlockNumber: () => (tx.blockNumber === null ? null : this.toAmount(tx.blockNumber)),
      readDB: guard((key) => this.programReadDB(tx, programUuid, key)),
      writeDB: guard((key, value) => this.programWriteDB(tx, programUuid, key, value)),
      deleteDB: guard((key) => this.programDeleteDB(tx, programUuid, key)),
      transferNative: guard((to, amount) => this.programTransferNative(tx, programUuid, to, this.fromAmount(amount))),
      setMetadata: guard((field, value) => this.programSetMetadata(tx, programUuid, field, value === null ? null : fromProgram(value, "metadata", this.bigintValues))),
      emit: guard((name, data) => this.programEmit(tx, programUuid, caller.depth, name, fromProgram(data ?? {}, "event", this.bigintValues))),
      keccak256: guard((value) => this.programKeccak(tx, typeof value === "string" ? value : fromProgram(value, "ค่าที่ keccak256", this.bigintValues))),
      ecrecover: guard((value, signature) => this.programEcrecover(tx, typeof value === "string" ? value : fromProgram(value, "ค่าที่ ecrecover", this.bigintValues), signature)),
      runProgram: guard((target, functionName, input, options) => toProgram(
        this.programRunProgram(tx, caller, target, functionName,
          this.bigintValues ? fromProgram(input ?? {}, "input", true) : input,
          this.bigintValues ? fromProgramOptions(options) : options) ?? null,
        "ผลลัพธ์", this.bigintValues)),
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
    return value === undefined ? undefined : toProgram(value, "ค่าที่อ่านจาก DB", this.bigintValues);
  }

  programWriteDB(tx, programUuid, key, value) {
    if (value === undefined) fail(ERRORS.writeUndefined);
    const stored = this.checkValueSize(fromProgram(value, "ค่าที่ writeDB", this.bigintValues), "writeDB");
    tx.useGas(tx.gas.write + tx.gas.byte * valueSize(stored));
    tx.put(this.checkKeySize(tx.touch(programUuid, key)), stored);
  }

  programDeleteDB(tx, programUuid, key) {
    tx.useGas(tx.gas.write);
    tx.delete(this.checkKeySize(tx.touch(programUuid, key)));
  }

  /** ยอดสะสมแต่ละช่อง */
  nativeField(tx, address, field, raw = false) {
    const dbKey = nativeKey(address, field);
    return (raw ? tx.readRaw(dbKey) : tx.current(dbKey)) ?? 0;
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
    tx.put(nativeKey(address, field), this.nativeField(tx, address, field) + amount);
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

  /** number → ค่าที่โปรแกรมเห็น (BigInt เมื่อเปิดโหมด bigint) */
  toAmount(value) {
    return this.bigintValues ? BigInt(value) : value;
  }

  /** ค่าที่โปรแกรมส่งมา → number สำหรับใช้ภายใน */
  fromAmount(value, label = "amount") {
    return this.bigintValues ? fromProgramAmount(value, label) : value;
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

  /** กู้ address ของผู้เซ็นจากข้อความ + ลายเซ็น (r + s + v เหมือน EIP-191/712) */
  programEcrecover(tx, value, signature) {
    if (!isNonEmptyString(signature) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) fail(ERRORS.invalidSignature);
    const text = typeof value === "string" ? value : canonicalJson(toJsonValue(value, "ค่าที่ ecrecover"));
    tx.useGas(tx.gas.recover + tx.gas.byte * Buffer.byteLength(text, "utf8"));

    try {
      const digest = hexToBytesStrict(keccak256Hex(text));
      const bytes = hexToBytesStrict(signature);
      const v = bytes[64];
      if (v !== 27 && v !== 28) return null;
      const recovered = new Uint8Array([v - 27, ...bytes.slice(0, 64)]);
      const publicKey = secp256k1.recoverPublicKey(recovered, digest, { prehash: false });
      const uncompressed = secp256k1.Point.fromBytes(publicKey).toBytes(false).slice(1);
      return `0x${bytesToHex(keccak_256(uncompressed)).slice(-40)}`;
    } catch {
      return null;   // ลายเซ็นใช้ไม่ได้ → คืน null ให้โปรแกรมตัดสินใจเอง
    }
  }

  /** บันทึก event ให้ explorer อ่าน (ถูกย้อนพร้อม writes ถ้ากิ่งนั้นล้ม) */
  programEmit(tx, programUuid, depth, name, data = {}) {
    if (!isNonEmptyString(name) || !METADATA_FIELD_PATTERN.test(name)) fail(ERRORS.invalidEventName);
    const value = this.checkValueSize(toInputValue(data, `event '${name}'`) ?? {}, "event");
    tx.useGas(tx.gas.event + tx.gas.byte * valueSize(value));
    tx.events.push({ index: tx.events.length, depth, program: programUuid, name, data: value });
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
    if (!Number.isSafeInteger(amount) || amount <= 0) fail(ERRORS.invalidAmount);
    this.moveNative(tx, programUuid, normalizeAddress(to), amount);
    return true;
  }

  /** sender = โปรแกรมที่เรียก, origin = คงเดิม; ปลายทาง error → ย้อนการเขียนของปลายทางแล้ว throw ให้ผู้เรียกจัดการ */
  programRunProgram(tx, caller, programUuid, functionName, input, { value = 0 } = {}) {
    checkValue(value);
    const savepoint = tx.savepoint();
    try {
      const target = normalizeAddress(programUuid);
      if (value > 0) this.moveNative(tx, caller.programUuid, target, value); // แนบเงินไปกับการเรียก
      const context = { sender: caller.programUuid, origin: caller.context.origin };
      return this.runFunction(tx, { programUuid: target, functionName, input, context, value, depth: caller.depth + 1 });
    } catch (err) {
      tx.rollbackTo(savepoint);
      throw err;
    }
  }
}

/**
 * เรียง tx ที่รออยู่: จ่ายแพงกว่าได้ก่อน แต่ของแต่ละ address ยังเรียงตาม nonce เสมอ
 * @param {Array<{ request: object, receivedAt?: number }>} items
 */
export function sortPendingTransactions(items, { defaultGasPrice = DEFAULT_GAS.price } = {}) {
  const senderOf = (request) => normalizeAddress(request.from ?? request.context?.sender) ?? "";
  const priceOf = (request) => request.gasPrice ?? defaultGasPrice;

  // ราคาของ address = ใบที่ถูกที่สุดในคิวของคนนั้น (กันการใส่ใบแพงใบเดียวเพื่อลัดคิวทั้งชุด)
  const groups = new Map();
  for (const item of items) {
    const sender = senderOf(item.request);
    const group = groups.get(sender) ?? { sender, items: [], price: Infinity, receivedAt: Infinity };
    group.items.push(item);
    group.price = Math.min(group.price, priceOf(item.request));
    group.receivedAt = Math.min(group.receivedAt, item.receivedAt ?? 0);
    groups.set(sender, group);
  }

  return [...groups.values()]
    .sort((a, b) => b.price - a.price || a.receivedAt - b.receivedAt || (a.sender < b.sender ? -1 : 1))
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

  constructor(vm, {
    read = (dbKey) => vm.read(dbKey),
    timestamp = RealDate.now(),
    feeRecipient = vm.feeRecipient,
    burnPercent = vm.burnPercent,
    number,
    parentHash,
    parentStateRoot,
    recordBlocks = vm.recordBlocks,
    recordHistory = vm.recordHistory,
    checkChain = true,
    maxTransactions = vm.maxTransactions,
    maxTransactionsPerSender = vm.maxTransactionsPerSender,
    maxBlockGas = vm.maxBlockGas,
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
    this.#maxTransactions = maxTransactions;
    this.#maxTransactionsPerSender = maxTransactionsPerSender;
    this.#maxBlockGas = maxBlockGas;

    if (this.#number !== null && checkChain) {
      if (vm.getBlock(this.#number)) fail(ERRORS.blockExists, this.#number);
      if (previous && timestamp <= previous.timestamp) fail(ERRORS.blockTimestampOrder, timestamp, previous.timestamp);
    }
    this.#feeRecipient = feeRecipient === null || feeRecipient === undefined ? null : normalizeAddress(feeRecipient);
    this.#burnPercent = checkBurnPercent(burnPercent);
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
    const chainKinds = [KEY.HISTORY, KEY.BLOCK, KEY.BLOCK_BODY, KEY.BLOCK_UNDO, KEY.BLOCK_HASH, KEY.LATEST_BLOCK];
    const keys = [...new Set(writes.map((write) => write.dbKey))]
      .filter((dbKey) => !chainKinds.includes(decodeDbKey(dbKey).kind));
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

  /** hash ของ block: { hash, parentHash, txRoot, stateRoot } */
  hashes() {
    const writes = this.stateWrites();
    const txHashes = this.txHashes();
    const { hash, txRoot, stateRoot } = this.#vm.hashBlock({
      number: this.#number,
      parentHash: this.#parentHash,
      parentStateRoot: this.#parentStateRoot,
      timestamp: this.#timestamp,
      feeRecipient: this.#feeRecipient,
      burnPercent: this.#burnPercent,
      txHashes,
      writes,
    });
    return { hash, parentHash: this.#parentHash, parentStateRoot: this.#parentStateRoot, txRoot, stateRoot };
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
            blockNumber: this.#number, index, timestamp: this.#timestamp,
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
            hash, action: "call", status: call.status, txStatus: result.status,
            from: normalizeAddress(call.sender ?? call.context?.sender) ?? null,
            method: call.functionName ?? null,
            depth: call.depth, via: normalizeAddress(request.programUuid) ?? null, value: 0,
            blockNumber: this.#number, index, timestamp: this.#timestamp,
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
        // event Transfer ของ token → จำว่า address ปลายทางถือเหรียญของโปรแกรมนี้ (ยอดจริงอ่านจาก balanceOf ตอนแสดง)
        if (event.name === "Transfer" && result.status === STATUS.SUCCESS) {
          for (const holder of [event.data?.to, event.data?.from]) {
            if (!isWalletAddress(holder) || /^0x0{40}$/i.test(holder)) continue;
            writes.push({ type: WRITE.PUT, dbKey: holdingKey(normalizeAddress(holder), event.program),
              value: { program: event.program, lastBlock: this.#number } });
          }
        }
      }
    });
    return writes;
  }

  /** tx ดิบของทุกใบใน block ตามลำดับ (ใช้ replay ได้) */
  body() {
    return this.#requests.map(({ action, method, request }) => ({ action, method, request: copyValue(request) }));
  }

  /** header ของ block (ไม่มีรายละเอียด tx) */
  header() {
    const txHashes = this.txHashes();
    const { hash, txRoot, stateRoot } = this.hashes();
    const statuses = this.#results.map((result) => result.status);
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
      fee: this.#results.reduce((sum, result) => sum + (result.fee ?? 0), 0),
      parentStateRoot: this.#parentStateRoot,
      txRoot,
      stateRoot,
      txHashes,
    };
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
      txCount: transactions.length,
      successCount: transactions.filter((tx) => tx.status === STATUS.SUCCESS).length,
      failedCount: transactions.filter((tx) => tx.status === STATUS.THROW).length,
      gasUsed: transactions.reduce((sum, tx) => sum + tx.gasUsed, 0),
      fee: transactions.reduce((sum, tx) => sum + tx.fee, 0),
      transactions,
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
    if (this.#recordBlocks && this.#vm.getBlock(this.#number)) fail(ERRORS.blockExists, this.#number);
    const result = this.#vm.commit(this.writes());
    this.#committed = true;
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
      fee: 0,
      error: { code: error.code, message: error.message },
      calls: [],
      writes: [],
    };
  }

  #execute(method, request, action = method) {
    if (this.#committed) fail(ERRORS.blockCommitted);

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
