import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { cursorIndexedEvents, indexedFilterOf } from "../src/node/explorer-api.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * emit(name, data, { indexed: ["from", "to"] }) → index eventidx:<program>:<name>:<field>:<topic>:<block>:<tx>:<event>
 *   find events by field value without scanning every event (GET /program/:a/events?name=Transfer&to=0x… · eth_getLogs by topic)
 *   gas: + gas.topic per indexed field · the standard token indexes Transfer from / to
 */

const T = Date.parse("2024-06-01T10:00:00Z");
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const CAROL = "0x00000000000000000000000000000000000000c3";
const TOKEN = "0x00000000000000000000000000000000000000f1";
const P = "0x00000000000000000000000000000000000000e1";
const as = (who) => ({ sender: who, origin: who });

const EMITTER = `function program() {
  function plain(params) { emit("Ping", { who: params.input.who }) }
  function tagged(params) { emit("Ping", { who: params.input.who }, { indexed: ["who"] }) }
  function wrong(params) { emit("Ping", { who: 1n }, params.input.options) }
  function many(params) {
    emit("Order", { id: params.input.id, buyer: params.input.buyer, paid: params.input.paid, note: "x" }, { indexed: ["id", "buyer", "paid"] })
  }
  return { plain, tagged, wrong, many }
}`;

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, recordTransactions: true, recordHistory: true });
  let number = 0;
  const mine = (...calls) => {
    number += 1;
    const block = vm.createBlock({ number, timestamp: T + number * 1000, feeRecipient: OWNER });
    const results = calls.map(([method, request]) => block[method](request));
    block.commit();
    return results;
  };
  const call = (who, programUuid, functionName, input) => ["call", { programUuid, functionName, input, context: as(who) }];
  mine(
    ["deploy", { programUuid: TOKEN, code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Coin", ticker: "C", decimals: "0n", supply: "1000n" } }],
    ["init", { programUuid: TOKEN }],
    ["deploy", { programUuid: P, code: EMITTER, context: as(OWNER) }],
    ["init", { programUuid: P }],
  );
  mine(call(OWNER, TOKEN, "transfer", { to: BOB, amount: "5n" }), call(OWNER, TOKEN, "transfer", { to: CAROL, amount: "6n" }));
  mine(call(BOB, TOKEN, "transfer", { to: CAROL, amount: "1n" }), call(OWNER, TOKEN, "transfer", { to: BOB, amount: "7n" }));
  mine(call(OWNER, P, "many", { id: "42n", buyer: BOB, paid: true }), call(OWNER, P, "tagged", { who: "alice" }));
  return { vm, rpc: createEvmRpc({ vm }) };
}

test("emit indexed: validates options (at most 3 / must exist in data / no duplicates / must be an array) · the event stores the indexed list", () => {
  const { vm } = chain();
  const run = (options) => vm.call({ programUuid: P, functionName: "wrong", input: { options }, context: as(OWNER) }, { timestamp: T });
  assert.equal(run({ indexed: ["who"] }).status, "success");
  assert.deepEqual(run({ indexed: ["who"] }).events[0].indexed, ["who"]);
  assert.equal(run(undefined).events[0].indexed, undefined);   // omitted = event looks as before
  for (const [options, message] of [
    [{ indexed: ["nope"] }, /ไม่มี field 'nope'/],
    [{ indexed: ["who", "who"] }, /ซ้ำ/],
    [{ indexed: "who" }, /ต้องเป็น array/],
    [{ indexed: ["a", "b", "c", "d"] }, /ไม่เกิน 3/],
    [{ topics: ["who"] }, /ไม่รู้จัก 'topics'/],
  ]) {
    const res = run(options);
    assert.equal(res.status, "throw", JSON.stringify(options));
    assert.match(res.error.message, message);
  }
});

test("emit indexed: gas grows by gas.topic per field", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { gas: API_GAS_ONLY });
  vm.commit(vm.deploy({ programUuid: P, code: EMITTER, context: as(OWNER) }).writes);
  vm.commit(vm.init({ programUuid: P }).writes);
  const plain = vm.call({ programUuid: P, functionName: "plain", input: { who: "alice" }, context: as(OWNER) }, { timestamp: T });
  const tagged = vm.call({ programUuid: P, functionName: "tagged", input: { who: "alice" }, context: as(OWNER) }, { timestamp: T });
  assert.equal(tagged.gasUsed - plain.gasUsed, vm.gas.topic);
  assert.equal(vm.gas.topic, 375);
});

test("index: find token Transfers by to / from (newest first) · missing value = empty · non-indexed field = empty", () => {
  const { vm } = chain();
  const toBob = vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "to", value: BOB });
  assert.deepEqual(toBob.items.map((e) => [e.blockNumber, e.data.amount]), [[3, "7n"], [2, "5n"]]);
  const fromBob = vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "from", value: BOB.toUpperCase().replace("0X", "0x") });
  assert.deepEqual(fromBob.items.map((e) => e.data.to), [CAROL]);
  assert.equal(vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "to", value: "0x00000000000000000000000000000000000000dd" }).items.length, 0);
  assert.equal(vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "amount", value: "5" }).items.length, 0);
  // number / bool / string
  assert.equal(vm.listIndexedEvents({ program: P, name: "Order", field: "id", value: "42" }).items.length, 1);
  assert.equal(vm.listIndexedEvents({ program: P, name: "Order", field: "paid", value: "true" }).items.length, 1);
  assert.equal(vm.listIndexedEvents({ program: P, name: "Ping", field: "who", value: "alice" }).items[0].data.who, "alice");
  // index key: eventidx:<program>:<name>:<field>:<topic>:<block>:<tx>:<event> → value = the event's dbKey
  const [key] = vm.listKeys(VM.eventIndexPrefix(TOKEN, "Transfer", "to", VM.topicOf(CAROL)));
  assert.equal(VM.decodeDbKey(key).kind, "eventidx");
  assert.equal(vm.read(key), VM.eventKey(TOKEN, "Transfer", 2, 1, 0));
});

test("index: cursor paging + multi-field filter (REST) · name is required", () => {
  const { vm } = chain();
  const query = new URLSearchParams({ name: "Transfer", to: BOB, limit: "1" });
  const filters = indexedFilterOf(query);
  assert.deepEqual(filters, [["to", BOB]]);
  const first = cursorIndexedEvents(vm, TOKEN, "Transfer", filters, { limit: 1 });
  assert.deepEqual(first.items.map((e) => e.data.amount), ["7n"]);
  assert.ok(first.next);
  const second = cursorIndexedEvents(vm, TOKEN, "Transfer", filters, { limit: 1, cursor: first.next });
  assert.deepEqual(second.items.map((e) => e.data.amount), ["5n"]);
  assert.equal(second.next, null);
  const both = cursorIndexedEvents(vm, TOKEN, "Transfer", [["to", CAROL], ["from", BOB]], { limit: 10 });
  assert.deepEqual(both.items.map((e) => e.data.amount), ["1n"]);
  assert.equal(cursorIndexedEvents(vm, TOKEN, "", filters).status, 400);
  assert.equal(indexedFilterOf(new URLSearchParams({ name: "Transfer", page: "2" })), null);
});

test("eth_getLogs: filters Transfer (ERC-20) topics via the index · same result as scanning every block · skips blocks via logsBloom", () => {
  const { vm, rpc } = chain();
  const ask = (filter) => rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }).result;
  const TRANSFER = VM.keccak256Hex("Transfer(address,address,uint256)");
  const toBob = ask({ fromBlock: "0x1", toBlock: "latest", topics: [TRANSFER, null, VM.topicOf(BOB)] });
  assert.deepEqual(toBob.map((log) => [log.blockNumber, BigInt(log.data)]), [["0x2", 5n], ["0x3", 7n]]);
  // without the index (topic0 only), filtering manually → same result
  const all = ask({ fromBlock: "0x1", toBlock: "latest", topics: [TRANSFER] });
  assert.deepEqual(all.filter((log) => log.topics[2] === VM.topicOf(BOB)), toBob);
  // multiple topic values (OR) + address
  const either = ask({ fromBlock: "0x1", address: TOKEN, topics: [TRANSFER, [VM.topicOf(BOB), VM.topicOf(CAROL)]] });
  assert.deepEqual(either.map((log) => log.topics[1]), [VM.topicOf(BOB)]);
  // indexed events of a generic program: topic0 = keccak("Order(uint256,address,bool,string)") · data = the remaining fields, ABI encoded
  const ORDER = VM.keccak256Hex("Order(uint256,address,bool,string)");
  const [order] = ask({ fromBlock: "0x1", topics: [ORDER, VM.topicOf("42n")] });
  assert.deepEqual(order.topics, [ORDER, VM.topicOf("42n"), VM.topicOf(BOB), VM.topicOf(true)]);
  assert.equal(Buffer.from(order.data.slice(2 + 128, 2 + 130), "hex").toString(), "x");
  // eventsig: topic0 → (program, name, indexed fields)
  assert.deepEqual(vm.listEventSignatures(ORDER), [{ program: P, name: "Order", indexed: ["id", "buyer", "paid"] }]);
  // block 1's bloom (no Transfer to BOB) → skipped
  assert.equal(VM.bloomContains(vm.getBlock(4).logsBloom, VM.topicOf(CAROL)), false);
  assert.equal(ask({ fromBlock: "0x4", toBlock: "0x4", topics: [TRANSFER] }).length, 0);
});

test("standard token: Transfer indexes from / to · Approval indexes owner / spender · exact ERC-20 logs", () => {
  const { vm } = chain();
  const [event] = vm.listEvents({ program: TOKEN, name: "Transfer", limit: 1 });
  assert.deepEqual(event.indexed, ["from", "to"]);
  const log = VM.eventLog(event);
  assert.deepEqual(log.topics, [VM.keccak256Hex("Transfer(address,address,uint256)"), VM.topicOf(OWNER), VM.topicOf(BOB)]);
  assert.equal(BigInt(log.data), 7n);
  // replay gives the same index (rebuild); the index is in blockundo, so it is removed / recreated per block
  const before = vm.listKeys("eventidx:");
  vm.rebuildFrom(vm.latestBlockNumber());
  assert.deepEqual(vm.listKeys("eventidx:"), before);
});
