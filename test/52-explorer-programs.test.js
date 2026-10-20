import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { approvedProgramAddresses, programCounts, pagePendingPrograms, pageApprovedPrograms } from "../src/node/explorer-api.js";

/* explorer: จำนวนโปรแกรมที่อนุมัติแล้ว / รออนุมัติ + รายการแบบแบ่งหน้า */

const OWNER = "0x00000000000000000000000000000000000000a1";
const program = (i) => `0x${"f".repeat(38)}${String(i).padStart(2, "0")}`;
const PLAIN = "function program() { function ping(params) { return 1; } return { ping }; }";
const as = (who) => ({ sender: who, origin: who });

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  let number = 0;
  const block = (fn) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: number * 1000, feeRecipient: OWNER });
    const results = fn(b);
    b.commit();
    results.forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
  };
  return { vm, block };
}

test("programCounts / รายการ: deploy = รออนุมัติ · init = อนุมัติแล้ว · reject = หายจากทั้งสองรายการ · กระเป๋าไม่นับ", () => {
  const { vm, block } = chain();
  assert.deepEqual(programCounts(vm), { approved: 0, pending: 0 });

  block((b) => [
    b.deploy({ programUuid: program(1), code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "A", ticker: "A", decimals: "0n", supply: "10n" } }),
    b.deploy({ programUuid: program(2), code: PLAIN, context: as(OWNER) }),
    b.deploy({ programUuid: program(3), code: PLAIN, context: as(OWNER) }),
    b.deploy({ programUuid: program(4), code: PLAIN, context: as(OWNER), metadata: { namespace: "four" } }),
  ]);
  assert.deepEqual(programCounts(vm), { approved: 0, pending: 4 });

  block((b) => [b.init({ programUuid: program(1) })]);
  block((b) => [b.init({ programUuid: program(2) }), b.reject({ programUuid: program(3) })]);
  assert.deepEqual(programCounts(vm), { approved: 2, pending: 1 });
  assert.deepEqual(approvedProgramAddresses(vm), [program(1), program(2)]);   // OWNER มี key (native / nonce) แต่ไม่ใช่โปรแกรม

  const pending = pagePendingPrograms(vm, { page: 1, limit: 20 });
  assert.equal(pending.total, 1);
  assert.deepEqual(pending.items[0], { address: program(4), deployer: OWNER, name: "four", value: "0n", codeSize: PLAIN.length, token: false });

  const approved = pageApprovedPrograms(vm, { page: 1, limit: 20 });
  assert.deepEqual(approved.items.map((p) => [p.address, p.creator, p.createdAt, p.token]),
    [[program(2), OWNER, 3000, false], [program(1), OWNER, 2000, true]]);   // อนุมัติล่าสุดก่อน
});

test("รายการโปรแกรมแบ่งหน้าได้", () => {
  const { vm, block } = chain();
  block((b) => Array.from({ length: 25 }, (_, i) => b.deploy({ programUuid: program(i), code: PLAIN, context: as(OWNER) })));
  block((b) => Array.from({ length: 12 }, (_, i) => b.init({ programUuid: program(i) })));
  assert.deepEqual(programCounts(vm), { approved: 12, pending: 13 });
  const pending = pagePendingPrograms(vm, { page: 2, limit: 10 });
  assert.deepEqual([pending.total, pending.pages, pending.items.length], [13, 2, 3]);
  const approved = pageApprovedPrograms(vm, { page: 2, limit: 10 });
  assert.deepEqual([approved.total, approved.pages, approved.items.length], [12, 2, 2]);
});
