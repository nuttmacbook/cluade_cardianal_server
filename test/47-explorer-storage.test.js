import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import { storageLayout, storageMap, storageGet, programFlags } from "../src/node/explorer-api.js";
import { TOKEN } from "./programs.js";

/* แถบ "ข้อมูล" ของ explorer แยก storage ตามจำนวนชั้นของ key: variable (1) / contract (2) / get storage (3+) */

const P = "0x00000000000000000000000000000000000000aa";
const ALICE = "0xAbCdEf0000000000000000000000000000000001";

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const put = (key, value) => [VM.storageKey(P, key.length === 1 ? key[0] : VM.map(...key)), value];
  const rows = [
    put(["owner"], ALICE.toLowerCase()),
    put(["price"], "100n"),
    put(["ชื่อ"], "ร้าน:ทดสอบ"),
    put(["items", 1], { name: "เก้าอี้" }),
    put(["items", 2], { name: "โคมไฟ" }),
    put(["allow", ALICE, "0xbb"], "5n"),
    put(["mixed", "a"], 1),            // กลุ่มเดียวกันมีทั้ง 2 ชั้นและ 3 ชั้น
    put(["mixed", "a", "b"], 2),
    put(["deeper", "x", "y", "z"], true),
  ];
  for (let i = 0; i < 120; i += 1) rows.push(put(["balances", `0x${String(i).padStart(40, "0")}`], `${i}n`));
  vm.db.load(Object.fromEntries(rows));
  return vm;
}

test("layout: แยก key 1 ชั้น (พร้อมค่า) / 2 ชั้น (นับจำนวน) / 3 ชั้นขึ้นไป (นับ + ชั้นลึกสุด)", () => {
  const layout = storageLayout(setup(), P.toUpperCase().replace("0X", "0x"));
  assert.deepEqual(layout.variables.map((v) => [v.key, v.value]).sort(), [
    ["owner", ALICE.toLowerCase()], ["price", "100n"], ["ชื่อ", "ร้าน:ทดสอบ"],
  ].sort());
  assert.deepEqual(layout.maps.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "balances", count: 120 }, { name: "items", count: 2 }, { name: "mixed", count: 1 }]);
  assert.deepEqual(layout.deep.sort((a, b) => a.name.localeCompare(b.name)),
    [{ name: "allow", count: 1, depth: 3 }, { name: "deeper", count: 1, depth: 4 }, { name: "mixed", count: 1, depth: 3 }]);
  assert.equal(layout.scanned, 129);
  assert.equal(layout.truncated, false);
});

test("layout: ไล่ key เกินกำหนด → truncated", () => {
  const layout = storageLayout(setup(), P, { scanLimit: 10 });
  assert.equal(layout.truncated, true);
  assert.equal(layout.scanned, 10);
});

test("map: แสดงเฉพาะ key ชั้นที่ 2 ของกลุ่ม แบ่งหน้าด้วย cursor จนครบไม่ซ้ำ", () => {
  const vm = setup();
  const seen = [];
  let next;
  let pages = 0;
  do {
    const page = storageMap(vm, P, "balances", { limit: 50, start: next });
    seen.push(...page.items.map((item) => item.key));
    next = page.next;
    pages += 1;
  } while (next);
  assert.equal(pages, 3);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.equal(storageMap(vm, P, "balances", { limit: 1 }).items[0].value, "0n");

  // กลุ่มที่มีทั้ง 2 และ 3 ชั้น → ได้เฉพาะ 2 ชั้น
  assert.deepEqual(storageMap(vm, P, "mixed"), { name: "mixed", items: [{ key: "a", value: 1 }], next: null });
  // limit พอดีกับจำนวนที่มี → ไม่มีหน้าถัดไป
  assert.equal(storageMap(vm, P, "items", { limit: 2 }).next, null);
  assert.equal(storageMap(vm, P, "items", { limit: 1 }).next !== null, true);
});

test("map: cursor ที่ไม่ใช่ของกลุ่มนี้ถูกเมิน", () => {
  const page = storageMap(setup(), P, "items", { start: "0xzz:storage:zzz" });
  assert.equal(page.items.length, 2);
});

test("get: อ่าน key ทีละตัวทุกความลึก (address ตัวพิมพ์ใหญ่ / ตัวเลข ใช้ได้)", () => {
  const vm = setup();
  assert.deepEqual(storageGet(vm, P, ["allow", ALICE, "0xBB"]), { key: ["allow", ALICE.toLowerCase(), "0xbb"], exists: true, value: "5n" });
  assert.deepEqual(storageGet(vm, P, ["deeper", "x", "y", "z"]).value, true);
  assert.deepEqual(storageGet(vm, P, ["items", "1"]).value, { name: "เก้าอี้" });
  assert.deepEqual(storageGet(vm, P, ["price"]).value, "100n");
  assert.deepEqual(storageGet(vm, P, ["allow", ALICE, "0xcc"]), { key: ["allow", ALICE.toLowerCase(), "0xcc"], exists: false, value: null });
  assert.equal(storageGet(vm, P, []).status, 400);
  assert.equal(storageGet(vm, P, ["allow", "", "x"]).status, 400);
});

test("is-program: มีโค้ด (init แล้ว) หรือรอ init = โปรแกรม · กระเป๋าธรรมดา = ไม่ใช่", () => {
  const vm = new VM.VirtualMachine(new MemoryDB());
  const plain = new VM.VirtualMachine(vm.db);
  const context = { sender: "0xalice", origin: "0xalice" };
  vm.commit(plain.deploy({ programUuid: "0xp1", code: TOKEN, context, initInput: { supply: 1 } }).writes);
  vm.commit(plain.init({ programUuid: "0xp1" }).writes);
  vm.commit(plain.deploy({ programUuid: "0xp2", code: TOKEN, context, initInput: { supply: 1 } }).writes);
  assert.deepEqual(programFlags(vm, ["0xP1", "0xp2", "0xalice"]), { "0xp1": true, "0xp2": true, "0xalice": false });
});
