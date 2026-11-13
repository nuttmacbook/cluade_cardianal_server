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

test("sender / origin: modifying params.context in a program does not affect programs it calls", () => {
  activateProbes("a", "b");
  const res = ok(callAs("alice", "a", "mutateContextThenRelay", { target: "b" }));
  assert.deepEqual(res.result, { sender: "a", origin: "alice" });
});

test("sender / origin: a user tx is forced to origin = sender", () => {
  activateProbes("a", "b");
  const res = ok(vm.call({ programUuid: "a", functionName: "relay", input: { target: "b", fn: "whoami" }, context: user("gateway", "alice") }));
  assert.deepEqual(res.result, { sender: "a", origin: "gateway" });
});

test("sender / origin: forceOriginFromSender off → the given origin is used", () => {
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

test("storage is per program: B can write a key with the same name as A without collision", () => {
  activateProbes("a", "b");
  ok(callAs("u", "a", "writeKey", { key: "shared", value: "a" }));
  const res = ok(callAs("u", "a", "readAfterNestedWrite", { target: "b", value: "b" }));
  assert.equal(res.result, "b");
  assert.equal(stored("a", "shared"), "a");
  assert.equal(stored("b", "shared"), "b");
});

test("catch: A catches B's error → A success, B's writes revert, A's writes before/after remain", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "beforeCatchAfter", { target: "b" }));

  assert.equal(res.result, "done");
  assert.deepEqual(trace(res), ["0:a.beforeCatchAfter:success", "1:b.writeThenThrow:throw:PROGRAM_ERROR"]);
  assert.deepEqual(res.calls[1].error, { code: "PROGRAM_ERROR", message: "boom" });
  assert.deepEqual(dbKeys(res), ["put a:storage:before", "put a:storage:error", "put a:storage:after"]);
  assert.equal(stored("b", "dirty"), undefined);
});

test("catch: keys touched in a reverted call stay in afterValues but with changed false", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "beforeCatchAfter", { target: "b" }));
  assert.deepEqual(res.afterValues.find((v) => v.dbKey === "b:storage:dirty"), { dbKey: "b:storage:dirty", afterValue: undefined, changed: false });
});

test("catch: B succeeds first, then fails on a later caught call → the first call's writes remain", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "okThenCaughtFailure", { target: "b" }));
  assert.deepEqual(trace(res), ["0:a.okThenCaughtFailure:success", "1:b.writeKey:success", "1:b.writeThenThrow:throw:PROGRAM_ERROR"]);
  assert.deepEqual(dbKeys(res), ["put b:storage:first"]);
});

test("catch: whole branch reverts — B calls C successfully, then B throws and A catches → all of B's and C's writes are gone", () => {
  activateProbes("a", "b", "c");
  const res = ok(callAs("u", "a", "relayCatch", { target: "b", fn: "writeCallThrow", args: { target: "c" } }));

  assert.deepEqual(res.result, { ok: false, message: "after nested success", code: "PROGRAM_ERROR" });
  assert.deepEqual(trace(res), ["0:a.relayCatch:success", "1:b.writeCallThrow:throw:PROGRAM_ERROR", "2:c.writeKey:success"]);
  assert.deepEqual(res.writes, []);
});

test("no catch: the error propagates through every level → the whole request throws", () => {
  activateProbes("a", "b", "c");
  const res = fails(callAs("u", "a", "relay", { target: "b", fn: "relay", args: { target: "c", fn: "writeThenThrow" } }), "PROGRAM_ERROR", "boom");
  assert.deepEqual(trace(res), [
    "0:a.relay:throw:PROGRAM_ERROR",
    "1:b.relay:throw:PROGRAM_ERROR",
    "2:c.writeThenThrow:throw:PROGRAM_ERROR",
  ]);
});

test("HOP D > E > F > A > B fails at A with no catch → everything throws, B is never called", () => {
  for (const id of ["d", "e", "f", "a", "b"]) activate(id, HOP);
  const res = fails(callAs("u", "d", "hop", { path: ["d", "e", "f", "a", "b"], failAt: "a" }), "PROGRAM_ERROR", "fail at a");
  assert.deepEqual(trace(res), [
    "0:d.hop:throw:PROGRAM_ERROR",
    "1:e.hop:throw:PROGRAM_ERROR",
    "2:f.hop:throw:PROGRAM_ERROR",
    "3:a.hop:throw:PROGRAM_ERROR",
  ]);
});

test("HOP D > E > F > A > B fails at A but E catches → success, only D's and E's writes are kept", () => {
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

test("HOP through every program without errors → every level success", () => {
  for (const id of ["d", "e", "f", "a", "b"]) activate(id, HOP);
  const res = ok(callAs("u", "d", "hop", { path: ["d", "e", "f", "a", "b"] }));
  assert.deepEqual(res.result, ["d", "e", "f", "a", "b"]);
  assert.equal(res.writes.length, 5);
  assert.ok(trace(res).every((t) => t.endsWith(":success")));
});

test("catchable runProgram errors: NOT_FOUND / FORBIDDEN / initialization / non-JSON input", () => {
  activateProbes("a", "b");
  const relayCatch = (args) => ok(callAs("u", "a", "relayCatch", args)).result;

  assert.deepEqual(relayCatch({ target: "missing", fn: "whoami" }), { ok: false, message: "ไม่พบโปรแกรม 'missing'", code: "NOT_FOUND" });
  assert.deepEqual(relayCatch({ target: "b", fn: "internalOnly" }), { ok: false, message: "เรียก 'internalOnly' ไม่ได้ (ไม่มีหรือไม่ได้ export)", code: "FORBIDDEN" });
  assert.deepEqual(relayCatch({ target: "b", fn: "initialization" }), { ok: false, message: "เรียก 'initialization' ไม่ได้ (ไม่มีหรือไม่ได้ export)", code: "FORBIDDEN" });
  assert.deepEqual(relayCatch({ target: "a:b", fn: "whoami" }).ok, false);
});

test("runProgram errors before execution starts (NOT_FOUND / FORBIDDEN) are not recorded in calls", () => {
  activateProbes("a");
  const res = ok(callAs("u", "a", "relayCatch", { target: "missing", fn: "whoami" }));
  assert.deepEqual(trace(res), ["0:a.relayCatch:success"]);
});

test("recursion: bounded self-recursion → success", () => {
  activateProbes("r");
  const res = ok(callAs("u", "r", "recurse", { self: "r", left: 5 }));
  assert.equal(res.result, "5n");
  assert.equal(res.calls.length, 6);
});

test("recursion: unbounded → LIMIT_EXCEEDED at maxCallDepth, every level throws", () => {
  activateProbes("r");
  const res = fails(callAs("u", "r", "recurse", { self: "r" }), "LIMIT_EXCEEDED", "เรียกโปรแกรมซ้อนได้ไม่เกิน 8 ชั้น");
  assert.equal(res.calls.length, 9); // depth 0..8
  assert.ok(trace(res).every((t) => t.endsWith(":throw:LIMIT_EXCEEDED")));
});

test("recursion: LIMIT_EXCEEDED can be caught", () => {
  activateProbes("r");
  const res = ok(callAs("u", "r", "recurseCatch", { self: "r" }));
  assert.equal(res.result, "LIMIT_EXCEEDED");
});

test("config.maxCallDepth is configurable", () => {
  activateProbes("r");
  vm.maxCallDepth = 2;
  fails(callAs("u", "r", "recurse", { self: "r", left: 3 }), "LIMIT_EXCEEDED", "เรียกโปรแกรมซ้อนได้ไม่เกิน 2 ชั้น");
  ok(callAs("u", "r", "recurse", { self: "r", left: 2 }));
});

test("mutual recursion A ↔ B within maxCallDepth", () => {
  activateProbes("a", "b");
  const res = ok(callAs("u", "a", "relay", {
    target: "b", fn: "relay", args: { target: "a", fn: "relay", args: { target: "b", fn: "whoami" } },
  }));
  assert.deepEqual(res.result, { sender: "a", origin: "u" });
  assert.equal(res.calls.length, 4);
});
