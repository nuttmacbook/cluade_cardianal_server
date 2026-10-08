/**
 * ชุดทดสอบโปรแกรมในเครื่อง — รันบน VM ตัวจริง ไม่ใช่ของจำลอง
 * พฤติกรรมที่เห็นตรงนี้จึงเหมือนกับตอนรันบน chain จริงทุกอย่าง
 */
import { VirtualMachine } from "programvm";
import { MemoryDB } from "programvm/db.js";

let counter = 0;

/**
 * สร้าง chain จำลองไว้ทดสอบ
 * @param {{ chargeGas?: boolean, timestamp?: number, balances?: Record<string, number> }} [options]
 */
export function createChain({ chargeGas = false, timestamp = Date.parse("2024-01-01T00:00:00Z"), balances = {} } = {}) {
  const vm = new VirtualMachine(new MemoryDB(), { chargeGas, recordBlocks: true, recordHistory: true });
  vm.db.load(Object.fromEntries(Object.entries(balances).map(([address, value]) => [`${address}:native:received`, value])));

  let now = timestamp;
  const context = (sender) => ({ sender, origin: sender });

  /** รัน 1 tx ใน block ของตัวเอง แล้วบันทึกทันที */
  const run = (method, request) => {
    now += 1000;
    const block = vm.createBlock({ timestamp: now, feeRecipient: "miner" });
    const result = block[method](request);
    if (result.status === "success") block.commit();
    return result;
  };

  return {
    vm,

    /** ติดตั้งโปรแกรม (deploy + init) แล้วคืนตัวช่วยเรียกใช้งาน */
    deploy(program, { as = "owner", initInput = {}, value = 0, id } = {}) {
      const code = typeof program === "function" ? String(program) : program;
      const programUuid = id ?? `program-${++counter}`;

      const deployed = run("deploy", { programUuid, code, context: context(as), initInput, value });
      if (deployed.status !== "success") throw new Error(`deploy ล้มเหลว: ${deployed.error.message}`);
      const initialized = run("init", { programUuid });
      if (initialized.status !== "success") throw new Error(`initialization ล้มเหลว: ${initialized.error.message}`);

      return {
        address: programUuid,
        /** เรียกฟังก์ชันที่ return ไว้ — คืน result ถ้าสำเร็จ, throw ถ้าโปรแกรม throw */
        call(functionName, input = {}, { as: sender = "alice", value: sent = 0 } = {}) {
          const result = run("call", { programUuid, functionName, input, context: context(sender), value: sent });
          if (result.status !== "success") throw Object.assign(new Error(result.error.message), { code: result.error.code, result });
          return result.result;
        },
        /** เหมือน call แต่คืนผลดิบ (ดู gasUsed / writes / trace ได้) */
        callRaw(functionName, input = {}, { as: sender = "alice", value: sent = 0 } = {}) {
          return run("call", { programUuid, functionName, input, context: context(sender), value: sent });
        },
        /** ข้อมูลที่โปรแกรมเก็บไว้ทั้งหมด: { "balances/alice": 70 } */
        state() {
          return Object.fromEntries(vm.listProgramStorage(programUuid).map(({ key, value }) => [key.join("/"), value]));
        },
      };
    },

    /** โอน native ระหว่าง address */
    transfer(from, to, amount) {
      return run("transfer", { from, to, amount });
    },

    /** ยอด native: { received, sended, consumed, balance } */
    balanceOf(address) {
      return vm.nativeBalanceOf(address);
    },

    /** เวลาปัจจุบันของ chain จำลอง (โปรแกรมเห็นค่านี้ผ่าน Date.now()) */
    setTime(value) {
      now = value;
    },
  };
}
