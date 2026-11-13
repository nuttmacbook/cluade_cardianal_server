/**
 * Values every machine in the network must set identically — locked in genesis.json (part of the genesis hash)
 *
 *   { "chainId": 1, "balances": { … }, "config": { "burnPercent": 100, "admins": ["0x…"], "producers": ["0x…"], … } }
 *
 *   const { settings, errors } = resolveSettings(genesis, process.env);
 *
 * Each value = genesis first → env → default
 * genesis has a value but env sets a different one → errors (the server refuses to start) — stops one machine diverging from the network until hashes mismatch
 * genesis without config (during development) = nothing locked, env is used as before
 * genesis.forks = { "<name>": <block> } fork table (see FORKS in virtualmachine.js) → settings.forks · not part of the genesis hash, can be added later
 * genesis.producerSchedule = [{ fromBlock, producers }] changes the producer list from a given block (remove a leaked key / add a new key)
 *   → settings.producerSchedule · not part of the genesis hash · producersAt(settings, n) = the list used for block n
 */

const list = (value) => (Array.isArray(value) ? value : String(value).split(","))
  .map((item) => String(item).trim().toLowerCase()).filter(Boolean);
const integer = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`must be an integer (got ${value})`);
  return number;
};
const wei = (value) => BigInt(String(value).replace(/n$/, ""));

/** genesis name → { env, parse, default } · chainId is at the top level of genesis (as before), the rest is in genesis.config */
export const GENESIS_SETTINGS = {
  chainId: { env: "CHAIN_ID", parse: integer, default: 41234 },
  burnPercent: { env: "BURN_PERCENT", parse: integer, default: 100 },
  minBaseFee: { env: "GAS_PRICE", parse: wei, default: 10_000_000_000_000n },   // 10,000 gwei
  gasTarget: { env: "GAS_TARGET", parse: integer, default: null },
  baseFeeDenominator: { env: "BASE_FEE_DENOMINATOR", parse: integer, default: 8 },
  blockMs: { env: "BLOCK_MS", parse: integer, default: 2000 },
  maxBlockGas: { env: "MAX_BLOCK_GAS", parse: integer, default: 5_000_000 },   // gasTarget unset = half of this (affects the base fee → must match on every machine)
  upgradeDelayBlocks: { env: "UPGRADE_DELAY_BLOCKS", parse: integer, default: 0 },
  memoryLimitMb: { env: "MEMORY_LIMIT_MB", parse: integer, default: 32 },
  stackLimitKb: { env: "STACK_LIMIT_KB", parse: integer, default: 256 },
  admins: { env: "ADMINS", parse: list, default: null },
  producers: { env: "PRODUCERS", parse: list, default: null },
};

const same = (a, b) => JSON.stringify(a, (_, v) => (typeof v === "bigint" ? `${v}` : v)) === JSON.stringify(b, (_, v) => (typeof v === "bigint" ? `${v}` : v));
const sameSet = (a, b) => same([...a].sort(), [...b].sort());

/** genesis + env → { settings, locked: names genesis locks, errors: messages } */
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
      if (fromEnv !== undefined && !equal) errors.push(`${envName}=${envRaw} does not match genesis (${name} = ${Array.isArray(raw) ? raw.join(",") : raw}) — remove this env var or edit genesis`);
      settings[name] = fromGenesis;
    } else {
      settings[name] = fromEnv ?? fallback;
    }
  }
  // fork table (new rules from a given block · not part of the genesis hash · no env) — the VM checks the names are known
  const forks = genesis?.forks ?? {};
  if (typeof forks !== "object" || Array.isArray(forks) || Object.values(forks).some((block) => !Number.isSafeInteger(block) || block < 0)) {
    errors.push("genesis forks: must be { \"fork name\": block number (integer ≥ 0) }");
    settings.forks = {};
  } else {
    settings.forks = { ...forks };
  }
  const schedule = parseProducerSchedule(genesis?.producerSchedule, settings.producers);
  if (schedule.error) errors.push(`genesis producerSchedule: ${schedule.error}`);
  settings.producerSchedule = schedule.entries;
  return { settings, locked, errors };
}

/** genesis.producerSchedule → { entries: [{ fromBlock, producers }] sorted by block, error } */
export function parseProducerSchedule(raw, base = null) {
  if (raw === undefined || raw === null) return { entries: [] };
  if (!Array.isArray(raw)) return { entries: [], error: "must be [{ \"fromBlock\": block number, \"producers\": [\"0x…\"] }]" };
  if (raw.length && !base?.length) return { entries: [], error: "config.producers (the list from block 1) is required first" };
  const entries = [];
  for (const item of raw) {
    const fromBlock = item?.fromBlock;
    const producers = Array.isArray(item?.producers) ? list(item.producers) : [];
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 2) return { entries: [], error: `fromBlock must be an integer ≥ 2 (got ${fromBlock})` };
    if (!producers.length || producers.some((address) => !/^0x[0-9a-f]{40}$/.test(address))) {
      return { entries: [], error: `block ${fromBlock}: producers must be at least 1 address` };
    }
    entries.push({ fromBlock, producers });
  }
  entries.sort((a, b) => a.fromBlock - b.fromBlock);
  if (entries.some((entry, index) => index > 0 && entry.fromBlock === entries[index - 1].fromBlock)) return { entries: [], error: "duplicate fromBlock" };
  return { entries };
}

/** the producer list for a block number (config.producers, then replaced by producerSchedule entries already reached) · null = not enforced */
export function producersAt({ producers = null, producerSchedule = [] } = {}, number) {
  let current = producers?.length ? producers : null;
  for (const entry of producerSchedule ?? []) if (number >= entry.fromBlock) current = entry.producers;
  return current;
}

/** per-block producer checker from raw genesis (startSync / loadSnapshot / client) → (number) => list | null · no list = null */
export function producerSetOf(genesis) {
  const producers = genesis?.config?.producers ? list(genesis.config.producers) : null;
  if (!producers?.length) return null;
  const { entries, error } = parseProducerSchedule(genesis.producerSchedule, producers);
  if (error) throw new Error(`genesis producerSchedule: ${error}`);
  return (number) => producersAt({ producers, producerSchedule: entries }, number);
}

/**
 * Problems that should stop the server from starting (empty = OK to start)
 *   dev = true (DEV=1) → skips real-network requirements (ADMINS / PRODUCER_KEY)
 *   follow = true (FOLLOW) → PRODUCER_KEY not required · nextBlock = the next block to produce (checks the key against producerSchedule) · null = don't check the list
 */
export function startupProblems({ settings, errors = [], dev = false, producer = null, follow = false, nextBlock = 1 }) {
  const problems = [...errors];
  if (!dev) {
    if (!settings.admins?.length) problems.push("ADMINS must be set (or config.admins in genesis) — unset = anyone can approve deploy / upgrade · use DEV=1 during development");
    if (!producer && !follow) problems.push("PRODUCER_KEY must be set (the key that signs blocks) · use DEV=1 during development · standby machines use FOLLOW=<url>");
    // malformed address (e.g. forgot to edit the sample value in genesis) = nobody can actually be admin / producer, and fixing it later means wiping the chain
    for (const [name, list] of [["admins", settings.admins], ["producers", settings.producers]]) {
      const bad = (list ?? []).filter((address) => !/^0x[0-9a-f]{40}$/.test(address));
      if (bad.length) problems.push(`config.${name} has values that are not addresses: ${bad.join(", ")}`);
    }
  }
  const allowed = nextBlock === null ? null : producersAt(settings, nextBlock);   // null = check later (FAILOVER_FROM: after syncing)
  if (producer && !follow && allowed && !allowed.includes(producer.toLowerCase())) {
    problems.push(`PRODUCER_KEY belongs to ${producer}, who is not in the producer list for block ${nextBlock} (${allowed.join(", ")})`);
  }
  return problems;
}

/** warnings that don't stop the server (printed at startup) */
export function startupWarnings({ settings, dev = false }) {
  const warnings = [];
  if (!dev && settings.producers?.length === 1) {
    warnings.push("config.producers has a single key — losing it = no more blocks can be produced (the chain must be wiped) · add an offline backup key to the list");
  }
  return warnings;
}
