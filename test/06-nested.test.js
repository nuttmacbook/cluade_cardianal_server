import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, vm, createVm, resetVM, user, ok, fails, activate, callAs, trace, stored, dbKeys } from "./helpers.js";
import { PROBE, HOP } from "./programs.js";

beforeEach(resetVM);

function activateProbes(...ids) {
  for (const id of ids) activate(id, PROBE);
}

test("sender / origin: A → B → C", () => {
  activateProbes("a", "b", "c");
  const res = ok(callAs("alice", "a", "relay", {
    target: "b", fn: "relay", args: { target: "c", fn: "whoami" },
  }));
  assert.deepEqual(res.result, { sender: "b", origin: "alice" });
  assert.deepEqual(res.calls.map((c) => [c.depth, c.programUuid, c.sender, c.origin]), [
    [0, "a", "alice", "alice"],
    [1, "b", "a", "alice"],
    [2, "c", "b", "alice"],
  ]);
});

test("sender / origin: แก้ params.context ในโปรแกรม ไม่มีผลกับโปรแกรมที่ถูกเรียกต่อ", () => {
  activateProbes("a", "b");
  const res = ok(callAs("alice", "a", "mutateContextThenRelay", { target: "b" }));
  assert.deepEqual(res.result, { sender: "a", origin: "alice" });
});

test("sender / origin: tx ของ user ถูกบังคับให้ origin = sender", () => {
  activateProbes("a", "b");
  const res = ok(vm.call({ programUuid: "a", functionName: "relay", input: { target: "b", fn: "whoami" }, context: user("gateway", "alice") }));
  assert.deepEqual(res.result, { sender: "a", origin: "gateway" });
});

test("sender / origin: ปิด forceOriginFromSender → ใช้ origin ที่ส่งมาได้", () => {
  const loose = createVm({ forceOriginFromSender: false });
  const save = (res) => {
    assert.equal(res.status, "success", JSON.stringify(res.error));
    loose.commit(res.writes);
  };
  for (const id of ["a", "b"]) {
    save(loose.deploy({ programUuid: id, code: PROBE, context: user("owner") }));
    save(loose.init({ programUuid: id }));
  }
  const res = loose.call({ programUuid: "a", functionName: "relay", input: { target: "b", fn: "whoami" }, context: user("gateway", "alice") });
  assert.equal(res.status, "success");
  assert.deepEqual(res.result, { sender: "a", origin: "alice" });
});

test("storage แยกตามโปรแกรม: B เขียน key ชื่อเดียวกับ A ได้โดยไม่ชนกัน", () => {
  activateProbes("a", "b");
  ok(callAs("u", "a", "writeKey", { key: "shared", value: "a" }));
  const res = ok(callAs("u", "a", "readAfterNestedWrite", { target: "b", value: "b" }));
  assert.equal(res.result, "b");
  assert.equal(stored("a", "shared"), "a");
  assert.equal(stored("b", "shared"), "b");
});

test("catch: A catch error ของ B → A success, writes ของ B ถูกย้อน, writes ของ A ก่อน/หลังยังอยู่", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "beforeCatchAfter", { target: "b" }));

  assert.equal(res.result, "done");
  assert.deepEqual(trace(res), ["0:a.beforeCatchAfter:success", "1:b.writeThenThrow:throw:PROGRAM_ERROR"]);
  assert.deepEqual(res.calls[1].error, { code: "PROGRAM_ERROR", message: "boom" });
  assert.deepEqual(dbKeys(res), ["put a:storage:before", "put a:storage:error", "put a:storage:after"]);
  assert.equal(stored("b", "dirty"), undefined);
});

test("catch: key ที่ถูกแตะใน call ที่ถูกย้อน ยังอยู่ใน afterValues แต่ changed false", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "beforeCatchAfter", { target: "b" }));
  assert.deepEqual(res.afterValues.find((v) => v.dbKey === "b:storage:dirty"), { dbKey: "b:storage:dirty", afterValue: undefined, changed: false });
});

test("catch: B สำเร็จก่อน แล้ว B ล้มในครั้งถัดไปที่ถูก catch → writes ของครั้งแรกยังอยู่", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "okThenCaughtFailure", { target: "b" }));
  assert.deepEqual(trace(res), ["0:a.okThenCaughtFailure:success", "1:b.writeKey:success", "1:b.writeThenThrow:throw:PROGRAM_ERROR"]);
  assert.deepEqual(dbKeys(res), ["put b:storage:first"]);
});

test("catch: ย้อนทั้งกิ่ง — B เรียก C สำเร็จแล้ว B throw และ A catch → writes ของ B และ C หายทั้งหมด", () => {
  activateProbes("a", "b", "c");
  const res = ok(callAs("u", "a", "relayCatch", { target: "b", fn: "writeCallThrow", args: { target: "c" } }));

  assert.deepEqual(res.result, { ok: false, message: "after nested success", code: "PROGRAM_ERROR" });
  assert.deepEqual(trace(res), ["0:a.relayCatch:success", "1:b.writeCallThrow:throw:PROGRAM_ERROR", "2:c.writeKey:success"]);
  assert.deepEqual(res.writes, []);
});

test("ไม่ catch: error ส่งต่อขึ้นไปทุกชั้น → throw ทั้ง request", () => {
  activateProbes("a", "b", "c");
  const res = fails(callAs("u", "a", "relay", { target: "b", fn: "relay", args: { target: "c", fn: "writeThenThrow" } }), "PROGRAM_ERROR", "boom");
  assert.deepEqual(trace(res), [
    "0:a.relay:throw:PROGRAM_ERROR",
    "1:b.relay:throw:PROGRAM_ERROR",
    "2:c.writeThenThrow:throw:PROGRAM_ERROR",
  ]);
});

test("HOP D > E > F > A > B ล้มที่ A ไม่มีใคร catch → throw ทั้งหมด, B ไม่ถูกเรียก", () => {
  for (const id of ["d", "e", "f", "a", "b"]) activate(id, HOP);
  const res = fails(callAs("u", "d", "hop", { path: ["d", "e", "f", "a", "b"], failAt: "a" }), "PROGRAM_ERROR", "fail at a");
  assert.deepEqual(trace(res), [
    "0:d.hop:throw:PROGRAM_ERROR",
    "1:e.hop:throw:PROGRAM_ERROR",
    "2:f.hop:throw:PROGRAM_ERROR",
    "3:a.hop:throw:PROGRAM_ERROR",
  ]);
});

test("HOP D > E > F > A > B ล้มที่ A แต่ E catch → success, เก็บ writes ของ D และ E เท่านั้น", () => {
  for (const id of ["d", "e", "f", "a", "b"]) activate(id, HOP);
  const res = ok(callAs("u", "d", "hop", { path: ["d", "e", "f", "a", "b"], failAt: "a", catchAt: "e" }));

  assert.deepEqual(res.result, ["d", "e", "caught: fail at a"]);
  assert.deepEqual(trace(res), [
    "0:d.hop:success",
    "1:e.hop:success",
    "2:f.hop:throw:PROGRAM_ERROR",
    "3:a.hop:throw:PROGRAM_ERROR",
  ]);
  assert.deepEqual(dbKeys(res), ["put d:storage:visited", "put e:storage:visited", "put e:storage:caught"]);
});

test("HOP ครบทุกโปรแกรมไม่มี error → ทุกชั้น success", () => {
  for (const id of ["d", "e", "f", "a", "b"]) activate(id, HOP);
  const res = ok(callAs("u", "d", "hop", { path: ["d", "e", "f", "a", "b"] }));
  assert.deepEqual(res.result, ["d", "e", "f", "a", "b"]);
  assert.equal(res.writes.length, 5);
  assert.ok(trace(res).every((t) => t.endsWith(":success")));
});

test("runProgram error ที่ catch ได้: NOT_FOUND / FORBIDDEN / initialization / input ไม่ใช่ JSON", () => {
  activateProbes("a", "b");
  const relayCatch = (args) => ok(callAs("u", "a", "relayCatch", args)).result;

  assert.deepEqual(relayCatch({ target: "missing", fn: "whoami" }), { ok: false, message: "ไม่พบโปรแกรม 'missing'", code: "NOT_FOUND" });
  assert.deepEqual(relayCatch({ target: "b", fn: "internalOnly" }), { ok: false, message: "เรียก 'internalOnly' ไม่ได้ (ไม่มีหรือไม่ได้ export)", code: "FORBIDDEN" });
  assert.deepEqual(relayCatch({ target: "b", fn: "initialization" }), { ok: false, message: "เรียก 'initialization' ไม่ได้ (ไม่มีหรือไม่ได้ export)", code: "FORBIDDEN" });
  assert.deepEqual(relayCatch({ target: "a:b", fn: "whoami" }).ok, false);
});

test("runProgram error ก่อนเริ่มรัน (NOT_FOUND / FORBIDDEN) ไม่ถูกบันทึกใน calls", () => {
  activateProbes("a");
  const res = ok(callAs("u", "a", "relayCatch", { target: "missing", fn: "whoami" }));
  assert.deepEqual(trace(res), ["0:a.relayCatch:success"]);
});

test("recursion: เรียกตัวเองซ้อนแบบมีจุดจบ → success", () => {
  activateProbes("r");
  const res = ok(callAs("u", "r", "recurse", { self: "r", left: 5 }));
  assert.equal(res.result, 5);
  assert.equal(res.calls.length, 6);
});

test("recursion: ไม่รู้จบ → LIMIT_EXCEEDED ที่ maxCallDepth, ทุกชั้น throw", () => {
  activateProbes("r");
  const res = fails(callAs("u", "r", "recurse", { self: "r" }), "LIMIT_EXCEEDED", "เรียกโปรแกรมซ้อนได้ไม่เกิน 8 ชั้น");
  assert.equal(res.calls.length, 9); // depth 0..8
  assert.ok(trace(res).every((t) => t.endsWith(":throw:LIMIT_EXCEEDED")));
});

test("recursion: catch LIMIT_EXCEEDED ได้", () => {
  activateProbes("r");
  const res = ok(callAs("u", "r", "recurseCatch", { self: "r" }));
  assert.equal(res.result, "LIMIT_EXCEEDED");
});

test("config.maxCallDepth ปรับได้", () => {
  activateProbes("r");
  vm.maxCallDepth = 2;
  fails(callAs("u", "r", "recurse", { self: "r", left: 3 }), "LIMIT_EXCEEDED", "เรียกโปรแกรมซ้อนได้ไม่เกิน 2 ชั้น");
  ok(callAs("u", "r", "recurse", { self: "r", left: 2 }));
});

test("mutual recursion A ↔ B ภายใน maxCallDepth", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "relay", {
    target: "b", fn: "relay", args: { target: "a", fn: "relay", args: { target: "b", fn: "whoami" } },
  }));
  assert.deepEqual(res.result, { sender: "a", origin: "u" });
  assert.equal(res.calls.length, 4);
});
