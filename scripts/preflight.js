/**
 * Check genesis + env before launching the real chain (doesn't start the server · doesn't touch DATA)
 *
 *   node --env-file=deploy/producer.env scripts/preflight.js      # producer machine
 *   node --env-file=deploy/follower.env scripts/preflight.js      # standby machine (FOLLOW)
 *
 * exit 0 = OK to launch · 1 = problems (the server would refuse to start, or would start misconfigured in a way that needs a chain wipe to fix later)
 * Same checks as server startup (startupProblems) + things the server allows but shouldn't be used on a public chain
 */
import fs from "node:fs";
import { resolveSettings, startupProblems, startupWarnings } from "../src/node/genesis.js";
import { addressOf } from "../src/crypto/signature.js";
import { FORKS } from "../src/core/virtualmachine.js";

const env = process.env;
const problems = [];
const warnings = [];
const file = env.GENESIS ?? "genesis.json";
if (!fs.existsSync(file)) {
  console.error(`genesis file not found: ${file} (set GENESIS=<file>)`);
  process.exit(1);
}
const genesis = JSON.parse(fs.readFileSync(file, "utf8"));
const { settings, errors } = resolveSettings(genesis, env);
const dev = ["1", "true", "yes", "on"].includes(String(env.DEV ?? "").toLowerCase());
let producer = null;
try { producer = env.PRODUCER_KEY ? addressOf(env.PRODUCER_KEY) : null; } catch (error) { problems.push(`PRODUCER_KEY is invalid: ${error.message}`); }
const follow = Boolean(env.FOLLOW);

// ---- same as server startup
problems.push(...startupProblems({ settings, errors, dev: false, producer, follow }));
warnings.push(...startupWarnings({ settings, dev: false }));

// ---- allowed by the server, but shouldn't be used on a public chain
if (dev) problems.push("DEV=1 is set — disables admin / key enforcement, never use on a real chain");
if (!genesis.config) problems.push(`${file} has no config — chain values aren't locked in genesis (a development file) · use deploy/genesis.mainnet.example.json`);
// forks the code knows but genesis doesn't enable → the chain uses the old rules (e.g. no bluewolf = old gas table, native transfers cost 1,300 gas instead of 17,300)
for (const name of Object.keys(FORKS)) {
  if (settings.forks?.[name] === undefined) problems.push(`genesis has no fork "${name}" in forks — add "forks": { "${name}": 0 } when launching a new chain (an existing chain: use a future block number)`);
}
if (settings.chainId === 1) problems.push("chainId = 1 collides with Ethereum mainnet · use a unique number (check chainlist.org)");
for (const [address, amount] of Object.entries(genesis.balances ?? {})) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) problems.push(`balances has a value that is not an address: ${address}`);
  if (!/^\d+n?$/.test(String(amount))) problems.push(`balance of ${address} must be an integer in wei (e.g. "1000000000000000000n"): ${amount}`);
}
if (!Object.keys(genesis.balances ?? {}).length) warnings.push("balances is empty — nobody has coins to pay gas at launch");
if (!settings.upgradeDelayBlocks) warnings.push("upgradeDelayBlocks = 0 — approved upgrades take effect immediately, users get no time to see them first (3600 = 1 h at 1 s blocks recommended)");
if (settings.admins?.length === 1) warnings.push("config.admins has a single admin — losing that wallet = no more deploy / upgrade approvals");
if (!Number(env.TRUST_PROXY)) warnings.push("TRUST_PROXY is not set — behind nginx everyone gets the same IP (the rate limit blocks everyone at once)");
if (env.HOST !== "127.0.0.1" && env.HOST !== "localhost") warnings.push("HOST is not 127.0.0.1 — the server listens on all interfaces · firewall the port so outsiders can't reach it directly (bypassing HTTPS / rate limits)");
if (!env.DATA) warnings.push("DATA is not set — chain data goes to ./data next to server.js");

console.log(`genesis: ${file}`);
console.log(`chainId ${settings.chainId} · block ${settings.blockMs} ms · maxBlockGas ${settings.maxBlockGas} · gasTarget ${settings.gasTarget ?? settings.maxBlockGas / 2} · upgradeDelayBlocks ${settings.upgradeDelayBlocks}`);
console.log(`forks: ${Object.entries(settings.forks ?? {}).map(([name, block]) => `${name}@${block}`).join(", ") || "-"}`);
console.log(`admins: ${(settings.admins ?? []).join(", ") || "-"}`);
console.log(`producers: ${(settings.producers ?? []).join(", ") || "-"}`);
console.log(`this machine: ${follow ? `standby following ${env.FOLLOW}` : producer ? `producer ${producer}` : "-"}`);
for (const warning of warnings) console.log(`warning: ${warning}`);
if (problems.length) {
  console.log(`\nnot ready to launch (${problems.length}):`);
  for (const problem of problems) console.log(`- ${problem}`);
  process.exit(1);
}
console.log("\npassed · ready to launch");
