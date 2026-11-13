/**
 * Local program test kit — runs on the real VM, not a simulation
 * so the behavior seen here is identical to running on the real chain
 */
import { VirtualMachine } from "programvm";
import { MemoryDB } from "programvm/db.js";

let counter = 0;

/**
 * Creates a simulated chain for testing
 * Numbers in programs are always BigInt: values returned by call() are "123n", and state() stores them the same way
 * @param {{ chargeGas?: boolean, timestamp?: number, balances?: Record<string, bigint | number> }} [options]  native balances (wei)
 */
export function createChain({ chargeGas = false, timestamp = Date.parse("2024-01-01T00:00:00Z"), balances = {} } = {}) {
  const vm = new VirtualMachine(new MemoryDB(), { chargeGas, recordBlocks: true, recordHistory: true });
  vm.db.load(Object.fromEntries(Object.entries(balances).map(([address, value]) => [`${address}:native:received`, `${BigInt(value)}n`])));

  let now = timestamp;
  const context = (sender) => ({ sender, origin: sender });

  /** Runs 1 tx in its own block and commits immediately */
  const run = (method, request) => {
    now += 1000;
    const block = vm.createBlock({ timestamp: now, feeRecipient: "miner" });
    const result = block[method](request);
    if (result.status === "success") block.commit();
    return result;
  };

  return {
    vm,

    /** Installs a program (deploy + init) and returns a helper for using it */
    deploy(program, { as = "owner", initInput = {}, value = 0, id } = {}) {
      const code = typeof program === "function" ? String(program) : program;
      const programUuid = id ?? `program-${++counter}`;

      const deployed = run("deploy", { programUuid, code, context: context(as), initInput, value });
      if (deployed.status !== "success") throw new Error(`deploy failed: ${deployed.error.message}`);
      const initialized = run("init", { programUuid });
      if (initialized.status !== "success") throw new Error(`initialization failed: ${initialized.error.message}`);

      return {
        address: programUuid,
        /** Calls a returned function — returns result on success, throws if the program throws */
        call(functionName, input = {}, { as: sender = "alice", value: sent = 0 } = {}) {
          const result = run("call", { programUuid, functionName, input, context: context(sender), value: sent });
          if (result.status !== "success") throw Object.assign(new Error(result.error.message), { code: result.error.code, result });
          return result.result;
        },
        /** Like call but returns the raw result (gasUsed / writes / trace visible) */
        callRaw(functionName, input = {}, { as: sender = "alice", value: sent = 0 } = {}) {
          return run("call", { programUuid, functionName, input, context: context(sender), value: sent });
        },
        /** All data the program stores: { "balances/alice": "70n" } */
        state() {
          return Object.fromEntries(vm.listProgramStorage(programUuid).map(({ key, value }) => [key.join("/"), value]));
        },
      };
    },

    /** Transfers native between addresses */
    transfer(from, to, amount) {
      return run("transfer", { from, to, amount });
    },

    /** Native balance (BigInt): { received, sended, consumed, balance } */
    balanceOf(address) {
      return vm.nativeBalanceOf(address);
    },

    /** Current time of the simulated chain (programs see this via Date.now()) */
    setTime(value) {
      now = value;
    },
  };
}
