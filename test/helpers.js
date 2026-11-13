import assert from "node:assert/strict";
import * as VM from "../src/core/virtualmachine.js";
import { MemoryDB } from "../src/storage/db.js";

export { MemoryDB };

// the timeout test program (FAULTY.busy) must burn real time with performance.now(), and the sandbox has no real clock unless wallClock is on
VM.DEFAULT_OPTIONS.wallClock = true;

/** The single VM shared by every test */
export const vm = new VM.VirtualMachine(new MemoryDB());

/** The DB's internal data (Map), used to inspect / prepare data in tests */
export const mockData = vm.db.data;

export { VM };

export const TEST_TIMEOUT_MS = 300;

/** Native balances ("123n" / BigInt) → number for easy comparison in tests (recurses into objects / arrays) */
export function num(value) {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^-?\d+n$/.test(value)) return Number(value.slice(0, -1));
  if (Array.isArray(value)) return value.map(num);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, num(item)]));
  return value;
}

/** Gas table without step counting (node / builtin = 0), for tests that check exact API gas values */
export const API_GAS_ONLY = { node: 0, builtin: 0 };

/** Clear the mock DB and restore the config before every test */
export function resetVM() {
  vm.db.clear();
  vm.timeoutMs = TEST_TIMEOUT_MS;
  vm.maxCallDepth = 8;
  vm.maxTxGas = Infinity;   // older tests check timeout with an infinite loop (step-counted gas is tested separately in 53-gas-meter)
}

export const user = (name, origin = name) => ({ sender: name, origin });

/** A new VM with its own DB (for when options must differ from the test defaults) */
let extraVmCount = 0;
export function createVm(options = {}) {
  extraVmCount += 1;
  return new VM.VirtualMachine(new MemoryDB(), { timeoutMs: TEST_TIMEOUT_MS, maxTxGas: Infinity, ...options });
}

/** Save writes to the DB via vm.commit → db.writeKeys (only on success) */
export function save(res) {
  if (res.status === "success") vm.commit(res.writes);
  return res;
}

export function ok(res) {
  assert.equal(res.status, "success", `expected success but got ${JSON.stringify(res.error)}`);
  return save(res);
}

export function fails(res, code, message) {
  assert.equal(res.status, "throw", `expected throw but got success: ${JSON.stringify(res.result)}`);
  assert.equal(res.error.code, code, res.error.message);
  if (message instanceof RegExp) assert.match(res.error.message, message);
  else if (message !== undefined) assert.equal(res.error.message, message);
  // the gas fee breakdown (baseFee / burnedFee / producerFee, plus maxFee / priority for EIP-1559 txs) can appear on both success and throw
  const feeKeys = ["baseFee", "burnedFee", "producerFee", "feeType", "maxFeePerGas", "maxPriorityFeePerGas"];
  assert.deepEqual(Object.keys(res).filter((key) => !feeKeys.includes(key)).sort(), ["accepted", "calls", "debug", "error", "events", "fee", "gasPrice", "gasUsed", "status", "timestamp", "writes"], "throw must not have loadValues / afterValues");
  assert.deepEqual(res.writes, [], "throw must not have program writes (except nonce / gas fees)");
  return res;
}

/** deploy + init + save */
export function activate(programUuid, code, { context = user("owner"), initInput } = {}) {
  ok(vm.deploy({ programUuid, code, context, initInput }));
  return ok(vm.init({ programUuid }));
}

export function callAs(sender, programUuid, functionName, input) {
  return vm.call({ programUuid, functionName, input, context: user(sender) });
}

/** Summarize calls in a readable form: "depth:program.fn:status[:code]" */
export function trace(res) {
  return res.calls.map((c) => `${c.depth}:${c.programUuid}.${c.functionName}:${c.status}${c.error ? `:${c.error.code}` : ""}`);
}

/** Read a program's saved value: stored("token", "balances", "alice") */
export function stored(programUuid, ...parts) {
  const key = parts.length === 1 ? parts[0] : VM.map(...parts);
  return mockData.get(VM.storageKey(programUuid, key));
}

export const dbKeys = (res) => res.writes.map((w) => `${w.type} ${w.dbKey}`);
