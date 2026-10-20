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
 */
export function createFakeApi({
  storage = {},
  balances = {},
  metadata = {},
  programs = [],
  self = "0xprogram",
  blockNumber = 1,
  timestamp = Date.parse("2025-01-01T00:00:00Z"),
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

    /** เรียกโปรแกรมอื่นไม่ได้ในโหมดนี้ — ใช้ createChain() จาก testkit แทน */
    runProgram: () => { throw new Error("โหมดทดสอบเร็วเรียกโปรแกรมอื่นไม่ได้ ใช้ createChain() แทน"); },

    // ---------- ตรวจผลในเทสต์ ----------
    store, native, meta, events, transfers,
    params: (input = {}, { sender = "0xalice", value = 0n } = {}) =>
      ({ input, context: { sender, origin: sender }, value: BigInt(value), block: { timestamp: BigInt(timestamp) } }),
  };
}
