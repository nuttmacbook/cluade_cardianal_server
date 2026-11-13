import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { VM, mockData, resetVM, user, ok, fails, activate, callAs, stored, dbKeys } from "./helpers.js";
import { COUNTER, PROBE, FAULTY } from "./programs.js";

beforeEach(resetVM);

test("storage: read-your-writes within a single request", () => {
  activate("counter", COUNTER, { initInput: { start: 1 } });
  const res = ok(callAs("a", "counter", "addTwice", { amount: 10 }));
  assert.equal(res.result, "21n");
  assert.deepEqual(dbKeys(res), ["put counter:storage:count", "put counter:storage:count"]);
  assert.deepEqual(res.writes.map((w) => w.value), ["11n", "21n"]);
  assert.equal(stored("counter", "count"), "21n");
});

test("storage: loadValues holds the pre-run values (first read), afterValues holds the final values", () => {
  activate("counter", COUNTER, { initInput: { start: 1 } });
  const res = ok(callAs("a", "counter", "addTwice", { amount: 10 }));
  assert.deepEqual(res.loadValues, [{ dbKey: "counter:storage:count", loadValue: "1n" }]);
  assert.deepEqual(res.afterValues, [{ dbKey: "counter:storage:count", afterValue: "21n", changed: true }]);
});

test("storage: read only → changed false, no writes", () => {
  activate("counter", COUNTER, { initInput: { start: 3 } });
  const res = ok(callAs("a", "counter", "get"));
  assert.deepEqual(res.afterValues, [{ dbKey: "counter:storage:count", afterValue: "3n", changed: false }]);
  assert.deepEqual(res.writes, []);
});

test("storage: rewriting the same value → writes but changed false", () => {
  activate("probe", PROBE);
  ok(callAs("a", "probe", "writeKey", { key: "k", value: { x: 1 } }));
  const res = ok(callAs("a", "probe", "writeKey", { key: "k", value: { x: 1 } }));
  assert.equal(res.writes.length, 1);
  assert.equal(res.afterValues[0].changed, false);
});

test("storage: write only (no read) → not in loadValues but in afterValues", () => {
  activate("probe", PROBE);
  ok(callAs("a", "probe", "writeOnly", { key: "k", value: 1 }));
  const res = ok(callAs("a", "probe", "writeOnly", { key: "k", value: 2 }));
  assert.deepEqual(res.loadValues, []);
  assert.deepEqual(res.afterValues, [{ dbKey: "probe:storage:k", afterValue: "2n", changed: true }]);
});

test("storage: null can be written and reads back as null", () => {
  activate("faulty", FAULTY);
  const res = ok(callAs("a", "faulty", "writeNull"));
  assert.equal(res.result, null);
  assert.deepEqual(res.loadValues, [{ dbKey: "faulty:storage:k", loadValue: undefined }]);
  assert.deepEqual(res.afterValues, [{ dbKey: "faulty:storage:k", afterValue: null, changed: true }]);
});

test("storage: read after delete → undefined, afterValue undefined, changed true", () => {
  activate("counter", COUNTER, { initInput: { start: 9 } });
  const res = ok(callAs("a", "counter", "reset"));
  assert.equal(res.result, undefined);
  assert.deepEqual(dbKeys(res), ["del counter:storage:count"]);
  assert.deepEqual(res.afterValues, [{ dbKey: "counter:storage:count", afterValue: undefined, changed: true }]);
  assert.equal(mockData.has("counter:storage:count"), false);
});

test("storage: read values are copied — modifying a read object does not affect the DB", () => {
  activate("probe", PROBE);
  ok(callAs("a", "probe", "writeKey", { key: "obj", value: { n: 1 } }));
  mockData.get("probe:storage:obj").n = 1;
  const before = structuredClone(mockData.get("probe:storage:obj"));
  ok(callAs("a", "probe", "readKey", { key: "obj" })).result.n = 999;
  assert.deepEqual(mockData.get("probe:storage:obj"), before);
});

test("storage: writeDB non-JSON values / undefined", () => {
  activate("faulty", FAULTY);
  fails(callAs("a", "faulty", "writeUndefined"), "INVALID_REQUEST", "writeDB cannot store undefined (use deleteDB)");
  fails(callAs("a", "faulty", "writeFunction"), "INVALID_REQUEST", "writeDB value must be JSON data");
  fails(callAs("a", "faulty", "writeCircular"), "PROGRAM_ERROR", /RangeError/);
  fails(callAs("a", "faulty", "writeDate"), "INVALID_REQUEST", "writeDB value must be JSON data");
  // BigInt can be written, stored in the DB as "10n"
  const big = ok(callAs("a", "faulty", "writeBigInt"));
  assert.deepEqual(big.writes.map((w) => w.value), ["10n"]);
});

test("key: strings containing ':' are encoded — no collision with map() and no writing across namespaces", () => {
  activate("probe", PROBE);
  const colon = ok(callAs("a", "probe", "writeKey", { key: "other:storage:x", value: 1 }));
  assert.deepEqual(dbKeys(colon), ["put probe:storage:other%3Astorage%3Ax"]);

  assert.equal(VM.storageKey("probe", "a:b"), "probe:storage:a%3Ab");
  assert.equal(VM.storageKey("probe", VM.map("a", "b")), "probe:storage:a:b");
  assert.equal(VM.storageKey("probe", VM.map("a", 1)), "probe:storage:a:1");
  assert.equal(VM.storageKey("probe", VM.map("a", "1")), "probe:storage:a:1"); // 1 and "1" are the same key
  assert.equal(VM.storageKey("probe", VM.map("用户", "a b/c")), "probe:storage:%E7%94%A8%E6%88%B7:a%20b%2Fc");   // non-ASCII key is intentional: tests percent-encoding of Unicode
});

test("key: invalid format → INVALID_REQUEST", () => {
  activate("faulty", FAULTY);
  const cases = {
    empty: "each key part must be a non-empty string, an integer or a BigInt",
    emptyMap: "key must be a string or map(...)",
    emptyPart: "each key part must be a non-empty string, an integer or a BigInt",
    floatPart: "each key part must be a non-empty string, an integer or a BigInt",
    nullPart: "each key part must be a non-empty string, an integer or a BigInt",
    objectKey: "key must be a string or map(...)",
    numberKey: "key must be a string or map(...)",
    nullKey: "key must be a string or map(...)",
    arrayKey: "key must be a string or map(...)",
  };
  for (const [which, message] of Object.entries(cases)) {
    fails(callAs("a", "faulty", "badKey", { which }), "INVALID_REQUEST", message);
  }
});

test("key: key errors can be caught by the program", () => {
  activate("faulty", FAULTY);
  assert.equal(ok(callAs("a", "faulty", "badKeyCaught")).result, "INVALID_REQUEST");
});
