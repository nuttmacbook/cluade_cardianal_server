/**
 * ตัวช่วยแปลงข้อมูลที่ไม่พึ่ง VM / sandbox (ใช้ทั้งฝั่ง node และ SDK ฝั่ง client — ดู client-sdk/index.js)
 * virtualmachine.js export ตัวเดียวกันนี้ต่อ (ของเดิม import จากที่นั่นได้เหมือนเดิม)
 */
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export const HEX_PATTERN = /^0x[0-9a-f]+$/i;

export const keccak256Hex = (text) => `0x${bytesToHex(keccak_256(utf8ToBytes(text)))}`;

/** address ของ wallet / program เป็นตัวพิมพ์เล็กเสมอ */
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

/**
 * ข้อมูลที่ hash เป็น hash ของ block (จาก field ของ header) — VM.hashHeader และ client-sdk (ตรวจ header ที่ได้มา) ใช้ตัวเดียวกัน
 *   hash ของ block = keccak256(canonicalJson(headerFields(header, chainId)))
 */
export function headerFields({ number, parentHash, timestamp, feeRecipient, burnPercent, txCount, txRoot, stateRoot, writesRoot,
  baseFeePerGas = null, gasUsed = 0, receiptsRoot = null, logsBloom = null, rejectedCount = 0, rejectedRoot = null, producer = null }, chainId) {
  return {
    chainId, number, parentHash: parentHash ?? null, timestamp,
    feeRecipient: feeRecipient ?? null, burnPercent, txCount, txRoot, stateRoot, writesRoot,
    // EIP-1559 + receipt: base fee ของ block / แก๊สที่ใช้ (ใช้คำนวณ base fee ของ block ถัดไป) / root ของ receipt / bloom ของ log
    baseFeePerGas, gasUsed, receiptsRoot, logsBloom,
    ...(rejectedRoot ? { rejectedCount, rejectedRoot } : {}),
    // ผู้ผลิต: อยู่ใน hash เฉพาะ block ที่มี · ลายเซ็นของผู้ผลิตเซ็น hash นี้ จึงอยู่นอก hash
    ...(producer ? { producer } : {}),
  };
}
