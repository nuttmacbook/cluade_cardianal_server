import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB, API_GAS_ONLY } from "./helpers.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { cursorIndexedEvents, indexedFilterOf } from "../src/node/explorer-api.js";
import { createEvmRpc } from "../src/node/evm-rpc.js";

/*
 * emit(name, data, { indexed: ["from", "to"] }) → ดัชนี eventidx:<program>:<name>:<field>:<topic>:<block>:<tx>:<event>
 *   ค้น event ด้วยค่าของ field ได้โดยไม่ไล่ทุก event (GET /program/:a/events?name=Transfer&to=0x… · eth_getLogs ตาม topic)
 *   ค่าแก๊ส: + gas.topic ต่อ field ที่ indexed · token มาตรฐาน index from / to ของ Transfer
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

test("emit indexed: ตรวจ options (ไม่เกิน 3 / ต้องมีใน data / ห้ามซ้ำ / ต้องเป็น array) · event เก็บรายชื่อ indexed", () => {
  const { vm } = chain();
  const run = (options) => vm.call({ programUuid: P, functionName: "wrong", input: { options }, context: as(OWNER) }, { timestamp: T });
  assert.equal(run({ indexed: ["who"] }).status, "success");
  assert.deepEqual(run({ indexed: ["who"] }).events[0].indexed, ["who"]);
  assert.equal(run(undefined).events[0].indexed, undefined);   // ไม่ส่ง = event หน้าตาเหมือนเดิม
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

test("emit indexed: ค่าแก๊สเพิ่ม gas.topic ต่อ field", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { gas: API_GAS_ONLY });
  vm.commit(vm.deploy({ programUuid: P, code: EMITTER, context: as(OWNER) }).writes);
  vm.commit(vm.init({ programUuid: P }).writes);
  const plain = vm.call({ programUuid: P, functionName: "plain", input: { who: "alice" }, context: as(OWNER) }, { timestamp: T });
  const tagged = vm.call({ programUuid: P, functionName: "tagged", input: { who: "alice" }, context: as(OWNER) }, { timestamp: T });
  assert.equal(tagged.gasUsed - plain.gasUsed, vm.gas.topic);
  assert.equal(vm.gas.topic, 375);
});

test("ดัชนี: ค้น Transfer ของ token ด้วย to / from ได้ (ใหม่ไปเก่า) · ค่าที่ไม่มี = ว่าง · field ที่ไม่ได้ indexed = ว่าง", () => {
  const { vm } = chain();
  const toBob = vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "to", value: BOB });
  assert.deepEqual(toBob.items.map((e) => [e.blockNumber, e.data.amount]), [[3, "7n"], [2, "5n"]]);
  const fromBob = vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "from", value: BOB.toUpperCase().replace("0X", "0x") });
  assert.deepEqual(fromBob.items.map((e) => e.data.to), [CAROL]);
  assert.equal(vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "to", value: "0x00000000000000000000000000000000000000dd" }).items.length, 0);
  assert.equal(vm.listIndexedEvents({ program: TOKEN, name: "Transfer", field: "amount", value: "5" }).items.length, 0);
  // ตัวเลข / bool / string
  assert.equal(vm.listIndexedEvents({ program: P, name: "Order", field: "id", value: "42" }).items.length, 1);
  assert.equal(vm.listIndexedEvents({ program: P, name: "Order", field: "paid", value: "true" }).items.length, 1);
  assert.equal(vm.listIndexedEvents({ program: P, name: "Ping", field: "who", value: "alice" }).items[0].data.who, "alice");
  // key ของดัชนี: eventidx:<program>:<name>:<field>:<topic>:<block>:<tx>:<event> → ค่า = dbKey ของ event
  const [key] = vm.listKeys(VM.eventIndexPrefix(TOKEN, "Transfer", "to", VM.topicOf(CAROL)));
  assert.equal(VM.decodeDbKey(key).kind, "eventidx");
  assert.equal(vm.read(key), VM.eventKey(TOKEN, "Transfer", 2, 1, 0));
});

test("ดัชนี: แบ่งหน้าด้วย cursor + กรองหลาย field (REST) · ต้องระบุ name", () => {
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

test("eth_getLogs: กรอง topic ของ Transfer (ERC-20) ด้วยดัชนี · ได้ผลเท่ากับไล่ทุก block · ข้าม block ด้วย logsBloom", () => {
  const { vm, rpc } = chain();
  const ask = (filter) => rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [filter] }).result;
  const TRANSFER = VM.keccak256Hex("Transfer(address,address,uint256)");
  const toBob = ask({ fromBlock: "0x1", toBlock: "latest", topics: [TRANSFER, null, VM.topicOf(BOB)] });
  assert.deepEqual(toBob.map((log) => [log.blockNumber, BigInt(log.data)]), [["0x2", 5n], ["0x3", 7n]]);
  // ไม่ใช้ดัชนี (มีแค่ topic0) แล้วกรองเอง → ผลตรงกัน
  const all = ask({ fromBlock: "0x1", toBlock: "latest", topics: [TRANSFER] });
  assert.deepEqual(all.filter((log) => log.topics[2] === VM.topicOf(BOB)), toBob);
  // topic หลายค่า (OR) + address
  const either = ask({ fromBlock: "0x1", address: TOKEN, topics: [TRANSFER, [VM.topicOf(BOB), VM.topicOf(CAROL)]] });
  assert.deepEqual(either.map((log) => log.topics[1]), [VM.topicOf(BOB)]);
  // event ของโปรแกรมทั่วไปที่ indexed: topic0 = keccak("Order(uint256,address,bool,string)") · data = field ที่เหลือแบบ ABI
  const ORDER = VM.keccak256Hex("Order(uint256,address,bool,string)");
  const [order] = ask({ fromBlock: "0x1", topics: [ORDER, VM.topicOf("42n")] });
  assert.deepEqual(order.topics, [ORDER, VM.topicOf("42n"), VM.topicOf(BOB), VM.topicOf(true)]);
  assert.equal(Buffer.from(order.data.slice(2 + 128, 2 + 130), "hex").toString(), "x");
  // eventsig: topic0 → (โปรแกรม, ชื่อ, field ที่ indexed)
  assert.deepEqual(vm.listEventSignatures(ORDER), [{ program: P, name: "Order", indexed: ["id", "buyer", "paid"] }]);
  // bloom ของ block 1 (ไม่มี Transfer ไป BOB) → ไม่ต้องดู
  assert.equal(VM.bloomContains(vm.getBlock(4).logsBloom, VM.topicOf(CAROL)), false);
  assert.equal(ask({ fromBlock: "0x4", toBlock: "0x4", topics: [TRANSFER] }).length, 0);
});

test("token มาตรฐาน: Transfer index from / to · Approval index owner / spender · log แบบ ERC-20 ตรงตัว", () => {
  const { vm } = chain();
  const [event] = vm.listEvents({ program: TOKEN, name: "Transfer", limit: 1 });
  assert.deepEqual(event.indexed, ["from", "to"]);
  const log = VM.eventLog(event);
  assert.deepEqual(log.topics, [VM.keccak256Hex("Transfer(address,address,uint256)"), VM.topicOf(OWNER), VM.topicOf(BOB)]);
  assert.equal(BigInt(log.data), 7n);
  // replay ได้ดัชนีชุดเดิม (rebuild) — ดัชนีอยู่ใน blockundo จึงถูกลบ / สร้างใหม่ตาม block
  const before = vm.listKeys("eventidx:");
  vm.rebuildFrom(vm.latestBlockNumber());
  assert.deepEqual(vm.listKeys("eventidx:"), before);
});
