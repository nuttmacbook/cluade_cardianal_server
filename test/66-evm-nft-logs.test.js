import { test } from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { VM, MemoryDB } from "./helpers.js";
import { NFT_PROGRAM } from "../src/standards/nft.js";
import { MULTITOKEN_PROGRAM } from "../src/standards/multitoken.js";
import { TOKEN_PROGRAM } from "../src/standards/token.js";
import { createEvmRpc, EVM_ERROR } from "../src/node/evm-rpc.js";

/* /evm: event ของ NFT มาตรฐาน → log ERC-721 · ของ multi-token มาตรฐาน → log ERC-1155 · eth_call อ่านแบบ ERC-721 / ERC-1155 (ถอดด้วย ethers) */

const N = "0x00000000000000000000000000000000000000f2";
const G = "0x00000000000000000000000000000000000000f3";
const T = "0x00000000000000000000000000000000000000f1";
const OWNER = "0x00000000000000000000000000000000000000a1";
const BOB = "0x00000000000000000000000000000000000000b2";
const CAROL = "0x00000000000000000000000000000000000000c3";
const ZERO = `0x${"0".repeat(40)}`;

const ERC721 = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "function name() view returns (string)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)", "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)", "function getApproved(uint256 tokenId) view returns (address)",
  "function isApprovedForAll(address owner, address operator) view returns (bool)", "function supportsInterface(bytes4 id) view returns (bool)",
]);
const ERC1155 = new Interface([
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event ApprovalForAll(address indexed account, address indexed operator, bool approved)",
  "event URI(string value, uint256 indexed id)",
  "function balanceOf(address account, uint256 id) view returns (uint256)", "function uri(uint256 id) view returns (string)",
  "function totalSupply(uint256 id) view returns (uint256)", "function name() view returns (string)",
  "function isApprovedForAll(address account, address operator) view returns (bool)", "function supportsInterface(bytes4 id) view returns (bool)",
]);

function chain() {
  const vm = new VM.VirtualMachine(new MemoryDB(), { chainId: 7777, recordBlocks: true, recordTransactions: true, recordHistory: true });
  let number = 0;
  const as = (who) => ({ sender: who, origin: who });
  const block = (...requests) => {
    number += 1;
    const b = vm.createBlock({ number, timestamp: 1_700_000_000_000 + number * 1000, feeRecipient: OWNER });
    const results = requests.map(([method, request]) => b[method](request));
    b.commit();
    results.forEach((r) => assert.equal(r.status, "success", JSON.stringify(r.error)));
    return results;
  };
  const call = (who, programUuid, functionName, input) => ["call", { programUuid, functionName, input, context: as(who) }];
  block(
    ["deploy", { programUuid: N, code: NFT_PROGRAM, context: as(OWNER), initInput: { name: "Siam Art", symbol: "SART", baseURI: "ipfs://art/" } }],
    ["init", { programUuid: N }],
    ["deploy", { programUuid: G, code: MULTITOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Items", symbol: "ITM", uri: "https://g.test/{id}" } }],
    ["init", { programUuid: G }],
    ["deploy", { programUuid: T, code: TOKEN_PROGRAM, context: as(OWNER), initInput: { name: "Coin", ticker: "C", decimals: "0n", supply: "10n" } }],
    ["init", { programUuid: T }],
  );
  block(call(OWNER, N, "mint", { to: BOB }), call(OWNER, N, "mint", { to: BOB, uri: "ipfs://two" }));             // block 2
  block(call(BOB, N, "approve", { to: CAROL, tokenId: "1n" }), call(CAROL, N, "transferFrom", { from: BOB, to: CAROL, tokenId: "1n" }),
    call(BOB, N, "setApprovalForAll", { operator: OWNER, approved: true }));                                       // block 3
  block(call(OWNER, G, "mint", { to: BOB, id: "7n", amount: "50n" }),
    call(OWNER, G, "mintBatch", { to: BOB, ids: ["1n", "2n", "3n"], amounts: ["10n", "20n", "30n"] }),
    call(BOB, G, "safeTransferFrom", { from: BOB, to: CAROL, id: "7n", amount: "5n" }),
    call(BOB, G, "setApprovalForAll", { operator: CAROL, approved: true }),
    call(OWNER, G, "setURI", { id: "7n", uri: "ipfs://seven" }),
    call(OWNER, T, "transfer", { to: BOB, amount: "3n" }));                                                       // block 4
  return { vm, rpc: createEvmRpc({ vm }) };
}
const ask = (rpc, method, ...params) => {
  const reply = rpc.handle({ jsonrpc: "2.0", id: 1, method, params });
  assert.equal(reply.error, undefined, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const logsOf = (rpc, vm, number) => vm.getBlock(number).txHashes.flatMap((hash) => ask(rpc, "eth_getTransactionReceipt", hash).logs);
const lower = (value) => String(value).toLowerCase();

test("evm: mint / transferFrom ของ NFT → log Transfer แบบ ERC-721 (4 topic, tokenId indexed, data ว่าง) · ethers ถอดได้", () => {
  const { vm, rpc } = chain();
  const [mint1, mint2] = logsOf(rpc, vm, 2);
  assert.equal(mint1.address, N);
  assert.equal(mint1.topics.length, 4);
  assert.equal(mint1.data, "0x");
  assert.equal(mint1.topics[0], "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
  const parsed = ERC721.parseLog(mint2);
  assert.deepEqual([parsed.name, lower(parsed.args.from), lower(parsed.args.to), parsed.args.tokenId], ["Transfer", ZERO, BOB, 2n]);
  const [approval, transfer, all] = logsOf(rpc, vm, 3).map((log) => ERC721.parseLog(log));
  assert.deepEqual([approval.name, lower(approval.args.owner), lower(approval.args.approved), approval.args.tokenId], ["Approval", BOB, CAROL, 1n]);
  assert.deepEqual([transfer.name, lower(transfer.args.from), lower(transfer.args.to), transfer.args.tokenId], ["Transfer", BOB, CAROL, 1n]);
  assert.deepEqual([all.name, lower(all.args.owner), lower(all.args.operator), all.args.approved], ["ApprovalForAll", BOB, OWNER, true]);
});

test("evm: TransferSingle / TransferBatch / ApprovalForAll / URI ของ multi-token → log แบบ ERC-1155 · Transfer ของ ERC-20 ยังเป็น 3 topic", () => {
  const { vm, rpc } = chain();
  const logs = logsOf(rpc, vm, 4);
  const [single, batch, moved, all, uri] = logs.slice(0, 5).map((log) => ERC1155.parseLog(log));
  assert.deepEqual([single.name, lower(single.args.operator), lower(single.args.from), lower(single.args.to), single.args.id, single.args.value],
    ["TransferSingle", OWNER, ZERO, BOB, 7n, 50n]);
  assert.deepEqual([batch.name, lower(batch.args.to), [...batch.args.ids], [...batch.args[4]]], ["TransferBatch", BOB, [1n, 2n, 3n], [10n, 20n, 30n]]);
  assert.deepEqual([moved.name, lower(moved.args.operator), lower(moved.args.from), lower(moved.args.to), moved.args.value], ["TransferSingle", BOB, BOB, CAROL, 5n]);
  assert.deepEqual([all.name, lower(all.args.account), lower(all.args.operator), all.args.approved], ["ApprovalForAll", BOB, CAROL, true]);
  assert.deepEqual([uri.name, uri.args.value, uri.args.id], ["URI", "ipfs://seven", 7n]);
  const erc20 = logs.at(-1);
  assert.deepEqual([erc20.address, erc20.topics.length, BigInt(erc20.data)], [T, 3, 3n]);
  // eth_getLogs กรองด้วย topic ของ ERC-1155 ได้
  const filtered = ask(rpc, "eth_getLogs", { fromBlock: "0x1", toBlock: "latest", topics: [ERC1155.getEvent("TransferSingle").topicHash] });
  assert.deepEqual(filtered.map((log) => log.address), [G, G]);
  const nftTransfers = ask(rpc, "eth_getLogs", { fromBlock: "0x1", address: N, topics: [ERC721.getEvent("Transfer").topicHash, null, null, `0x${"0".repeat(63)}1`] });
  assert.equal(nftTransfers.length, 2);   // mint #1 + โอน #1
});

test("evm: event ชื่อเดียวกันจากโปรแกรมที่ไม่ใช่มาตรฐาน → topic0 = keccak(ชื่อ) + JSON เหมือนเดิม", () => {
  const vm = new VM.VirtualMachine(new MemoryDB(), { recordBlocks: true, recordTransactions: true, recordHistory: true });
  const fake = `function program() {
  function poke(params) {
    emit("TransferSingle", { operator: params.context.sender, from: params.context.sender, to: params.context.sender, id: 1n, amount: 1n })
    emit("Transfer", { from: params.context.sender, to: params.context.sender, tokenId: 1n })
  }
  return { poke }
}`;
  const P = "0x00000000000000000000000000000000000000ee";
  const b = vm.createBlock({ number: 1, timestamp: 1000, feeRecipient: OWNER });
  b.deploy({ programUuid: P, code: fake, context: { sender: OWNER, origin: OWNER } });
  b.init({ programUuid: P });
  assert.equal(b.call({ programUuid: P, functionName: "poke", input: {}, context: { sender: OWNER, origin: OWNER } }).status, "success");
  b.commit();
  const rpc = createEvmRpc({ vm });
  const logs = ask(rpc, "eth_getTransactionReceipt", vm.getBlock(1).txHashes[2]).logs;
  assert.deepEqual(logs.map((log) => log.topics.length), [1, 1]);
  assert.match(Buffer.from(logs[0].data.slice(2), "hex").toString(), /"operator"/);
});

test("evm: eth_call ERC-721 (name / symbol / totalSupply / balanceOf / ownerOf / tokenURI / getApproved / isApprovedForAll / supportsInterface)", () => {
  const { rpc } = chain();
  const read = (fn, args = []) => ERC721.decodeFunctionResult(fn, ask(rpc, "eth_call", { to: N, data: ERC721.encodeFunctionData(fn, args) }, "latest"))[0];
  assert.equal(read("name"), "Siam Art");
  assert.equal(read("symbol"), "SART");
  assert.equal(read("totalSupply"), 2n);
  assert.equal(read("balanceOf", [BOB]), 1n);
  assert.equal(lower(read("ownerOf", [1n])), CAROL);
  assert.equal(read("tokenURI", [1n]), "ipfs://art/1");
  assert.equal(read("tokenURI", [2n]), "ipfs://two");
  assert.equal(lower(read("getApproved", [2n])), ZERO);
  assert.equal(read("isApprovedForAll", [BOB, OWNER]), true);
  assert.equal(read("supportsInterface", ["0x80ac58cd"]), true);
  assert.equal(read("supportsInterface", ["0xd9b67a26"]), false);
  const missing = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: N, data: ERC721.encodeFunctionData("ownerOf", [99n]) }] });
  assert.equal(missing.error.code, EVM_ERROR.SERVER);
  assert.match(missing.error.message, /token does not exist/);
  // ย้อนดู ณ block 2: ชิ้นที่ 1 ยังเป็นของ BOB
  const before = ERC721.decodeFunctionResult("ownerOf", ask(rpc, "eth_call", { to: N, data: ERC721.encodeFunctionData("ownerOf", [1n]) }, "0x2"))[0];
  assert.equal(lower(before), BOB);
});

test("evm: eth_call ERC-1155 (balanceOf(account,id) / uri / totalSupply / isApprovedForAll / supportsInterface) · selector อื่น → error", () => {
  const { rpc } = chain();
  const read = (fn, args = []) => ERC1155.decodeFunctionResult(fn, ask(rpc, "eth_call", { to: G, data: ERC1155.encodeFunctionData(fn, args) }, "latest"))[0];
  assert.equal(read("balanceOf", [BOB, 7n]), 45n);
  assert.equal(read("balanceOf", [CAROL, 7n]), 5n);
  assert.equal(read("uri", [7n]), "ipfs://seven");
  assert.equal(read("uri", [1n]), "https://g.test/{id}");
  assert.equal(read("totalSupply", [2n]), 20n);
  assert.equal(read("name"), "Items");
  assert.equal(read("isApprovedForAll", [BOB, CAROL]), true);
  assert.equal(read("supportsInterface", ["0xd9b67a26"]), true);
  const other = rpc.handle({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: G, data: ERC721.encodeFunctionData("ownerOf", [1n]) }] });
  assert.equal(other.error.code, EVM_ERROR.SERVER);
  assert.match(other.error.message, /ERC-1155/);
});
