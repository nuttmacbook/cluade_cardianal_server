import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";

/*
 * สถานการณ์ซับซ้อน: ตลาดกลางที่ขายของด้วยเหรียญของโปรแกรมอื่น
 *   TOKEN   เหรียญ มี approve / transferFrom ให้โปรแกรมอื่นหักเงินแทนได้
 *   MARKET  ประกาศขาย ซื้อด้วย token หักค่าธรรมเนียมเข้าคลัง ฝาก/ถอน native เป็นมัดจำ
 * ผู้ใช้ 5 คน ทำหลายอย่างสลับกัน ทั้งสำเร็จและล้ม
 */

const T = Date.parse("2025-03-01T09:00:00Z");
const user = (name) => ({ sender: name, origin: name });
const PEOPLE = ["alice", "bob", "carol", "dave", "treasury"];

const TOKEN = `
function program() {
  function initialization(params) {
    writeDB("owner", params.context.sender)
    writeDB("supply", params.input.supply)
    writeDB(map("balances", params.context.sender), params.input.supply)
    setMetadata("namespace", "coin")
    emit("Minted", { to: params.context.sender, amount: params.input.supply })
  }

  function balanceOf(params) { return readDB(map("balances", params.input.who)) || 0n }
  function allowanceOf(params) { return readDB(map("allow", params.input.owner, params.input.spender)) || 0n }

  function move(from, to, amount) {
    const balance = readDB(map("balances", from)) || 0n
    if (balance < amount) throw new Error("ยอดไม่พอ")
    writeDB(map("balances", from), balance - amount)
    writeDB(map("balances", to), (readDB(map("balances", to)) || 0n) + amount)
    emit("Transfer", { from: from, to: to, amount: amount })
  }

  function transfer(params) { move(params.context.sender, params.input.to, params.input.amount); return true }

  function approve(params) {
    writeDB(map("allow", params.context.sender, params.input.spender), params.input.amount)
    emit("Approval", { owner: params.context.sender, spender: params.input.spender, amount: params.input.amount })
    return true
  }

  function transferFrom(params) {
    const spender = params.context.sender
    const allowed = readDB(map("allow", params.input.from, spender)) || 0n
    if (allowed < params.input.amount) throw new Error("วงเงินไม่พอ")
    writeDB(map("allow", params.input.from, spender), allowed - params.input.amount)
    move(params.input.from, params.input.to, params.input.amount)
    return true
  }

  return { balanceOf, allowanceOf, transfer, approve, transferFrom }
}`;

const MARKET = `
function program() {
  function initialization(params) {
    writeDB("token", params.input.token)
    writeDB("treasury", params.input.treasury)
    writeDB("feeBps", params.input.feeBps)
    writeDB("nextId", 1n)
    setMetadata("namespace", "market")
  }

  function onlyOwner(fn) {
    return function (params) {
      if (params.context.sender !== readDB(map("items", params.input.id, "seller"))) throw new Error("ไม่ใช่เจ้าของประกาศ")
      return fn(params)
    }
  }

  function list(params) {
    const id = readDB("nextId")
    writeDB("nextId", id + 1n)
    writeDB(map("items", id, "seller"), params.context.sender)
    writeDB(map("items", id, "price"), params.input.price)
    writeDB(map("items", id, "name"), params.input.name)
    writeDB(map("items", id, "sold"), 0n)
    writeDB(map("bySeller", params.context.sender, id), 1n)
    emit("Listed", { id: id, seller: params.context.sender, price: params.input.price })
    return id
  }

  const cancel = onlyOwner(function (params) {
    deleteDB(map("items", params.input.id, "price"))
    emit("Cancelled", { id: params.input.id })
    return true
  })

  function buy(params) {
    const id = params.input.id
    const price = readDB(map("items", id, "price"))
    if (!price) throw new Error("ไม่พบประกาศนี้")
    if (readDB(map("items", id, "sold"))) throw new Error("ขายไปแล้ว")

    const seller = readDB(map("items", id, "seller"))
    const fee = (price * readDB("feeBps")) / 10000n
    const token = readDB("token")

    runProgram(token, "transferFrom", { from: params.context.sender, to: seller, amount: price - fee })
    runProgram(token, "transferFrom", { from: params.context.sender, to: readDB("treasury"), amount: fee })

    writeDB(map("items", id, "sold"), 1n)
    writeDB(map("items", id, "buyer"), params.context.sender)
    writeDB(map("sales", params.context.sender, id), price)
    writeDB("volume", (readDB("volume") || 0n) + price)
    writeDB("fees", (readDB("fees") || 0n) + fee)
    emit("Sold", { id: id, buyer: params.context.sender, seller: seller, price: price, fee: fee })
    return { id: id, paid: price, fee: fee }
  }

  function deposit(params) {
    if (params.value <= 0n) throw new Error("ต้องแนบเงินมาด้วย")
    writeDB(map("deposits", params.context.sender), (readDB(map("deposits", params.context.sender)) || 0n) + params.value)
    emit("Deposited", { who: params.context.sender, amount: params.value })
    return readDB(map("deposits", params.context.sender))
  }

  function withdraw(params) {
    const balance = readDB(map("deposits", params.context.sender)) || 0n
    if (balance <= 0n) throw new Error("ไม่มีเงินฝาก")
    writeDB(map("deposits", params.context.sender), 0n)
    transferNative(params.context.sender, balance)
    emit("Withdrawn", { who: params.context.sender, amount: balance })
    return balance
  }

  function stats() { return { volume: readDB("volume") || 0n, fees: readDB("fees") || 0n, listings: readDB("nextId") - 1n, balance: ThisBalance() } }
  function item(params) { return { seller: readDB(map("items", params.input.id, "seller")), price: readDB(map("items", params.input.id, "price")), sold: readDB(map("items", params.input.id, "sold")) } }

  return { list, cancel, buy, deposit, withdraw, stats, item }
}`;

function setup() {
  const vm = new VM.VirtualMachine(new MemoryDB(), {
    bigintValues: true, requireNonce: false, chargeGas: true, recordBlocks: true, recordHistory: true,
    recordTransactions: true, feeRecipient: "miner", burnPercent: 50,
  });
  vm.db.load(Object.fromEntries(PEOPLE.map((p) => [`${p}:native:received`, 10_000_000])));

  let time = T;
  const run = (method, request) => {
    time += 1000;
    const block = vm.createBlock({ timestamp: time, feeRecipient: "miner" });
    const result = block[method](request);
    if (result.status === "success") block.commit();
    return result;
  };
  const call = (programUuid, functionName, input, as, value = 0) =>
    run("call", { programUuid, functionName, input, context: user(as), value });

  run("deploy", { programUuid: "coin", code: TOKEN, context: user("alice"), initInput: { supply: 1_000_000 } });
  run("init", { programUuid: "coin" });
  run("deploy", { programUuid: "market", code: MARKET, context: user("alice"),
    initInput: { token: "coin", treasury: "treasury", feeBps: 250 } });
  run("init", { programUuid: "market" });

  for (const who of ["bob", "carol", "dave"]) call("coin", "transfer", { to: who, amount: 50_000 }, "alice");
  const read = (programUuid, functionName, input = {}) => {
    const result = vm.query({ programUuid, functionName, input });
    assert.equal(result.status, "success", JSON.stringify(result.error));
    return result.result;
  };
  return { vm, run, call, read };
}

const value = (result) => { assert.equal(result.status, "success", JSON.stringify(result.error)); return result.result; };

// ---------------------------------------------------------------------------

test("ตลาด: ประกาศขาย → อนุมัติวงเงิน → ซื้อข้ามโปรแกรม → เงินถึงผู้ขายและคลัง", () => {
  const { call, read } = setup();
  const id = value(call("market", "list", { price: 10_000, name: "ของชิ้นแรก" }, "bob"));
  assert.equal(id, "1n");

  assert.match(call("market", "buy", { id }, "carol").error.message, /วงเงินไม่พอ/);   // ยังไม่ approve

  value(call("coin", "approve", { spender: "market", amount: 10_000 }, "carol"));
  const sale = value(call("market", "buy", { id }, "carol"));
  assert.deepEqual(sale, { id: "1n", paid: "10000n", fee: "250n" });

  assert.equal(read("coin", "balanceOf", { who: "bob" }), "59750n");      // 50,000 + 9,750
  assert.equal(read("coin", "balanceOf", { who: "carol" }), "40000n");
  assert.equal(read("coin", "balanceOf", { who: "treasury" }), "250n");   // ค่าธรรมเนียม 2.5%
  assert.equal(read("coin", "allowanceOf", { owner: "carol", spender: "market" }), "0n");
});

test("ตลาด: ซื้อซ้ำ / ไม่มีประกาศ / ยกเลิกโดยคนอื่น ถูกปฏิเสธและไม่เปลี่ยนข้อมูล", () => {
  const { vm, call, read } = setup();
  const id = value(call("market", "list", { price: 1_000, name: "ของ" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 5_000 }, "carol"));
  value(call("market", "buy", { id }, "carol"));

  assert.match(call("market", "buy", { id }, "dave").error.message, /ขายไปแล้ว/);
  assert.match(call("market", "buy", { id: "99n" }, "dave").error.message, /ไม่พบประกาศ/);
  assert.match(call("market", "cancel", { id }, "dave").error.message, /ไม่ใช่เจ้าของประกาศ/);

  assert.equal(vm.read("market:storage:items:1:buyer"), "carol");
  assert.equal(read("market", "stats", {}).volume, "1000n");
});

test("ตลาด: ฝาก-ถอน native ของจริงผ่านโปรแกรม", () => {
  const { vm, call, read } = setup();
  assert.match(call("market", "deposit", {}, "dave", 0).error.message, /ต้องแนบเงิน/);

  value(call("market", "deposit", {}, "dave", 3_000));
  value(call("market", "deposit", {}, "bob", 2_000));
  assert.equal(vm.nativeBalanceOf("market").balance, 5_000);
  assert.equal(read("market", "stats", {}).balance, "5000n");

  assert.equal(value(call("market", "withdraw", {}, "dave")), "3000n");
  assert.equal(vm.nativeBalanceOf("market").balance, 2_000);
  assert.match(call("market", "withdraw", {}, "carol").error.message, /ไม่มีเงินฝาก/);
});

test("ผู้ใช้หลายคน หลายรายการ: ยอดรวมทุกฝั่งตรงกัน", () => {
  const { vm, call, read } = setup();
  const ids = [
    value(call("market", "list", { price: 2_000, name: "a" }, "bob")),
    value(call("market", "list", { price: 3_000, name: "b" }, "bob")),
    value(call("market", "list", { price: 5_000, name: "c" }, "dave")),
  ];
  for (const who of ["carol", "dave", "carol"]) value(call("coin", "approve", { spender: "market", amount: 20_000 }, who));

  value(call("market", "buy", { id: ids[0] }, "carol"));
  value(call("market", "buy", { id: ids[1] }, "dave"));
  value(call("market", "buy", { id: ids[2] }, "carol"));

  const stats = read("market", "stats", {});
  assert.deepEqual({ volume: stats.volume, fees: stats.fees, listings: stats.listings }, { volume: "10000n", fees: "250n", listings: "3n" });

  // เหรียญทั้งหมดในระบบต้องเท่ากับ supply เสมอ
  const holders = ["alice", "bob", "carol", "dave", "treasury"];
  const total = holders.reduce((sum, who) => sum + BigInt(read("coin", "balanceOf", { who }).slice(0, -1)), 0n);
  assert.equal(total, 1_000_000n);
  assert.equal(vm.listProgramStorage("market").length > 20, true, "ตลาดต้องมี key หลายรายการ");
});

test("event ครบทุกชั้นของการเรียกซ้อน และ trace ลึก 2 ชั้น", () => {
  const { call, read } = setup();
  const id = value(call("market", "list", { price: 4_000, name: "x" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 4_000 }, "carol"));
  const sale = call("market", "buy", { id }, "carol");

  assert.deepEqual(sale.events.map((e) => `${e.depth}:${e.program}.${e.name}`), [
    "1:coin.Transfer", "1:coin.Transfer", "0:market.Sold",
  ]);
  assert.deepEqual(sale.calls.map((c) => `${c.depth} ${c.programUuid}.${c.functionName}`), [
    "0 market.buy", "1 coin.transferFrom", "1 coin.transferFrom",
  ]);
  assert.equal(sale.events[2].data.fee, "100n");
});

test("ล้มกลางทาง: การเรียกซ้อนที่ล้มทำให้ทั้ง tx ถูกย้อนทั้งหมด", () => {
  const { vm, call, read } = setup();
  const id = value(call("market", "list", { price: 90_000, name: "แพง" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 90_000 }, "carol"));   // อนุมัติพอ แต่เหรียญไม่พอ

  const failed = call("market", "buy", { id }, "carol");
  assert.equal(failed.status, "throw");
  assert.match(failed.error.message, /ยอดไม่พอ/);
  assert.deepEqual(failed.events, []);

  assert.equal(vm.read("market:storage:items:1:sold"), "0n");          // ไม่ถูกทำเครื่องหมายว่าขายแล้ว
  assert.equal(vm.read("market:storage:volume"), undefined);
  assert.equal(read("coin", "balanceOf", { who: "carol" }), "50000n");
  assert.equal(read("coin", "allowanceOf", { owner: "carol", spender: "market" }), "90000n"); // วงเงินไม่ถูกหัก
});

test("ย้อนดูข้อมูลของตลาด ณ block เก่าได้", () => {
  const { vm, call, read } = setup();
  const before = vm.latestBlockNumber();
  const id = value(call("market", "list", { price: 1_500, name: "y" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 1_500 }, "carol"));
  value(call("market", "buy", { id }, "carol"));

  assert.equal(vm.stateAt(before, "coin:storage:balances:carol"), "50000n");
  assert.equal(vm.read("coin:storage:balances:carol"), "48500n");
  assert.deepEqual(Object.keys(vm.snapshotAt(before, "market:storage:items:")), []);

  const receipt = vm.replayBlock(vm.latestBlockNumber());
  assert.equal(receipt.transactions[0].events.length, 3);
});

test("ค่าแก๊สและเงินในระบบ: ไม่มีเหรียญหลักหายไปไหน", () => {
  const { vm, call, read } = setup();
  const id = value(call("market", "list", { price: 1_000, name: "z" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 1_000 }, "carol"));
  value(call("market", "buy", { id }, "carol"));
  value(call("market", "deposit", {}, "dave", 7_000));

  const accounts = [...PEOPLE, "coin", "market", "miner", VM.BURN_ADDRESS];
  const total = accounts.reduce((sum, who) => sum + vm.nativeBalanceOf(who).balance, 0);
  assert.equal(total, PEOPLE.length * 10_000_000);
  assert.equal(vm.nativeBalanceOf("market").balance, 7_000);
  assert.ok(vm.nativeBalanceOf("miner").balance > 0);
});
