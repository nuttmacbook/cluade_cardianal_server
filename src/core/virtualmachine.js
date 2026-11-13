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
 *  const vm = new VirtualMachine(new DB("./data"), { timeoutMs: 1000, maxCallDepth: 8 })  // see db.js
 *
 *  A program is a single scope for the whole file and is valid JavaScript (can be passed through the API as a string as is):
 *    function program() {
 *      function initialization(params) {}   runs once at init; cannot be called from outside
 *      function helper() {}                 not in return = internal to the program only
 *      function transfer(params) {}
 *      return { transfer }                  list of functions callable from outside (last line)
 *    }
 *    The wrapper function can have any name, and `const program = () => { ... }` also works; no import / export
 *
 *  vm.deploy({ programUuid, code, context, initInput })   user submits code → pending
 *  vm.init({ programUuid })                               team approves → runs initialization once
 *  vm.reject({ programUuid })                             team rejects
 *  vm.call({ programUuid, functionName, input, context }) user calls an exported function
 *  vm.transfer({ from, to, amount })                      native transfer between addresses (no program call)
 *
 *  Program upgrades (only for programs with an upgrader; none = immutable forever):
 *    vm.deploy({ ..., upgrader })                            set the upgrader at deploy → written as metadata.upgrader at init
 *    vm.setUpgrader({ programUuid, upgrader, context })      the current upgrader transfers the right (null = renounce → immutable from then on)
 *    vm.upgrade({ programUuid, code, migrateInput, context }) the upgrader submits new code → pending-upgrade:<id> awaiting review
 *    vm.initUpgrade({ programUuid }) / vm.rejectUpgrade(...) team approves / rejects (same rules as init / reject)
 *       approve → replace <id>:code, run migrate(params) once, metadata.version + 1, store <id>:codeversion:<n>
 *       upgradeDelayBlocks = N > 0 → the new code takes effect when block (approval + N) is created; see Block.#activateUpgrades
 *  Program cloning (inside a program): cloneProgram(template, initInput, { salt, value }) → new address (CREATE2-style)
 *
 *  Gas price floor that the chain owner can adjust mid-chain (no fork / chain reset · see setGasConfig):
 *    vm.setGasConfig({ minBaseFee, context })   admin signs → writes gasconfig to state · takes effect from the next block
 *    per-unit prices (DEFAULT_GAS) change only via fork (a leaked admin key cannot make txs free)
 *
 *  Returns { status: "success", result, calls, loadValues, afterValues, writes }
 *      or { status: "throw", error: { code, message }, calls }
 *  On success → vm.commit(res.writes) persists to the DB via db.writeKeys (or persist it yourself)
 *  runProgram error → the caller can catch it (the callee's writes are rolled back); if not caught → it propagates until the whole request fails
 *  timeout / out of gas / memory exceeded / DB read failure → the whole request always fails (cannot be caught)
 *
 *  sandbox: program code runs in QuickJS (WebAssembly), not in the server process; see sandbox.js
 *    1 tx = 1 runtime (memory memoryLimitBytes / stack maxStackBytes counted across the whole call chain)
 *    1 program = 1 context (separate globals) · values always cross the boundary as copies; programs cannot touch host objects
 *    program globals: standard JS built-ins + the block's Date / Math · no eval / new Function / process / require
 *
 *  Time: every call in a block sees the same time (like EVM block.timestamp)
 *    vm.createBlock({ timestamp })  /  vm.call(request, { timestamp })   not given → Date.now() once
 *    inside a program: params.block.timestamp, Date.now(), new Date() all return this value
 *
 *  Receipts for the explorer: vm.buildReceipt(request, result, { index, action }) / block.receipt({ number })
 *    each tx has a hash computed from the user's request only (known before sending; failed txs have one too)
 *    switch to keccak256 with the hashFunction option when creating the VM
 *
 *  Several calls, then commit once
 *    const block = vm.createBlock()
 *    block.call({ ... })      // tx1
 *    block.call({ ... })      // tx2 sees tx1's results
 *    block.loadValues()       // storage keys the whole block read (values before the block)
 *    block.afterValues()      // storage keys the whole block touched (values after the block, changed)
 *    block.writes()           // combined writes of every successful tx
 *    block.commit()           // persist once via db.writeKeys
 *
 *  Program address: set it yourself, or let the VM derive it from keccak256(deployer + nonce) with deriveProgramAddress
 *  Math.random() inside programs is replaced by a tx-bound RNG (re-running gives the same result)
 *
 *  Program APIs: readDB / writeDB / deleteDB / map / runProgram / transferNative / setMetadata / emit
 *                 keccak256 / ecrecover / ThisAddress / ThisBalance / BalanceOf / IsProgram / MetadataOf / BlockNumber
 *                 sha256 / ripemd160 / blake2b / modexp / BlockHash / ChainId / Coinbase / BlockGasLimit / GasPrice / BaseFee / GasLeft
 *                 keccak256Bytes / ecrecoverDigest / eip712Digest / eip712DomainSeparator (raw bytes + EIP-712 as in eth_signTypedData_v4)
 *                 CodeHashOf / CodeSizeOf · runProgram(..., { readonly: true }) = read-only call (STATICCALL)
 *  Numbers in programs must be BigInt only, e.g. 10n (stored in the DB as "123n", converted both ways automatically)
 *    native balances (ThisBalance / BalanceOf) / params.value / params.block.timestamp / BlockNumber() are BigInt
 *    Date.now() / Math still return number → wrap in BigInt() before storing or returning (round decimals first, or pass as a string)
 *
 *  DB keys: pending:<id> | <id>:code | <id>:context | <id>:this | <id>:storage:<a>:<b>...
 *    <id>:this          the program's own address (programs read it with ThisAddress())
 *    <addr>:nonce       wallet tx sequence (prevents duplicate txs); enabled with requireNonce
 *    <addr>:native:received / :sended / :consumed   cumulative totals (only ever increase)
 *       balance = received - sended - consumed  (consumed = gas fees paid)
 *       the "burned" part of gas fees is transferred to 0x000…000, not just dropped
 *    <addr>:metadata:<field>   address metadata (namespace, type, creator, ...)
 *    namespace:<name>          name → address (unique across the whole system)
 *    <addr>:txn:<nonce>:<txhash>  the address's tx list (for the explorer); enabled with recordTransactions
 *    block:<number> | blockbody:<number> | blockhash:<hash> | latestblock | tx:<txhash> | sigtx:<digest>
 *    history:<dbKey>:<number>   value before the change (look up state at any block with a single seek)
 *    blockundo:<number>         list of state keys the block touched (indexes have no history; see isIndexKey)
 *       blockbody = raw txs of every tx in the block (replay can rebuild the entire state)
 *                          block data and tx-by-hash index; enabled with recordBlocks + passing number to createBlock
 *
 *  Gas fees (when chargeGas): call 100 + write 500 + read 100 + 1 per byte read/written
 *    + 1 per code node executed (counters injected at compile time; see gasmeter.js) + builtin per unit of data copied / created
 *      (1 element or 32 characters / bytes: built-in methods · spread · concatenated strings · runProgram input / result; see sandbox.js)
 *    per-tx ceiling = maxTxGas, applied even when gas is not charged → infinite loops end with OUT_OF_GAS
 *    the payer is always the sender of the outermost tx, deducted from <sender>:nativebalance
 *    users may supply their own gasLimit (the maximum is the native balance left after deducting value)
 *    not enough gas → OUT_OF_GAS (programs cannot catch it); failed txs still consume the nonce and gas fee
 *    EIP-1559-style gas fees (see resolveFees / nextBaseFee):
 *      each block has a baseFeePerGas (in the header + hash) adjusted by the previous block's gas used vs gasTarget (±12.5% per block, never below minBaseFee)
 *      a tx sends maxFeePerGas + maxPriorityFeePerGas (or legacy gasPrice = both values) → actual price = min(maxFee, baseFee + priority)
 *      of the base fee portion (gas × baseFee), burnPercent % is burned (default 100); the rest + all tips go to the block closer (feeRecipient)
 *
 *  Attaching funds to a tx: vm.call({ ..., value: 20 })  → transfers native from the sender to the program
 *    deploy can attach too: funds move to the program at deploy, initialization sees them in params.value, reject refunds them
 *    inside a program: params.value, and funds can be forwarded with runProgram(target, fn, input, { value: 20 })
 *
 *  Addresses (wallet / program): programUuid, sender, origin → always lowercase
 *    0x… hex strings in input and in storage keys → lowercase (other strings unchanged)
 */

// ============================================================================
//  frequently tuned values
// ============================================================================

export const DEFAULT_OPTIONS = {
  timeoutMs: 1000,     // total time per request (including chained program calls)
  maxCallDepth: 8,     // how many levels runProgram can nest
  requireNonce: false, // require every user tx to include a nonce
  chargeGas: false,    // deduct gas fees from <sender>:nativebalance
  burnPercent: 100,    // share of the base fee burned (%); the rest goes to feeRecipient · tips (priority fee) always go to feeRecipient
  minBaseFee: null,              // minimum base fee (also the first block's); null = gas.price
  gasTarget: null,               // target gas per block (EIP-1559); null = maxBlockGas / 2 · neither set = base fee fixed at minBaseFee
  baseFeeChangeDenominator: 8,   // base fee may change by at most 1/8 (12.5%) per block
  feeRecipient: null,  // block closer (can be set per block in createBlock)
  chainId: 1,          // prevents a tx from one system being replayed on another
  recordTransactions: false, // also write <address>:txn:<nonce>:<txhash> along with the tx's writes
  recordBlocks: false,       // write block:<number> / blockhash:<hash> / latestblock / tx:<hash>
  deriveProgramAddress: false, // always derive program addresses from keccak256(deployer + nonce)
  forceOriginFromSender: true, // user txs: origin = sender always (prevents origin spoofing)
  maxTransactions: null,          // maximum txs per block (null = unlimited)
  maxTransactionsPerSender: null, // maximum txs per address in 1 block
  maxBlockGas: null,              // maximum total gas per block
  maxTxGas: 10_000_000,           // maximum gas per tx / query (infinite loops stop here with OUT_OF_GAS even when gas is not charged)
  admins: null,                   // addresses allowed to call init / reject (null = anyone)
  maxCodeSize: 64 * 1024,         // maximum code size per program
  maxKeySize: 1000,               // maximum storage key length (leaves room for the history: prefix)
  autoReview: false,              // true = review code against the allowlist at deploy (instead of human review)
  maxValueSize: 64 * 1024,        // maximum size of each value written / returned / emitted
  recordHistory: false,           // store history:<key>:<block> + blockundo:<block> (must be on to look back / recover the system)
  upgradeDelayBlocks: 0,          // upgrade timelock: 0 = new code takes effect as soon as approved, N = takes effect at block (approval + N)
  memoryLimitBytes: SANDBOX_DEFAULTS.memoryLimitBytes, // sandbox memory per tx (across all programs in the call chain); exceeded → OUT_OF_MEMORY
  maxStackBytes: SANDBOX_DEFAULTS.maxStackBytes,       // sandbox stack per tx (nesting function calls too deep → a catchable RangeError)
  wallClock: false,               // expose performance.now() (real time) to programs; for tests only, results differ across machines
  producer: null,                 // this node's block producer { address, sign(blockHash) → signature } · null = blocks have no producer (legacy)
  replayTimeoutMs: 60_000,        // per-tx time during replay / rebuild / sync; the producer already filtered TIMEOUTs, so gas stops first (slower machines produce no divergence)
  forks: {},                      // fork table { name: activation block } (genesis.json "forks") · see FORKS
  forkRules: {},                  // extra fork rules on top of FORKS (used in tests)
  historyKeep: null,              // pruning: keep history for only the latest N blocks (state lookback / replay limited to that range) · null = keep everything (archive)
};

/** length of block numbers in keys (zero-padded so lexical order matches numeric order) */
export const BLOCK_NUMBER_WIDTH = 12;

/** program address = last 20 bytes of a hash (there is no private key, so nobody can sign txs as the program) */
export const addressFromHash = (hash) => `0x${hash.slice(-40)}`;

/** default hash: keccak256, same as the EVM (changeable with the hashFunction option) */
const hexToBytesStrict = (hex) => hexToBytes(String(hex).replace(/^0x/, ""));
/** hash precompiles programs can call (name = API name = name in the gas table) */
const DIGESTS = { sha256, ripemd160, blake2b };
/** bit count of a non-negative BigInt (0n → 0) */
const bitLength = (value) => {
  if (value === 0n) return 0;
  const hex = value.toString(16);
  return (hex.length - 1) * 4 + Number.parseInt(hex[0], 16).toString(2).length;
};

/** gas fee table */
export const DEFAULT_GAS = {
  call: 100,   // per program call (including the outermost)
  read: 100,   // per readDB call
  write: 500,  // per writeDB / deleteDB call
  stateKey: 1000, // per state key a tx writes / deletes for the first time (cost of Merkle trie + history updates at block close · rewriting the same key in the same tx is not charged again)
  byte: 1,     // per byte of data read / written
  event: 200,  // per event (plus the byte cost of the event data)
  hash: 100,   // per keccak256 call (plus the byte cost of the data)
  recover: 3000, // per ecrecover call (computationally heavy)
  sha256: 100,    // per sha256 call (plus the byte cost of the data)
  ripemd160: 300, // per ripemd160 call (plus the byte cost of the data; about 3× slower than sha256)
  blake2b: 100,   // per blake2b call (plus the byte cost of the data)
  modexp: 200,    // minimum per modexp call, plus ⌊words² × exponent bits / 3⌋ (word = 8 bytes of the longest of base / mod, as in EIP-2565)
  env: 10,        // per call of ChainId / Coinbase / BlockGasLimit / GasPrice / BaseFee / GasLeft
  topic: 375,     // per field emitted as indexed (writes 1 permanent index key per field, like EVM LOG topics)
  code: 10,    // per byte of code at deploy (occupies permanent DB space)
  node: 1,     // per AST node the program executes (counter injected at compile time; see gasmeter.js)
  builtin: 1,  // per unit of data copied / created: 1 element (array / property / Set / Map / argument) or 32 characters / bytes (rounded up)
               //   built-in methods (join, split, slice, JSON.stringify …) · spread [...a] f(...a) { ...o } · a + b yielding a string · template
               //   ArrayBuffer / typed array / RegExp by size · runProgram input / result (see sandbox.js "gas by data size")
  tx: 0,       // base cost per user tx (charged at the start of every kind of tx · roughly EIP intrinsic gas) · 0 = not charged · the "bluewolf" fork sets 15,000
  price: 1,    // native per 1 gas
};

/**
 * fork: change chain rules from a given block on (like an Ethereum hard fork) without resetting the chain
 *   the table (which block each fork activates at) lives in genesis.json `"forks": { "<name>": <block> }`; it is not part of the genesis hash, so it can be added later
 *   each fork's rules live in the code here · a node whose code does not know a name in genesis refuses to start (the software must be updated first)
 *   blocks before the given number use the old rules → replay / sync / rebuild of old blocks gives byte-identical results
 *   nodes with different tables = block hashes diverge from that block on (sync stops) · every machine must update before reaching that block
 *
 *   name → { description, gas?: { gas field name: new value } }
 *     gas: replaces values in DEFAULT_GAS from that block on (except price; the minimum price is in genesis.config.minBaseFee)
 *     other kinds of rules (new header fields, new instructions) → check vm.forkActive("<name>", blockNumber) where the behaviour changes
 */
export const FORKS = {
  // Bluewolfchain: per-unit price = 2.5× the measured machine load (measured 11 Nov 2026 · 1 ms CPU = 2,000 gas · 1 DB byte = 2 gas)
  //   used with 5M-gas blocks · a block every 2 seconds · min gas price 10,000 gwei → a native coin transfer costs ~17,300 gas
  //   genesis.json: "forks": { "bluewolf": 0 } = active from the first block · values not measured (hash, recover, env …) keep their old values
  bluewolf: {
    description: "Bluewolfchain gas: unit prices at 2.5x the measured machine load + 15,000 base gas per transaction",
    gas: { call: 1750, read: 150, write: 125, stateKey: 1125, byte: 10, event: 1250, topic: 940, code: 33, node: 3, builtin: 3, tx: 15000 },
  },
};

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

/** all errors: code + message (message may be a function) */
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
  invalidTransferAmount: [INVALID_REQUEST, "amount ต้องเป็นจำนวนเต็มไม่ติดลบ"],   // native transfer (tx); transferring 0 is allowed, as in the EVM
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
  gasConfigNeedsAdmins: [FORBIDDEN, "ปรับค่าแก๊สได้เฉพาะเชนที่ตั้ง admins ไว้ (genesis config.admins)"],
  notGasAdmin: [FORBIDDEN, (address) => `'${address}' ไม่มีสิทธิ์ปรับค่าแก๊ส (ต้องอยู่ใน admins)`],
  invalidGasConfig: [INVALID_REQUEST, (detail) => `setGasConfig: ${detail}`],
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
//  constants
// ============================================================================

const INIT_FUNCTION = "initialization";
const MIGRATE_FUNCTION = "migrate";   // runs once at upgrade time; like initialization, it cannot be called from outside
const KEY = { SEPARATOR: ":", PENDING: "pending", CODE: "code", CONTEXT: "context", STORAGE: "storage", THIS: "this", NONCE: "nonce", NATIVE: "native", TXN: "txn",
  METADATA: "metadata", NAMESPACE: "namespace", EVENT: "event", EVENT_INDEX: "eventidx", EVENT_SIG: "eventsig", TX_TO: "txto",
  BLOCK: "block", BLOCK_BODY: "blockbody", BLOCK_HASH: "blockhash", LATEST_BLOCK: "latestblock", TX: "tx", GENESIS: "genesis",
  HISTORY: "history", HISTORY_FROM: "historyfrom", BLOCK_UNDO: "blockundo", SIG_TX: "sigtx", HOLDING: "holding",
  PENDING_UPGRADE: "pending-upgrade", SCHEDULED_UPGRADE: "scheduled-upgrade", UPGRADE_AT: "upgradeat", CODE_VERSION: "codeversion",
  GAS_CONFIG: "gasconfig" };
const PROGRAM_API_NAMES = [
  "readDB", "writeDB", "deleteDB", "map", "runProgram", "transferNative", "setMetadata", "emit",
  "keccak256", "ecrecover", "cloneProgram",
  "ThisAddress", "ThisBalance", "BalanceOf", "IsProgram", "MetadataOf", "BlockNumber", "Date", "Math",
  "sha256", "ripemd160", "blake2b", "modexp",
  "BlockHash", "ChainId", "Coinbase", "BlockGasLimit", "GasPrice", "BaseFee", "GasLeft", "CodeHashOf", "CodeSizeOf",
  "keccak256Bytes", "ecrecoverDigest", "eip712Digest", "eip712DomainSeparator",
];

/** how many blocks back BlockHash can reach (like the EVM's BLOCKHASH) */
export const BLOCK_HASH_WINDOW = 256;
/** maximum size of each modexp value (like EIP-7823) */
export const MODEXP_MAX_BYTES = 1024;

/**
 * A program is a single scope for the whole file and is valid JavaScript (editors / prettier work on it)
 *   function program() {
 *     function initialization(params) {}
 *     function transfer(params) {}
 *     return { transfer }        ← list of functions callable from outside (last line)
 *   }
 * Write it as a string and pass it through the API as is, or use String(program) from a real file
 */
const PROGRAM_WRAPPER_PATTERN = /^\s*(?:const|let|var)?\s*(?:program\s*=\s*)?(?:async\s+)?(?:function\s*[A-Za-z_$][\w$]*?\s*\(\s*\)|\(\s*\)\s*=>)\s*\{([\s\S]*)\}\s*;?\s*$/;
const RETURN_EXPORT_PATTERN = /return\s*\{([^}]*)\}\s*;?\s*$/;
const MODULE_KEYWORD_PATTERN = /^[ \t]*(import|export)\b/m;
const FUNCTION_PATTERN = /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
// supports modifiers: const name = onlyOwner(function () {...}); the value must be a function at run time
const BINDING_PATTERN = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm;

const STATUS = { SUCCESS: "success", THROW: "throw", RUNNING: "running" };
const STATE = { PENDING: "pending_review", ACTIVE: "active", REJECTED: "rejected", SCHEDULED: "scheduled" };
const WRITE = { PUT: "put", DEL: "del" };

const METADATA_FIELD_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const NODE_VM_TIMEOUT_CODE = "ERR_SCRIPT_EXECUTION_TIMEOUT";   // a program throwing { code: this value } = TIMEOUT (legacy node:vm behaviour)
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

  /** convert any error raised while running a program */
  static fromProgram(err) {
    if (err instanceof VMError) return err;
    if (err?.code === NODE_VM_TIMEOUT_CODE) return VMError.from(ERRORS.timeout);
    // V8 messages (TypeError etc.) can differ across Node versions → replaced with fixed messages
    if (err instanceof Error) {
      const name = err.constructor?.name ?? "Error";
      const error = new VMError(PROGRAM_ERROR, name === "Error" ? err.message : `โปรแกรมทำงานผิดพลาด (${name})`);
      // the real details are for debugging only; not stored in the DB and not part of any hash
      error.detail = { name, message: err.message, at: locateInProgram(err) };
      return error;
    }
    return new VMError(PROGRAM_ERROR, String(err));
  }

  /** error a program throws inside the sandbox (received as name + message); same rules as fromProgram */
  static fromGuest({ name, message, stack }) {
    const error = new VMError(PROGRAM_ERROR, name === "Error" ? message : `โปรแกรมทำงานผิดพลาด (${name})`);
    error.detail = { name, message, at: locateInGuest(stack) };
    return error;
  }
}

/** position from a QuickJS stack: "at f (program:12:5)" */
function locateInGuest(stack) {
  const match = /\(program:(\d+):(\d+)\)/.exec(stack ?? "");
  return match ? `line ${match[1]}, col ${match[2]}` : null;
}

/** rough position in the compiled code (code is stored as a single line, so the numbers are only a hint) */
function locateInProgram(err) {
  const match = /<anonymous>:(\d+):(\d+)/.exec(err.stack ?? "");
  return match ? `line ${match[1]}, col ${match[2]}` : null;
}

export function fail(definition, ...args) {
  throw VMError.from(definition, ...args);
}

// ============================================================================
//  helper functions (stateless)
// ============================================================================

export const copyValue = (value) => (value === undefined ? undefined : structuredClone(value));
export const isSameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const isNonEmptyString = (value) => typeof value === "string" && value !== "";
export const pickContext = ({ sender, origin }) => ({ sender, origin });

// ---------- address ----------

/** wallet / program addresses are always lowercase */
const isWalletAddress = (value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value);

export const normalizeContext = ({ sender, origin }) => ({ sender: normalizeAddress(sender), origin: normalizeAddress(origin) });

/** program input: JSON copy, then normalize addresses */
export const toInputValue = (value, label) => normalizeHexDeep(toJsonValue(value, label));

/** data size in bytes for gas charging (gas by data size inside programs is charged in the sandbox; see sandbox.js) */
export const valueSize = (value) => (value === undefined ? 0 : Buffer.byteLength(JSON.stringify(encodeBigints(value)) ?? "", "utf8"));

/** data units of values copied across the boundary between programs: 1 unit per 32 bytes of JSON (rounded up); same unit as the sandbox */
export const copyUnits = (value) => Math.ceil(valueSize(value) / 32);

/** numbers are stored as strings ending in n, e.g. "1000n", because JSON has no BigInt */
const BIGINT_TEXT = /^-?\d+n$/;

/** BigInt → "123n" (whole object) for storing in the DB or exporting as JSON */
export function encodeBigints(value) {
  if (typeof value === "bigint") return `${value}n`;
  if (Array.isArray(value)) return value.map(encodeBigints);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeBigints(item)]));
  }
  return value;
}

/** "123n" → BigInt, and integers from JSON → BigInt (used when passing values into a program) */
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

/** amounts sent by a program must be BigInt (number → numberNotAllowed) */
export function fromProgramAmount(amount, label = "amount") {
  if (typeof amount === "number") fail(ERRORS.numberNotAllowed, label);
  if (typeof amount !== "bigint") fail(ERRORS.invalidAmount);
  return amount;
}

/** runProgram options: { value } as BigInt · { readonly: true } = read-only call (STATICCALL) */
export function fromProgramOptions(options) {
  if (options === undefined || options === null) return undefined;
  const { value, readonly } = options;
  if (readonly !== undefined && readonly !== null && typeof readonly !== "boolean") fail(ERRORS.invalidReadonly);
  return {
    ...(value === undefined ? {} : { value: fromProgramAmount(value, "value") }),
    ...(readonly ? { readonly: true } : {}),
  };
}

/** values into / out of programs: "123n" ↔ BigInt converted both ways automatically */
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

/** convert code to a single line: newlines are stored as escaped "\\n", so they convert back exactly */
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
/** cumulative totals of an address (only ever increase) */
export const NATIVE_FIELD = { RECEIVED: "received", SENDED: "sended", CONSUMED: "consumed" };
export const nativeKey = (address, field) => joinKey(address, KEY.NATIVE, field);
export const metadataKey = (address, field) => joinKey(address, KEY.METADATA, field);
export const namespaceKey = (name) => joinKey(KEY.NAMESPACE, name);
/** upgrades awaiting review / approved but waiting on the timelock / index of "which block activates whose code" / every code version */
export const pendingUpgradeKey = (programUuid) => joinKey(KEY.PENDING_UPGRADE, programUuid);
export const scheduledUpgradeKey = (programUuid) => joinKey(KEY.SCHEDULED_UPGRADE, programUuid);
/** gas price floor set on-chain by the admin (a single state key · in stateRoot / history like other state) */
export const GAS_CONFIG_KEY = KEY.GAS_CONFIG;
export const upgradeAtKey = (number) => joinKey(KEY.UPGRADE_AT, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const codeVersionKey = (programUuid, version) => joinKey(programUuid, KEY.CODE_VERSION, String(version));

/** destination address for burned funds (lets anyone audit the total burned) */
export const BURN_ADDRESS = `0x${"0".repeat(40)}`;

/** metadata fields the system uses itself; users cannot overwrite them */
export const METADATA_FIELD = {
  NAMESPACE: "namespace",   // human-readable name (unique across the whole system)
  TYPE: "type",             // "program"; set by the VM at init
  CREATOR: "creator",       // deployer
  CREATED_AT: "createdAt",  // timestamp of the block at init
  DESCRIPTION: "description",
  URL: "url",
  ICON: "icon",
  TAGS: "tags",
  UPGRADER: "upgrader",     // who may submit new code (none = the program is immutable forever)
  VERSION: "version",       // code version (none = 1); incremented by 1 on every upgrade
  TEMPLATE: "template",     // template program (only for programs created with cloneProgram)
  ABI: "abi",               // function / event descriptions (optional · validated by checkAbi); the explorer uses them to build forms and decode events
};
export const RESERVED_METADATA = [METADATA_FIELD.TYPE, METADATA_FIELD.CREATOR, METADATA_FIELD.CREATED_AT,
  METADATA_FIELD.UPGRADER, METADATA_FIELD.VERSION, METADATA_FIELD.TEMPLATE];
export const txnKey = (address, nonce, hash) => joinKey(address, KEY.TXN, String(nonce), hash);
export const blockKey = (number) => joinKey(KEY.BLOCK, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const blockBodyKey = (number) => joinKey(KEY.BLOCK_BODY, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const blockHashKey = (hash) => joinKey(KEY.BLOCK_HASH, hash);
export const txIndexKey = (hash) => joinKey(KEY.TX, hash);
export const sigTxKey = (digest) => joinKey(KEY.SIG_TX, digest);

/** index of "who interacted with this address": txto:<address>:<block>:<index> */
export const txToKey = (address, number, index, callIndex = 0) =>
  joinKey(KEY.TX_TO, address, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"),
    String(index).padStart(4, "0"), String(callIndex).padStart(4, "0"));

/** event index: event:<program>:<name>:<block>:<txIndex>:<eventIndex> */
export const eventKey = (program, name, number, txIndex, eventIndex) =>
  joinKey(KEY.EVENT, program, name,
    String(number).padStart(BLOCK_NUMBER_WIDTH, "0"),
    String(txIndex).padStart(4, "0"),
    String(eventIndex).padStart(4, "0"));
/**
 * Index of fields emitted as indexed (written at block close · 1 key per field per event · value = the event: dbKey)
 *   eventidx:<program>:<name>:<field>:<topic>:<block>:<txIndex>:<eventIndex>   topic = topicOf(value) (0x + 64 hex)
 *   eventsig:<topic0>:<program>:<name>  → { program, name, indexed }  (EVM-style log topic0 → event name / indexed fields · used by eth_getLogs)
 */
export const eventIndexPrefix = (program, name, field, topic) => `${joinKey(KEY.EVENT_INDEX, program, name, field, String(topic).toLowerCase())}${KEY.SEPARATOR}`;
export const eventIndexKey = (program, name, field, topic, number, txIndex, eventIndex) =>
  `${eventIndexPrefix(program, name, field, topic)}${joinKey(String(number).padStart(BLOCK_NUMBER_WIDTH, "0"), String(txIndex).padStart(4, "0"), String(eventIndex).padStart(4, "0"))}`;
export const eventSigKey = (topic0, program, name) => joinKey(KEY.EVENT_SIG, String(topic0).toLowerCase(), program, name);
/** index of "this address has received tokens from this program" (from Transfer events); the real balance is read from the program's balanceOf */
export const holdingKey = (address, program) => joinKey(KEY.HOLDING, address, program);
/** events that feed the holding index (with data.from / data.to): Transfer of token / NFT, TransferSingle / TransferBatch of multi-token */
export const HOLDING_EVENTS = new Set(["Transfer", "TransferSingle", "TransferBatch"]);
export const blockUndoKey = (number) => joinKey(KEY.BLOCK_UNDO, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));

/**
 * Rejected txs (passed signature checks but were not executed) that the producer recorded in a block: not executed, no state touched, no nonce consumed, no gas fee
 *   blockrejected:<block>             list for the whole block (in rejection order) · the header has rejectedCount + rejectedRoot (part of the block hash)
 *   rejtx:<hash>                      lookup index by hash (rejected again in a later block = points to the latest)
 *   rejfrom:<sender>:<block>:<index>  index by sender (explorer paging)
 */
export const REJECTED_KEY = { BLOCK: "blockrejected", TX: "rejtx", FROM: "rejfrom" };
/**
 * Indexes: written only at block close, never read while running txs, and rebuildable from blockbody
 *   → no history / not in blockundo · rebuildFrom deletes them and lets replay rebuild them
 */
const INDEX_KINDS = new Set([KEY.TX, KEY.TXN, KEY.SIG_TX, KEY.TX_TO, KEY.EVENT, KEY.EVENT_INDEX, KEY.EVENT_SIG, KEY.HOLDING]);
const REJECTED_HEADS = new Set(Object.values(REJECTED_KEY));
export const isIndexKey = (dbKey) => INDEX_KINDS.has(decodeDbKey(dbKey).kind) || REJECTED_HEADS.has(dbKey.split(KEY.SEPARATOR, 1)[0]);
/** prefixes of indexes that start with a type (txn starts with an address, so it is deleted via the tx index) · blockrejected is deleted per block */
const INDEX_PREFIXES = [KEY.TX, KEY.SIG_TX, KEY.TX_TO, KEY.EVENT, KEY.EVENT_INDEX, KEY.EVENT_SIG, KEY.HOLDING, REJECTED_KEY.TX, REJECTED_KEY.FROM]
  .map((head) => `${head}${KEY.SEPARATOR}`);
export const REJECTED_STAGES = ["sendtx", "block", "expired"];
export const MAX_REJECTED_REASON = 500;
export const blockRejectedKey = (number) => joinKey(REJECTED_KEY.BLOCK, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const rejectedTxKey = (hash) => joinKey(REJECTED_KEY.TX, hash);
export const rejectedFromKey = (sender, number, index) =>
  joinKey(REJECTED_KEY.FROM, sender, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"), String(index).padStart(6, "0"));

/** the value of a key before it changed at a given block; sorted by key, so a backwards lookup takes a single seek */
export const historyKey = (dbKey, number) => joinKey(KEY.HISTORY, dbKey, String(number).padStart(BLOCK_NUMBER_WIDTH, "0"));
export const historyPrefix = (dbKey) => `${joinKey(KEY.HISTORY, dbKey)}${KEY.SEPARATOR}`;
export const LATEST_BLOCK_KEY = KEY.LATEST_BLOCK;
/** first block from which history is continuous up to the latest (replayBlock / snapshotAt check once instead of walking blockundo for every block) */
export const HISTORY_FROM_KEY = KEY.HISTORY_FROM;
/** the chain's own data (blocks / history); not state: rebuildable from the bodies */
const CHAIN_KINDS = new Set([KEY.HISTORY, KEY.BLOCK, KEY.BLOCK_BODY, KEY.BLOCK_UNDO, KEY.BLOCK_HASH, KEY.LATEST_BLOCK]);
/**
 * State keys (read / written by txs) = in the trie (stateRoot) · have history · included in snapshots
 * Not state: blocks / history / indexes / historyfrom / genesis (the genesis hash) / the trie's own nodes
 */
export const isStateKey = (dbKey) => !dbKey.startsWith(TRIE_PREFIX) && dbKey !== HISTORY_FROM_KEY && dbKey !== KEY.GENESIS
  && !CHAIN_KINDS.has(decodeDbKey(dbKey).kind) && !isIndexKey(dbKey);
const KEY_END = "\uffff";

/** nested key: map("balances", "alice") */
export const map = (...parts) => ({ [MAP_PARTS]: parts });

export function getKeyParts(key) {
  const parts = typeof key === "string" ? [key] : key?.[MAP_PARTS];
  if (!parts?.length) fail(ERRORS.invalidKey);
  if (!parts.every((part) => isNonEmptyString(part) || Number.isInteger(part) || typeof part === "bigint")) fail(ERRORS.invalidKeyPart);
  return parts.map((part) => normalizeHex(typeof part === "bigint" ? `${part}` : part));
}

/** encodes every part: "a:b" and map("a", "b") are therefore different keys */
export function storageKey(programUuid, key) {
  const encoded = getKeyParts(key).map((part) => encodeURIComponent(String(part)));
  return joinKey(programUuid, KEY.STORAGE, ...encoded);
}

/** infer the action from the shape of the request (used when none is given) */
export function guessAction(request = {}) {
  if (request.from !== undefined && request.to !== undefined) return "transfer";
  if (request.code !== undefined) return "deploy";
  if (request.functionName !== undefined) return "call";
  return "unknown";
}

/** the same key can be written several times in one tx → keep only the last value (ordered by first write) */
export function collapseWrites(writes) {
  const latest = new Map();
  for (const write of writes) {
    latest.set(write.dbKey, { ...decodeDbKey(write.dbKey), value: write.type === WRITE.DEL ? undefined : write.value });
  }
  return [...latest.values()];
}

/** convert a dbKey to a readable form (for receipts / explorer) */
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
  if (dbKey === KEY.GAS_CONFIG) return { kind: KEY.GAS_CONFIG };

  const [kind, ...parts] = rest;
  if (kind === KEY.STORAGE) return { kind, address: head, key: parts.map(decodeURIComponent) };
  if (kind === KEY.TXN) return { kind, address: head, nonce: Number(parts[0]), hash: parts[1] };
  if (kind === KEY.NATIVE) return { kind, address: head, field: parts[0] };
  if (kind === KEY.METADATA) return { kind, address: head, field: parts[0] };
  if (kind === KEY.CODE_VERSION) return { kind, address: head, version: Number(parts[0]) };
  return { kind, address: head };
}

// ---------- request validation ----------

export function checkProgramUuid(programUuid) {
  if (!isNonEmptyString(programUuid) || programUuid.includes(KEY.SEPARATOR)) fail(ERRORS.invalidProgramUuid);
}

/**
 * Validate an admin request → { minBaseFee: "wei" | null }
 *   minBaseFee: null = revert to the genesis value · value = wei per gas ≥ 1
 *   per-unit prices (gas) cannot be adjusted on-chain (setting 0 would make txs free = machines overwhelmed) → use a fork
 */
export function checkGasConfigChange({ minBaseFee, gas } = {}) {
  if (gas !== undefined) fail(ERRORS.invalidGasConfig, "ราคาต่อหน่วย (gas) ปรับบนเชนไม่ได้ · เปลี่ยนผ่าน fork (FORKS ใน virtualmachine.js)");
  if (minBaseFee === undefined) fail(ERRORS.invalidGasConfig, "ต้องส่ง minBaseFee (wei ต่อแก๊ส) หรือ null = กลับไปใช้ค่าใน genesis");
  if (minBaseFee === null) return { minBaseFee: null };
  const parsed = parseNative(minBaseFee);
  if (parsed === null || parsed < 1n) fail(ERRORS.invalidGasConfig, "minBaseFee ต้องเป็นจำนวนเต็ม wei ≥ 1 (เช่น \"100000000\" = 0.1 gwei)");
  return { minBaseFee: parsed.toString() };
}

export function checkContext(context) {
  if (!isNonEmptyString(context?.sender) || !isNonEmptyString(context?.origin)) fail(ERRORS.invalidContext);
}

/**
 * native amount (smallest unit, 18 decimals) → BigInt
 * accepts BigInt, a safe-integer number, "123" or "123n" · anything else returns null
 */
export function parseNative(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === "string" && NATIVE_TEXT.test(value)) return BigInt(value.endsWith("n") ? value.slice(0, -1) : value);
  return null;
}
const NATIVE_TEXT = /^-?\d+n?$/;

/** BigInt → "123n" (the format stored in the DB / exported in responses, receipts, headers) */
export const encodeNative = (amount) => `${amount}n`;

/** value read from the DB / a response back to BigInt (missing = 0) */
export const readNative = (value) => (value === undefined || value === null ? 0n : parseNative(value) ?? 0n);

export function checkValue(value) {
  const amount = parseNative(value);
  if (amount === null || amount < 0n) fail(ERRORS.invalidValue);
  return amount;
}

/** the gasPrice the sender offers must not be below the system minimum (returns BigInt) */
export function checkGasPrice(gasPrice, minimum) {
  const floor = parseNative(minimum);
  if (gasPrice === undefined || gasPrice === null) return floor;
  const price = parseNative(gasPrice);
  if (price === null || price < floor) fail(ERRORS.invalidGasPrice, minimum);
  return price;
}

/** EIP-1559 gas fee fields of a request (not sent = undefined) */
// sponsor = the party paying gas on the sender's behalf (paymaster) · not sent = not part of the tx hash (existing txs unchanged)
export const feeFields = (request) => ({ maxFeePerGas: request?.maxFeePerGas ?? undefined, maxPriorityFeePerGas: request?.maxPriorityFeePerGas ?? undefined,
  sponsor: request?.sponsor ? normalizeAddress(request.sponsor) : undefined });

/** whether this request uses EIP-1559 (type 2) gas fees */
export const isFeeMarketRequest = (request) => (request?.maxFeePerGas ?? null) !== null || (request?.maxPriorityFeePerGas ?? null) !== null;

/**
 * gas price of a tx in a block with a baseFee (all BigInt)
 *   legacy: gasPrice = maxFee = priority (must be ≥ baseFee) · nothing sent = pay exactly baseFee, no tip
 *   EIP-1559: maxFeePerGas (not sent = baseFee + priority) + maxPriorityFeePerGas (not sent = 0) · maxFee must be ≥ baseFee and ≥ priority
 *   actual price = min(maxFee, baseFee + priority) · tip = price - baseFee (per gas)
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
 * tip per gas the producer earns if this request is included in a block with a baseFee (used for queue ordering) · maxFee < baseFee → null (cannot be included yet)
 * no price given = pay exactly baseFee (tip 0) · legacy gasPrice = both maxFee and priority
 */
export function effectiveTip(request = {}, baseFee = 0n, { defaultGasPrice = null } = {}) {
  let maxFee;
  let priority;
  if (isFeeMarketRequest(request)) {
    priority = parseNative(request.maxPriorityFeePerGas ?? 0) ?? 0n;
    maxFee = (request.maxFeePerGas ?? null) === null ? baseFee + priority : parseNative(request.maxFeePerGas) ?? 0n;
  } else if ((request.gasPrice ?? null) === null) {
    // no price given = always pays exactly baseFee (includable in any block) · the tip counts as the base price above baseFee
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
 * next block's base fee from the previous block (EIP-1559 formula)
 *   gas used equals target → unchanged · more → increase by base × (used - target) / target / denominator (at least 1)
 *   less → decrease by base × (target - used) / target / denominator · never below minimum · no target = always minimum
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

// ---------- EVM-style logs (used for logsBloom / receiptsRoot in the header and /evm) ----------

const ADDRESS_TEXT = /^0x[0-9a-f]{40}$/i;
const UINT256 = 2n ** 256n;
/** ABI type of an event value (stored values: BigInt = "123n"); used for topic0 = keccak(name(type,...)) */
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
/** single value (uint256 / address / bool) → 1 word (64 hex) */
const staticWord = (type, value) => (type === "uint256" ? word64(BigInt(value.slice(0, -1)))
  : type === "address" ? value.slice(2).toLowerCase().padStart(64, "0") : word64(value ? 1n : 0n));
/** head + tail ABI encoding of a tuple (uint256 / address / bool / string / uint256[] / address[]) → hex without 0x */
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
 * 1 value → 32-byte topic (0x + 64 hex), EVM indexed style
 *   BigInt → uint256 (negative = two's complement) · address → left-padded with 0 · bool → 0/1
 *   string → keccak256(text) · anything else (object / null) → keccak256(canonical JSON)
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
 * chain event → EVM-style log { address, topics, data } (depends only on the event data, so re-running gives the same result)
 *   with indexed: topic0 = keccak("name(types of all fields in order)"), e.g. Transfer(address,address,uint256)
 *               topic1..3 = values of the indexed fields · data = remaining fields ABI-encoded (uint256 / address / bool / string / uint256[] / address[])
 *               fields of other types present (object etc.) → data = JSON of the remaining fields
 *   without indexed: topic0 = keccak(name) · data = JSON of the whole data
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

/** bytes of an address / topic put into the bloom (non-hex addresses, such as program names in tests = bytes of the text) */
const bloomBytes = (item) => {
  const text = String(item ?? "");
  return /^0x(?:[0-9a-f]{2})+$/i.test(text) ? hexToBytesStrict(text.toLowerCase()) : utf8ToBytes(text);
};

/** EVM-style logsBloom (2048 bits): address + every topic of every log */
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

/** whether this bloom may contain an item (address / topic) (false = definitely not) */
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

// ---------- program ABI (metadata.abi) ----------

/** types used in metadata.abi */
export const ABI_TYPES = ["address", "uint", "int", "bool", "string", "bytes", "object", "array", "any"];
export const ABI_LIMITS = { functions: 64, events: 32, fields: 16, size: 16 * 1024, description: 200 };
const ABI_NAME = /^[A-Za-z_$][\w$]{0,31}$/;

/**
 * Validate metadata.abi (function / event descriptions so the explorer can build forms and decode events)
 *   { functions: [{ name, inputs: [{ name, type }], outputs: [{ name?, type }], readonly?, payable?, description? }],
 *     events: [{ name, fields: [{ name, type, indexed? }], description? }] }
 * type ∈ ABI_TYPES · names must be unique · an event may have at most 3 indexed fields
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

/** chain ABI → Ethereum-style JSON ABI (for EVM tools to read) */
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

/** a value from a query string (or a real value) → every possible topic: "0x…40" = address · number = BigInt or string · true/false = bool or string */
export function indexedTopicCandidates(value) {
  if (typeof value === "bigint") return [topicOf(`${value}n`)];
  if (typeof value === "boolean") return [topicOf(value)];
  const text = String(value ?? "");
  const topics = new Set([topicOf(ADDRESS_TEXT.test(text) ? text.toLowerCase() : text)]);
  if (/^-?\d+n?$/.test(text)) topics.add(topicOf(`${text.replace(/n$/, "")}n`));
  if (text === "true" || text === "false") topics.add(topicOf(text === "true"));
  return [...topics];
}

/** maximum number of indexed fields in an emit (same as EVM LOG4: topic0 + 3) */
export const MAX_INDEXED = 3;

/** emit options: { indexed: ["field", ...] }; names must be unique, present in data, and at most MAX_INDEXED → the list (not sent = []) */
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

/** amount of gas purchasable (BigInt) → number, capped at what a number can represent */
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

/** upgrader: an address (non-empty string without ':') · null / undefined = none → returns the lowercase address or null */
export function checkUpgrader(upgrader) {
  if (upgrader === undefined || upgrader === null) return null;
  if (!isNonEmptyString(upgrader) || upgrader.includes(":")) fail(ERRORS.invalidUpgrader);
  return normalizeAddress(upgrader);
}

// ---------- time ----------

const RealDate = Date;

/** seeded RNG: yields the same sequence every time when the seed and call order are the same */
export function createSeededRandom(hashFunction, seed) {
  let counter = 0;
  return () => {
    const hex = hashFunction(`${seed}:${counter++}`).slice(2, 15); // 13 hex = 52 bit
    return Number.parseInt(hex, 16) / 2 ** 52;
  };
}

/** the Math programs see: identical to the original except random() */
export function createSeededMath(random) {
  return new Proxy(Math, { get: (target, prop, receiver) => (prop === "random" ? random : Reflect.get(target, prop, receiver)) });
}

export function checkTimestamp(timestamp) {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) fail(ERRORS.invalidTimestamp);
}

/**
 * The Date programs see: the current time is always the block timestamp
 *   Date.now() / new Date() / Date()  → block time
 *   new Date(x), Date.UTC, Date.parse, instanceof Date → work normally
 */
export function createBlockDate(timestamp) {
  return new Proxy(RealDate, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [timestamp], newTarget),
    apply: () => new RealDate(timestamp).toString(),
    get: (target, prop, receiver) => (prop === "now" ? () => timestamp : Reflect.get(target, prop, receiver)),
  });
}

// ============================================================================
//  Compiler: validate code + inject gas counters → source ready to run in the sandbox (cached by code content)
// ============================================================================

export class Compiler {
  #cache = new Map(); // oneLineCode → program

  /** single-line code → { exports, hasInit, hasMigrate, source } (source = factory(api) function with gas counters injected) */
  compile(oneLineCode) {
    if (!this.#cache.has(oneLineCode)) {
      const { body, exports, candidateNames } = Compiler.parse(fromOneLine(oneLineCode));
      Compiler.checkSyntax(body);
      const functionNames = candidateNames.filter((name) => Compiler.isTopLevelDeclaration(body, name));
      const callable = Compiler.validateExports(exports, functionNames);
      const source = Compiler.buildFactory(Compiler.meter(body), functionNames);
      const guestError = checkGuestSyntax(source);   // QuickJS does not accept exactly the same syntax as V8 → also check against the engine that actually runs it
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

  /** forget compiled code (called when a program's code is replaced by an upgrade; it can be recompiled whenever needed again) */
  forget(oneLineCode) {
    this.#cache.delete(oneLineCode);
  }

  /** split code into the body inside the scope, the returned names, and names that "may" be functions */
  static parse(code) {
    if (MODULE_KEYWORD_PATTERN.test(code)) fail(ERRORS.importNotAllowed);

    const wrapper = code.match(PROGRAM_WRAPPER_PATTERN);
    if (!wrapper) fail(ERRORS.programWrapperMissing);

    const inner = wrapper[1];
    const returned = inner.match(RETURN_EXPORT_PATTERN);
    const exports = (returned?.[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    const body = returned ? inner.slice(0, returned.index) : inner; // strip the final return

    const candidateNames = [...new Set([
      ...[...body.matchAll(FUNCTION_PATTERN)].map((m) => m[1]),
      ...[...body.matchAll(BINDING_PATTERN)].map((m) => m[1]),
    ])];
    return { body, exports, candidateNames };
  }

  static source(body, tail = "") {
    return `"use strict";\nconst { ${[...PROGRAM_API_NAMES, ...METER_FNS].join(", ")} } = api;\n${body}\n;${tail}`;
  }

  /** inject gas counters into the code (see gasmeter.js) */
  static meter(body) {
    try {
      return instrument(body);
    } catch (err) {
      fail(ERRORS.syntaxError, err.message);
    }
  }

  /** compile with V8 to check syntax (does not run code; only creates the function without calling it, error messages unchanged) */
  static checkSyntax(body) {
    try {
      new Function("api", Compiler.source(body));
    } catch (err) {
      fail(ERRORS.syntaxError, err.message);
    }
  }

  /**
   * whether name is declared at the top level of the program (does not run code)
   * appends a `let name` declaration; if the name already exists in the same scope, V8 reports a SyntaxError at compile time
   */
  static isTopLevelDeclaration(body, name) {
    try {
      new Function("api", Compiler.source(body, `let ${name};`));
      return false;
    } catch (err) {
      return err instanceof SyntaxError && err.message.includes(`'${name}' has already been declared`);
    }
  }

  /** initialization / migrate are always removed from the export list (the VM calls them itself, only at init / upgrade) */
  static validateExports(exports, functionNames) {
    const missing = exports.find((name) => !functionNames.includes(name));
    if (missing) fail(ERRORS.exportMissing, missing);
    return exports.filter((name) => name !== INIT_FUNCTION && name !== MIGRATE_FUNCTION);
  }

  /** source of factory(api) → { function name: function } (runs in the sandbox on every call, so no variables persist across calls) */
  static buildFactory(body, functionNames) {
    const returns = functionNames.map((name) => `${name}: typeof ${name} === "function" ? ${name} : undefined`);
    return `(function (api) {\n${Compiler.source(body, `return { ${returns.join(", ")} };`)}\n})`;
  }
}

// ============================================================================
//  Transaction: state of 1 request
// ============================================================================

export class Transaction {
  #read;
  #readCache = new Map(); // dbKey → value already read from the DB (each key is read from the DB once per request)

  #sandbox = null;
  #sandboxOptions;

  constructor({ read, timeoutMs, maxCallDepth, timestamp = RealDate.now(), gas = DEFAULT_GAS, chargeGas = false, feeRecipient = null, burnPercent = 100, blockNumber = null, maxTxGas = Infinity, baseFee,
    memoryLimitBytes = DEFAULT_OPTIONS.memoryLimitBytes, maxStackBytes = DEFAULT_OPTIONS.maxStackBytes, wallClock = false }) {
    checkTimestamp(timestamp);
    this.#read = read;
    this.#sandboxOptions = { memoryLimitBytes, maxStackBytes, wallClock };
    this.blockNumber = blockNumber;           // block number this tx is in (null = run outside a block)
    this.seed = null;                         // RNG seed (set from the tx hash)
    this.Math = Math;                         // replaced by the tx-bound RNG once the seed is known
    this.gas = gas;                           // gas fee table
    this.baseFee = baseFee === undefined || baseFee === null ? readNative(gas.price) : readNative(baseFee);   // block base fee (BigInt)
    this.gasPrice = this.baseFee;             // actual price per 1 gas for this tx = min(maxFee, baseFee + priority); set in preparePayer
    this.fees = null;                         // result of resolveFees (the price the sender offered); set in preparePayer
    this.feeBurned = 0n;                      // burned part of the gas fee (base fee portion × burnPercent)
    this.feeReward = 0n;                      // gas fee going to the block closer (tip + unburned base fee portion)
    this.chargeGas = chargeGas;
    this.gasUsed = 0;
    this.maxTxGas = maxTxGas;                 // per-tx gas ceiling regardless of how much the payer has
    this.gasLimit = maxTxGas;                 // set from the payer's native balance once the payer is known
    this.payer = null;                        // { address, nonce } of the outermost tx
    this.transaction = null;                  // tx data for writing <addr>:txn:<nonce>:<hash>
    this.feeCharged = 0n;                     // gas fee actually collected (native BigInt)
    this.feeRecipient = feeRecipient;         // block closer receiving a share of the gas fee
    this.burnPercent = burnPercent;
    this.timestamp = timestamp;               // request / block time that programs see
    this.Date = createBlockDate(timestamp);
    this.maxCallDepth = maxCallDepth;
    this.deadline = Date.now() + timeoutMs;
    this.fatal = null;       // error that must fail the whole request (DB failure / out of gas / timeout / memory exceeded); programs cannot catch it
    this.writes = [];        // [{ type: "put", dbKey, value } | { type: "del", dbKey }]
    this.calls = [];         // program call log
    this.events = [];        // events emitted by programs (rolled back together with writes)
    this.before = new Map(); // dbKey → value before running
    this.loaded = new Set(); // dbKeys the program read
    this.stateKeys = new Set(); // dbKeys already charged stateKey gas (not refunded on a branch rollback; gas already spent is not refunded)
  }

  /** gas for state keys a tx writes for the first time (writeDB / deleteDB) */
  useStateKeyGas(dbKey) {
    if (this.stateKeys.has(dbKey)) return;
    this.useGas(this.gas.stateKey);
    this.stateKeys.add(dbKey);
  }

  // ---------- DB ----------

  /** read the DB (once per key): on failure, remember the error and rethrow it until the request ends */
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

  /** read the DB regardless of whether the request has failed (used when collecting gas fees of failed txs) */
  readRaw(dbKey) {
    return this.#read(dbKey);
  }

  /** DB failure / out of gas → stop everything and rethrow until the request ends */
  assertAlive() {
    if (this.fatal) throw this.fatal;
  }

  /** charge gas: exceeding what the payer has → OUT_OF_GAS (cannot be caught) */
  useGas(amount) {
    this.assertAlive();
    this.gasUsed += amount;
    if (this.gasUsed > this.gasLimit) {
      this.fatal = VMError.from(ERRORS.outOfGas, this.gasUsed, this.gasLimit);
      throw this.fatal;
    }
  }

  /** the sandbox marks the whole request as failed: "timeout" | "memory" (first error wins) */
  abort(kind) {
    this.fatal ??= kind === "timeout"
      ? VMError.from(ERRORS.timeout)
      : VMError.from(ERRORS.outOfMemory, this.#sandboxOptions.memoryLimitBytes);
    return this.fatal;
  }

  // ---------- sandbox ----------

  /** this tx's QuickJS runtime (created when a program first runs; txs that run no program do not pay for it) */
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

  /** release all runtimes / contexts (runAction always calls this) */
  dispose() {
    this.#sandbox?.dispose();
  }

  /** gas fee to pay, in native */
  gasFee() {
    return this.chargeGas ? BigInt(Math.min(this.gasUsed, this.gasLimit)) * this.gasPrice : 0n;
  }

  /** latest value: if written in this request, use that; otherwise read the DB */
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

  /** convert a program key to a dbKey and remember its value before running */
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
    this.events.length = savepoint.events;   // events of a rolled-back branch disappear too
  }

  // ---------- time ----------

  remainingTime() {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0) fail(ERRORS.timeout);
    return remaining;
  }

  // ---------- call log ----------

  startCall({ depth, programUuid, functionName, context, input, value = 0, gasStart = this.gasUsed, type }) {
    const record = { depth, programUuid, functionName, ...pickContext(context), input, value: encodeNative(readNative(value)), gasStart, status: STATUS.RUNNING };
    if (type) record.type = type;   // "create" = the program was created with cloneProgram (absent = a normal call)
    this.calls.push(record);
    return record;
  }

  static finishCall(record, error, gasUsed) {
    record.status = error ? STATUS.THROW : STATUS.SUCCESS;
    if (gasUsed !== undefined) record.gasUsed = gasUsed - record.gasStart;
    if (error) record.error = { code: error.code, message: error.message };
  }

  /** close every still-open call as throw; used on a timeout, which stops every level at once */
  closeRunningCalls(error) {
    for (const record of this.calls) {
      if (record.status === STATUS.RUNNING) Transaction.finishCall(record, error, this.gasUsed);
    }
  }

  // ---------- result summary ----------

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
   *        the DB used for storage (see db.js: DB for production, MemoryDB for tests)
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
    // EIP-1559: minimum base fee / target gas per block / per-block change denominator
    this.minBaseFee = parseNative(minBaseFee ?? this.gas.price);
    if (this.minBaseFee === null || this.minBaseFee < 0n) fail(ERRORS.invalidBaseFeeOption, "minBaseFee");
    const target = gasTarget ?? (Number.isSafeInteger(maxBlockGas) && maxBlockGas > 0 ? Math.max(1, Math.floor(maxBlockGas / 2)) : null);
    if (target !== null && (!Number.isSafeInteger(target) || target <= 0)) fail(ERRORS.invalidBaseFeeOption, "gasTarget");
    this.gasTarget = target;
    if (!Number.isSafeInteger(baseFeeChangeDenominator) || baseFeeChangeDenominator <= 0) fail(ERRORS.invalidBaseFeeOption, "baseFeeChangeDenominator");
    this.baseFeeChangeDenominator = baseFeeChangeDenominator;
    this.compiler = new Compiler();
  }

  /**
   * base fee of the block following this header (no header = first block → minimum base fee)
   *   read = reads the state before that block (the minimum comes from the admin-set gasconfig, if any · not sent = latest DB)
   */
  baseFeeAfter(header, read) {
    const minimum = this.minBaseFeeNow(read);
    if (!header) return minimum;
    return nextBaseFee({
      parentBaseFee: parseNative(header.baseFeePerGas ?? null) ?? minimum,
      parentGasUsed: header.gasUsed ?? 0,
      gasTarget: this.gasTarget,
      denominator: this.baseFeeChangeDenominator,
      minimum,
    });
  }

  /** base fee of the next block (following the latest block in the DB) */
  currentBaseFee() {
    try {
      if (!this.gasTarget) return this.minBaseFeeNow();   // no target = base fee fixed at the minimum
      const latest = this.latestBlockNumber();
      return this.baseFeeAfter(latest === null ? null : this.getBlock(latest));
    } catch {
      return this.minBaseFee;   // DB unreadable → the tx will fail on its own when reading the DB (INTERNAL)
    }
  }

  // ---------- gas price floor set on-chain by the admin (gasconfig · see setGasConfig) ----------

  /**
   * the admin-set value in state: { minBaseFee: "wei" | null, block, by } or null (never set)
   *   chains without admins can never set this → no DB read needed
   */
  gasConfig(read = (dbKey) => this.read(dbKey)) {
    if (!this.admins) return null;
    const value = read(GAS_CONFIG_KEY);
    return value && typeof value === "object" ? value : null;
  }

  /** minimum base fee (= gas price floor) in effect = the admin-set value (if any), otherwise the genesis value (the VM's minBaseFee) */
  minBaseFeeNow(read) {
    const configured = parseNative(this.gasConfig(read)?.minBaseFee ?? null);
    return configured ?? this.minBaseFee;
  }

  /** read 1 key via db.readKeys */
  read(dbKey) {
    return this.db.readKeys([dbKey])[0];
  }

  /**
   * persist writes to the DB via db.writeKeys · changed state keys → update the trie (stateRoot) in the same commit
   *   trie = the precomputed result of trieUpdate(writes) (Block uses the same one it used for the header's stateRoot) · not sent = computed here
   */
  commit(writes, { trie } = {}) {
    this.#ensureTrie();
    if (trie && trie.parentRoot !== this.stateRoot()) fail(ERRORS.trieStale);
    const update = trie ?? this.trieUpdate(writes);
    return this.db.writeKeys(update.writes.length ? [...writes, ...update.writes] : writes);
  }

  // ---------- fork (rules by block height · see FORKS) ----------

  #forks = [];          // [{ name, block, rule }] sorted by block
  #gasCache = new Map(); // names of active forks → gas table

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

  /** the block a tx run outside a block (query / simulate / mempool) would land in = the next block */
  #effectiveBlock(blockNumber) {
    return blockNumber ?? (this.latestBlockNumber() ?? 0) + 1;
  }

  /** whether this fork is active at that block (not sent = the next block) */
  forkActive(name, blockNumber = null) {
    const fork = this.#forks.find((item) => item.name === name);
    return Boolean(fork) && this.#effectiveBlock(blockNumber) >= fork.block;
  }

  /** fork table → [{ name, block, active, description }] (active = active at the next block) */
  forkSchedule() {
    const next = this.#effectiveBlock(null);
    return this.#forks.map(({ name, block, rule }) => ({ name, block, active: next >= block, description: rule.description ?? null }));
  }

  /** gas table used in that block = the VM's defaults, overridden by the active forks in order */
  gasAt(blockNumber = null) {
    if (!this.#forks.length) return this.gas;   // no forks = no need to read the block number from the DB
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

  // ---------- state trie (phase 4.3 · src/core/trie.js) ----------

  #trieReady = false;

  /** the latest state trie in the DB (nodes live at trie:<path> · only the latest is kept) */
  #trie() {
    return new StateTrie({ load: (path) => this.read(trieNodeKey(path)) });
  }

  /** a DB with state but no trie yet (created before phase 4.3 / state written directly) → build the trie from the whole state once */
  #ensureTrie() {
    if (this.#trieReady) return;
    this.#trieReady = true;
    if (this.read(trieNodeKey("")) !== undefined || typeof this.db.listKeys !== "function") return;
    this.rebuildTrie();
  }

  /** current state trie root (= the latest block's stateRoot) */
  stateRoot() {
    this.#ensureTrie();
    return this.#trie().root;
  }

  /** writes → { parentRoot, root, writes: trie nodes to persist } (not persisted · state keys only) */
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
   * Build a new trie from the whole state in the DB (deleting the old nodes first) → { root, keys } · used for data migration / snapshot load
   * reads every state key into memory and sorts it (≈ 150–250 bytes per key), then builds the whole tree in one go (buildTrie)
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
   * Proof for keys in the latest state (like eth_getProof · verifiable with verifyProof from src/core/trie.js / client-sdk)
   *   → { blockNumber, blockHash, stateRoot, proofs: [{ dbKey, value, proof: [hex of nodes from the root] }] }
   * value undefined = the key does not exist (the proof can prove absence too)
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
   * pruning (phase 4.2): delete history of blocks older than the latest historyKeep blocks → state lookback / replay limited to that range
   * block headers / bodies stay complete (can still sync other nodes) · deletes at most maxKeys keys per call (enabling it on a long chain = gradual deletion every block)
   *   → { from, to, keys } · to = the new historyfrom
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

  // ---------- server API ----------

  /** user submits code → syntax check → pending review */
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
        // program address = hash(deployer + nonce), so nobody holds its private key
        ? this.programAddressFor(context.sender, tx.payer?.nonce ?? tx.current(nonceKey(context.sender)) ?? 0)
        : normalizeAddress(rawProgramUuid);
      this.rememberTransaction(tx, arguments[0], "deploy");
      this.seedRandom(tx, arguments[0], "deploy");
      const oneLineCode = toOneLine(code);
      const codeSize = Buffer.byteLength(oneLineCode, "utf8");
      if (codeSize > this.maxCodeSize) fail(ERRORS.codeTooLong, this.maxCodeSize, codeSize);

      // base tx cost + by code size (stored permanently in the DB and compiled on every call)
      if (this.autoReview) {
        const result = review(code, { apiNames: [...PROGRAM_API_NAMES, "params"] });
        if (!result.ok) fail(ERRORS.reviewFailed, reviewMessage(result));
      }
      tx.useGas(tx.gas.call + tx.gas.code * codeSize);
      this.compiler.compile(oneLineCode);

      if (tx.current(pendingKey(programUuid)) || tx.current(codeKey(programUuid))) {
        fail(ERRORS.programUuidUsed, programUuid);
      }

      if (amount > 0n) this.moveNative(tx, context.sender, programUuid, amount); // funds go straight to the program and wait there

      this.checkMetadata(metadata);
      // ABI supplied at deploy: declared functions must actually be exported
      const missing = (metadata?.abi?.functions ?? []).find((fn) => !this.compiler.compile(oneLineCode).exports.includes(fn.name));
      if (missing) fail(ERRORS.invalidAbi, `ฟังก์ชัน '${missing.name}' ไม่ได้ export`);
      tx.put(pendingKey(programUuid), {
        code: oneLineCode,
        context,
        initInput: toInputValue(initInput, "initInput"),
        metadata,
        value: encodeNative(amount),
        // not given = this field is absent entirely (pending entries of immutable programs stay byte-identical)
        ...(upgraderAddress ? { upgrader: upgraderAddress } : {}),
      });
      return { programUuid, code: oneLineCode, state: STATE.PENDING, value: encodeNative(amount), ...(upgraderAddress ? { upgrader: upgraderAddress } : {}) };
    }, options);
  }

  /** team approves → run initialization once → store the program → delete pending */
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


  /** team rejects → delete pending */
  reject({ programUuid: rawProgramUuid, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      const programUuid = normalizeAddress(rawProgramUuid);
      this.prepareAdminAction(tx, arguments[0], "reject", { context, nonce, gasLimit, gasPrice });
      const pending = tx.current(pendingKey(programUuid));
      if (!pending) fail(ERRORS.pendingNotFound);

      const refund = readNative(pending.value);
      if (refund > 0n) this.moveNative(tx, programUuid, pending.context.sender, refund); // refund the deployer

      tx.delete(pendingKey(programUuid));
      return { programUuid, state: STATE.REJECTED, refund: encodeNative(refund) };
    }, options);
  }

  // ---------- program upgrades ----------

  /** the program must exist and have an upgrader, and the sender must be the current upgrader */
  requireUpgrader(tx, programUuid, sender) {
    if (typeof tx.current(codeKey(programUuid)) !== "string") fail(ERRORS.programNotFound, programUuid);
    const upgrader = tx.current(metadataKey(programUuid, METADATA_FIELD.UPGRADER));
    if (upgrader === undefined || upgrader === null) fail(ERRORS.immutableProgram, programUuid);
    if (upgrader !== sender) fail(ERRORS.notUpgrader, sender);
    return upgrader;
  }

  /** upgrader submits new code → same checks as deploy → pending-upgrade:<id> awaiting team approval */
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
      tx.useGas(tx.gas.call + tx.gas.code * codeSize);   // charged the same as deploy
      this.compiler.compile(oneLineCode);

      this.requireUpgrader(tx, programUuid, userContext.sender);
      if (tx.current(pendingUpgradeKey(programUuid)) || tx.current(scheduledUpgradeKey(programUuid))) fail(ERRORS.upgradePending, programUuid);

      tx.put(pendingUpgradeKey(programUuid), { code: oneLineCode, context: userContext, migrateInput: toInputValue(migrateInput, "migrateInput") ?? {} });
      return { programUuid, code: oneLineCode, state: STATE.PENDING, version: this.programVersion(tx, programUuid) + 1 };
    }, options);
  }

  /** the current upgrader transfers the right to someone else, or renounces it (upgrader: null → the program is immutable forever) */
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
   * admin adjusts the gas price floor mid-chain (no fork / chain reset)
   *   minBaseFee: wei per gas ≥ 1 · null = revert to the genesis value
   *     every tx cost (in coins) = gas × base fee → lowering the floor makes txs proportionally cheaper, while gas per tx / block capacity stay the same
   *     the base fee still moves with block fullness (EIP-1559) · falls toward a new floor by at most 12.5% per block · a raise applies immediately in the next block
   *   per-unit prices (DEFAULT_GAS) cannot be adjusted here → fork only (a leaked admin key cannot make txs free)
   *   writes gasconfig to state (in stateRoot / history) · takes effect from the next block: Block reads it from the state before the block
   *   → every machine that syncs / replays gets the same result
   *   admins must be set (genesis config.admins) and the signer must be on the list · chains without admins (DEV) cannot adjust it
   */
  setGasConfig({ minBaseFee, gas, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkContext(context);
      const sender = this.userContext(context).sender;
      if (!this.admins) fail(ERRORS.gasConfigNeedsAdmins);
      if (!this.admins.includes(sender)) fail(ERRORS.notGasAdmin, sender);
      const change = checkGasConfigChange({ minBaseFee, gas });

      this.preparePayer(tx, sender, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice });
      this.rememberTransaction(tx, arguments[0], "setGasConfig");
      this.seedRandom(tx, arguments[0], "setGasConfig");
      tx.useGas(tx.gas.call + tx.gas.write);

      const value = { minBaseFee: change.minBaseFee, block: tx.blockNumber ?? null, by: sender };
      tx.put(GAS_CONFIG_KEY, value);
      const effectiveFrom = tx.blockNumber === null || tx.blockNumber === undefined ? null : tx.blockNumber + 1;
      return { ...value, effectiveFrom, minBaseFeeEffective: encodeNative(change.minBaseFee === null ? this.minBaseFee : parseNative(change.minBaseFee)) };
    }, options);
  }

  /**
   * team approves an upgrade (approver rules are identical to init)
   *   upgradeDelayBlocks = 0 → swap the code + run migrate immediately (migrate fails = approval fails, nothing changes)
   *   upgradeDelayBlocks = N → schedule activation at block (this block number + N); the old code keeps running until then
   */
  initUpgrade({ programUuid: rawProgramUuid, context, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      checkProgramUuid(rawProgramUuid);
      const programUuid = normalizeAddress(rawProgramUuid);
      this.prepareAdminAction(tx, arguments[0], "initUpgrade", { context, nonce, gasLimit, gasPrice });

      const pending = tx.current(pendingUpgradeKey(programUuid));
      if (!pending) fail(ERRORS.upgradeNotFound);
      if (context === undefined) this.seedRandom(tx, arguments[0], "initUpgrade");
      // the upgrader must still be the same (transferred / renounced → the pending code can no longer be used; the team can discard it with rejectUpgrade)
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

  /** team rejects an upgrade → delete pending-upgrade (the old code keeps running) */
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
   * activate code whose timelock has elapsed; Block calls this itself when creating the block matching activateAt
   * (not anyone's tx: no gas payer, no hash, not in the body · replaying the same block gives the same result)
   * migrate fails → the result is discarded (Block deletes the schedule itself) and the old code keeps running
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

  /** current code version (no metadata.version = 1) */
  programVersion(tx, programUuid) {
    return Number(tx.current(metadataKey(programUuid, METADATA_FIELD.VERSION)) ?? 1);
  }

  /** swap the code → store the version → run migrate once (throw = the whole tx fails, nothing changes) */
  applyUpgrade(tx, programUuid, { code, migrateInput = {}, context }) {
    const oldCode = tx.current(codeKey(programUuid));
    if (typeof oldCode !== "string") fail(ERRORS.programNotFound, programUuid);
    const version = this.programVersion(tx, programUuid);
    const next = version + 1;
    tx.useGas(3 * tx.gas.write);

    // the first version is not stored separately at init → stored when it is first replaced (blockNumber unknown = null)
    if (tx.current(codeVersionKey(programUuid, version)) === undefined) {
      tx.put(codeVersionKey(programUuid, version), { version, code: oldCode, blockNumber: null,
        timestamp: tx.current(metadataKey(programUuid, METADATA_FIELD.CREATED_AT)) ?? null });
    }
    tx.put(codeKey(programUuid), code);
    tx.put(codeVersionKey(programUuid, next), { version: next, code, blockNumber: tx.blockNumber, timestamp: tx.timestamp });
    this.writeMetadata(tx, programUuid, { [METADATA_FIELD.VERSION]: next }, { allowReserved: true });

    // migrate already sees the new code (runProgram back into itself also gets the new code) · context = the upgrader who submitted the code
    const program = this.compiler.compile(code);
    const migrateResult = program.hasMigrate
      ? this.runFunction(tx, { programUuid, functionName: MIGRATE_FUNCTION, input: migrateInput, context, value: 0n, code, isInit: true })
      : undefined;
    // the compile cache is keyed by code content, so this address can never get old code again · forget the old one (replaying old blocks can recompile it)
    if (oldCode !== code) this.compiler.forget(oldCode);
    return { version: next, migrateResult };
  }

  /** every stored code version (only for programs that have been upgraded), oldest to newest; requires db.listKeys */
  listCodeVersions(programUuid) {
    const prefix = joinKey(normalizeAddress(programUuid), KEY.CODE_VERSION, "");
    return this.listEntries(prefix).map(({ value }) => value).sort((a, b) => a.version - b.version);
  }

  /** code version n (missing → null) */
  getCodeVersion(programUuid, version) {
    return this.read(codeVersionKey(normalizeAddress(programUuid), version)) ?? null;
  }

  /** the code a program used when block <number> closed (requires recordHistory) */
  codeAt(number, programUuid) {
    return this.stateAt(number, codeKey(normalizeAddress(programUuid))) ?? null;
  }

  /** user calls an exported function */
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
      if (amount > 0n) this.moveNative(tx, sender, target, amount); // attach funds to the tx

      return this.runFunction(tx, { programUuid: target, functionName, input, context: userContext, value: amount });
    }, options);
  }

  /** native transfer between addresses without calling a program */
  transfer({ from, to, amount, nonce, gasLimit, gasPrice } = {}, options) {
    return this.runAction((tx) => {
      if (!isNonEmptyString(from) || !isNonEmptyString(to)) fail(ERRORS.invalidAddress);
      const value = parseNative(amount);
      // transferring 0 is allowed, as in the EVM (still charges gas and consumes the nonce) → a queued tx can be cancelled by sending 0 to yourself
      if (value === null || value < 0n) fail(ERRORS.invalidTransferAmount);

      const sender = normalizeAddress(from);
      const recipient = normalizeAddress(to);
      this.preparePayer(tx, sender, { ...feeFields(arguments[0]), nonce, gasLimit, gasPrice, value });
      this.rememberTransaction(tx, arguments[0], "transfer");
      this.seedRandom(tx, arguments[0], "transfer");

      tx.useGas(tx.gas.call); // base tx cost
      this.moveNative(tx, sender, recipient, value);
      return { from: sender, to: recipient, amount: encodeNative(value) };
    }, options);
  }

  /**
   * data used for the tx hash; comes from the user's request only, with no part of the result
   * call / deploy / transfer: from + nonce already make it unique
   * init / reject: no sender / nonce, so blockNumber + index are used as well
   */
  transactionPayload(request = {}, { action = guessAction(request), blockNumber = null, index = null } = {}) {
    const base = { chainId: this.chainId, action };
    // maxFeePerGas / maxPriorityFeePerGas: not sent = not part of the hash (legacy tx hashes unchanged · canonicalJson skips undefined)
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
        ...(request.upgrader === undefined ? {} : { upgrader: normalizeAddress(request.upgrader) }),   // not sent = not part of the hash (existing tx hashes unchanged)
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
    if (action === "setGasConfig") {
      return { ...base, from: normalizeAddress(request.context?.sender) ?? null,
        minBaseFee: request.minBaseFee === undefined ? "unchanged" : request.minBaseFee === null ? null : String(request.minBaseFee), ...fee };
    }
    const signer = normalizeAddress(request.context?.sender) ?? null;
    if (signer) return { ...base, from: signer, to: normalizeAddress(request.programUuid) ?? null, ...fee };
    return { ...base, to: normalizeAddress(request.programUuid) ?? null, blockNumber, index };
  }

  /** tx hash (known before it is submitted to the VM) */
  hashTransaction(request, meta) {
    return this.hashFunction(canonicalJson(this.transactionPayload(request, meta)));
  }

  /** context of a user-submitted tx: origin = sender always (origin can only change via runProgram) */
  userContext(rawContext) {
    const context = normalizeContext(rawContext);
    return this.forceOriginFromSender ? { sender: context.sender, origin: context.sender } : context;
  }

  /** program address from deployer + nonce (same scheme as an EVM contract address) */
  programAddressFor(deployer, nonce) {
    return addressFromHash(this.hashData({ chainId: this.chainId, deployer: normalizeAddress(deployer), nonce }));
  }

  /** set the tx's RNG seed (uses the tx hash so re-running gives the same result) */
  seedRandom(tx, request, action) {
    // bound to the tx and the block time: the same tx in the same block gives the same result, but a different block gives a new value
    tx.seed = this.hashData({ tx: this.hashTransaction(request, { action }), timestamp: tx.timestamp });
    tx.Math = createSeededMath(createSeededRandom(this.hashFunction, tx.seed));
  }

  /** hash of arbitrary data, same scheme as the tx hash */
  hashData(value) {
    return this.hashFunction(canonicalJson(value));
  }

  /**
   * block hash
   *   txRoot     = hash of the list of all tx hashes (ordered by index)
   *   stateRoot  = root of the Merkle Patricia Trie of the whole state after this block (phase 4.3 · Block computes it from the trie in the DB and passes it in)
   *   writesRoot = hash of this block's state writes (sorted by dbKey); replaying old blocks verifies execution results with this (the trie keeps only the latest)
   *   receiptsRoot / logsBloom / baseFeePerGas / gasUsed come from Block (see Block.receiptEntries) and are part of the hash too
   */
  hashBlock({ number, parentHash, timestamp, feeRecipient, burnPercent, txHashes, writes, stateRoot, rejected = [],
    baseFeePerGas = null, gasUsed = 0, receiptsRoot = null, logsBloom: bloom = null, producer = null }) {
    const txRoot = this.hashData(txHashes);
    // rejected txs: part of the hash only for blocks that have them
    const rejectedRoot = rejected.length ? this.hashData(rejected) : null;
    const writesRoot = this.hashData([...writes].sort((a, b) => (a.dbKey < b.dbKey ? -1 : 1)).map((write) => [write.type, write.dbKey, write.value ?? null]));
    const hash = this.hashHeader({
      number, parentHash, timestamp, feeRecipient, burnPercent, txCount: txHashes.length, txRoot, stateRoot, writesRoot,
      baseFeePerGas, gasUsed, receiptsRoot, logsBloom: bloom, rejectedCount: rejected.length, rejectedRoot, producer,
    });
    return { hash, txRoot, stateRoot, writesRoot, rejectedRoot };
  }

  /** hash from header fields (no txs / writes needed); a stored header recomputes to the same hash (used to verify snapshot headers) */
  hashHeader(header) {
    return this.hashData(headerFields(header, this.chainId));
  }


  /**
   * convert a request + result into a receipt for the explorer
   * @param {object} request  the request sent to deploy / init / reject / call / transfer
   * @param {object} result   the result returned
   * @param {{ index?: number, action?: string, nativeBefore?: Map }} [meta]  action = "call" | "deploy" | "init" | "reject" | "transfer"
   *        nativeBefore = dbKey → value before this tx (passed by block.receipt), so nativeChanges also includes before
   */
  buildReceipt(request = {}, result = {}, { index = 0, action = guessAction(request), blockNumber = null, nativeBefore = null } = {}) {
    const changes = collapseWrites(result.writes ?? []);
    const pick = (kind) => changes.filter((change) => change.kind === kind);
    const isTransfer = action === "transfer";

    return {
      hash: this.hashTransaction(request, { action, blockNumber, index }),
      digest: request.digest ?? null,   // the hash the user signed (if it came from a signed tx)
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
      // EIP-1559: actual price paid · block base fee · price the sender offered (legacy = gasPrice in both fields) · breakdown of burned / block closer share
      type: isFeeMarketRequest(request) ? 2 : 0,
      effectiveGasPrice: result.gasPrice ?? null,
      baseFeePerGas: result.baseFee ?? null,
      maxFeePerGas: result.maxFeePerGas ?? (isFeeMarketRequest(request) ? null : request.gasPrice ?? null ? encodeNative(readNative(request.gasPrice)) : null),
      maxPriorityFeePerGas: result.maxPriorityFeePerGas ?? (isFeeMarketRequest(request) ? null : request.gasPrice ?? null ? encodeNative(readNative(request.gasPrice)) : null),
      burnedFee: result.burnedFee ?? "0n",
      producerFee: result.producerFee ?? "0n",
      fee: result.fee ?? "0n",
      // the chain the wallet was on when signing (in the signature · set by the web page, not proof) · absent = system tx / older
      ...(request.signedOnChainId === undefined || request.signedOnChainId === null ? {} : { signedOnChainId: Number(request.signedOnChainId) }),
      ...(request.sponsor ? { sponsor: normalizeAddress(request.sponsor) } : {}),   // the party paying gas on the sender's behalf (already part of the tx hash)
      ...(request.evmRaw ? { evmHash: request.digest } : {}),   // came from eth_sendRawTransaction: Ethereum-style hash = keccak(raw)
      nonce: pick(KEY.NONCE)[0]?.value ?? null,
      events: (result.events ?? []).map((event) => ({ ...event })),
      trace: (result.calls ?? []).map((call) => ({
        ...(call.type ? { type: call.type } : {}),   // "create" = the program was created with cloneProgram
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

  /** validate user-supplied metadata (null value = delete that field) */
  checkMetadata(metadata, { allowReserved = false } = {}) {
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) fail(ERRORS.invalidMetadata);
    for (const [field, value] of Object.entries(metadata)) {
      if (!METADATA_FIELD_PATTERN.test(field)) fail(ERRORS.invalidMetadataField, field);
      if (!allowReserved && RESERVED_METADATA.includes(field)) fail(ERRORS.reservedMetadata, field);
      if (value !== null) toJsonValue(value, `metadata.${field}`);
      if (field === METADATA_FIELD.ABI && value !== null) checkAbi(value);   // the ABI must match the schema (see checkAbi)
    }
    return metadata;
  }

  /** write an address's metadata (namespace must be unique; the old name is released for others to use) */
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
    if (current !== undefined) tx.delete(namespaceKey(current)); // release the old name

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
   * init / reject: if a context is sent, treat it as a team-signed tx (with its own nonce / gas fee / hash)
   * no context = internal call (used in tests or by the server's own scripts)
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

  /** user tx: set metadata of one's own address */
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

  /** all metadata of an address (requires db.listKeys) */
  getMetadata(address) {
    const account = normalizeAddress(address);
    const prefix = joinKey(account, KEY.METADATA, "");
    return Object.fromEntries(this.listEntries(prefix).map(({ dbKey, value }) => [decodeDbKey(dbKey).field, value]));
  }

  /** look up an address by namespace */
  resolveNamespace(name) {
    return this.read(namespaceKey(String(name).toLowerCase())) ?? null;
  }

  // ---------- reads for the explorer (requires db.listKeys) ----------

  /** key list by prefix; options: { start, limit, reverse } */
  listKeys(prefix = "", options) {
    if (typeof this.db.listKeys !== "function") fail(ERRORS.listNotSupported);
    return this.db.listKeys(prefix, options);
  }

  /** [{ dbKey, value }] by prefix */
  listEntries(prefix = "", options) {
    return this.listKeys(prefix, options).map((dbKey) => ({ dbKey, value: this.read(dbKey) }));
  }

  /** native balances of an address from the DB: { received, sended, consumed, balance } */
  nativeBalanceOf(address) {
    const account = normalizeAddress(address);
    const [received, sended, consumed] = this.db.readKeys([
      nativeKey(account, NATIVE_FIELD.RECEIVED),
      nativeKey(account, NATIVE_FIELD.SENDED),
      nativeKey(account, NATIVE_FIELD.CONSUMED),
    ]).map(readNative);
    return { received, sended, consumed, balance: received - sended - consumed };   // BigInt
  }

  /** genesis hash (excluding "forks" / "producerSchedule"; tables that can be added later with the same genesis hash) */
  hashGenesis(genesis = {}) {
    const { forks, producerSchedule, ...rest } = genesis ?? {};
    return this.hashData(rest);
  }

  /** the stored genesis hash */
  genesisHash() {
    return this.read(KEY.GENESIS) ?? null;
  }

  /** set the chain's initial state, then store its hash for other nodes to compare */
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

  /** compare the genesis this node uses with the one supplied */
  checkGenesis(genesis) {
    const hash = this.hashGenesis(genesis);
    const current = this.genesisHash();
    if (current !== null && current !== hash) fail(ERRORS.genesisMismatch, current, hash);
    return hash;
  }

  /** latest block number */
  latestBlockNumber() {
    return this.read(LATEST_BLOCK_KEY) ?? null;
  }

  getBlock(number) {
    return this.read(blockKey(number)) ?? null;
  }

  /** txs sent to this address (program called, or funds received), newest to oldest */
  listTransactionsTo(address, { limit = 20, reverse = true, start } = {}) {
    const prefix = `${joinKey(KEY.TX_TO, normalizeAddress(address))}${KEY.SEPARATOR}`;
    const headers = new Map();
    return this.listKeys(prefix, { limit, reverse, start }).map((dbKey) => this.readTransactionTo(dbKey, headers));
  }

  /**
   * full txto entries: blockNumber + index come from the key · timestamp comes from the header (not duplicated in the value)
   * headers = a Map reused within the same page (many rows are often in the same block)
   */
  readTransactionTo(dbKey, headers = new Map()) {
    const value = this.read(dbKey);
    if (!value) return value;
    const { number, index } = decodeDbKey(dbKey);
    if (!headers.has(number)) headers.set(number, this.getBlock(number)?.timestamp ?? null);
    return { ...value, blockNumber: number, index, timestamp: value.timestamp ?? headers.get(number) };
  }

  /** search events a program has emitted, newest to oldest */
  listEvents({ program, name = "", limit = 20, reverse = true, start } = {}) {
    const prefix = program
      ? joinKey(KEY.EVENT, normalizeAddress(program), name ? `${name}${KEY.SEPARATOR}` : "")
      : `${KEY.EVENT}${KEY.SEPARATOR}`;
    return this.listEntries(prefix, { limit, reverse, start }).map((entry) => entry.value);
  }

  /**
   * events whose indexed field has this value (uses the eventidx index instead of scanning all events), newest to oldest
   *   value = the desired value (string / BigInt / "123n" / bool) or topic = a raw 0x…64-hex topic
   *   numeric / true / false strings may be several types → search every possible form and merge
   * → { items: [event], next } · next = cursor (dbKey of the next event), passed back as cursor
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

  /** event dbKeys (event:…) where field = topic within block range [fromBlock, toBlock] (oldest to newest) */
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

  /** events with this topic0 (EVM-style logs) → [{ program, name, indexed }] */
  listEventSignatures(topic0) {
    return this.listEntries(`${joinKey(KEY.EVENT_SIG, String(topic0).toLowerCase())}${KEY.SEPARATOR}`, { limit: 1000 }).map((entry) => entry.value);
  }

  /** raw txs of a block (for replay / explorer) */
  getBlockBody(number) {
    return this.read(blockBodyKey(number)) ?? null;
  }

  getBlockByHash(hash) {
    const number = this.read(blockHashKey(hash));
    return number === undefined ? null : this.getBlock(number);
  }

  /** headers of several blocks (newest to oldest) */
  listBlocks({ limit = 20, reverse = true, start } = {}) {
    return this.listEntries(`${KEY.BLOCK}${KEY.SEPARATOR}`, { limit, reverse, start }).map((entry) => entry.value);
  }

  /** look up a tx by system hash or by the hash the user signed (EIP-712 digest) */
  getTransaction(hash, { signature = false } = {}) {
    const entry = this.read(txIndexKey(hash)) ?? this.read(txIndexKey(this.read(sigTxKey(hash)) ?? ""));
    if (!entry) return null;
    const record = entry.from === null ? null : this.read(txnKey(entry.from, entry.nonce, entry.hash)) ?? null;
    // signatures are stored only in blockbody (txn does not duplicate them) → read additionally only on request
    if (signature && record) return { ...entry, record: { ...record, signature: this.transactionSignature(entry), digest: entry.digest ?? null } };
    return { ...entry, record };
  }

  /** signature of a tx in a block (from blockbody) · { blockNumber, index } from the tx index */
  transactionSignature({ blockNumber, index }) {
    return this.getBlockBody(blockNumber)?.[index]?.request?.signature ?? null;
  }

  /** token programs this address has received tokens from (from Transfer events) */
  listHoldings(address, { limit = 200 } = {}) {
    return this.listEntries(`${joinKey(KEY.HOLDING, normalizeAddress(address))}${KEY.SEPARATOR}`, { limit }).map((entry) => entry.value);
  }

  /** an address's tx list (newest to oldest) */
  listTransactionsOf(address, { limit = 20, reverse = true, start } = {}) {
    const prefix = joinKey(normalizeAddress(address), KEY.TXN, "");
    return this.listKeys(prefix, { limit, reverse, start }).map((dbKey) => this.readTransactionRecord(dbKey));
  }

  /** txn entries + digest from the tx index (txn does not duplicate them) · signatures are read one at a time with getTransaction(hash, { signature: true }) */
  readTransactionRecord(dbKey) {
    const record = this.read(dbKey);
    if (!record || "digest" in record) return record;   // legacy data still has the digest inline
    return { ...record, digest: this.read(txIndexKey(record.hash))?.digest ?? null };
  }

  /** all storage of a program → { key: [...], value } */
  listProgramStorage(programUuid, options) {
    const prefix = joinKey(normalizeAddress(programUuid), KEY.STORAGE, "");
    return this.listEntries(prefix, options).map(({ dbKey, value }) => ({ key: decodeDbKey(dbKey).key, value }));
  }

  // ---------- historical lookback (requires recordHistory) ----------

  /** list of keys that block touched */
  getBlockUndo(number) {
    return this.read(blockUndoKey(number)) ?? null;
  }

  /** rejected txs recorded in this block (none = []) */
  getBlockRejected(number) {
    return this.read(blockRejectedKey(number)) ?? [];
  }

  /** rejected tx by hash → { hash, blockNumber, index, sender, nonce, action, to, gasPrice, reason, code, stage, timestamp } | null */
  getRejectedTransaction(hash) {
    return this.read(rejectedTxKey(String(hash ?? "").toLowerCase())) ?? null;
  }

  /** rejected txs of this sender (newest to oldest) · start = dbKey continuing from the previous page */
  listRejectedOf(address, { limit = 20, reverse = true, start } = {}) {
    const prefix = `${joinKey(REJECTED_KEY.FROM, normalizeAddress(address))}${KEY.SEPARATOR}`;
    return this.listEntries(prefix, { limit, reverse, start });
  }

  /**
   * the value of a key exactly when block <number> closed
   * reads the first history entry with a block number greater than number (a single seek, independent of chain length)
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
    return this.read(dbKey); // nobody changed it since that block → current value
  }

  /**
   * first block available for lookback (history complete from this block to the latest) · no blocks = null
   * older chains without historyfrom yet → walk blockundo once (slow), then the next block records the value
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

  /** whether state at the close of block number can be looked up (requires history of every later block) */
  #checkHistoryAt(number) {
    const latest = this.latestBlockNumber() ?? 0;
    if (!Number.isSafeInteger(number) || number < 0 || number > latest) fail(ERRORS.blockMissing, number);
    if (number < latest && number + 1 < (this.historyFrom() ?? 1)) fail(ERRORS.historyMissing, number + 1);
  }

  /** data by prefix at that block → { dbKey: value } (everything · see pageSnapshotAt for paging) */
  snapshotAt(number, prefix = "") {
    return Object.fromEntries(this.pageSnapshotAt(number, prefix).items);
  }

  /**
   * data by prefix at that block, paged → { items: [[dbKey, value]], next } · next = after for the next page (null = done)
   * keys to inspect = keys present now ∪ keys with history (modified / deleted after that block)
   * walks history jumping key by key (does not read every history entry) → cost scales with key count, not chain length
   * limitation: child keys whose next segment is a number starting with 0, about as long as a 12-digit block number (e.g. map("a", "0000000001")), that have been deleted may not show up
   */
  pageSnapshotAt(number, prefix = "", { limit = Infinity, after } = {}) {
    this.#checkHistoryAt(number);
    const latest = this.latestBlockNumber() ?? 0;
    const chunk = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 1000) : 1000;

    // keys present now (already sorted · listKeys' start is inclusive, so skip after)
    function* current(vm) {
      let start = after;
      for (;;) {
        const keys = vm.listKeys(prefix, { start, limit: chunk + 1 });
        for (const key of keys.slice(0, chunk)) if (after === undefined || key > after) yield key;
        if (keys.length <= chunk) return;
        start = keys[chunk];
      }
    }
    // keys with history: on finding history:<key>:<n>, jump past all history of that key
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
      if (isIndexKey(dbKey)) continue;   // indexes have no history → the value read is the current one, not as of that block
      const value = this.stateAt(number, dbKey);
      if (value === undefined) continue;
      if (items.length === limit) return { items, next: items[items.length - 1][0] };
      items.push([dbKey, value]);
    }
    return { items, next: null };
  }

  /**
   * re-run an old block on the state as of then (without touching the real DB) → full receipt with trace / stateChanges
   * reads only the keys that block touched, so it is equally fast however far back it goes
   */
  replayBlock(number, { verify = true } = {}) {
    const header = this.getBlock(number);
    if (!header) fail(ERRORS.blockMissing, number);
    const body = this.getBlockBody(number);
    if (!body) fail(ERRORS.historyMissing, number);

    // history of every block from this one on is required, otherwise state cannot be rolled back (checked once via historyfrom)
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
      stateRoot: header.stateRoot,   // the trie in the DB is the latest → use the stored root · execution results are verified with writesRoot / receiptsRoot
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
   * system recovery: roll state back to before block 1, then re-run blocks 1..target from blockbody
   * used instead of rollback (slower, but built from source data, so always correct)
   */
  rebuildFrom(target, { verify = true, batch = 10_000 } = {}) {
    const latest = this.latestBlockNumber();
    if (latest === null) fail(ERRORS.blockMissing, target);
    if (!Number.isSafeInteger(target) || target < 0 || target > latest) fail(ERRORS.blockMissing, target);
    if ((this.historyFrom() ?? 1) > 1) fail(ERRORS.historyMissing, this.historyFrom() - 1);
    // every step works in batches without holding the whole chain in memory · headers / bodies of blocks to re-run are read one block at a time during replay

    // 1) restore every key ever touched to its state before block 1 = the before value of the key's first history entry
    //    (walk all history in order · a key's first entry is the first one found when seeking from history:<key>:)
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

    // 2) delete all history (replay rebuilds it for blocks 1..target) · all indexes (replay rebuilds them)
    for (;;) {
      const keys = this.listKeys(historyBase, { limit: batch });
      if (!keys.length) break;
      this.commit(keys.map((dbKey) => ({ type: WRITE.DEL, dbKey })));
    }
    this.commit([{ type: WRITE.PUT, dbKey: HISTORY_FROM_KEY, value: 1 }]);
    this.#deleteIndexes(batch);

    // 3) re-run blocks 1..target one at a time · overwrite the existing header / body / undo in a single commit
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

    // 4) delete blocks beyond target in batches
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

  /** delete all indexes (they come only from blocks · genesis has no indexes) in batches, without holding everything in memory */
  #deleteIndexes(batch = 10_000) {
    for (const prefix of INDEX_PREFIXES) {
      for (;;) {
        const entries = prefix === INDEX_PREFIXES[0] ? this.listEntries(prefix, { limit: batch }) : this.listKeys(prefix, { limit: batch }).map((dbKey) => ({ dbKey }));
        if (!entries.length) break;
        const writes = [];
        for (const { dbKey, value } of entries) {
          writes.push({ type: WRITE.DEL, dbKey });
          // txn starts with an address → found via the tx index (from + nonce + hash complete)
          if (value?.from && value.nonce !== null && value.nonce !== undefined) writes.push({ type: WRITE.DEL, dbKey: txnKey(value.from, value.nonce, value.hash) });
        }
        this.commit(writes);
      }
    }
  }

  /**
   * call a program function read-only: no nonce consumed, no gas fee, no DB writes
   * used for the /query endpoint so apps can read values from programs without sending a tx
   */
  query({ programUuid, functionName, input = {}, context, value = 0 } = {}, options = {}) {
    const caller = context ?? { sender: normalizeAddress(programUuid), origin: normalizeAddress(programUuid) };
    const result = this.runAction((tx) => {
      checkProgramUuid(programUuid);
      checkContext(caller);
      this.seedRandom(tx, { programUuid, functionName, input }, "call");
      return this.runFunction(tx, { programUuid, functionName, input, context: caller, value });
    }, { ...options, timestamp: options.timestamp ?? RealDate.now() });

    // discard all writes, keep only the data read
    const { writes, ...rest } = result;
    return { ...rest, readOnly: true };
  }

  /** several calls, then commit once */
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
      baseFee: baseFee ?? this.currentBaseFee(),   // running outside a block = the next block's base fee
      timeoutMs,
      maxCallDepth: this.maxCallDepth,
      maxTxGas: this.maxTxGas,
      gas: this.gasAt(blockNumber),   // per the rules of the block the tx is in (fork)
      chargeGas: this.chargeGas,
      feeRecipient: feeRecipient === null || feeRecipient === undefined ? null : normalizeAddress(feeRecipient),
      burnPercent: checkBurnPercent(burnPercent),
      memoryLimitBytes: this.memoryLimitBytes,
      maxStackBytes: this.maxStackBytes,
      wallClock: this.wallClock,
    });
  }

  /** run action(tx) and convert it to a response (always releases the tx's sandbox) */
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
      const charge = this.chargeOnSuccess(tx); // the program transferred out so much native that gas cannot be paid → OUT_OF_GAS
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
      // TIMEOUT depends on machine speed → not admitted to the block and nothing is charged
      const accepted = code === TIMEOUT ? false : this.isAccepted(tx);
      const writes = !accepted ? [] : [
        ...this.chargeOnFailure(tx), // failed txs still consume the nonce and gas fee
        ...this.transactionRecordWrites(tx, { status: STATUS.THROW, error: { code, message } }),
      ];
      return {
        status: STATUS.THROW,
        // txs that have not passed preliminary checks (e.g. wrong nonce) are considered not admitted, so they do not enter the block
        accepted,
        timestamp: tx.timestamp,
        gasUsed: tx.gasUsed,
        gasPrice: encodeNative(tx.gasPrice),
        ...this.feeSummary(tx),
        fee: encodeNative(tx.feeCharged),
        error: { code, message },
        debug: err?.detail ?? null,   // debug info; not stored in the DB and not part of any hash
        calls: tx.calls,
        events: [],   // a wholly failed tx = no events
        writes,
      };
    }
  }

  /** gas fee breakdown (in every tx result): block baseFee · burned portion · block closer's portion · type 2 = maxFee / priority were sent */
  feeSummary(tx) {
    return {
      baseFee: encodeNative(tx.baseFee),
      burnedFee: encodeNative(tx.feeBurned),
      producerFee: encodeNative(tx.feeReward),
      ...(tx.fees?.type === 2 ? { feeType: 2, maxFeePerGas: encodeNative(tx.fees.maxFee), maxPriorityFeePerGas: encodeNative(tx.fees.maxPriority) } : {}),
      ...(tx.payer?.sponsor ? { sponsor: tx.payer.sponsor } : {}),   // the gas payer for this tx
    };
  }

  /** whether the tx has been admitted (nonce passed and a payer is set) */
  isAccepted(tx) {
    if (tx.payer) return true;
    return !this.requireNonce && !this.chargeGas && !this.recordTransactions;
  }

  /**
   * preliminary check before admitting a tx to the queue (reads only the nonce from the DB; does not run the program)
   * used to filter out duplicate txs before they enter a block
   */
  checkTransaction({ nonce, from, context } = {}, { read = (dbKey) => this.read(dbKey) } = {}) {
    const address = normalizeAddress(from ?? context?.sender);
    if (!isNonEmptyString(address)) return { ok: false, reason: "ไม่มี sender" };
    if (!this.requireNonce) return { ok: true, expectedNonce: null };

    const expectedNonce = read(nonceKey(address)) ?? 0;
    if (nonce !== expectedNonce) return { ok: false, reason: `nonce ต้องเป็น ${expectedNonce}`, expectedNonce };
    return { ok: true, expectedNonce };
  }

  // ---------- nonce / gas fees ----------

  /** set the payer of the outermost tx: check the nonce, then set the gas ceiling from the native balance */
  preparePayer(tx, address, { nonce, gasLimit, gasPrice, maxFeePerGas, maxPriorityFeePerGas, sponsor, value = 0 } = {}) {
    const requestedLimit = Math.min(checkGasLimit(gasLimit), tx.maxTxGas);
    // actual price = min(maxFee, baseFee + priority) · maxFee below the block's baseFee → rejected (nonce not consumed)
    tx.fees = resolveFees({ gasPrice, maxFeePerGas, maxPriorityFeePerGas }, tx.baseFee);
    tx.gasPrice = tx.fees.price;
    if (!this.requireNonce && !this.chargeGas && !this.recordTransactions) {
      tx.gasLimit = requestedLimit;
      if (tx.gas.tx) tx.useGas(tx.gas.tx);   // base cost per tx (bluewolf fork)
      return;
    }

    const current = tx.current(nonceKey(address)) ?? 0;
    if (this.requireNonce && nonce !== current) fail(ERRORS.invalidNonce, current, nonce);
    // sponsor: pays gas on the sender's behalf (the sender still uses its own nonce and pays value itself) · the sponsor's signature was verified when the tx was admitted (verifyTransaction)
    tx.payer = sponsor && sponsor !== address ? { address, nonce: current, sponsor } : { address, nonce: current };

    if (tx.chargeGas) {
      if (tx.payer.sponsor && this.nativeBalance(tx, address) < readNative(value)) fail(ERRORS.nativeInsufficient, address);
      // funds available for gas = the payer's balance (minus the value attached to the tx when the payer is the sender)
      const available = tx.payer.sponsor ? this.nativeBalance(tx, tx.payer.sponsor) : this.nativeBalance(tx, address) - readNative(value);
      if (available < 0n) fail(ERRORS.nativeInsufficient, address);
      tx.gasLimit = tx.gasPrice > 0n ? Math.min(gasUnits(available / tx.gasPrice), requestedLimit) : requestedLimit;
    } else {
      tx.gasLimit = requestedLimit;
    }
    if (tx.gas.tx) tx.useGas(tx.gas.tx);   // base cost per tx (bluewolf fork)
  }

  /** remember the request to write the tx list entry (called after preparePayer) */
  rememberTransaction(tx, request, action) {
    if (!this.recordTransactions || !tx.payer) return;
    tx.transaction = {
      hash: this.hashTransaction(request, { action }),
      action,
    };
  }

  /** write for the tx list: <address>:txn:<nonce>:<txhash> */
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

  /** writes for nonce + gas fee (base fee portion burned per burnPercent · tip goes to the block closer) */
  buildChargeWrites(tx, balance, raw) {
    const { address, nonce } = tx.payer;
    const feePayer = tx.payer.sponsor ?? address;
    const due = tx.gasFee();
    const fee = due < balance ? due : balance > 0n ? balance : 0n;
    tx.feeCharged = fee;
    const writes = [];
    if (this.requireNonce) writes.push({ type: WRITE.PUT, dbKey: nonceKey(address), value: nonce + 1 });
    if (fee <= 0n) return writes;

    // the gas fee goes into the payer's consumed field; the unburned part goes into the block closer's received field
    writes.push({
      type: WRITE.PUT,
      dbKey: nativeKey(feePayer, NATIVE_FIELD.CONSUMED),
      value: encodeNative(this.nativeField(tx, feePayer, NATIVE_FIELD.CONSUMED, raw) + fee),
    });

    // EIP-1559: of the base fee portion (gas × baseFee), burnPercent % is burned · the tip (amount above baseFee) goes entirely to the block closer
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

    const burned = fee - reward; // burned portion → sent to 0x000…000
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
      // values in the DB (the tx's writes have already been discarded)
      return this.buildChargeWrites(tx, this.nativeBalance(tx, tx.payer.sponsor ?? tx.payer.address, true), true);
    } catch {
      return []; // DB unreadable → gas fee cannot be collected
    }
  }

  // ---------- running program functions ----------

  /** load a program from the supplied code or from the DB */
  loadProgram(tx, programUuid, code = tx.current(codeKey(programUuid))) {
    if (typeof code !== "string") fail(ERRORS.programNotFound, programUuid);
    return this.compiler.compile(code);
  }

  /**
   * @param {Transaction} tx
   * @param {object} request  { programUuid, functionName, input, context, depth, code, isInit }
   *   code   single-line code (used at init because it is not in the DB yet)
   *   isInit allow calling initialization
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
        value: readNative(value),   // native attached to this call
        block: { timestamp: BigInt(tx.timestamp) },
      };
      const result = this.invokeProgram(tx, program, api, functionName, params, depth, programUuid);
      tx.assertAlive(); // DB failed but the program caught it → still throw
      record.result = result;
      Transaction.finishCall(record, undefined, tx.gasUsed);
      return result;
    } catch (err) {
      const error = VMError.fromProgram(err);
      // a real timeout only surfaces at the outermost level (inner catches never ran) → close every open call here
      if (depth === 0 && error.code === TIMEOUT) tx.closeRunningCalls(error);
      else Transaction.finishCall(record, error, tx.gasUsed);
      throw error;
    }
  }

  /** run in the tx's sandbox (time / memory / stack counted across the whole call chain) */
  invokeProgram(tx, program, api, functionName, params, depth, programUuid) {
    if (depth === 0) tx.remainingTime();   // time already ran out before starting → TIMEOUT
    const outcome = tx.sandbox().invoke({ programUuid, source: program.source, functionName, params, api, blockNumber: tx.blockNumber });
    if (outcome.kind === "fatal") throw tx.fatal;
    if (outcome.kind === "async") fail(ERRORS.asyncNotSupported);
    if (outcome.kind === "throw") {
      if (outcome.hostError !== undefined) throw outcome.hostError;   // the original host error that the program did not catch
      if (outcome.fakeTimeout) fail(ERRORS.timeout);
      if (outcome.guestError) throw VMError.fromGuest(outcome.guestError);
      throw new VMError(PROGRAM_ERROR, outcome.text);
    }
    // values leaving the program: BigInt converted to "123n" so they can be sent as JSON
    return this.checkValueSize(fromProgram(outcome.value, "ค่าที่ return"), "ค่าที่ return");
  }

  // ---------- APIs that programs call ----------

  /**
   * host-side APIs that programs call through the sandbox (values received are always copies from the program)
   * __gas / __str / __props / __spread / map / Date / Math / ThisAddress / BlockNumber live in the sandbox itself (see sandbox.js)
   * every function stops immediately if the DB has already failed in this request
   * caller.readonly (called via runProgram with { readonly: true } at any level above) → state-changing APIs throw (catchable)
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
      // ---- precompiles (input format same as keccak256: string or JSON data) ----
      sha256: guard((value) => this.programDigest(tx, "sha256", text(value, "ค่าที่ sha256"))),
      ripemd160: guard((value) => this.programDigest(tx, "ripemd160", text(value, "ค่าที่ ripemd160"))),
      blake2b: guard((value) => this.programDigest(tx, "blake2b", text(value, "ค่าที่ blake2b"))),
      modexp: guard((base, exponent, modulus) => this.programModexp(tx, base, exponent, modulus)),
      // ---- block / tx / code data ----
      BlockHash: guard((number) => this.programBlockHash(tx, number)),
      ChainId: guard(() => this.programEnv(tx, BigInt(this.chainId))),
      Coinbase: guard(() => this.programEnv(tx, tx.feeRecipient ?? null)),
      BlockGasLimit: guard(() => this.programEnv(tx, this.maxBlockGas === null || this.maxBlockGas === undefined ? null : BigInt(this.maxBlockGas))),
      GasPrice: guard(() => this.programEnv(tx, tx.gasPrice)),   // actual price of this tx = min(maxFee, baseFee + priority)
      BaseFee: guard(() => this.programEnv(tx, tx.baseFee)),     // block base fee (EIP-1559 · BASEFEE)
      GasLeft: guard(() => {
        tx.useGas(tx.gas.env);   // deduct this call's own cost first, then count what remains
        const left = tx.gasLimit - tx.gasUsed;
        return Number.isFinite(left) ? BigInt(left) : null;
      }),
      CodeHashOf: guard((address) => this.programCodeOf(tx, address, true)),
      CodeSizeOf: guard((address) => this.programCodeOf(tx, address, false)),
      // ---- raw bytes / EIP-712 (MetaMask eth_signTypedData_v4 signatures) ----
      keccak256Bytes: guard((hex) => this.programKeccakBytes(tx, hex)),
      ecrecoverDigest: guard((digest, signature) => this.programEcrecoverDigest(tx, digest, signature)),
      eip712Digest: guard((domain, types, primaryType, message) => this.programEip712(tx, (meter) => eip712Digest(
        toProgramValue(domain, "domain"), toProgramValue(types, "types"), primaryType, toProgramValue(message, "message"), meter))),
      eip712DomainSeparator: guard((domain, types) => this.programEip712(tx, (meter) => eip712DomainSeparator(
        toProgramValue(domain, "domain"), types === undefined || types === null ? undefined : toProgramValue(types, "types"), meter))),
    };
  }

  /** keys must not exceed the length limit (LMDB caps at ~1978 bytes, and history: adds another layer) */
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

  /** each cumulative total field */
  nativeField(tx, address, field, raw = false) {
    const dbKey = nativeKey(address, field);
    return readNative(raw ? tx.readRaw(dbKey) : tx.current(dbKey));
  }

  /** balance = received - sended - consumed */
  nativeBalance(tx, address, raw = false) {
    const { RECEIVED, SENDED, CONSUMED } = NATIVE_FIELD;
    return this.nativeField(tx, address, RECEIVED, raw)
      - this.nativeField(tx, address, SENDED, raw)
      - this.nativeField(tx, address, CONSUMED, raw);
  }

  /** increase a cumulative total (these values can never decrease) */
  addNative(tx, address, field, amount) {
    tx.put(nativeKey(address, field), encodeNative(this.nativeField(tx, address, field) + amount));
  }

  /** native transfer between addresses (used by both transferNative and the value attached to a call) */
  moveNative(tx, from, to, amount) {
    tx.useGas(2 * (tx.gas.read + tx.gas.write));
    if (this.nativeBalance(tx, from) < amount) fail(ERRORS.nativeInsufficient, from);

    this.addNative(tx, from, NATIVE_FIELD.SENDED, amount);
    this.addNative(tx, to, NATIVE_FIELD.RECEIVED, amount);
  }

  /** values leaving a program must not exceed the size limit (prevents dumping huge data into the DB) */
  checkValueSize(value, label) {
    const size = valueSize(value);
    if (size > this.maxValueSize) fail(ERRORS.valueTooLarge, this.maxValueSize, size);
    return value;
  }

  /** native balance of an address (reads 3 fields) */
  programNativeBalance(tx, address) {
    if (!isNonEmptyString(address)) fail(ERRORS.invalidAddress);
    tx.useGas(3 * tx.gas.read);
    return this.nativeBalance(tx, normalizeAddress(address));
  }

  /** whether this address is a program or a wallet (used to prevent transfers into programs that cannot handle funds) */
  programIsProgram(tx, address) {
    if (!isNonEmptyString(address)) fail(ERRORS.invalidAddress);
    tx.useGas(tx.gas.read);
    return tx.current(thisKey(normalizeAddress(address))) !== undefined;
  }

  /** read metadata of any address, e.g. namespace / creator */
  programMetadataOf(tx, address, field) {
    if (!isNonEmptyString(address)) fail(ERRORS.invalidAddress);
    if (!isNonEmptyString(field)) fail(ERRORS.invalidMetadataField, field);
    const value = tx.current(metadataKey(normalizeAddress(address), field));
    tx.useGas(tx.gas.read + tx.gas.byte * valueSize(value));
    return value ?? null;
  }

  /** keccak256 of a string or JSON data (objects are canonicalized first) */
  programKeccak(tx, value) {
    const text = typeof value === "string" ? value : canonicalJson(toJsonValue(value, "ค่าที่ keccak256"));
    tx.useGas(tx.gas.hash + tx.gas.byte * Buffer.byteLength(text, "utf8"));
    return keccak256Hex(text);
  }

  /** sha256 / ripemd160 / blake2b (BLAKE2b-512) of a string or JSON data → 0x… hex · gas = that hash's cost + bytes of data */
  programDigest(tx, name, value) {
    const text = typeof value === "string" ? value : canonicalJson(toJsonValue(value, `ค่าที่ ${name}`));
    const bytes = utf8ToBytes(text);
    tx.useGas(tx.gas[name] + tx.gas.byte * bytes.length);
    return `0x${bytesToHex(DIGESTS[name](bytes))}`;
  }

  /**
   * BigInt (base ** exponent) % modulus (MODEXP precompile) · modulus = 0n → 0n
   * gas = modexp + ⌊words² × max(exponent bits, 1) / 3⌋, charged before computing, so it can stop before the machine does heavy work
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
   * hash of a previous block (like BLOCKHASH): reaches back BLOCK_HASH_WINDOW blocks · current / future / older blocks → null
   * running outside a block (query) → the block after the latest counts as the current block
   */
  programBlockHash(tx, number) {
    if (typeof number === "number") fail(ERRORS.numberNotAllowed, "BlockHash");
    if (typeof number !== "bigint" || number < 0n) fail(ERRORS.invalidBlockNumber);
    tx.useGas(tx.gas.read);
    const current = BigInt(tx.blockNumber ?? (tx.current(LATEST_BLOCK_KEY) ?? 0) + 1);
    if (number >= current || number < current - BigInt(BLOCK_HASH_WINDOW)) return null;
    return tx.current(blockKey(Number(number)))?.hash ?? null;
  }

  /** chain / block / tx values already known (no DB read) */
  programEnv(tx, value) {
    tx.useGas(tx.gas.env);
    return value;
  }

  /**
   * the code an address currently uses (initialized programs · upgraded = new code)
   *   hash = true  → keccak256 of the code (same value as the codeHash cloneProgram uses to compute addresses) · not a program → null
   *   hash = false → code length in bytes (BigInt) · not a program → 0n
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

  /** recover the signer address from a message + signature (r + s + v, as in EIP-191/712) · digest = keccak256(UTF-8 of the message / canonical JSON) */
  programEcrecover(tx, value, signature) {
    if (!isNonEmptyString(signature) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) fail(ERRORS.invalidSignature);
    const text = typeof value === "string" ? value : canonicalJson(toJsonValue(value, "ค่าที่ ecrecover"));
    tx.useGas(tx.gas.recover + tx.gas.byte * Buffer.byteLength(text, "utf8"));
    return recoverAddress(hexToBytesStrict(keccak256Hex(text)), signature);
  }

  /**
   * EVM-style ecrecover: recover an address from a raw 32-byte digest (no re-hashing); used with eip712Digest / keccak256Bytes
   * unusable signature (v not 27/28, point not on the curve) → null · malformed → throw (catchable) · gas = recover
   */
  programEcrecoverDigest(tx, digest, signature) {
    if (typeof digest !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(digest)) fail(ERRORS.invalidDigest);
    if (!isNonEmptyString(signature) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) fail(ERRORS.invalidSignature);
    tx.useGas(tx.gas.recover);
    return recoverAddress(hexToBytesStrict(digest), signature);
  }

  /** keccak256 of raw bytes ("0x…" hex) → "0x…" 32 bytes · gas = hash + byte × number of bytes (same as keccak256 of a text of equal length) */
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
   * eip712Digest / eip712DomainSeparator: compute first (work is linear in data size the program already paid gas to create), then charge gas
   * gas = hash × number of keccak calls + byte × all bytes hashed (typeHash / string / bytes / array / struct / digest)
   * malformed data → INVALID_REQUEST (catchable), charging gas for the work done so far
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
   * record an event for the explorer to read (rolled back with writes if that branch fails)
   *   emit(name, data, { indexed: ["from", "to"] }) → searchable by those fields' values (GET /program/:a/events?name=&to= · eth_getLogs by topic)
   */
  programEmit(tx, programUuid, depth, name, data = {}, options) {
    if (!isNonEmptyString(name) || !METADATA_FIELD_PATTERN.test(name)) fail(ERRORS.invalidEventName);
    const value = this.checkValueSize(toInputValue(data, `event '${name}'`) ?? {}, "event");
    const indexed = checkIndexed(options, value);
    // indexed: each field writes 1 permanent index key (eventidx:) → charge an extra topic per field
    tx.useGas(tx.gas.event + tx.gas.byte * valueSize(value) + tx.gas.topic * indexed.length);
    tx.events.push({ index: tx.events.length, depth, program: programUuid, name, data: value, ...(indexed.length ? { indexed } : {}) });
    return true;
  }

  /** a program sets its own metadata (system fields cannot be changed) */
  programSetMetadata(tx, programUuid, field, value) {
    tx.useGas(tx.gas.write + tx.gas.byte * valueSize(value));
    this.writeMetadata(tx, programUuid, { [field]: value === undefined ? null : value });
    return true;
  }

  /** transfer native from this program's wallet to another address */
  programTransferNative(tx, programUuid, to, amount) {
    if (!isNonEmptyString(to)) fail(ERRORS.invalidAddress);
    if (amount <= 0n) fail(ERRORS.invalidAmount);
    this.moveNative(tx, programUuid, normalizeAddress(to), amount);
    return true;
  }

  /**
   * sender = the calling program, origin = unchanged; callee error → roll back the callee's writes, then throw for the caller to handle
   * { readonly: true } = STATICCALL-style: the callee and every level it calls cannot modify state (a level already readonly always passes it on)
   */
  programRunProgram(tx, caller, programUuid, functionName, input, { value = 0n, readonly = false } = {}) {
    value = checkValue(value);
    readonly = readonly || Boolean(caller.readonly);
    if (readonly && value > 0n) fail(ERRORS.readonlyValue);
    const savepoint = tx.savepoint();
    try {
      const target = normalizeAddress(programUuid);
      if (value > 0n) this.moveNative(tx, caller.programUuid, target, value); // attach funds to the call
      const context = { sender: caller.programUuid, origin: caller.context.origin };
      // input / return value are copied across the boundary (JSON) → builtin per 32 bytes (rounded up), both ways
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

  /** address of a program created by cloneProgram (CREATE2-style: factory + salt + code hash) → known before it is actually created */
  cloneAddressFor(factory, salt, oneLineCode) {
    return addressFromHash(this.hashData({ chainId: this.chainId, factory: normalizeAddress(factory), salt: String(salt), codeHash: keccak256Hex(oneLineCode) }));
  }

  /**
   * cloneProgram(template, initInput, { salt, value }) → new address
   *   copies the template's code (must be approved) to a new address, then runs initialization immediately in the same tx
   *   initialization's context.sender = the calling program (factory) · value is transferred from the factory to the new program
   *   the new program is approved immediately (no upgrader = immutable) · failure anywhere → everything rolls back
   *   trace: recorded as a call of kind "create" (explorer / callTracer show it as CREATE)
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
    const code = tx.current(codeKey(source));   // only initialized programs have it (pending / rejected / missing → no code)
    if (typeof code !== "string") fail(ERRORS.templateNotActive, source);

    const address = this.cloneAddressFor(factory, saltText, code);
    if (tx.current(codeKey(address)) !== undefined || tx.current(pendingKey(address)) !== undefined
      || tx.current(thisKey(address)) !== undefined) fail(ERRORS.programUuidUsed, address);

    // gas fee: call (counted in runFunction) + by code size (like deploy) + writes of code / context / this / 4 metadata fields
    const codeSize = Buffer.byteLength(code, "utf8");
    tx.useGas(tx.gas.code * codeSize + 7 * tx.gas.write);

    const savepoint = tx.savepoint();
    try {
      if (amount > 0n) this.moveNative(tx, factory, address, amount);
      const context = { sender: factory, origin: caller.context.origin };
      tx.useGas(tx.gas.builtin * copyUnits(initInput));   // initInput is copied across the boundary, like runProgram input
      if (this.compiler.compile(code).hasInit) {
        this.runFunction(tx, { programUuid: address, functionName: INIT_FUNCTION, input: initInput, context, value: amount, depth, code, isInit: true, callType: "create" });
      } else {
        // even without initialization, the trace still needs a create entry
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
 * Order pending txs: higher tip per gas goes first, but each address's txs always stay in nonce order
 *   tip = min(maxPriorityFeePerGas, maxFeePerGas - baseFee) (legacy gasPrice = both values) · see effectiveTip
 *   baseFee not sent = 0 → order by the offered price directly, as before · txs with maxFee < baseFee count as tip = -1 (go last; Mempool.take skips them)
 * @param {Array<{ request: object, receivedAt?: number }>} items
 */
export function sortPendingTransactions(items, { defaultGasPrice = DEFAULT_GAS.price, baseFee = 0n } = {}) {
  const senderOf = (request) => normalizeAddress(request.from ?? request.context?.sender) ?? "";
  const priceOf = (request) => effectiveTip(request, readNative(baseFee), { defaultGasPrice }) ?? -1n;

  // an address's price = the cheapest tx in its queue (prevents one expensive tx from jumping the whole batch ahead)
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
//  Block: run several calls in sequence, then commit once
// ============================================================================

/**
 * each tx runs in order and sees the results of earlier txs in the block (not yet in the DB)
 * a tx that throws has no effect on the block; other txs keep running
 *
 * block-level data (same format as call):
 *   loadValues()   storage keys read by successful txs + DB values before the block
 *   afterValues()  storage keys touched by successful txs + values after the whole block + changed relative to before the block
 *   writes()       final writes, 1 entry per key
 *   timestamp      block time every tx sees
 */
export class Block {
  #vm;
  #read;
  #state = new Map();   // dbKey → latest write (put / del)
  #dbCache = new Map(); // dbKey → value read from the DB (each key is read from the DB once per block)
  #loaded = new Set();  // storage keys read by successful txs
  #touched = new Set(); // storage keys touched by successful txs (read / write / delete)
  #results = [];
  #requests = [];       // { action, request } of each tx for building receipts
  #rejected = [];       // txs not admitted to the block (e.g. wrong nonce)
  #committed = false;
  #timestamp;

  /** options: { read, timestamp }; no timestamp → Date.now() when the block is created */
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
  #upgrades = [];       // upgrades whose timelock elapsed and were activated at the start of this block
  #rejectedTxs = [];    // txs the producer rejected in earlier blocks (only recorded, not executed); see recordRejected
  #hashesCache = null;  // result of the latest hashes() (cleared when the block changes)
  #trieCache = null;    // trie nodes computed by hashes() (commit uses the same ones)
  #trustedStateRoot;    // replayBlock: stateRoot from the stored header (the trie in the DB is the latest, so an old block's cannot be computed)
  #baseFee;             // this block's base fee (BigInt · EIP-1559, computed from the previous block)
  #producer;            // producer address (part of the hash) · null = legacy block
  #producerSignature;   // producer's signature over the block hash (passed in = sync / replay · not passed = signed with vm.producer when needed)
  #timeoutMs;           // per-tx time (null = vm.timeoutMs); replay / sync use vm.replayTimeoutMs

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
    overwrite = false,     // rebuildFrom: overwrite the same block number (header / body / undo) in a single commit
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

    // no block number given → continue from the latest block in the DB automatically
    this.#number = number === undefined ? (recordBlocks ? (vm.latestBlockNumber() ?? 0) + 1 : null) : number;
    const previous = this.#number === null ? null : vm.getBlock(this.#number - 1);

    // parentHash / parentStateRoot not given → read from the previous block
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
    // the base fee always comes from the previous block's header (never accepted from the caller) → sync / replay compute it themselves and compare hashes
    // a block without a number (simulate) = the next block's base fee
    // the admin-set floor (gasconfig) is read from the state before the block (the caller's read) → setGasConfig in this block takes effect from the next block
    this.#baseFee = this.#number === null ? vm.currentBaseFee() : vm.baseFeeAfter(previous, read);
    if (this.#number !== null) this.#activateUpgrades();
  }

  /**
   * upgrade timelock: before the first tx of block N, activate all code scheduled for N (upgradeat:<N>)
   * done at block creation, so it depends only on the block number; replay / rebuild of the same block always gives the same result
   * writes go into the block's state (in stateRoot / history) but are not a tx: no hash, not in the body
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
      // failed (migrate threw) → discard the schedule, the old code keeps running
      this.#state.set(scheduledUpgradeKey(programUuid), { type: WRITE.DEL, dbKey: scheduledUpgradeKey(programUuid) });
      this.#upgrades.push({ program: programUuid, status: result.status, version: result.result?.version ?? null, error: result.error ?? null });
    }
    this.#state.set(dueKey, { type: WRITE.DEL, dbKey: dueKey });
    this.#hashesCache = null;
  }

  /** programs whose new code was activated at the start of this block (timelock elapsed) */
  upgrades() {
    return this.#upgrades.map(copyValue);
  }

  /** this block's base fee (BigInt wei per gas) */
  get baseFee() {
    return this.#baseFee;
  }

  /** block closer receiving a share of the gas fee */
  get feeRecipient() {
    return this.#feeRecipient;
  }

  get number() {
    return this.#number;
  }

  get parentHash() {
    return this.#parentHash;
  }

  /** stateRoot of the previous block (the chain of state links up) */
  get parentStateRoot() {
    return this.#parentStateRoot;
  }

  /** block time: every tx sees this value */
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

  setGasConfig(request) {
    return this.#execute("setGasConfig", request);
  }

  initUpgrade(request) {
    return this.#execute("initUpgrade", request);
  }

  rejectUpgrade(request) {
    return this.#execute("rejectUpgrade", request);
  }

  /** results of every tx in the block (copy) */
  results() {
    return this.#results.map(copyValue);
  }

  /** preliminary check that also counts txs already in this block (used to filter the queue before the real call) */
  checkTransaction(request) {
    const quotaError = this.#quotaError(request);
    if (quotaError) return { ok: false, reason: quotaError.message };
    return this.#vm.checkTransaction(request, { read: (dbKey) => this.read(dbKey) });
  }

  /** remaining quota of this block */
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

  /** txs rejected before entering the block (wrong nonce etc.) */
  rejected() {
    return this.#rejected.map(copyValue);
  }

  /** storage keys read, with their DB values before the block */
  loadValues() {
    return [...this.#loaded].map((dbKey) => ({ dbKey, loadValue: this.#beforeBlock(dbKey) }));
  }

  /** storage keys touched, with values after the whole block and whether they changed from before the block */
  afterValues() {
    return [...this.#touched].map((dbKey) => {
      const afterValue = this.read(dbKey);
      return { dbKey, afterValue, changed: !isSameValue(this.#beforeBlock(dbKey), afterValue) };
    });
  }

  /** writes of all txs (block data not yet included) */
  stateWrites() {
    return [...this.#state.values()].map(copyValue);
  }

  /** final writes of the whole block (1 entry per key) to persist in one go */
  writes() {
    const stateWrites = this.stateWrites();
    const blockWrites = this.blockWrites();
    return [...stateWrites, ...blockWrites, ...this.historyWrites([...stateWrites, ...blockWrites])];
  }

  /** the value of a key before it changed (from the block cache if present, otherwise from the DB) */
  #beforeValue(dbKey) {
    if (!this.#dbCache.has(dbKey)) this.#dbCache.set(dbKey, this.#read(dbKey));
    return this.#dbCache.get(dbKey);
  }

  /** history:<key>:<block> for every key this block touched + blockundo:<block> */
  historyWrites(writes = this.writes()) {
    if (!this.#recordHistory) return [];

    // the chain's own data (blocks / indexes) needs no history because it can be rebuilt from the bodies
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

  /** block hash: { hash, parentHash, txRoot, stateRoot, writesRoot, ... } */
  hashes() {
    // same result until the block changes (tx run / rejected tx recorded / upgrade activated); header() / receipt() / commit() call it several times
    if (this.#hashesCache) return { ...this.#hashesCache };
    this.#hashesCache = this.#computeHashes();
    return { ...this.#hashesCache };
  }

  #computeHashes() {
    const writes = this.stateWrites();
    const txHashes = this.txHashes();
    const { receiptsRoot, logsBloom: bloom } = this.receiptRoots(txHashes);
    // stateRoot = trie root after applying this block's writes onto the latest trie in the DB (= the state before this block)
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
   * condensed receipts of every tx (data produced by execution; not in txRoot), ordered by index
   *   { hash, status, gasUsed, cumulativeGasUsed, effectiveGasPrice, fee, error, logs: [{ address, topics, data }] }
   * receiptsRoot = hash of this list · logsBloom = bloom of every log (EVM-style) → in the header and the block hash
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

  /** { receiptsRoot, logsBloom } of this block */
  receiptRoots(txHashes = this.txHashes()) {
    const entries = this.receiptEntries(txHashes);
    return { receiptsRoot: this.#vm.hashData(entries), logsBloom: logsBloom(entries.flatMap((entry) => entry.logs)) };
  }

  /**
   * record a rejected tx in the block (not executed, no state touched, no nonce consumed, no gas fee) → the stored entry
   *   { hash, sender, nonce, action, to, gasPrice, reason, code, stage }   stage: "sendtx" | "block" | "expired"
   * part of the block hash (rejectedRoot) → replay / sync must insert the same entries in the same order to get a matching hash
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

  /** rejected txs recorded in this block (copy) */
  rejectedTransactions() {
    return this.#rejectedTxs.map((entry) => ({ ...entry }));
  }

  /** hashes of every tx in the block, in order */
  txHashes() {
    return this.#results.map((result, index) => {
      const { action, request } = this.#requests[index];
      return this.#vm.hashTransaction(request, { action, blockNumber: this.#number, index });
    });
  }

  /** block data to persist to the DB (block:<number>, blockhash:<hash>, latestblock, tx:<hash>) */
  blockWrites() {
    if (!this.#recordBlocks) return [];

    const header = this.header();
    const writes = [
      { type: WRITE.PUT, dbKey: blockKey(this.#number), value: header },
      { type: WRITE.PUT, dbKey: blockBodyKey(this.#number), value: this.body() },
      { type: WRITE.PUT, dbKey: blockHashKey(header.hash), value: this.#number },
      { type: WRITE.PUT, dbKey: LATEST_BLOCK_KEY, value: this.#number },
    ];

    // rejected txs: the block's list + indexes by hash / sender
    if (this.#rejectedTxs.length) {
      writes.push({ type: WRITE.PUT, dbKey: blockRejectedKey(this.#number), value: this.rejectedTransactions() });
      this.#rejectedTxs.forEach((entry, index) => {
        const value = { ...entry, blockNumber: this.#number, index, timestamp: this.#timestamp };
        writes.push({ type: WRITE.PUT, dbKey: rejectedTxKey(entry.hash), value });
        writes.push({ type: WRITE.PUT, dbKey: rejectedFromKey(entry.sender, this.#number, index), value });
      });
    }

    const signatures = new Set();   // eventsig: written once per block
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
          // gas fees (eth_feeHistory reads them from here without replaying)
          gasUsed: result.gasUsed ?? 0,
          gasPrice: result.gasPrice ?? null,
          tip: encodeNative(readNative(result.gasPrice) > this.#baseFee ? readNative(result.gasPrice) - this.#baseFee : 0n),
        },
      });
      // also allows lookup from the hash the user signed (EIP-712) back to the tx
      if (digest) writes.push({ type: WRITE.PUT, dbKey: sigTxKey(digest), value: hash });

      // index of "who interacted with this address" (called program, or funds recipient)
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
            // blockNumber / index are in the key · timestamp is read from the header (readTransactionTo)
          },
        });
      }

      // programs called in a nested way (runProgram) must also see who called them
      (result.calls ?? []).forEach((call, callIndex) => {
        if (call.depth === 0) return;   // the outermost level was already recorded above
        writes.push({
          type: WRITE.PUT,
          dbKey: txToKey(call.programUuid, this.#number, index, callIndex + 1),
          value: {
            // status = result of this level's call · txStatus = result of the whole tx (this level may fail while an upper level catches it)
            hash, action: call.type === "create" ? "create" : "call", status: call.status, txStatus: result.status,
            from: normalizeAddress(call.sender ?? call.context?.sender) ?? null,
            method: call.functionName ?? null,
            depth: call.depth, via: normalizeAddress(request.programUuid) ?? null, value: 0,
          },
        });
      });

      // event index: lets you search what this program has emitted
      for (const event of result.events ?? []) {
        writes.push({
          type: WRITE.PUT,
          dbKey: eventKey(event.program, event.name, this.#number, index, event.index),
          value: { ...event, blockNumber: this.#number, txIndex: index, txHash: hash, timestamp: this.#timestamp },
        });
        // indexed fields → eventidx:<program>:<name>:<field>:<topic>:… (searchable by value without scanning every event) + eventsig: (topic0 → name)
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
        // Transfer events of token / NFT and TransferSingle / TransferBatch of multi-token → remember that this address holds this program's assets
        // (the real balance is read from the program when displayed)
        if (HOLDING_EVENTS.has(event.name) && result.status === STATUS.SUCCESS) {
          for (const holder of [event.data?.to, event.data?.from]) {
            if (!isWalletAddress(holder) || /^0x0{40}$/i.test(holder)) continue;
            writes.push({ type: WRITE.PUT, dbKey: holdingKey(normalizeAddress(holder), event.program),
              value: { program: event.program, lastBlock: this.#number } });
          }
        }
      }
    });
    // from which block history is complete: this block keeps no history → count again from the next block · no value yet → the first block that keeps it
    if (!this.#recordHistory) writes.push({ type: WRITE.PUT, dbKey: HISTORY_FROM_KEY, value: this.#number + 1 });
    else if (this.#vm.read(HISTORY_FROM_KEY) === undefined) writes.push({ type: WRITE.PUT, dbKey: HISTORY_FROM_KEY, value: this.#vm.historyFrom() ?? this.#number });
    return writes;
  }

  /** raw txs of every tx in the block, in order (usable for replay) */
  body() {
    return this.#requests.map(({ action, method, request }) => ({ action, method, request: copyValue(request) }));
  }

  /** block header (no tx details) */
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
      baseFeePerGas: encodeNative(this.#baseFee),   // EIP-1559 (part of the hash)
      gasTarget: this.#vm.gasTarget,                // target gas per block (null = fixed base fee)
      burnedFee: sum("burnedFee"),                  // gas fees burned in the whole block
      producerFee: sum("producerFee"),              // gas fees the block closer receives (tip + unburned base fee portion)
      parentStateRoot: this.#parentStateRoot,
      txRoot,
      stateRoot,                                     // root of the trie of the whole state after this block (verifiable with getProof)
      writesRoot,                                    // hash of this block's state writes
      receiptsRoot,                                  // hash of every condensed receipt (part of the hash)
      logsBloom: bloom,                              // EVM-style bloom of every log (part of the hash)
      txHashes,
      ...(this.#rejectedTxs.length ? { rejectedCount: this.#rejectedTxs.length, rejectedRoot: this.hashes().rejectedRoot } : {}),
      ...(this.#upgrades.length ? { upgrades: this.upgrades() } : {}),   // timelocks elapsed in this block (not part of the hash; the effect is already in stateRoot)
      ...(this.#producer ? { producer: this.#producer, producerSignature: this.producerSignature() } : {}),
    };
  }

  /**
   * producer's signature over the block hash → "0x" + r + s + v · null = no producer, or this node is not the block's producer
   * the producer node signs with vm.producer.sign (same value every time for the same hash) · sync / replay use the signature that came with the header
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

  /** receipt of the whole block for the explorer */
  receipt({ number = this.#number, feeRecipient = this.#feeRecipient } = {}) {
    // native values before each tx (walked in block order) → the receipt can show how much each field changed
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
      rejected: this.rejectedTransactions(),   // rejected txs (not executed) recorded in this block
      // events of the whole block in tx order (used for the explorer feed)
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

  /** summary of the whole block in the same format as a call result */
  summary() {
    return {
      timestamp: this.#timestamp,
      results: this.results(),
      loadValues: this.loadValues(),
      afterValues: this.afterValues(),
      writes: this.writes(),
    };
  }

  /** persist the whole block's writes to the DB in one go, then close the block */
  commit() {
    if (this.#committed) fail(ERRORS.blockCommitted);
    if (this.#recordBlocks && !this.#overwrite && this.#vm.getBlock(this.#number)) fail(ERRORS.blockExists, this.#number);
    const writes = this.writes();   // compute hashes (+ trie) if not done yet
    const result = this.#vm.commit(writes, this.#trieCache ? { trie: this.#trieCache } : {});
    this.#committed = true;
    if (this.#recordBlocks && this.#recordHistory && this.#vm.historyKeep !== null) this.#vm.pruneHistory();
    return result;
  }

  get committed() {
    return this.#committed;
  }

  /** current value within the block: block state → value previously read from the DB → read the DB */
  read(dbKey) {
    if (this.#state.has(dbKey)) {
      const write = this.#state.get(dbKey);
      return write.type === WRITE.DEL ? undefined : copyValue(write.value);
    }
    if (!this.#dbCache.has(dbKey)) this.#dbCache.set(dbKey, this.#read(dbKey));
    return copyValue(this.#dbCache.get(dbKey));
  }

  /** DB value before the block (keys touched by successful txs have always already been read from the DB) */
  #beforeBlock(dbKey) {
    return copyValue(this.#dbCache.get(dbKey));
  }

  /** sender address of a request (used for per-sender limits) */
  #senderOf(request) {
    return normalizeAddress(request?.from ?? request?.context?.sender) ?? null;
  }

  /** whether quota remains for this tx; returns an error if full */
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

  /** result of a tx not admitted to the block (no program run) */
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
      return result; // never enters the block: no writes / hash / indexes
    }

    // block gas is full → this tx is not accepted (its execution result is discarded)
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
    this.#results.push(copyValue(result)); // store a copy: callers modifying the returned result do not affect the block
    this.#requests.push({ action, method, request: copyValue(request) ?? {} });
    return result;
  }
}
