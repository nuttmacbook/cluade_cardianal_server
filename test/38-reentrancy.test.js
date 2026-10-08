import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { VULNERABLE_VAULT, ATTACKER } from "./programs.js";

/*
 * reentrancy: โปรแกรมเรียกออกไปข้างนอกแล้วถูกเรียกกลับเข้ามาระหว่างที่ยังทำงานค้างอยู่
 * VM ยอมให้เกิดได้ (เหมือน EVM) การป้องกันเป็นหน้าที่ของคนเขียนโปรแกรม
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const user = (name) => ({ sender: name, origin: name });

function setup({ rounds = 2 } = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true });
  vm.db.load({ "alice:native:received": 1000, "victim:native:received": 0 });

  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "vault", code: VULNERABLE_VAULT, context: user("owner") });
  block.init({ programUuid: "vault" });
  block.deploy({ programUuid: "attacker", code: ATTACKER, context: user("alice"), initInput: { vault: "vault", rounds } });
  block.init({ programUuid: "attacker" });
  block.commit();

  // เหยื่อฝากเงินไว้ในตู้ 500
  vm.commit(vm.transfer({ from: "alice", to: "victim", amount: 500 }, { timestamp: T + 500 }).writes);
  vm.commit(vm.call({ programUuid: "vault", functionName: "deposit", context: user("victim"), value: 500 }, { timestamp: T + 600 }).writes);
  return vm;
}

const attack = (vm, method, value = 100) =>
  vm.call({ programUuid: "attacker", functionName: "attack", input: { method }, context: user("alice"), value }, { timestamp: T + 1000 });

// ---------------------------------------------------------------------------

test("⚠️ withdrawUnsafe: ถอนซ้ำได้ ดูดเงินคนอื่นออกไปด้วย", () => {
  const vm = setup({ rounds: 2 });
  const res = attack(vm, "withdrawUnsafe");

  assert.equal(res.status, "success");
  vm.commit(res.writes);
  assert.equal(vm.nativeBalanceOf("attacker").balance, 300);   // ฝาก 100 แต่ถอนออกมา 300
  assert.equal(vm.nativeBalanceOf("vault").balance, 300);      // เงินของเหยื่อหายไป 200
  assert.equal(vm.db.readKeys(["vault:storage:balances:attacker"])[0], 0);
});

test("withdrawSafe: อัปเดตยอดก่อนเรียกออก (checks-effects-interactions) → ถอนซ้ำได้ 0", () => {
  const vm = setup({ rounds: 3 });
  const res = attack(vm, "withdrawSafe");

  assert.equal(res.status, "success");
  vm.commit(res.writes);
  assert.equal(vm.nativeBalanceOf("attacker").balance, 100);   // ได้คืนเท่าที่ฝาก
  assert.equal(vm.nativeBalanceOf("vault").balance, 500);      // เงินของเหยื่อครบ
});

test("withdrawGuarded: ล็อกด้วย flag → การเรียกซ้ำถูกปฏิเสธ", () => {
  const vm = setup({ rounds: 2 });
  const res = attack(vm, "withdrawGuarded");

  assert.equal(res.status, "success");
  vm.commit(res.writes);
  assert.equal(vm.db.readKeys(["attacker:storage:lastError"])[0], "กำลังทำงานอยู่");  // เรียกซ้ำไม่ผ่าน
  assert.equal(vm.nativeBalanceOf("attacker").balance, 100);   // ได้คืนเท่าที่ฝาก
  assert.equal(vm.nativeBalanceOf("vault").balance, 500);      // เงินของเหยื่อครบ
  assert.equal(vm.db.readKeys(["vault:storage:locked"])[0], undefined); // ล็อกถูกปลดแล้ว
});

test("การเรียกซ้ำเห็นข้อมูลที่เขียนไปแล้วในชั้นก่อนหน้า", () => {
  const vm = setup({ rounds: 1 });
  const res = attack(vm, "withdrawSafe");
  const depths = res.calls.map((call) => `${call.depth} ${call.programUuid}.${call.functionName}`);

  assert.deepEqual(depths, [
    "0 attacker.attack",
    "1 vault.deposit",
    "1 vault.withdrawSafe",
    "2 attacker.receive",
    "3 vault.withdrawSafe",     // เรียกกลับเข้ามาระหว่างที่ชั้น 1 ยังทำงานค้าง
  ]);
  assert.equal(res.calls.at(-1).status, "throw");   // ชั้นที่เรียกซ้ำเห็นยอดเป็น 0 แล้ว
  assert.equal(res.status, "success");
});

test("ความลึกของการเรียกซ้ำถูกจำกัดด้วย maxCallDepth", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { maxCallDepth: 4, recordBlocks: true });
  vm.db.load({ "alice:native:received": 1000 });
  const block = vm.createBlock({ timestamp: T, feeRecipient: "miner" });
  block.deploy({ programUuid: "vault", code: VULNERABLE_VAULT, context: user("owner") });
  block.init({ programUuid: "vault" });
  block.deploy({ programUuid: "attacker", code: ATTACKER, context: user("alice"), initInput: { vault: "vault", rounds: 99 } });
  block.init({ programUuid: "attacker" });
  block.commit();
  vm.commit(vm.call({ programUuid: "vault", functionName: "deposit", context: user("alice"), value: 100 }, { timestamp: T + 100 }).writes);

  const res = vm.call({ programUuid: "attacker", functionName: "attack", input: { method: "withdrawUnsafe" }, context: user("alice"), value: 100 }, { timestamp: T + 200 });
  assert.equal(Math.max(...res.calls.map((call) => call.depth)), 4);   // ไม่ลึกเกิน maxCallDepth
  vm.commit(res.writes);
  assert.match(vm.db.readKeys(["attacker:storage:lastError"])[0], /ซ้อนได้ไม่เกิน 4 ชั้น/);  // ชั้นที่เกินถูกปฏิเสธ
});

test("ตัวล็อกไม่ค้างไปยัง tx ถัดไป", () => {
  const vm = setup({ rounds: 2 });
  vm.commit(attack(vm, "withdrawGuarded").writes);
  assert.equal(vm.db.readKeys(["vault:storage:locked"])[0], undefined);

  const normal = vm.call({ programUuid: "vault", functionName: "balanceOf", input: { who: "victim" }, context: user("bob") }, { timestamp: T + 2000 });
  assert.equal(normal.result, 500);
});
