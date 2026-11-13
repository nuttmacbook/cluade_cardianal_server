import { test } from "node:test";
import assert from "node:assert/strict";
import { VM, MemoryDB } from "./helpers.js";

/*
 * Complex scenario: a marketplace that sells items for another program's token
 *   TOKEN   token with approve / transferFrom so other programs can debit on a user's behalf
 *   MARKET  lists items, buys with the token, takes a fee into the treasury, native deposit/withdraw as collateral
 * 5 users doing many interleaved actions, both successful and failing
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
    if (balance < amount) throw new Error("insufficient balance")
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
    if (allowed < params.input.amount) throw new Error("insufficient allowance")
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
      if (params.context.sender !== readDB(map("items", params.input.id, "seller"))) throw new Error("not the listing owner")
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
    if (!price) throw new Error("listing not found")
    if (readDB(map("items", id, "sold"))) throw new Error("already sold")

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
    if (params.value <= 0n) throw new Error("value must be attached")
    writeDB(map("deposits", params.context.sender), (readDB(map("deposits", params.context.sender)) || 0n) + params.value)
    emit("Deposited", { who: params.context.sender, amount: params.value })
    return readDB(map("deposits", params.context.sender))
  }

  function withdraw(params) {
    const balance = readDB(map("deposits", params.context.sender)) || 0n
    if (balance <= 0n) throw new Error("no deposit")
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
    requireNonce: false, chargeGas: true, recordBlocks: true, recordHistory: true,
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

test("market: list → approve allowance → cross-program buy → funds reach the seller and treasury", () => {
  const { call, read } = setup();
  const id = value(call("market", "list", { price: 10_000, name: "first item" }, "bob"));
  assert.equal(id, "1n");

  assert.match(call("market", "buy", { id }, "carol").error.message, /insufficient allowance/);   // not approved yet

  value(call("coin", "approve", { spender: "market", amount: 10_000 }, "carol"));
  const sale = value(call("market", "buy", { id }, "carol"));
  assert.deepEqual(sale, { id: "1n", paid: "10000n", fee: "250n" });

  assert.equal(read("coin", "balanceOf", { who: "bob" }), "59750n");      // 50,000 + 9,750
  assert.equal(read("coin", "balanceOf", { who: "carol" }), "40000n");
  assert.equal(read("coin", "balanceOf", { who: "treasury" }), "250n");   // 2.5% fee
  assert.equal(read("coin", "allowanceOf", { owner: "carol", spender: "market" }), "0n");
});

test("market: repeat buy / missing listing / cancel by someone else are rejected and change nothing", () => {
  const { vm, call, read } = setup();
  const id = value(call("market", "list", { price: 1_000, name: "item" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 5_000 }, "carol"));
  value(call("market", "buy", { id }, "carol"));

  assert.match(call("market", "buy", { id }, "dave").error.message, /already sold/);
  assert.match(call("market", "buy", { id: "99n" }, "dave").error.message, /listing not found/);
  assert.match(call("market", "cancel", { id }, "dave").error.message, /not the listing owner/);

  assert.equal(vm.read("market:storage:items:1:buyer"), "carol");
  assert.equal(read("market", "stats", {}).volume, "1000n");
});

test("market: real native deposit and withdraw through the program", () => {
  const { vm, call, read } = setup();
  assert.match(call("market", "deposit", {}, "dave", 0).error.message, /value must be attached/);

  value(call("market", "deposit", {}, "dave", 3_000));
  value(call("market", "deposit", {}, "bob", 2_000));
  assert.equal(vm.nativeBalanceOf("market").balance, 5_000n);
  assert.equal(read("market", "stats", {}).balance, "5000n");

  assert.equal(value(call("market", "withdraw", {}, "dave")), "3000n");
  assert.equal(vm.nativeBalanceOf("market").balance, 2_000n);
  assert.match(call("market", "withdraw", {}, "carol").error.message, /no deposit/);
});

test("many users, many actions: totals on every side match", () => {
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

  // all tokens in the system must always equal supply
  const holders = ["alice", "bob", "carol", "dave", "treasury"];
  const total = holders.reduce((sum, who) => sum + BigInt(read("coin", "balanceOf", { who }).slice(0, -1)), 0n);
  assert.equal(total, 1_000_000n);
  assert.equal(vm.listProgramStorage("market").length > 20, true, "market must have many keys");
});

test("events from every nested call level, and a 2-level-deep trace", () => {
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

test("failure midway: a failed nested call reverts the whole tx", () => {
  const { vm, call, read } = setup();
  const id = value(call("market", "list", { price: 90_000, name: "pricey" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 90_000 }, "carol"));   // enough allowance, but not enough tokens

  const failed = call("market", "buy", { id }, "carol");
  assert.equal(failed.status, "throw");
  assert.match(failed.error.message, /insufficient balance/);
  assert.deepEqual(failed.events, []);

  assert.equal(vm.read("market:storage:items:1:sold"), "0n");          // not marked as sold
  assert.equal(vm.read("market:storage:volume"), undefined);
  assert.equal(read("coin", "balanceOf", { who: "carol" }), "50000n");
  assert.equal(read("coin", "allowanceOf", { owner: "carol", spender: "market" }), "90000n"); // allowance not deducted
});

test("market data can be read as of an old block", () => {
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

test("gas and funds in the system: no native coin goes missing", () => {
  const { vm, call, read } = setup();
  const id = value(call("market", "list", { price: 1_000, name: "z" }, "bob"));
  value(call("coin", "approve", { spender: "market", amount: 1_000 }, "carol"));
  value(call("market", "buy", { id }, "carol"));
  value(call("market", "deposit", {}, "dave", 7_000));

  const accounts = [...PEOPLE, "coin", "market", "miner", VM.BURN_ADDRESS];
  const total = accounts.reduce((sum, who) => sum + vm.nativeBalanceOf(who).balance, 0n);
  assert.equal(total, BigInt(PEOPLE.length * 10_000_000));
  assert.equal(vm.nativeBalanceOf("market").balance, 7_000n);
  assert.ok(vm.nativeBalanceOf("miner").balance > 0);
});
