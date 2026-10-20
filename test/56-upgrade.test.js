import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";
import * as sign from "../src/crypto/signature.js";
import { review } from "../src/core/autoreview.js";
import { simulate } from "../src/node/simulate.js";

/*
 * อัปเกรดโปรแกรม (decision 12–14)
 *   - upgrader ตั้งตอน deploy (vm.deploy({ upgrader }) / tx.upgrader) → metadata.upgrader ตอน init · ไม่มี = แก้ไม่ได้ตลอดไป
 *   - setUpgrader: upgrader คนปัจจุบันโอนสิทธิ์ / สละสิทธิ์ (null)
 *   - upgrade → pending-upgrade:<id> → initUpgrade / rejectUpgrade (กติกาผู้อนุมัติเหมือน init / reject)
 *   - อนุมัติ: เปลี่ยนโค้ด + migrate(params) ครั้งเดียว + version + 1 + <id>:codeversion:<n>
 *   - upgradeDelayBlocks = N: โค้ดใหม่เริ่มใช้ตอนสร้าง block (ที่อนุมัติ + N)
 */

const T = Date.parse("2026-03-01T00:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const P = "counter";

const V1 = `function program() {
  function initialization(params) { writeDB("count", 0n) }
  function add(params) {
    const next = (readDB("count") || 0n) + params.input.by
    writeDB("count", next)
    return next
  }
  function version() { return 1n }
  return { add, version }
}`;

// เวอร์ชัน 2: storage เดิมยังอยู่ · migrate รันครั้งเดียว (อยู่ใน return ก็เรียกจากภายนอกไม่ได้)
const V2 = `function program() {
  function initialization(params) { writeDB("count", 0n) }
  function migrate(params) {
    writeDB("migrated", params.input.tag || "none")
    writeDB("count", (readDB("count") || 0n) + 100n)
    return "migrated"
  }
  function add(params) {
    const next = (readDB("count") || 0n) + params.input.by * 2n
    writeDB("count", next)
    return next
  }
  function version() { return 2n }
  function count() { return readDB("count") }
  function migrated() { return readDB("migrated") || null }
  return { add, version, count, migrated, migrate }
}`;

const V3 = V2.replace("return 2n", "return 3n");
const BAD_MIGRATE = `function program() {
  function migrate(params) { writeDB("count", 999n); throw new Error("migrate ล้ม") }
  function version() { return 9n }
  return { version }
}`;

function setup(options = {}) {
  const vm = new VM.VirtualMachine(new MemoryDB(), { timeoutMs: 5000, recordBlocks: true, recordHistory: true, ...options });
  let time = T;
  /** สร้าง block ถัดไป → รัน fn(block) → commit · คืนผลของ fn */
  const block = (fn = () => []) => {
    time += 1000;
    const b = vm.createBlock({ timestamp: time });
    const out = fn(b);
    b.commit();
    return { b, out };
  };
  const ok = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    return res;
  };
  const one = (fn) => block((b) => fn(b)).out;
  const call = (functionName, input = {}, as = "carol") => one((b) => b.call({ programUuid: P, functionName, input, context: user(as) }));
  const meta = (field) => vm.read(VM.metadataKey(P, field));
  return { vm, block, one, ok, call, meta };
}

function deployed(options, { upgrader = "alice", code = V1, admin } = {}) {
  const t = setup(options);
  t.block((b) => {
    t.ok(b.deploy({ programUuid: P, code, context: user("owner"), upgrader }));
    t.ok(b.init({ programUuid: P, context: admin }));
  });
  return t;
}

test("upgrade: upgrader ส่งโค้ดใหม่ → รอรีวิว → อนุมัติ → โค้ดใหม่ทำงาน storage เดิมอยู่ครบ และ migrate รันครั้งเดียว", () => {
  const t = deployed();
  assert.equal(t.meta("upgrader"), "alice");
  assert.equal(t.meta("version"), undefined);   // ยังไม่เคยอัปเกรด = เวอร์ชัน 1
  t.ok(t.call("add", { by: 5 }));

  const sent = t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, migrateInput: { tag: "v2" }, context: user("alice") })));
  assert.deepEqual([sent.result.state, sent.result.version], ["pending_review", 2]);
  assert.equal(t.vm.read(VM.pendingUpgradeKey(P)).context.sender, "alice");
  assert.equal(t.ok(t.call("version")).result, "1n");   // ระหว่างรอรีวิว โค้ดเดิมยังทำงาน

  const approved = t.ok(t.one((b) => b.initUpgrade({ programUuid: P })));
  assert.deepEqual([approved.result.state, approved.result.version, approved.result.migrateResult], ["active", 2, "migrated"]);
  assert.equal(t.vm.read(VM.pendingUpgradeKey(P)), undefined);
  assert.equal(t.meta("version"), 2);
  assert.equal(t.ok(t.call("version")).result, "2n");
  assert.equal(t.ok(t.call("count")).result, "105n");      // 5 เดิม + 100 จาก migrate
  assert.equal(t.ok(t.call("migrated")).result, "v2");
  assert.equal(t.ok(t.call("add", { by: 1 })).result, "107n");   // ตรรกะใหม่ (× 2) บน storage เดิม
  assert.deepEqual(approved.calls.map((c) => [c.depth, c.programUuid, c.functionName, c.sender]), [[0, P, "migrate", "alice"]]);

  // migrate อยู่ใน return ก็เรียกจากภายนอกไม่ได้ (เหมือน initialization)
  const again = t.call("migrate", { tag: "x" });
  assert.deepEqual([again.status, again.error.code], ["throw", "FORBIDDEN"]);
});

test("upgrade: คนที่ไม่ใช่ upgrader ส่งโค้ดใหม่ไม่ได้ · ส่งซ้ำระหว่างรอรีวิวไม่ได้", () => {
  const t = deployed();
  const res = t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("bob") }));
  assert.deepEqual([res.status, res.error.code], ["throw", "FORBIDDEN"]);
  assert.match(res.error.message, /ไม่ใช่ upgrader/);
  assert.equal(t.vm.read(VM.pendingUpgradeKey(P)), undefined);

  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("alice") })));
  const twice = t.one((b) => b.upgrade({ programUuid: P, code: V3, context: user("alice") }));
  assert.match(twice.error.message, /รออยู่แล้ว/);

  const missing = t.one((b) => b.upgrade({ programUuid: "nope", code: V2, context: user("alice") }));
  assert.equal(missing.error.code, "NOT_FOUND");
});

test("upgrade: โปรแกรมที่ไม่มี upgrader (รวมทุกโปรแกรมเดิม) แก้ไม่ได้ตลอดไป · ตั้ง upgrader ผ่าน metadata / setMetadata ไม่ได้", () => {
  const t = deployed({}, { upgrader: null });
  assert.equal(t.meta("upgrader"), undefined);
  assert.equal(t.vm.read(VM.pendingKey(P)), undefined);
  const res = t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("owner") }));
  assert.deepEqual([res.status, res.error.code], ["throw", "FORBIDDEN"]);
  assert.match(res.error.message, /อัปเกรดไม่ได้/);
  const grab = t.one((b) => b.setUpgrader({ programUuid: P, upgrader: "owner", context: user("owner") }));
  assert.match(grab.error.message, /อัปเกรดไม่ได้/);

  // ฟิลด์ของระบบ: ผู้ใช้ / โปรแกรมเขียนเองไม่ได้
  for (const field of ["upgrader", "version", "template"]) {
    const viaDeploy = t.vm.deploy({ programUuid: "x", code: V1, context: user("owner"), metadata: { [field]: "owner" } });
    assert.equal(viaDeploy.error.code, "FORBIDDEN", field);
  }
  const sneaky = setup();
  sneaky.block((b) => {
    sneaky.ok(b.deploy({ programUuid: "s", code: `function program() {
      function initialization(params) { setMetadata("upgrader", params.context.sender) }
      return {}
    }`, context: user("owner") }));
    assert.match(b.init({ programUuid: "s" }).error.message, /ฟิลด์ของระบบ/);
  });

  // pending ของโปรแกรมที่ไม่มี upgrader หน้าตาเหมือนเดิม (ไม่มี field upgrader) · upgrader ต้องเป็น string
  const plain = setup().vm.deploy({ programUuid: "p", code: V1, context: user("owner") });
  assert.equal("upgrader" in plain.writes.find((w) => w.dbKey === "pending:p").value, false);
  assert.equal(setup().vm.deploy({ programUuid: "p", code: V1, context: user("owner"), upgrader: 5 }).error.code, "INVALID_REQUEST");
});

test("upgrade: โอนสิทธิ์ upgrader ให้คนอื่น และสละสิทธิ์ (null) → แก้ไม่ได้อีก", () => {
  const t = deployed();
  const notMine = t.one((b) => b.setUpgrader({ programUuid: P, upgrader: "bob", context: user("bob") }));
  assert.equal(notMine.error.code, "FORBIDDEN");

  assert.deepEqual(t.ok(t.one((b) => b.setUpgrader({ programUuid: P, upgrader: "BOB", context: user("alice") }))).result, { programUuid: P, upgrader: "bob" });
  assert.equal(t.meta("upgrader"), "bob");
  assert.equal(t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("alice") })).error.code, "FORBIDDEN");
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, migrateInput: { tag: "bob" }, context: user("bob") })));

  // สละสิทธิ์ระหว่างที่มีโค้ดรอรีวิว → อนุมัติไม่ได้แล้ว ทีมงาน reject ทิ้งได้
  assert.deepEqual(t.ok(t.one((b) => b.setUpgrader({ programUuid: P, upgrader: null, context: user("bob") }))).result, { programUuid: P, upgrader: null });
  assert.equal(t.meta("upgrader"), undefined);
  const stale = t.one((b) => b.initUpgrade({ programUuid: P }));
  assert.match(stale.error.message, /อัปเกรดไม่ได้/);
  t.ok(t.one((b) => b.rejectUpgrade({ programUuid: P })));
  assert.equal(t.ok(t.call("version")).result, "1n");
  assert.equal(t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("bob") })).error.code, "FORBIDDEN");
  assert.equal(t.one((b) => b.setUpgrader({ programUuid: P, upgrader: "bob", context: user("bob") })).error.code, "FORBIDDEN");
});

test("upgrade: ทีมงาน reject → โค้ดเดิม · ผู้อนุมัติใช้กติกาเดียวกับ init / reject (admins)", () => {
  const t = deployed({ admins: ["0xadmin"] }, { admin: user("0xadmin") });
  t.block((b) => {
    t.ok(b.deploy({ programUuid: "other", code: V1, context: user("owner"), upgrader: "alice" }));
    t.ok(b.init({ programUuid: "other", context: user("0xadmin") }));
  });
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("alice") })));

  assert.match(t.one((b) => b.initUpgrade({ programUuid: P })).error.message, /ไม่มีสิทธิ์/);   // ไม่มีผู้เซ็น
  assert.match(t.one((b) => b.initUpgrade({ programUuid: P, context: user("alice") })).error.message, /ไม่มีสิทธิ์/);
  assert.match(t.one((b) => b.rejectUpgrade({ programUuid: P, context: user("bob") })).error.message, /ไม่มีสิทธิ์/);

  const rejected = t.ok(t.one((b) => b.rejectUpgrade({ programUuid: P, context: user("0xadmin") })));
  assert.equal(rejected.result.state, "rejected");
  assert.equal(t.vm.read(VM.pendingUpgradeKey(P)), undefined);
  assert.equal(t.ok(t.call("version")).result, "1n");
  assert.equal(t.meta("version"), undefined);
  assert.equal(t.one((b) => b.initUpgrade({ programUuid: P, context: user("0xadmin") })).error.code, "NOT_FOUND");
});

test("upgrade: migrate ล้ม → อนุมัติไม่สำเร็จ ไม่มีอะไรเปลี่ยน (โค้ด / storage / version / pending เดิม)", () => {
  const t = deployed();
  t.ok(t.call("add", { by: 7 }));
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: BAD_MIGRATE, context: user("alice") })));
  const res = t.one((b) => b.initUpgrade({ programUuid: P }));
  assert.deepEqual([res.status, res.error.code, res.error.message], ["throw", "PROGRAM_ERROR", "migrate ล้ม"]);
  assert.deepEqual(res.writes, []);
  assert.equal(t.ok(t.call("version")).result, "1n");
  assert.equal(t.vm.read(VM.storageKey(P, "count")), "7n");
  assert.equal(t.meta("version"), undefined);
  assert.equal(t.vm.listCodeVersions(P).length, 0);
  assert.ok(t.vm.read(VM.pendingUpgradeKey(P)), "pending ยังอยู่ให้ทีมงาน reject");
});

test("upgrade: timelock upgradeDelayBlocks = 0 ใช้โค้ดใหม่ทันทีใน block ที่อนุมัติ", () => {
  const t = deployed({ upgradeDelayBlocks: 0 });
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("alice") })));
  const { out } = t.block((b) => [b.initUpgrade({ programUuid: P }), b.call({ programUuid: P, functionName: "version", context: user("carol") })]);
  assert.deepEqual(out.map((r) => r.status), ["success", "success"]);
  assert.equal(out[1].result, "2n");   // tx ถัดไปใน block เดียวกันเห็นโค้ดใหม่แล้ว
});

test("upgrade: timelock N > 0 → โค้ดเดิมทำงานจนถึง block (อนุมัติ + N) แล้วสลับตอนสร้าง block นั้น (ก่อน tx ใบแรก)", () => {
  const t = deployed({ upgradeDelayBlocks: 2 });
  t.ok(t.call("add", { by: 1 }));
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, migrateInput: { tag: "later" }, context: user("alice") })));

  const { b: approveBlock, out: approved } = t.block((b) => b.initUpgrade({ programUuid: P }));
  const at = approveBlock.number + 2;
  assert.deepEqual(t.ok(approved).result, { programUuid: P, state: "scheduled", version: 2, activateAt: at });
  assert.deepEqual(t.vm.read(VM.upgradeAtKey(at)), [P]);
  assert.equal(t.vm.read(VM.scheduledUpgradeKey(P)).activateAt, at);
  // ระหว่างรอ: ส่งโค้ดใหม่อีกไม่ได้ และโค้ดเดิมยังทำงาน
  const { b: before, out: [again, stillOld] } = t.block((b) => [
    b.upgrade({ programUuid: P, code: V3, context: user("alice") }),
    b.call({ programUuid: P, functionName: "version", context: user("carol") }),
  ]);
  assert.match(again.error.message, /รออยู่แล้ว/);
  assert.equal(before.number, at - 1);
  assert.equal(t.ok(stillOld).result, "1n");
  assert.equal(before.header().upgrades, undefined);

  // block ที่ครบกำหนด: เปิดใช้ตอนสร้าง block แม้ไม่มี tx (deterministic: ขึ้นกับเลข block อย่างเดียว)
  const { b: due } = t.block();
  assert.equal(due.number, at);
  assert.deepEqual(t.vm.getBlock(at).upgrades, [{ program: P, status: "success", version: 2, error: null }]);
  assert.equal(t.vm.read(VM.scheduledUpgradeKey(P)), undefined);
  assert.equal(t.vm.read(VM.upgradeAtKey(at)), undefined);
  assert.equal(t.meta("version"), 2);
  assert.equal(t.ok(t.call("version")).result, "2n");
  assert.equal(t.ok(t.call("count")).result, "101n");   // migrate รันตอนเปิดใช้
  assert.equal(t.vm.getCodeVersion(P, 2).blockNumber, at);

  // replay block ที่เปิดใช้ได้ hash เดิม (writes ของการเปิดใช้อยู่ใน stateRoot)
  assert.equal(t.vm.replayBlock(at).hash, t.vm.getBlock(at).hash);

  // อนุมัตินอก block (ไม่มีเลข block) นัดไม่ได้
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V3, context: user("alice") })));
  assert.match(t.vm.initUpgrade({ programUuid: P }).error.message, /เลข block/);
});

test("upgrade: timelock N > 0 และ migrate ล้มตอนเปิดใช้ → ยกเลิกการอัปเกรด โค้ดเดิมทำงานต่อ", () => {
  const t = deployed({ upgradeDelayBlocks: 1 });
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: BAD_MIGRATE, context: user("alice") })));
  t.ok(t.one((b) => b.initUpgrade({ programUuid: P })));
  const { b: due } = t.block();
  assert.equal(t.vm.getBlock(due.number).upgrades[0].status, "throw");
  assert.equal(t.vm.read(VM.scheduledUpgradeKey(P)), undefined);
  assert.equal(t.ok(t.call("version")).result, "1n");
  assert.equal(t.vm.read(VM.storageKey(P, "count")), "0n");
  // ยกเลิกแล้ว upgrader ส่งใหม่ได้
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("alice") })));
});

test("upgrade: เก็บโค้ดทุกเวอร์ชัน <id>:codeversion:<n> · stateAt / replay ของ block เก่ายังใช้โค้ดเก่า", () => {
  const t = deployed();
  const v1Code = t.vm.read(VM.codeKey(P));
  const { b: oldBlock } = t.block((b) => t.ok(b.call({ programUuid: P, functionName: "add", input: { by: 3 }, context: user("carol") })));

  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, migrateInput: { tag: "a" }, context: user("alice") })));
  const { b: v2Block } = t.block((b) => t.ok(b.initUpgrade({ programUuid: P })));
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V3, migrateInput: { tag: "b" }, context: user("alice") })));
  const { b: v3Block } = t.block((b) => t.ok(b.initUpgrade({ programUuid: P })));

  const versions = t.vm.listCodeVersions(P);
  assert.deepEqual(versions.map((v) => [v.version, v.blockNumber]), [[1, null], [2, v2Block.number], [3, v3Block.number]]);
  assert.equal(versions[0].code, v1Code);
  assert.equal(versions[0].timestamp, t.meta("createdAt"));
  assert.equal(t.vm.getCodeVersion(P, 3).code, t.vm.read(VM.codeKey(P)));
  assert.equal(t.vm.getCodeVersion(P, 4), null);
  assert.equal(t.meta("version"), 3);

  assert.equal(t.vm.codeAt(oldBlock.number, P), v1Code);
  assert.equal(t.vm.codeAt(v2Block.number, P), versions[1].code);
  assert.equal(t.vm.codeAt(v3Block.number, P), versions[2].code);
  assert.equal(VM.decodeDbKey(VM.codeVersionKey(P, 2)).version, 2);

  // replay block เก่าใช้โค้ด ณ ตอนนั้น (ตรรกะ v1: บวกตรง ๆ) และ hash ตรงกับที่บันทึกไว้
  const replayed = t.vm.replayBlock(oldBlock.number);
  assert.equal(replayed.hash, oldBlock.header().hash);
  assert.equal(replayed.transactions[0].result, "3n");
  assert.equal(t.vm.replayBlock(v2Block.number).transactions[0].result.version, 2);
});

test("upgrade: action ที่เซ็นแล้ว (deploy + upgrader / upgrade / setUpgrader / initUpgrade / rejectUpgrade) ผ่าน verifyTransaction", () => {
  const key = sign.randomPrivateKey();
  const me = sign.addressOf(key);
  const t = setup({ deriveProgramAddress: true });
  const signed = (tx) => sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });

  const deploy = signed({ action: "deploy", from: me, code: V1, upgrader: me, nonce: 0 });
  assert.equal(deploy.request.upgrader, me);
  const { out: [created] } = t.block((b) => [t.ok(b[deploy.method](deploy.request))]);
  const program = created.result.programUuid;
  t.ok(t.one((b) => b.init({ programUuid: program })));
  assert.equal(t.vm.read(VM.metadataKey(program, "upgrader")), me);

  // upgrader อยู่ในข้อมูลที่เซ็น: เปลี่ยนหลังเซ็น → ได้ผู้เซ็นคนละคน
  const tx = { action: "deploy", from: me, code: V1, upgrader: me, nonce: 0 };
  assert.throws(() => sign.verifyTransaction({ tx: { ...tx, upgrader: "0x" + "9".repeat(40) }, signature: sign.signTransaction(tx, key) }), /ลายเซ็นไม่ตรง/);
  // ไม่ส่ง upgrader → ข้อมูลที่เซ็นเหมือนเดิมทุกไบต์ (tx เดิมไม่เปลี่ยน hash)
  assert.equal(sign.buildTypedData({ action: "deploy", from: me, code: V1 }).message.input, VM.canonicalJson({ input: {}, code: V1 }));
  assert.equal("upgrader" in sign.normalizeTransaction({ action: "deploy", code: V1 }), false);

  const upgrade = signed({ action: "upgrade", from: me, to: program, code: V2, input: { tag: "signed" }, nonce: 1 });
  assert.deepEqual([upgrade.method, upgrade.request.migrateInput], ["upgrade", { tag: "signed" }]);
  t.ok(t.one((b) => b[upgrade.method](upgrade.request)));
  const approve = signed({ action: "initUpgrade", from: me, to: program, nonce: 2 });
  const approved = t.ok(t.one((b) => b[approve.method](approve.request)));
  assert.equal(approved.result.version, 2);
  assert.equal(t.vm.read(VM.storageKey(program, "migrated")), "signed");

  t.ok(t.one((b) => b.upgrade({ programUuid: program, code: V3, context: user(me) })));
  const reject = signed({ action: "rejectUpgrade", from: me, to: program, nonce: 3 });
  assert.equal(t.ok(t.one((b) => b[reject.method](reject.request))).result.state, "rejected");

  const renounce = signed({ action: "setUpgrader", from: me, to: program, input: { upgrader: null }, nonce: 4 });
  assert.deepEqual(renounce.request.upgrader, null);
  t.ok(t.one((b) => b[renounce.method](renounce.request)));
  assert.equal(t.vm.read(VM.metadataKey(program, "upgrader")), undefined);

  // hash ของ tx แต่ละ action ไม่ชนกัน
  const hashes = ["initUpgrade", "rejectUpgrade", "init", "reject"].map((action) => t.vm.hashTransaction({ programUuid: program, context: user(me), nonce: 9 }, { action }));
  assert.equal(new Set(hashes).size, 4);
});

test("upgrade: autoreview ตรวจโค้ดใหม่แบบเดียวกับ deploy และ receipt แสดง action upgrade", () => {
  const t = deployed({ autoReview: true });
  const bad = t.one((b) => b.upgrade({ programUuid: P, code: V1.replace("return 1n", "return process.env"), context: user("alice") }));
  assert.match(bad.error.message, /ไม่ผ่านการตรวจอัตโนมัติ/);
  const { b } = t.block((block) => t.ok(block.upgrade({ programUuid: P, code: V2, migrateInput: { tag: "r" }, context: user("alice") })));
  const receipt = b.receipt().transactions[0];
  assert.deepEqual([receipt.action, receipt.to, receipt.input], ["upgrade", P, { tag: "r" }]);
  assert.deepEqual(receipt.programChanges, [{ kind: "pending-upgrade", address: P, removed: false }]);
  assert.equal(review(V2, { apiNames: ["readDB", "writeDB", "params"] }).ok, true);
});

test("upgrade: simulate ของ initUpgrade แบบมี timelock จำลองเป็น block ถัดไป (mempool รับเข้าคิวได้)", () => {
  const key = sign.randomPrivateKey();
  const admin = sign.addressOf(key);
  const t = deployed({ upgradeDelayBlocks: 3 });
  t.ok(t.one((b) => b.upgrade({ programUuid: P, code: V2, context: user("alice") })));
  const tx = { action: "initUpgrade", from: admin, to: P, nonce: 0 };
  const verified = sign.verifyTransaction({ tx, signature: sign.signTransaction(tx, key) });
  const result = simulate(t.vm, verified);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual([result.result.state, result.result.activateAt], ["scheduled", t.vm.latestBlockNumber() + 1 + 3]);
  assert.ok(t.vm.read(VM.pendingUpgradeKey(P)), "simulate ไม่ commit อะไร");
});
