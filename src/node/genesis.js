/**
 * ค่าที่ทุกเครื่องในเครือข่ายต้องตั้งเหมือนกัน — ล็อกไว้ใน genesis.json (อยู่ใน genesis hash)
 *
 *   { "chainId": 1, "balances": { … }, "config": { "burnPercent": 100, "admins": ["0x…"], "producers": ["0x…"], … } }
 *
 *   const { settings, errors } = resolveSettings(genesis, process.env);
 *
 * ค่าแต่ละตัว = genesis ก่อน → env → ค่าเริ่มต้น
 * genesis มีค่าแล้วแต่ env ตั้งเป็นค่าอื่น → errors (server ไม่ยอมเริ่ม) — กันเครื่องหนึ่งตั้งต่างจากเครือข่ายจน hash ไม่ตรง
 * genesis ไม่มี config (ช่วงพัฒนา) = ไม่ล็อกอะไร ใช้ env ตามเดิม
 * genesis.forks = { "<ชื่อ>": <block> } ตาราง fork (ดู FORKS ใน virtualmachine.js) → settings.forks · ไม่อยู่ใน genesis hash เพิ่มทีหลังได้
 */

const list = (value) => (Array.isArray(value) ? value : String(value).split(","))
  .map((item) => String(item).trim().toLowerCase()).filter(Boolean);
const integer = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`ต้องเป็นจำนวนเต็ม (ได้ ${value})`);
  return number;
};
const wei = (value) => BigInt(String(value).replace(/n$/, ""));

/** ชื่อใน genesis → { env, parse, default } · chainId อยู่ชั้นบนของ genesis (ที่เดิม) ที่เหลืออยู่ใน genesis.config */
export const GENESIS_SETTINGS = {
  chainId: { env: "CHAIN_ID", parse: integer, default: 1 },
  burnPercent: { env: "BURN_PERCENT", parse: integer, default: 100 },
  minBaseFee: { env: "GAS_PRICE", parse: wei, default: 1_000_000_000n },
  gasTarget: { env: "GAS_TARGET", parse: integer, default: null },
  baseFeeDenominator: { env: "BASE_FEE_DENOMINATOR", parse: integer, default: 8 },
  blockMs: { env: "BLOCK_MS", parse: integer, default: 3000 },
  upgradeDelayBlocks: { env: "UPGRADE_DELAY_BLOCKS", parse: integer, default: 0 },
  memoryLimitMb: { env: "MEMORY_LIMIT_MB", parse: integer, default: 32 },
  stackLimitKb: { env: "STACK_LIMIT_KB", parse: integer, default: 256 },
  admins: { env: "ADMINS", parse: list, default: null },
  producers: { env: "PRODUCERS", parse: list, default: null },
};

const same = (a, b) => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? `${v}` : v)) === JSON.stringify(b, (_, v) => (typeof v === "bigint" ? `${v}` : v));
const sameSet = (a, b) => same([...a].sort(), [...b].sort());

/** genesis + env → { settings, locked: ชื่อที่ genesis ล็อก, errors: ข้อความ } */
export function resolveSettings(genesis = {}, env = {}) {
  const settings = {};
  const locked = [];
  const errors = [];
  for (const [name, { env: envName, parse, default: fallback }] of Object.entries(GENESIS_SETTINGS)) {
    const raw = name === "chainId" ? genesis?.chainId : genesis?.config?.[name];
    const envRaw = env[envName];
    let fromGenesis;
    let fromEnv;
    try { fromGenesis = raw === undefined || raw === null ? undefined : parse(raw); }
    catch (error) { errors.push(`genesis ${name}: ${error.message}`); continue; }
    try { fromEnv = envRaw === undefined || envRaw === "" ? undefined : parse(envRaw); }
    catch (error) { errors.push(`${envName}: ${error.message}`); continue; }

    if (fromGenesis !== undefined) {
      locked.push(name);
      const equal = Array.isArray(fromGenesis) ? Array.isArray(fromEnv) && sameSet(fromGenesis, fromEnv) : same(fromGenesis, fromEnv);
      if (fromEnv !== undefined && !equal) errors.push(`${envName}=${envRaw} ไม่ตรงกับ genesis (${name} = ${Array.isArray(raw) ? raw.join(",") : raw}) — ลบ env นี้ออก หรือแก้ genesis`);
      settings[name] = fromGenesis;
    } else {
      settings[name] = fromEnv ?? fallback;
    }
  }
  // ตาราง fork (กติกาใหม่ตั้งแต่ block ที่กำหนด · ไม่อยู่ใน genesis hash · ไม่มี env) — VM ตรวจว่ารู้จักชื่อ
  const forks = genesis?.forks ?? {};
  if (typeof forks !== "object" || Array.isArray(forks) || Object.values(forks).some((block) => !Number.isSafeInteger(block) || block < 0)) {
    errors.push("genesis forks: ต้องเป็น { \"ชื่อ fork\": เลข block (จำนวนเต็ม ≥ 0) }");
    settings.forks = {};
  } else {
    settings.forks = { ...forks };
  }
  return { settings, locked, errors };
}

/**
 * ปัญหาที่ทำให้ server ไม่ควรเริ่ม (ว่าง = เริ่มได้)
 *   dev = true (DEV=1) → ข้ามข้อบังคับของเครือข่ายจริง (ADMINS / PRODUCER_KEY)
 */
export function startupProblems({ settings, errors = [], dev = false, producer = null }) {
  const problems = [...errors];
  if (!dev) {
    if (!settings.admins?.length) problems.push("ต้องตั้ง ADMINS (หรือ config.admins ใน genesis) — ไม่ตั้ง = ใครก็อนุมัติ deploy / upgrade ได้ · ช่วงพัฒนาใช้ DEV=1");
    if (!producer) problems.push("ต้องตั้ง PRODUCER_KEY (key ที่ใช้เซ็น block) · ช่วงพัฒนาใช้ DEV=1");
  }
  if (producer && settings.producers?.length && !settings.producers.includes(producer.toLowerCase())) {
    problems.push(`PRODUCER_KEY เป็นของ ${producer} ซึ่งไม่อยู่ในรายชื่อผู้ผลิตของ genesis (${settings.producers.join(", ")})`);
  }
  return problems;
}
