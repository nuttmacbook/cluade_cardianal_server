/**
 * ABI ของโปรแกรมแถม (ชุด deploy-system) — node ตอบให้เองจากโค้ดของโปรแกรม ไม่ได้เก็บบนเชน
 *
 *   systemAbiOf(code) → metadata.abi ของโปรแกรมแถมที่โค้ดตรงทุกตัวอักษร · ไม่ใช่ = null
 *   resolveAbi(read, address) → metadata.abi ที่โปรแกรมประกาศเอง ?? ABI ของโปรแกรมแถม (ใช้ทุกที่ที่อ่าน ABI: /evm · /program · explorer)
 *
 * ทำไมไม่เก็บบนเชน: โปรแกรมแถมไม่มี upgrader (แก้โค้ดไม่ได้) · ABI ที่ฝังในโค้ด = แก้ไม่ได้ตลอดไป
 *   และ clone (คู่เทรดของ dex / multisig จาก factory) ต้องจ่ายแก๊สเขียน ABI ทุกตัว
 *   ที่นี่ผูกกับโค้ด (โค้ดเดียวกัน = ABI เดียวกัน) → clone ได้ด้วย · แก้ ABI ได้ใน node รุ่นถัดไปโดยไม่แตะเชน
 * token / NFT / multi-token ต้นแบบไม่อยู่ในชุดนี้: /evm รู้จักแบบ ERC-20 / ERC-721 / ERC-1155 อยู่แล้ว
 * ชนิด: uint / int / address / bool / string / bytes · object / array / any = string ที่เป็น JSON (ดู checkAbi)
 */
import { toOneLine, metadataKey, codeKey } from "../core/virtualmachine.js";
import { MULTICALL_PROGRAM } from "./multicall.js";
import { WCARD_PROGRAM, MULTISIG_PROGRAM, FACTORY_PROGRAM } from "./system.js";
import { MULTISENDER_PROGRAM } from "./multisender.js";
import { TOKEN_LOCK_PROGRAM } from "./tokenlock.js";
import { DEX_PAIR_PROGRAM, DEX_PROGRAM } from "./dex.js";
import { STAKING_PROGRAM } from "./staking.js";
import { LIMIT_ORDER_PROGRAM } from "./limitorder.js";
import { NFT_MARKET_PROGRAM } from "./nftmarket.js";
import { MULTICALL_ABI, WCARD_ABI, MULTISIG_ABI, FACTORY_ABI, MULTISENDER_ABI } from "./abi/system.js";
import { DEX_PAIR_ABI, DEX_ABI, TOKEN_LOCK_ABI } from "./abi/dex.js";
import { STAKING_ABI, LIMIT_ORDER_ABI, NFT_MARKET_ABI } from "./abi/markets.js";

/** key ตรงกับ systemPrograms() ใน system.js */
export const SYSTEM_ABIS = [
  { key: "multicall", code: MULTICALL_PROGRAM, abi: MULTICALL_ABI },
  { key: "wcard", code: WCARD_PROGRAM, abi: WCARD_ABI },
  { key: "multisigTemplate", code: MULTISIG_PROGRAM, abi: MULTISIG_ABI },
  { key: "factory", code: FACTORY_PROGRAM, abi: FACTORY_ABI },
  { key: "multisender", code: MULTISENDER_PROGRAM, abi: MULTISENDER_ABI },
  { key: "tokenLock", code: TOKEN_LOCK_PROGRAM, abi: TOKEN_LOCK_ABI },
  { key: "dexPairTemplate", code: DEX_PAIR_PROGRAM, abi: DEX_PAIR_ABI },
  { key: "dex", code: DEX_PROGRAM, abi: DEX_ABI },
  { key: "staking", code: STAKING_PROGRAM, abi: STAKING_ABI },
  { key: "limitOrder", code: LIMIT_ORDER_PROGRAM, abi: LIMIT_ORDER_ABI },
  { key: "nftMarket", code: NFT_MARKET_PROGRAM, abi: NFT_MARKET_ABI },
];

let byCode = null;
/** โค้ดที่เก็บในเชน (แบบบรรทัดเดียว) → ABI · โค้ดไม่ตรงทุกตัวอักษร = null */
export function systemAbiOf(code) {
  if (typeof code !== "string") return null;
  byCode ??= new Map(SYSTEM_ABIS.map((item) => [toOneLine(item.code), item.abi]));
  return byCode.get(code) ?? null;
}

/** ABI ของ address: ที่ประกาศใน metadata.abi ก่อน แล้วจึงโปรแกรมแถม · read(dbKey) อ่าน state (ล่าสุด หรือ ณ block) */
export function resolveAbi(read, address) {
  const lower = String(address ?? "").toLowerCase();
  return read(metadataKey(lower, "abi")) ?? systemAbiOf(read(codeKey(lower)));
}

/** metadata ของ address + abi ของโปรแกรมแถม (ถ้าไม่ได้ประกาศเอง) — สำหรับ response ที่ explorer อ่าน metadata.abi */
export function withSystemAbi(metadata, read, address) {
  if (!metadata || metadata.abi) return metadata;
  const abi = systemAbiOf(read(codeKey(String(address ?? "").toLowerCase())));
  return abi ? { ...metadata, abi } : metadata;
}
