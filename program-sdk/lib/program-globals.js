/**
 * API ปลอมสำหรับทดสอบโปรแกรมในเครื่องแบบเร็ว ๆ โดยไม่ต้องรัน VM
 *   const api = createFakeApi({ balances: { "0xabc": 100n } });
 *   Object.assign(globalThis, api);
 *   const { transfer } = program();
 *
 * ตัวเลขเป็น BigInt เหมือนบน chain: ยอดเงิน / params.value / params.block.timestamp / BlockNumber()
 * (ต่างจาก chain ตรงที่ไม่ได้แปลง input / storage ให้ — ส่ง 10n เข้ามาเอง)
 *
 * ถ้าอยากได้พฤติกรรมเหมือนบน chain ทุกอย่าง (ค่าแก๊ส, การย้อนข้อมูลเมื่อ throw, เวลาของ block)
 * ให้ใช้ createChain() จาก lib/testkit.js แทน ซึ่งรันบน VM ตัวจริง
 */
import { createHash } from "node:crypto";

/** ข้อมูล → ข้อความแบบเดียวกับบน chain (key เรียงตามตัวอักษร · BigInt เป็น "123n") */
const canonical = (value) => {
  if (typeof value === "bigint") return JSON.stringify(`${value}n`);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
const digest = (algorithm) => (value) =>
  `0x${createHash(algorithm).update(typeof value === "string" ? value : canonical(value), "utf8").digest("hex")}`;

/**
 * @typedef {object} Params
 * @property {object} input                 ข้อมูลที่ผู้เรียกส่งมา
 * @property {{ sender: string, origin: string }} context  ผู้เรียกชั้นนี้ / ผู้เริ่ม tx
 * @property {bigint} value                 native ที่แนบมากับการเรียกนี้
 * @property {{ timestamp: bigint }} block  เวลาของ block
 */

/**
 * @param {object} [options]
 * @param {Record<string, any>} [options.storage]   ข้อมูลตั้งต้นของโปรแกรม
 * @param {Record<string, bigint>} [options.balances] ยอด native ของแต่ละ address
 * @param {Record<string, object>} [options.metadata] metadata ของแต่ละ address
 * @param {string[]} [options.programs]             address ที่ถือว่าเป็นโปรแกรม
 * @param {string} [options.self]                   address ของโปรแกรมที่กำลังทดสอบ
 * @param {number} [options.blockNumber]
 * @param {number} [options.timestamp]
 * @param {Record<number, string>} [options.blockHashes] hash ของ block ก่อนหน้า (เลข block → hash) สำหรับ BlockHash()
 * @param {Record<string, string>} [options.code]      โค้ดของแต่ละ address สำหรับ CodeSizeOf()
 * @param {number} [options.chainId]
 * @param {string|null} [options.coinbase]           ผู้ปิด block
 * @param {number|null} [options.blockGasLimit]
 * @param {bigint} [options.gasPrice]
 */
export function createFakeApi({
  storage = {},
  balances = {},
  metadata = {},
  programs = [],
  self = "0xprogram",
  blockNumber = 1,
  timestamp = Date.parse("2025-01-01T00:00:00Z"),
  blockHashes = {},
  code = {},
  chainId = 1,
  coinbase = null,
  blockGasLimit = null,
  gasPrice = 1_000_000_000n,
} = {}) {
  const store = new Map(Object.entries(storage));
  const meta = new Map(Object.entries(metadata));
  const programSet = new Set([self, ...programs].map((address) => address.toLowerCase()));
  const events = [];
  const transfers = [];

  const toKey = (key) => (typeof key === "string" ? key : key.parts.join(":"));
  const lower = (address) => String(address).toLowerCase();
  const native = new Map(Object.entries(balances).map(([address, value]) => [lower(address), BigInt(value)]));
  const balanceOf = (address) => native.get(lower(address)) ?? 0n;

  return {
    // ---------- ข้อมูลของโปรแกรม ----------
    /** @param {string|object} key */
    readDB: (key) => store.get(toKey(key)),
    /** @param {string|object} key @param {any} value */
    writeDB: (key, value) => void store.set(toKey(key), value),
    /** @param {string|object} key */
    deleteDB: (key) => void store.delete(toKey(key)),
    /** @param {...(string|number|bigint)} parts */
    map: (...parts) => ({ parts: parts.map(String) }),

    // ---------- เงิน ----------
    /** ยอด native คงเหลือของโปรแกรมตัวเอง */
    ThisBalance: () => balanceOf(self),
    /** @param {string} address */
    BalanceOf: (address) => balanceOf(address),
    /** @param {string} to @param {bigint} amount */
    transferNative: (to, amount) => {
      if (typeof amount !== "bigint") throw new Error("amount: ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เช่น 10n)");
      if (amount <= 0n) throw new Error("amount ต้องเป็นจำนวนเต็มบวก");
      if (balanceOf(self) < amount) throw new Error(`ยอด native ของ '${self}' ไม่พอ`);
      native.set(lower(self), balanceOf(self) - amount);
      native.set(lower(to), balanceOf(to) + amount);
      transfers.push({ from: lower(self), to: lower(to), amount });
      return true;
    },

    // ---------- ข้อมูลของ address ----------
    /** address ของโปรแกรมตัวเอง */
    ThisAddress: () => self,
    /** @param {string} address */
    IsProgram: (address) => programSet.has(lower(address)),
    /** @param {string} address @param {string} field */
    MetadataOf: (address, field) => meta.get(lower(address))?.[field] ?? null,
    /** @param {string} field @param {any} value */
    setMetadata: (field, value) => {
      const current = meta.get(lower(self)) ?? {};
      if (value === null) delete current[field];
      else current[field] = value;
      meta.set(lower(self), current);
      return true;
    },

    // ---------- event / block ----------
    /** @param {string} name @param {object} [data] */
    emit: (name, data = {}) => {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(name)) throw new Error("ชื่อ event ไม่ถูกต้อง");
      events.push({ index: events.length, name, data });
      return true;
    },
    BlockNumber: () => BigInt(blockNumber),
    /** hash ของ block ก่อนหน้า (ย้อนได้ 256 block) · block ปัจจุบัน / อนาคต → null @param {bigint} n */
    BlockHash: (n) => {
      if (typeof n !== "bigint") throw new Error("BlockHash: ตัวเลขในโปรแกรมต้องเป็น BigInt เท่านั้น (เช่น 10n)");
      if (n >= BigInt(blockNumber) || n < BigInt(blockNumber) - 256n) return null;
      return blockHashes[Number(n)] ?? null;
    },
    ChainId: () => BigInt(chainId),
    Coinbase: () => (coinbase === null ? null : lower(coinbase)),
    BlockGasLimit: () => (blockGasLimit === null ? null : BigInt(blockGasLimit)),
    GasPrice: () => BigInt(gasPrice),
    /** โหมดนี้ไม่นับแก๊ส → null เสมอ (ใช้ createChain() ถ้าต้องการค่าจริง) */
    GasLeft: () => null,

    // ---------- โค้ดของ address ----------
    /** @param {string} address */
    CodeSizeOf: (address) => (code[lower(address)] === undefined ? 0n : BigInt(Buffer.byteLength(code[lower(address)], "utf8"))),
    /** keccak256 ของโค้ดคำนวณไม่ได้ในโหมดนี้ (ไม่มี keccak ใน node:crypto) — ใช้ createChain() แทน */
    CodeHashOf: (address) => {
      if (code[lower(address)] === undefined) return null;
      throw new Error("โหมดทดสอบเร็วคำนวณ CodeHashOf ไม่ได้ ใช้ createChain() แทน");
    },

    // ---------- precompile ----------
    /** @param {string|object} value */
    sha256: digest("sha256"),
    /** @param {string|object} value */
    ripemd160: digest("ripemd160"),
    /** BLAKE2b-512 @param {string|object} value */
    blake2b: digest("blake2b512"),
    /** (base ** exponent) % modulus · modulus = 0n → 0n @param {bigint} base @param {bigint} exponent @param {bigint} modulus */
    modexp: (base, exponent, modulus) => {
      for (const value of [base, exponent, modulus]) {
        if (typeof value !== "bigint" || value < 0n) throw new Error("modexp: base / exponent / modulus ต้องเป็น BigInt ที่ไม่ติดลบ");
      }
      if (modulus === 0n) return 0n;
      let result = 1n % modulus;
      for (let b = base % modulus, e = exponent; e > 0n; e >>= 1n, b = (b * b) % modulus) if (e & 1n) result = (result * b) % modulus;
      return result;
    },

    /** เรียกโปรแกรมอื่นไม่ได้ในโหมดนี้ — ใช้ createChain() จาก testkit แทน */
    runProgram: () => { throw new Error("โหมดทดสอบเร็วเรียกโปรแกรมอื่นไม่ได้ ใช้ createChain() แทน"); },
    /** สร้างโปรแกรมใหม่ไม่ได้ในโหมดนี้ — ใช้ createChain() จาก testkit แทน */
    cloneProgram: () => { throw new Error("โหมดทดสอบเร็วสร้างโปรแกรมใหม่ไม่ได้ ใช้ createChain() แทน"); },

    // ---------- ตรวจผลในเทสต์ ----------
    store, native, meta, events, transfers,
    params: (input = {}, { sender = "0xalice", value = 0n } = {}) =>
      ({ input, context: { sender, origin: sender }, value: BigInt(value), block: { timestamp: BigInt(timestamp) } }),
  };
}
