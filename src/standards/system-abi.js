/**
 * ABI of the bundled programs (the deploy-system set) — the node serves it from the program code itself, it is not stored on-chain
 *
 *   systemAbiOf(code) → metadata.abi of the bundled program whose code matches character for character · otherwise = null
 *   resolveAbi(read, address) → the program's own metadata.abi ?? the bundled program ABI (used everywhere ABI is read: /evm · /program · explorer)
 *
 * Why not on-chain: bundled programs have no upgrader (code can't change) · an ABI embedded in code = unchangeable forever
 *   and clones (dex pairs / multisigs from the factory) would each have to pay gas to write the ABI
 *   Here it is bound to the code (same code = same ABI) → works for clones too · the ABI can be fixed in the next node release without touching the chain
 * Template token / NFT / multi-token are not in this set: /evm already knows them as ERC-20 / ERC-721 / ERC-1155
 * Types: uint / int / address / bool / string / bytes · object / array / any = a JSON string (see checkAbi)
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

/** keys match systemPrograms() in system.js */
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
/** code stored on-chain (single-line form) → ABI · code not matching character for character = null */
export function systemAbiOf(code) {
  if (typeof code !== "string") return null;
  byCode ??= new Map(SYSTEM_ABIS.map((item) => [toOneLine(item.code), item.abi]));
  return byCode.get(code) ?? null;
}

/** ABI of an address: the one declared in metadata.abi first, then the bundled program · read(dbKey) reads state (latest, or at a block) */
export function resolveAbi(read, address) {
  const lower = String(address ?? "").toLowerCase();
  return read(metadataKey(lower, "abi")) ?? systemAbiOf(read(codeKey(lower)));
}

/** metadata of an address + the bundled program's abi (if it declares none) — for responses where the explorer reads metadata.abi */
export function withSystemAbi(metadata, read, address) {
  if (!metadata || metadata.abi) return metadata;
  const abi = systemAbiOf(read(codeKey(String(address ?? "").toLowerCase())));
  return abi ? { ...metadata, abi } : metadata;
}
