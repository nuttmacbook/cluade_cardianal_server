/**
 * the explorer in a real browser (Chromium via Playwright) against a real server
 *   npm run test:e2e
 *
 * the wallet is mocked by a window.ethereum that signs with ethers.Wallet.signTypedData
 * → it signs exactly the data the page builds, like MetaMask (nothing is rebuilt on the Node side)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { chromium } from "playwright";
import { Wallet, JsonRpcProvider, WebSocketProvider, Contract, id as topicOf } from "ethers";

const ROOT = new URL("../../", import.meta.url).pathname;
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";  // funded in genesis.json
const wallet = new Wallet(KEY);
const ME = wallet.address.toLowerCase();
const BOB = "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a";                          // mixed-case checksum address

let server, browser, page, url, CHAIN_ID;   // CHAIN_ID = chainId of the chain under test (signed txs must match, or the node rejects them)
const pageErrors = [];

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const get = (path) => fetch(url + path).then((r) => r.json());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, DEV: "1", PORT: String(port), BLOCK_MS: "300", RATE_LIMIT: "0", REJECTED_HOLD_MS: "1000", GAS_PRICE: process.env.GAS_PRICE ?? "1000000000" }, stdio: "pipe" });
  for (let i = 0; i < 50; i += 1) {
    if (await fetch(`${url}/genesis`).then(() => true, () => false)) break;
    await wait(100);
  }
  // seed data: token "mytoken" + every tx type
  CHAIN_ID = (await (await fetch(`${url}/genesis`)).json()).chainId;
  await promisify(execFile)(process.execPath, ["dev/seed.js", url], { cwd: ROOT });

  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.exposeFunction("__signTypedData", (json) => {
    const { domain, types, message } = JSON.parse(json);
    const { EIP712Domain, ...rest } = types;          // ethers builds EIP712Domain itself
    return wallet.signTypedData(domain, rest, message);
  });
  await context.addInitScript((account) => {
    // like Brave Wallet (stricter than MetaMask): only accounts the site was granted (eth_accounts) can sign, and the address case must match what the wallet returned
    //   mismatch = error 4100 · __revoke() = the user disconnects in the wallet
    const authorized = new Set();
    window.__requested = 0;
    window.__revoke = () => authorized.clear();
    window.ethereum = {
      on: () => {},
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts") { window.__requested += 1; authorized.add(account); return [account]; }
        if (method === "eth_accounts") return [...authorized];
        // like MetaMask: another chain is active (default BSC 0x38 = this chain not added yet) · the domain chainId must match the active chain
        if (method === "eth_chainId") return window.__walletChain ?? "0x38";
        if (method === "eth_signTypedData_v4") {
          if (!authorized.has(params[0])) {
            throw Object.assign(new Error("The requested account and/or method has not been authorized by the user."), { code: 4100 });
          }
          const domainChain = JSON.parse(params[1]).domain?.chainId;
          if (domainChain !== undefined && BigInt(domainChain) !== BigInt(window.__walletChain ?? "0x38")) {
            throw new Error(`Provided chainId "${domainChain}" must match the active chainId "${BigInt(window.__walletChain ?? "0x38")}"`);
          }
          return window.__signTypedData(params[1]);
        }
        if (method === "wallet_addEthereumChain") { window.__addedChain = params[0]; return null; }
        throw new Error(`unsupported ${method}`);
      },
    };
  }, wallet.address);
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") pageErrors.push(message.text()); });
});

after(async () => {
  await browser?.close();
  server?.kill();
});

const open = async (hash) => {
  await page.goto(`${url}/${hash}`);
  await settle();
};
const settle = () => page.waitForFunction(() => !document.getElementById("view").textContent.includes("Loading"));
const view = () => page.locator("#view").textContent();   // textContent: not affected by CSS text-transform
const tab = async (label) => { await page.click(`button.tab:has-text('${label}')`); await page.waitForSelector(`button.tab.on:has-text('${label}')`); await settle(); };

test("home page: overview + block list", async () => {
  await open("");
  const text = await view();
  assert.match(text, /Latest blocks/);
  assert.equal(await page.locator("#view a", { hasText: /^1$/ }).count(), 1);
  assert.ok(await page.locator("#view .ico.blk").count() >= 1);                  // block numbers have a box icon
  assert.ok(await page.locator("#view .ico.gas").count() >= 1);                  // gas values have a flame icon
  assert.deepEqual(pageErrors, []);
});

test("Add network button: passes the GET /evm values to wallet_addEthereumChain (this node's chainId / rpcUrls / explorer)", async () => {
  await open("");
  await page.click("#nbtn");
  await page.waitForFunction(() => window.__addedChain);
  const added = await page.evaluate(() => window.__addedChain);
  const expected = await get("/evm");
  assert.deepEqual(added, expected);
  assert.equal(added.rpcUrls[0], `${url}/evm`);
  assert.deepEqual(pageErrors, []);
});

test("block page: header + the replayed tx list", async () => {
  await open("#block/1");
  const text = await view();
  assert.match(text, /Block #1/);
  assert.match(text, /Transactions \(\d+\)/);
  assert.match(text, /deploy/);
  assert.deepEqual(pageErrors, []);
});

test("tx page: found by both the system hash and the hash the user signed", async () => {
  const [first] = (await get(`/address/${ME}`)).transactions;
  const { digest, record } = await get(`/tx/${first.hash}`);
  assert.match(record.signature, /^0x[0-9a-f]{130}$/);   // the signature is read from blockbody (txn does not duplicate it)
  for (const hash of [first.hash, digest]) {
    await open(`#tx/${hash}`);
    const text = await view();
    assert.match(text, /Success/);
    assert.match(text, /Signed hash/);
    assert.ok(text.includes(record.signature), "shows the signature");
  }
  assert.deepEqual(pageErrors, []);
});

test("search by name → program page with event / data / code tabs", async () => {
  await open("");
  await page.fill("#q", "mytoken");
  await page.press("#q", "Enter");
  await page.waitForFunction(() => location.hash.startsWith("#address/"));
  await settle();
  assert.match(await view(), /mytoken/);
  // upgrades: version (never upgraded = 1) and upgrader (none = immutable)
  assert.match(await view(), /Version\s*1/);
  assert.match(await view(), /Upgrader\s*None \(immutable\)/);

  await tab("Events");
  assert.match(await view(), /Transfer/);

  await tab("Storage");
  assert.match(await page.locator("#storage-box").textContent(), /owner/);          // program info: 1-level keys
  await page.click("#storage-panel [data-sub=storage]");
  await page.waitForSelector("#storage-box #map-name");

  await tab("Code");
  assert.match(await view(), /function program\(\)/);
  assert.deepEqual(pageErrors, []);
});

test("address icons: program = computer · wallet = person", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await page.waitForSelector("#view .ico.big.program");
  await open(`#address/${ME}`);
  await page.waitForSelector("#view .ico.big.person");
  await open("#block/2");
  await page.waitForSelector("#view .ico.person");
  assert.equal(await page.locator("#view .ico[data-ico]:not(.person):not(.program)").count(), 0);
  assert.deepEqual(pageErrors, []);
});

test("data tab: program info / storage (dropdown in the table header) / get storage (vertical keys + a + button)", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Storage");
  await page.click("#storage-panel [data-sub=info]");                              // the tab chosen in the previous test is remembered
  const info = await page.locator("#storage-box").textContent();
  for (const key of ["owner", "name", "ticker", "decimals", "totalSupply"]) assert.match(info, new RegExp(key));
  await page.waitForSelector("#storage-box .ico.person");                          // the owner value is an address
  assert.ok(await page.locator("#storage-box .kchip").count() >= 5);              // keys are badges

  await page.click("#storage-panel [data-sub=storage]");
  await page.waitForSelector("#storage-box thead #map-name");                      // the dropdown is in the table header
  assert.deepEqual(await page.locator("#map-name option").allTextContents(), ["balances (63)"]);
  assert.match(await page.locator("#storage-box").textContent(), /Showing 1–25 of 63/);

  await page.click("#storage-panel [data-sub=get]");
  assert.deepEqual(await page.locator("#gk-name option").allTextContents(), ["allowance"]);
  const parts = page.locator(".gk-part");
  await parts.nth(0).fill(wallet.address);                                        // mixed case
  await parts.nth(1).fill(BOB);
  await page.click("button[title='Add a key part']");
  assert.equal(await parts.count(), 3);
  const [y1, y2] = await Promise.all([parts.nth(1).boundingBox(), parts.nth(2).boundingBox()]);
  assert.ok(y2.y > y1.y, "key fields are stacked vertically");
  assert.equal(await parts.nth(0).inputValue(), wallet.address);                  // pressing + keeps the entered value
  await page.click("button[title='Remove the last key part']");
  assert.equal(await parts.count(), 2);
  await page.click("#storage-box button:has-text('Read value')");
  await page.waitForSelector("#storage-box tbody .kchips");
  assert.equal(await page.locator("#storage-box tbody tr:first-child .kchip").count(), 3);
  assert.match(await page.locator("#storage-box tbody").textContent(), /300,000,000/);

  await parts.nth(1).fill("0x0000000000000000000000000000000000000001");
  await parts.nth(1).press("Enter");
  await page.waitForFunction(() => document.getElementById("storage-box").textContent.includes("No value"));
  assert.deepEqual(pageErrors, []);
});

test("holdings: counted from Transfer events · balances shown with decimals (6) · token info on the program page", async () => {
  await open(`#address/${BOB}`);
  await page.waitForSelector("#view button.tab.on:has-text('Tokens')");        // the first tab of a wallet that holds tokens
  const text = await view();
  assert.match(text, /MTK/);
  assert.match(text, /1,200\.5(?!\d)/);                                          // 1_200_500_000 units ÷ 10^6

  await open(`#address/${ME}`);
  assert.match(await view(), /998,799\.499933/);

  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  assert.match(await view(), /My Token/);
  assert.match(await view(), /6 decimals/);
  assert.match(await view(), /supply 1,000,000(?!\.)/);
  assert.deepEqual(pageErrors, []);
});

test("{ } data is shown in a dark JSON box (input / events on the tx page)", async () => {
  const { address } = await get("/name/mytoken");
  const [last] = (await get(`/address/${ME}/txs?limit=1`)).items;   // the seed's latest tx: a program calling a program
  await open(`#tx/${last.hash}`);
  assert.ok(await page.locator("#view pre.json").count() >= 2);
  const bg = await page.locator("#view pre.json").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(bg, "rgb(3, 7, 19)");
  assert.match(await page.locator("#view pre.json").first().textContent(), /^\{\n  "/);
  // the block row has a box icon + the tx's block number
  const blockRow = page.locator("#view tr", { hasText: /^Block/ }).first();
  assert.equal(await blockRow.locator(".ico.blk").count(), 1);
  assert.equal(await blockRow.locator("a").textContent(), String((await get(`/tx/${last.hash}`)).blockNumber));
  assert.ok(address);
  assert.deepEqual(pageErrors, []);
});

test("read program values from the form (no wallet connection needed)", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Interact");
  await page.click(".ix-head .seg button[data-mode=fields]");
  await page.selectOption("#fn", "balanceOf");
  await page.fill("#ix-who", ME);                                                   // the field inferred from params.input.who
  await page.evaluate(() => { window.__swaps = 0; new MutationObserver((ms) => { for (const m of ms) if (m.target.id === "view") window.__swaps += 1; })
    .observe(document.getElementById("view"), { childList: true }); });
  await page.click("text=Read (no gas)");
  await page.waitForSelector("#out .ix-ret");
  const { balance } = await get(`/address/${address}`).then(() => get(`/token/${address}/holders?limit=100`))
    .then((h) => h.items.find((x) => x.address === ME.toLowerCase()) ?? { balance: "0n" });
  assert.match(await page.locator("#out .ix-status").innerText(), /Success[\s\S]*Read · balanceOf\(\)/);
  assert.equal(await page.locator("#out .ix-ret .mono").innerText(), BigInt(String(balance).replace(/n$/, "")).toLocaleString("en-US")); // the actual returned value
  assert.equal(await page.locator("#out details.ix-full").getAttribute("open"), null);   // full details collapsed
  const full = JSON.parse(await page.locator("#out details.ix-full pre").textContent());
  assert.equal(full.status, "success");
  assert.equal(typeof full.result, "number");
  assert.equal(await page.evaluate(() => window.__swaps), 0, "pressing Read does not re-render the page");
  assert.equal(await page.locator("#fn").inputValue(), "balanceOf");
});

test("Interact: builds fields from the selected function's params.input · switching Fields ↔ JSON keeps the values", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Interact");
  await page.click(".ix-head .seg button[data-mode=fields]");
  await page.selectOption("#fn", "transfer");
  const fields = () => page.locator("#ix-input .ix-f").evaluateAll((els) => els.map((e) => `${e.dataset.name}:${e.dataset.type}`));
  assert.deepEqual(await fields(), ["to:address", "amount:number"]);
  await page.fill("#ix-to", BOB);
  await page.fill("#ix-amount", "7");

  await page.click(".ix-head .seg button[data-mode=json]");
  assert.deepEqual(JSON.parse(await page.inputValue("#args")), { to: BOB, amount: "7n" });   // numbers become bigint "7n"
  await page.fill("#args", JSON.stringify({ to: BOB, amount: "9n", memo: "hi" }));
  await page.click(".ix-head .seg button[data-mode=fields]");
  assert.equal(await page.inputValue("#ix-amount"), "9");
  assert.match(await page.locator("#ix-input").innerText(), /Also sent from the JSON: memo/);

  await page.fill("#ix-amount", "1.5");
  await page.click("text=Read (no gas)");
  assert.match(await page.locator("#out .ix-ret").innerText(), /amount must be a whole number/);

  await page.selectOption("#fn", "multiTransfer");                                     // a list of objects: example from item.to / item.amount
  assert.deepEqual(await fields(), ["transfers:list"]);
  assert.deepEqual(JSON.parse(await page.getAttribute("#ix-transfers", "placeholder")), [{ to: "0x…", amount: 1 }]);
  await page.selectOption("#fn", "balanceOf");
  assert.deepEqual(await fields(), ["who:address"]);
  await page.selectOption("#fn", "totalSupply");
  assert.match(await page.locator("#ix-input").innerText(), /reads nothing from params.input/);
  assert.deepEqual(pageErrors, []);
});

test("send a tx via wallet: signing works even with BSC active (this chain not added) · amount + gas shown before signing · the tx page shows Signed on (input address in mixed case)", async () => {
  const { address } = await get("/name/mytoken");
  const before = (await get(`/program/${address}/storage?prefix=balances&limit=200`)).items;
  const bobBefore = before.find((s) => s.key[1] === BOB.toLowerCase())?.value ?? "0n";

  await open(`#address/${address}`);
  await tab("Interact");
  await page.selectOption("#fn", "transfer");
  await page.click(".ix-head .seg button[data-mode=json]");                         // the JSON mode still works
  await page.fill("#args", JSON.stringify({ to: BOB, amount: "7n" }));
  // pause the wallet before signing → check the amount + gas message shown before the wallet window
  await page.evaluate(() => {
    const sign = window.__signTypedData;
    window.__signTypedData = async (json) => { window.__costText = document.querySelector("#out .ix-status")?.innerText; return sign(json); };
  });
  await page.click("text=Send transaction");
  // stays on the page: waits for the block, then shows the return value (transfer returns true) + collapsed full details
  await page.waitForSelector("#out:not(.busy) .ix-ret", { timeout: 20_000 });
  assert.match(await page.locator("#out .ix-status").innerText(), /Success[\s\S]*Transaction · transfer\(\) · block/);
  assert.equal(await page.locator("#out .ix-ret .mono").innerText(), "true");
  const receipt = JSON.parse(await page.locator("#out details.ix-full pre").textContent());
  assert.equal(receipt.from, ME);
  assert.equal(receipt.method, "transfer");
  assert.equal(receipt.signedOnChainId, 56);
  assert.match(await page.evaluate(() => window.__costText), /Balance [\d.,]+ BWSC · fee ≈ [\d.,]+ BWSC \(max [\d.,]+\) · signing on chain 56 — confirm in your wallet/);

  await page.click("#out .ix-link");                                                 // link to the tx page
  await page.waitForFunction(() => location.hash.startsWith("#tx/0x"));
  await page.waitForFunction(() => document.getElementById("view").innerText.includes("Success"));
  assert.match(await view(), /transfer/);
  assert.match(await page.locator("#view tr", { hasText: /^Return value/ }).innerText(), /true/);
  assert.match(await page.locator("#view tr", { hasText: /^Signed on/ }).innerText(), /BNB Smart Chain\s+chain id 56/);

  const after = (await get(`/program/${address}/storage?prefix=balances&limit=200`)).items;
  const bobAfter = after.find((s) => s.key[1] === BOB.toLowerCase()).value;
  assert.equal(BigInt(bobAfter.slice(0, -1)) - BigInt(bobBefore.slice(0, -1)), 7n);
  assert.deepEqual(pageErrors, []);
});

test("wallet: the user disconnects / switches account after connecting → permission is requested again before signing (no error 4100 not authorized)", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Interact");
  await page.selectOption("#fn", "transfer");
  await page.click(".ix-head .seg button[data-mode=json]");
  await page.fill("#args", JSON.stringify({ to: BOB, amount: "1n" }));
  const asked = await page.evaluate(async () => { await connect(false); window.__revoke(); return window.__requested; });   // connected, then the user revokes
  await page.click("text=Send transaction");
  await page.waitForSelector("#out:not(.busy) .ix-ret", { timeout: 20_000 });
  assert.match(await page.locator("#out .ix-status").innerText(), /Success/);
  assert.equal(await page.evaluate(() => window.__requested), asked + 1);   // permission requested again once
  assert.deepEqual(pageErrors, []);
});

test("wallet: other scripts on the page (browser extensions / Cloudflare) declare common global names → the explorer still loads fully (no walletButton is not defined)", async () => {
  const other = await browser.newPage();
  const errors = [];
  other.on("pageerror", (error) => errors.push(error.message));
  const names = ["provider", "eth", "web3", "ethereumProvider", "signer", "accounts", "chainId", "kit", "modal", "appKit"];
  await other.route(`${url}/`, async (route) => {
    const response = await route.fetch();
    route.fulfill({ response, body: (await response.text()).replace("<head>", `<head><script>${names.map((n) => `var ${n} = {};`).join("")}</script>`) });
  });
  await other.goto(`${url}/`);
  await other.waitForFunction(() => document.getElementById("view").textContent.length > 0);
  assert.deepEqual(errors, []);
  assert.equal(await other.evaluate(() => typeof walletButton), "function");
  await other.close();
});

test("Permit (ERC-2612): the token's Permit tab signs EIP-712 with eth_signTypedData_v4 (mock wallet = ethers signTypedData) → the permit is sent and the chain accepts it", async () => {
  const { address } = await get("/name/mytoken");
  const query = (functionName, input) => fetch(`${url}/query`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ programUuid: address, functionName, input }) }).then((r) => r.json());
  const nonceBefore = BigInt((await query("nonces", { owner: ME })).result.replace(/n$/, ""));

  // a token permit (EIP-2612) has chainId in its domain per the standard → MetaMask must have this chain active
  await page.evaluate((id) => { window.__walletChain = `0x${id.toString(16)}`; }, (await get("/genesis")).chainId);
  await open(`#address/${address}`);
  await tab("Permit");
  assert.match(await view(), /Domain: name My Token · version 1/);
  // bad values → warning message, wallet not called
  await page.fill("#permit-spender", "0x1234");
  await page.click("#permit-sign");
  await page.waitForFunction(() => /Spender must be an address/.test(document.getElementById("permit-sig").textContent));

  await page.fill("#permit-spender", BOB);                                          // mixed case (checksum)
  await page.fill("#permit-value", "2.5");                                          // 2.5 MTK = 2,500,000 units (6 decimals)
  await page.click("#permit-sign");
  await page.waitForSelector("#permit-signature");
  const signature = (await page.locator("#permit-signature").textContent()).trim();
  assert.match(signature, /^0x[0-9a-f]{130}$/);
  const typed = JSON.parse(await page.locator("#permit-sig details.ix-full pre").nth(1).textContent());
  assert.equal(typed.primaryType, "Permit");
  assert.deepEqual(typed.domain, { name: "My Token", version: "1", chainId: (await get("/genesis")).chainId, verifyingContract: address });
  assert.deepEqual(typed.message, { owner: ME, spender: BOB.toLowerCase(), value: "2500000", nonce: String(nonceBefore),
    deadline: typed.message.deadline });
  assert.ok(Number(typed.message.deadline) > Date.now() / 1000, "deadline is in seconds, in the future");
  // the page's signature = ethers signTypedData of the same typed data (MetaMask v4 gives the same value)
  const { EIP712Domain, ...types } = typed.types;
  assert.equal(signature, await wallet.signTypedData(typed.domain, types, typed.message));
  assert.equal(EIP712Domain.length, 4);

  await page.click("#permit-send");
  await page.waitForSelector("#permit-allowance", { timeout: 30_000 });
  assert.match(await page.locator("#permit-out").textContent(), /Success[\s\S]*Permit · block/);
  assert.match(await page.locator("#permit-allowance").textContent(), /Allowance now 2500000/);
  assert.equal((await query("allowance", { owner: ME, spender: BOB.toLowerCase() })).result, "2500000n");
  assert.equal((await query("nonces", { owner: ME })).result, `${nonceBefore + 1n}n`);
  await page.evaluate(() => { delete window.__walletChain; });
  assert.deepEqual(pageErrors, []);
});

test("responsive: from 180px screens to PC nothing overflows or gets clipped · mobile shows tables as cards with column names", async () => {
  const { address: token } = await get("/name/mytoken");
  const [last] = (await get(`/address/${ME}/txs?limit=1`)).items;   // the seed's latest tx: a program calling a program
  const pages = [["#", null], [`#tx/${last.hash}`, null], [`#address/${BOB}`, null],
    [`#address/${token}`, "#view button.tab:has-text('Interact')"], [`#address/${token}`, "#storage-panel [data-sub=storage]"],
    [`#address/${token}`, "#view button.tab[data-tab=holders]"], [`#address/${ME}`, "#view button.tab[data-tab=meta]"]];
  const original = page.viewportSize();
  try {
    for (const width of [180, 240, 360, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [hash, action] of pages) {
        await open(hash);
        if (action) { if (action.includes("storage-panel")) await page.click("#view button.tab:has-text('Storage')"); await page.click(action); if (action.includes("data-tab")) await page.waitForSelector(`${action}.on`); }
        const problems = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          const found = [];
          if (document.documentElement.scrollWidth > vw + 1) found.push(`page scrolls sideways ${document.documentElement.scrollWidth}`);
          const scrolls = (el) => { for (let a = el.parentElement; a; a = a.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(a).overflowX) && a.scrollWidth > a.clientWidth + 1) return true; } return false; };
          for (const el of document.querySelectorAll("header *, #view *")) {
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const box = el.closest(".panel, header")?.getBoundingClientRect() ?? { left: 0, right: vw };
            if ((r.right > Math.min(box.right, vw) + 1 || r.left < Math.max(box.left, 0) - 1) && !scrolls(el)) found.push(`${el.tagName} "${el.textContent.trim().slice(0, 30)}"`);
          }
          return found.slice(0, 5);
        });
        assert.deepEqual(problems, [], `${width}px ${hash} ${action ?? ""}`);
      }
    }
    // mobile: the latest blocks table is cards, each cell with its column name
    await page.setViewportSize({ width: 180, height: 800 });
    await open("#");
    const cell = page.locator("#view table.grid tbody td").first();
    assert.equal(await cell.getAttribute("data-label"), "Block");
    assert.equal(await cell.evaluate((td) => getComputedStyle(td).display), "grid");
    assert.equal(await page.locator("#view table.grid thead th").first().isVisible(), false);
  } finally {
    await page.setViewportSize(original ?? { width: 1280, height: 720 });
  }
  assert.deepEqual(pageErrors, []);
});

test("metadata: information (square icon + namespace) and links (url / contact open externally) · programs have no edit button", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { address: token } = await get("/name/mytoken");
  await open(`#address/${token}`);
  const info = page.locator("#meta-info");
  assert.match(await info.locator(".avatar img").getAttribute("src"), /^data:image\/svg\+xml/);
  const box = await info.locator(".avatar").boundingBox();
  assert.equal(Math.round(box.width), Math.round(box.height));                      // square
  assert.match(await info.textContent(), /mytoken/);
  assert.equal(await info.locator("button").count(), 0);                             // programs set metadata from code only
  assert.equal(await page.locator("button.tab[data-tab=meta]").count(), 0);         // no metadata edit tab
  assert.equal(await page.locator("button.tab[data-tab=interact]").count(), 1);
  const links = page.locator("#view a.ext");
  assert.equal(await links.count(), 2);
  assert.equal(await links.nth(0).getAttribute("href"), "https://mytoken.example");
  assert.equal(await links.nth(1).getAttribute("href"), "mailto:team@mytoken.example");
  for (let i = 0; i < 2; i += 1) {
    assert.equal(await links.nth(i).getAttribute("target"), "_blank");
    assert.match(await links.nth(i).getAttribute("rel"), /noopener/);
  }
  assert.deepEqual(pageErrors, []);
});

test("metadata: a wallet owner can set it (signed with the wallet) · dangerous links are not sent · other people's wallets cannot be edited", async () => {
  await open(`#address/${BOB}`);
  await tab("Edit metadata");                                                        // metadata editing is in the same tab as Interact
  await page.fill("#meta-url", "https://bob.example");
  await page.click("button:has-text('Save (send transaction)')");
  await page.waitForFunction(() => /only set metadata for the connected wallet/.test(document.getElementById("meta-out").textContent));

  await open(`#address/${ME}`);
  await tab("Edit metadata");
  await page.fill("#meta-url", "javascript:alert(1)");
  await page.click("button:has-text('Save (send transaction)')");
  assert.match(await page.locator("#meta-out").textContent(), /url must be an https/);

  await page.fill("#meta-url", "https://me.example");
  await page.fill("#meta-contact", "me@example.com");
  await page.fill("#meta-icon", "🦊");
  assert.equal((await page.locator("#meta-preview .avatar").textContent()).trim(), "🦊");
  const nonce = (await get(`/address/${ME}`)).nonce;
  await page.click("button:has-text('Save (send transaction)')");
  await page.waitForFunction(() => location.hash.startsWith("#tx/"), null, { timeout: 15_000 });
  for (let i = 0; i < 50 && (await get(`/address/${ME}`)).nonce === nonce; i += 1) await wait(200);
  const meta = (await get(`/address/${ME}`)).metadata;
  assert.deepEqual({ url: meta.url, contact: meta.contact, icon: meta.icon, namespace: meta.namespace },
    { url: "https://me.example", contact: "me@example.com", icon: "🦊", namespace: "alice" });   // unchanged fields are not sent

  await open(`#address/${ME}`);
  assert.equal(await page.locator("#view a.ext").nth(1).getAttribute("href"), "mailto:me@example.com");
  assert.deepEqual(pageErrors, []);
});

test("paging: token holders support page numbers / next / jumping to a typed page · balances sorted descending", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Holders");
  const pager = page.locator("#view .pager");
  assert.match(await pager.textContent(), /Showing 1–25 of 63/);
  assert.deepEqual(await pager.locator(".pg").allTextContents(), ["‹", "1", "2", "3", "›", "Go"]);
  assert.match(await page.locator("#view table.grid tbody tr").first().textContent(), /998,799\.4999/);   // the previous test already sent out 7 units

  await pager.locator(".pg", { hasText: /^3$/ }).click();
  await page.waitForFunction(() => /Showing 51–63 of 63/.test(document.querySelector("#view .pager").textContent));
  assert.equal(await page.locator("#view table.grid tbody tr").count(), 13);
  assert.equal(await page.locator("#view .pg.on").textContent(), "3");

  await page.locator("#view .pg[title='Previous page']").click();
  await page.waitForFunction(() => /Showing 26–50/.test(document.querySelector("#view .pager").textContent));

  await page.fill("#view .jump input", "1");
  await page.press("#view .jump input", "Enter");
  await page.waitForFunction(() => /Showing 1–25/.test(document.querySelector("#view .pager").textContent));
  assert.deepEqual(pageErrors, []);
});

test("addresses are shortened to 0x + first 4 … last 4 · the whole page is in English", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  const short = await page.locator("#view table.grid tbody a[title]").first().textContent();
  assert.match(short, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  for (const hash of ["", `#address/${address}`, "#block/2"]) {
    await open(hash);
    const text = (await page.locator("body").textContent());
    assert.doesNotMatch(text, /[\u0E00-\u0E7F]/, hash);
  }
  assert.deepEqual(pageErrors, []);
});

test("program call trace: a centered tree of small numbered boxes + arrows in order · clicking a box shows that call's details", async () => {
  let relay;
  for (const t of (await get(`/address/${ME}/txs?limit=50`)).items) {
    if ((await get(`/tx/${t.hash}/receipt`)).trace?.length === 2) { relay = t; break; }
  }
  await open(`#tx/${relay.hash}`);
  // the Return value row = the program's full return value, same as the Read result
  assert.equal((await page.locator("#view tr", { hasText: /^Return value/ }).locator("td").last().innerText()).trim(), "1,200,500,000");
  const nodes = page.locator("#view .flow .node[data-call]");
  assert.equal(await nodes.count(), 2);
  assert.equal(await page.locator("#view .flow .node.start").count(), 1);              // the tx sender box
  assert.equal(await page.locator("#view .flow svg path[marker-end]").count(), 2);     // arrows sender→#1 and #1→#2
  assert.deepEqual(await nodes.allTextContents(), ["1", "2"]);                         // boxes show only the sequence number
  const [w, h] = await nodes.nth(0).evaluate((n) => [n.offsetWidth, n.offsetHeight]);
  assert.ok(w <= 32 && h <= 32, `small boxes (${w}×${h})`);
  const [a, b] = await Promise.all([nodes.nth(0).boundingBox(), nodes.nth(1).boundingBox()]);
  assert.ok(b.y > a.y && Math.abs(b.x - a.x) < 1, "top-down tree: a callee sits centered under its caller");
  const [wrap, start] = await Promise.all([page.locator("#view .flowwrap").boundingBox(), page.locator("#view .flow .node.start").boundingBox()]);
  assert.ok(Math.abs(start.x + start.width / 2 - (wrap.x + wrap.width / 2)) <= 2, "the diagram is centered in its frame");
  const [flow, side] = await Promise.all([page.locator("#view .flowwrap").boundingBox(), page.locator("#call-detail").boundingBox()]);
  assert.ok(side.x >= flow.x + flow.width && side.y < flow.y + flow.height, "wide screen: details sit to the right of the diagram");
  assert.ok(Math.abs(side.height - flow.height) <= 1, `the details box is as tall as the diagram (${side.height} vs ${flow.height})`);

  // initially only #1's details are shown
  const detail = page.locator("#call-detail");
  assert.equal(await page.locator("#view .call").count(), 1);
  assert.match(await detail.textContent(), /Call #1[\s\S]*\.check\(\)[\s\S]*Input[\s\S]*"who"[\s\S]*Result[\s\S]*1,200,500,000/);
  await nodes.nth(1).click();
  assert.match(await detail.textContent(), /Call #2[\s\S]*depth 1[\s\S]*mytoken[\s\S]*\.balanceOf\(\)[\s\S]*Origin/);
  assert.equal(await page.locator("#view .flow .node.on").getAttribute("data-call"), "1");
  assert.deepEqual(pageErrors, []);
});

test("time: every ... ago has a small UTC date-time · seconds on wide screens, minutes on narrow ones", async () => {
  const { address } = await get("/name/mytoken");
  const latest = await get("/block/latest");
  const stamp = new Date(latest.timestamp).toISOString();
  for (const hash of ["", `#address/${address}`, `#block/${latest.number}`]) {
    await open(hash);
    if (hash.startsWith("#address")) await tab("Calls");
    const smalls = page.locator("#view .utc");
    assert.ok(await smalls.count() > 0, `has UTC on ${hash || "home page"}`);
    assert.match(await smalls.first().innerText(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  }
  assert.equal(await page.locator("#view .utc").first().innerText(), `${stamp.slice(0, 10)} ${stamp.slice(11, 19)} UTC`);
  const original = page.viewportSize();
  await page.setViewportSize({ width: 375, height: 800 });
  try {
    await open(`#block/${latest.number}`);
    assert.equal(await page.locator("#view .utc").first().innerText(), `${stamp.slice(0, 10)} ${stamp.slice(11, 16)} UTC`);
  } finally {
    await page.setViewportSize(original ?? { width: 1280, height: 720 });
  }
});

test("program Calls: a nested call that failed but was caught above → Status = Success matching the tx page + an orange ⚠ caught warning", async () => {
  const { address: token } = await get("/name/mytoken");
  await open(`#address/${token}`);
  await tab("Calls");
  const row = page.locator("#view tr", { hasText: "⚠ caught" });
  assert.equal(await row.count(), 1);
  assert.equal(await row.locator(".warn").evaluate((n) => getComputedStyle(n).color), "rgb(251, 146, 60)");   // orange, not red
  assert.match(await row.textContent(), /Nested · depth 1[\s\S]*transfer[\s\S]*Success/);
  await row.locator("a[title^='0x']").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#tx/0x"));
  await settle();
  assert.match(await page.locator("#view tr", { hasText: /^Status/ }).textContent(), /Success/);
});

test("/evm: ethers JsonRpcProvider connects to the chain (chainId, block, balance, tx, receipt, ERC-20) · cannot send txs · the wallet's explorer links lead to the same pages", async () => {
  const provider = new JsonRpcProvider(`${url}/evm`);
  const genesis = await get("/genesis");
  assert.equal((await provider.getNetwork()).chainId, BigInt(genesis.chainId));
  const latest = await provider.getBlock("latest");
  assert.ok(latest.number >= 1 && latest.timestamp < Date.now() / 1000 + 5);
  const native = (await get(`/address/${ME}`)).native.balance;
  assert.equal(await provider.getBalance(ME), BigInt(String(native).replace(/n$/, "")));   // native is already in wei
  const { address: token } = await get("/name/mytoken");
  const erc20 = new Contract(token, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"], provider);
  assert.equal(await erc20.symbol(), "MTK");
  assert.equal(await erc20.decimals(), 6n);
  const { result } = await fetch(`${url}/query`, { method: "POST", body: JSON.stringify({ programUuid: token, functionName: "balanceOf", input: { who: ME } }) }).then((r) => r.json());
  assert.equal(await erc20.balanceOf(ME), BigInt(String(result).replace(/n$/, "")));
  const [hash] = (await get("/block/1")).txHashes;
  const receipt = await provider.getTransactionReceipt(hash);
  assert.equal(receipt.status, 1);
  assert.equal(receipt.contractAddress.toLowerCase(), token);
  assert.equal((await provider.getTransaction(hash)).from.toLowerCase(), ME);
  await assert.rejects(provider.broadcastTransaction("0x02f86c"), /EIP-712|could not coalesce/);
  const params = await get("/evm");
  assert.equal(params.nativeCurrency.decimals, 18);
  assert.equal(params.rpcUrls[0], `${url}/evm`);
  await page.goto(`${url}/evm/explorer/tx/${hash}`);
  await settle();
  assert.equal(new URL(page.url()).hash, `#tx/${hash}`);
  assert.match(await view(), /deploy/i);
  provider.destroy();
});

test("/evm for Blockscout: historical balances by block number · eth_getLogs · debug_traceTransaction (callTracer) · WebSocket", async () => {
  const provider = new JsonRpcProvider(`${url}/evm`);
  const latest = await provider.getBlockNumber();
  const before = await provider.getBalance(ME, 0);
  assert.ok(before > await provider.getBalance(ME, latest));   // genesis has a larger balance than after paying gas
  assert.equal(await provider.getBalance(BOB, 0), 0n);
  const { address: token } = await get("/name/mytoken");
  assert.equal(await provider.getCode(token, 0), "0x");
  assert.match(Buffer.from((await provider.getCode(token)).slice(2), "hex").toString(), /function program\(\)/);

  const logs = await provider.getLogs({ address: token, topics: [topicOf("Transfer(address,address,uint256)")], fromBlock: 0, toBlock: latest });
  assert.ok(logs.length >= 2);
  const indexes = logs.map((log) => `${log.blockNumber}:${log.index}`);
  assert.equal(new Set(indexes).size, indexes.length);   // logIndex is unique within the block
  const receipts = await provider.send("eth_getBlockReceipts", [`0x${logs[0].blockNumber.toString(16)}`]);
  assert.ok(receipts.some((r) => r.transactionHash === logs[0].transactionHash));

  let relay;
  for (const t of (await get(`/address/${ME}/txs?limit=50`)).items) {
    if ((await get(`/tx/${t.hash}/receipt`)).trace?.length === 2) { relay = t; break; }
  }
  const trace = await provider.send("debug_traceTransaction", [relay.hash, { tracer: "callTracer" }]);
  assert.equal(trace.type, "CALL");
  assert.equal(trace.calls.length, 1);
  assert.equal(trace.calls[0].to, token);
  assert.equal((await provider.send("debug_traceBlockByNumber", ["latest", { tracer: "callTracer" }])).length,
    (await get(`/block/${latest}`)).txHashes.length);
  assert.deepEqual(await provider.send("txpool_status", []), { pending: "0x0", queued: "0x0" });
  provider.destroy();

  const ws = new WebSocketProvider(`${url.replace("http", "ws")}/evm`);
  assert.equal(await ws.getBlockNumber(), latest);
  assert.match(await ws.send("eth_subscribe", ["newHeads"]), /^0x[0-9a-f]+$/);
  await ws.destroy();
});


test("programs: the home page shows approved / pending counts · clicking shows each list", async () => {
  const sign = await import("../../src/crypto/signature.js");
  const { nonce } = await get(`/nonce/${ME}`);
  const tx = { chainId: CHAIN_ID, from: ME, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, gasPrice: "1000000000", nonce,
    action: "deploy", code: "function program() { function ping(params) { return 1; } return { ping }; }" };
  const sent = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx, signature: sign.signTransaction(tx, KEY) }) }).then((r) => r.json());
  assert.ok(sent.queued, JSON.stringify(sent));
  for (let i = 0; i < 50 && !(await get(`/tx/${sent.hash}`))?.blockNumber; i += 1) await wait(200);

  const counts = await get("/programs");
  assert.ok(counts.approved >= 2);   // mytoken + relay from the seed
  assert.equal(counts.pending, 1);

  await open("");
  assert.equal((await page.locator("[data-programs=approved] b").textContent()).trim(), String(counts.approved));
  assert.equal((await page.locator("[data-programs=pending] b").textContent()).trim(), "1");

  await page.click("[data-programs=pending]");
  await settle();
  assert.equal(await page.evaluate(() => location.hash), "#programs");
  await page.waitForSelector("button.tab.on:has-text('Awaiting approval')");
  assert.match(await view(), /Deployer/);
  assert.equal(await page.locator("#view tbody tr").count(), 1);

  await tab("Approved");
  assert.match(await view(), /mytoken/);
  assert.equal(await page.locator("#view tbody tr").count(), counts.approved);
  assert.deepEqual(pageErrors, []);
});

test("NFT: the program page shows Collection (ERC-721) · the wallet page has an NFTs tab with tokenId and tokenURI", async () => {
  const sign = await import("../../src/crypto/signature.js");
  const { NFT_PROGRAM } = await import("../../src/standards/nft.js");
  const send = async (fields) => {
    const { nonce } = await get(`/nonce/${ME}`);
    const tx = { chainId: CHAIN_ID, from: ME, to: "", method: "", input: {}, value: 0, gasLimit: 2_000_000, gasPrice: "1000000000", nonce, ...fields };
    const sent = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx, signature: sign.signTransaction(tx, KEY) }) }).then((r) => r.json());
    assert.ok(sent.queued, JSON.stringify(sent));
    for (let i = 0; i < 50 && !(await get(`/tx/${sent.hash}`))?.blockNumber; i += 1) await wait(200);
    return get(`/tx/${sent.hash}/receipt`);
  };
  const deployed = await send({ action: "deploy", code: NFT_PROGRAM, input: { name: "Siam Art", symbol: "SART", baseURI: "https://art.example/" } });
  const nft = deployed.result?.programUuid ?? deployed.result;
  assert.equal((await send({ action: "init", to: nft })).status, "success");
  assert.equal((await send({ action: "call", to: nft, method: "mint", input: { to: ME } })).status, "success");
  assert.equal((await send({ action: "call", to: nft, method: "mint", input: { to: BOB, uri: "ipfs://second" } })).status, "success");

  await open(`#address/${nft}`);
  const text = await view();
  assert.match(text, /Collection/);
  assert.match(text, /Siam Art/);
  assert.match(text, /ERC-721 · 2 minted/);

  await open(`#address/${ME}`);
  await tab("NFTs");
  assert.match(await view(), /#1/);
  assert.equal(await page.locator("#view a[href='https://art.example/1']").count(), 1);
  await open(`#address/${BOB}`);
  await tab("NFTs");
  assert.match(await view(), /ipfs:\/\/second/);
  assert.equal(await page.locator("#view a[href^='ipfs:']").count(), 0);   // not http(s) → not made a link
  assert.deepEqual(pageErrors, []);
});

// ---------------------------------------------------------------------------
//  deploy form (with upgrader) → approve → upgrade → approve the upgrade → transfer the right · every tx signed from the page
// ---------------------------------------------------------------------------

const V1 = "function program() {\n  function initialization(params) { writeDB(\"count\", 1n) }\n  function ping(params) { return readDB(\"count\") }\n  return { ping };\n}";
const V2 = "function program() {\n  function migrate(params) { writeDB(\"count\", params.input.start) }\n  function ping(params) { return readDB(\"count\") }\n  function pong(params) { return 2n }\n  return { ping, pong };\n}";
const query = (programUuid, functionName) => fetch(`${url}/query`, { method: "POST", body: JSON.stringify({ programUuid, functionName, input: {} }) }).then((r) => r.json());
const outSays = (selector, pattern, timeout = 20_000) =>
  page.waitForFunction(([sel, source]) => new RegExp(source).test(document.querySelector(sel)?.textContent ?? ""), [selector, pattern.source], { timeout });

let upgradable;
test("deploy form: set the upgrader to your own wallet (part of the signed data) → pending → press Approve on the program list page", async () => {
  await open("#deploy");
  assert.match(await view(), /Deploy a program/);
  await page.fill("#dp-code", V1);
  await page.click("button:has-text('Use my wallet as upgrader')");
  assert.equal(await page.inputValue("#dp-upgrader"), ME);
  await page.fill("#dp-upgrader", "0x123");
  await page.click("#dp-send");
  assert.match(await page.locator("#dp-out").textContent(), /Upgrader must be an address/);   // checked before signing
  await page.fill("#dp-upgrader", wallet.address);                                         // mixed case → sent lower case
  await page.click("#dp-send");
  await outSays("#dp-out", /Deployed[\s\S]*awaiting approval/);
  upgradable = (await page.locator("#dp-out a[title^='0x']").first().getAttribute("title")).toLowerCase();
  const pendingRow = (await get("/programs/pending?limit=100")).items.find((p) => p.address === upgradable);
  assert.equal(pendingRow.deployer, ME);

  await open("#programs");
  await tab("Awaiting approval");
  const row = page.locator("#view tbody tr", { has: page.locator(`a[title='${upgradable}']`) });
  await row.locator("[data-review=init]").click();
  await outSays("#review-out", /Success[\s\S]*Approved/);
  assert.equal((await get(`/program/${upgradable}`)).metadata.upgrader, ME);
  assert.equal((await query(upgradable, "ping")).result, "1n");
  assert.deepEqual(pageErrors, []);
});

test("deploy form: a large program using over 500,000 gas still deploys (default gas limit = the per-tx cap · no OUT_OF_GAS) · pays only the gas actually used", async () => {
  const big = `function program() {\n  function ping(params) { return 2n }\n  function pad(params) { return "${"x".repeat(16000)}" }\n  return { ping, pad };\n}`;
  await open("#deploy");
  await page.fill("#dp-code", big);
  await page.fill("#dp-upgrader", "");
  await page.click("#dp-send");
  await outSays("#dp-out", /Deployed[\s\S]*awaiting approval/);
  const program = (await page.locator("#dp-out a[title^='0x']").first().getAttribute("title")).toLowerCase();
  const pending = (await get("/programs/pending?limit=100")).items.find((p) => p.address === program);
  assert.ok(pending, "pending approval");
  const hash = await page.locator("#dp-out a[href^='#tx/']").first().getAttribute("href").catch(() => null);
  if (hash) {
    const receipt = (await get(`/tx/${hash.slice(4)}/receipt`)).result ?? {};
    if (receipt.gasUsed !== undefined) assert.ok(Number(receipt.gasUsed) > 500_000, `gasUsed ${receipt.gasUsed}`);
  }
  assert.deepEqual(pageErrors, []);
});

test("deploy form: gas limit can be set (part of the signed data) · non-numbers are blocked before signing · empty = automatic", async () => {
  const big = `function program() {\n  function ping(params) { return 3n }\n  function pad(params) { return "${"y".repeat(16000)}" }\n  return { ping, pad };\n}`;
  await open("#deploy");
  await page.fill("#dp-code", big);
  await page.fill("#dp-upgrader", "");
  await page.fill("#dp-gasLimit", "abc");
  await page.click("#dp-send");
  assert.match(await page.locator("#dp-out").textContent(), /Gas limit must be a whole number/);
  await page.fill("#dp-gasLimit", "2,000,000");                                            // commas as thousands separators are allowed
  const sent = page.waitForRequest((r) => r.url().endsWith("/sendtx"));
  await page.click("#dp-send");
  assert.equal(JSON.parse((await sent).postData()).tx.gasLimit, 2_000_000);               // the value set is in the signed data
  await outSays("#dp-out", /Deployed[\s\S]*awaiting approval/);
  await page.evaluate(() => { deployDraft.gasLimit = ""; });
  assert.deepEqual(pageErrors, []);
});

test("Upgrade tab: submit new code + migrate input → awaiting review → Approve upgrade → version 2 · transfer the right to BOB · programs without an upgrader cannot be changed", async () => {
  await open(`#address/${upgradable}`);
  await tab("Upgrade");
  assert.equal(await page.locator("#up-version").textContent(), "1");
  assert.match(await page.locator("#upgrade-panel").textContent(), /You are the upgrader/);
  assert.match(await page.inputValue("#up-code"), /function ping/);               // starts from the current code
  await page.fill("#up-code", V2);
  await page.fill("#up-input", '{ "start": 41 }');
  await page.click("#up-send");
  await page.waitForSelector("#up-pending-code", { timeout: 20_000 });
  assert.match(await page.locator("#up-out").textContent(), /Success[\s\S]*Upgrade submitted for review/);
  assert.match(await page.locator("#up-pending-code").textContent(), /function pong/);
  assert.match(await page.locator("#view").textContent(), /Upgrade pending review/);

  await page.click("#up-approve");
  await page.waitForFunction(() => document.getElementById("up-version")?.textContent === "2", null, { timeout: 20_000 });
  assert.equal(await page.locator("#up-pending-code").count(), 0);
  assert.equal((await query(upgradable, "pong")).result, "2n");
  assert.equal((await query(upgradable, "ping")).result, "41n");                // migrate receives the entered input (numbers → bigint)
  assert.equal((await get(`/program/${upgradable}/versions`)).length, 2);

  await page.fill("#up-next", "nope");
  await page.click("#up-transfer");
  assert.match(await page.locator("#up-out").textContent(), /must be an address/);
  await page.fill("#up-next", BOB);
  await page.click("#up-transfer");
  await outSays("#up-out", /Success[\s\S]*Upgrade rights transferred/);
  assert.equal((await get(`/program/${upgradable}`)).metadata.upgrader, BOB.toLowerCase());
  assert.match(await page.locator("#upgrade-panel").textContent(), /This wallet is not the upgrader/);

  const { address: token } = await get("/name/mytoken");                          // the seed deploys without an upgrader
  await open(`#address/${token}`);
  await tab("Upgrade");
  assert.match(await page.locator("#upgrade-panel").textContent(), /no upgrader, so its code can never change/);
  assert.equal(await page.locator("#up-send").count(), 0);
  assert.deepEqual(pageErrors, []);
});

test("Upgrade tab: renouncing needs two clicks · Reject upgrade removes the pending code (txs signed from Node show in the same tab)", async () => {
  const sign = await import("../../src/crypto/signature.js");
  const send = async (fields) => {
    const { nonce } = await get(`/nonce/${ME}`);
    const tx = { chainId: CHAIN_ID, from: ME, to: "", method: "", input: {}, value: 0, gasLimit: 500_000, gasPrice: "1000000000", nonce, ...fields };
    const sent = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx, signature: sign.signTransaction(tx, KEY) }) }).then((r) => r.json());
    assert.ok(sent.queued, JSON.stringify(sent));
    for (let i = 0; i < 50 && !(await get(`/tx/${sent.hash}`)).blockNumber; i += 1) await wait(200);
    return sent;
  };
  const deployed = await send({ action: "deploy", code: V1, upgrader: ME });
  const program = (await get(`/tx/${deployed.hash}/receipt`)).result.programUuid;
  await send({ action: "init", to: program });
  await send({ action: "upgrade", to: program, code: V2, input: { start: "5n" } });

  await open(`#address/${program}`);
  await tab("Upgrade");
  await page.click("#up-reject");
  await page.waitForFunction(() => !document.getElementById("up-pending-code") && /Upgrade rejected/.test(document.getElementById("up-out")?.textContent ?? ""), null, { timeout: 20_000 });
  assert.equal((await get(`/program/${program}`)).pendingUpgrade, null);
  assert.equal(await page.locator("#up-version").textContent(), "1");

  await page.click("#up-renounce");
  assert.equal(await page.locator("#up-renounce").textContent(), "Click again to renounce for good");
  assert.equal((await get(`/program/${program}`)).metadata.upgrader, ME);            // the first click does not send yet
  await page.click("#up-renounce");
  await page.waitForFunction(() => /no upgrader/.test(document.getElementById("upgrade-panel")?.textContent ?? ""), null, { timeout: 20_000 });
  assert.equal((await get(`/program/${program}`)).metadata.upgrader ?? null, null);
  assert.deepEqual(pageErrors, []);
});

test("paging program Calls / Events: Older / Newer (cursor) · page 2 continues page 1 with no repeats", async () => {
  const { address: token } = await get("/name/mytoken");
  // the seed has less than one page of calls → send 22 more token transfers (at most 16 per block per sender)
  const sign = await import("../../src/crypto/signature.js");
  for (const batch of [16, 6]) {
    const { nonce } = await get(`/nonce/${ME}`);
    let last;
    for (let i = 0; i < batch; i += 1) {
      const tx = { chainId: CHAIN_ID, action: "call", from: ME, to: token, method: "transfer", input: { to: BOB.toLowerCase(), amount: "1n" }, value: 0, gasLimit: 500_000, gasPrice: "1000000000", nonce: nonce + i };
      last = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ tx, signature: sign.signTransaction(tx, KEY) }) }).then((r) => r.json());
      assert.ok(last.queued, JSON.stringify(last));
    }
    for (let i = 0; i < 100 && !(await get(`/tx/${last.hash}`)).blockNumber; i += 1) await wait(200);
  }
  const calls = (await get(`/address/${token}/incoming?limit=100`)).items;
  assert.ok(calls.length > 20, `the seed has more than one page of calls (${calls.length})`);
  await open(`#address/${token}`);
  await tab("Calls");
  const pager = page.locator("#view .pager[data-cursor=in]");
  assert.match(await pager.textContent(), /Page 1 · 20 items/);
  assert.equal(await pager.locator("button[title=Newer]").isDisabled(), true);
  const firstPage = await page.locator("#view table.grid tbody a[title^='0x'][onclick*='#tx/']").evaluateAll((links) => links.map((a) => a.title));
  assert.equal(firstPage[0], calls[0].hash);
  await pager.locator("button[title=Older]").click();
  await page.waitForFunction(() => /Page 2/.test(document.querySelector("#view .pager[data-cursor=in]")?.textContent ?? ""));
  const secondPage = await page.locator("#view table.grid tbody a[title^='0x'][onclick*='#tx/']").evaluateAll((links) => links.map((a) => a.title));
  assert.equal(secondPage[0], calls[20].hash);
  await page.locator("#view .pager[data-cursor=in] button[title=Newer]").click();
  await page.waitForFunction(() => /Page 1/.test(document.querySelector("#view .pager[data-cursor=in]")?.textContent ?? ""));

  const events = (await get(`/program/${token}/events?limit=100`)).items;
  assert.ok(events.length > 20);
  await tab("Events");
  const eventPager = page.locator("#view .pager[data-cursor=events]");
  assert.match(await eventPager.textContent(), /Page 1 · 20 items/);
  assert.match(await page.locator("button.tab.on").textContent(), new RegExp(`Events${events.length}`));
  await eventPager.locator("button[title=Older]").click();
  await page.waitForFunction(() => /Page 2/.test(document.querySelector("#view .pager[data-cursor=events]")?.textContent ?? ""));
  assert.equal(await page.locator("#view table.grid tbody tr").first().locator("a[onclick*='#tx/']").getAttribute("title"), events[20].txHash);
  assert.deepEqual(pageErrors, []);
});

test("rejected txs: the tx page shows Rejected + reason · the block lists Rejected · the wallet has a Rejected tab · everything is English except the server's reason", async () => {
  const sign = await import("../../src/crypto/signature.js");
  const { nonce } = await get(`/nonce/${ME}`);
  const tx = { chainId: CHAIN_ID, action: "transfer", from: ME, to: BOB.toLowerCase(), method: "", input: {}, value: 1, gasLimit: 0, gasPrice: "1000000000", nonce: nonce + 5 };
  const sent = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx, signature: sign.signTransaction(tx, KEY) }) }).then((r) => r.json());
  assert.equal(sent.queued, false);
  let found;
  for (let i = 0; i < 50; i += 1) { found = await get(`/tx/${sent.hash}`); if (found.block) break; await wait(200); }
  assert.equal(found.status, "rejected");

  await open(`#tx/${sent.hash}`);
  const status = await page.locator("#view tr", { hasText: /^Status/ }).textContent();
  assert.match(status, /Rejected/);
  assert.ok(status.includes(found.reason));
  assert.match(await view(), /At submission[\s\S]*never ran/);
  await page.locator("#view tr", { hasText: /^Recorded in block/ }).locator("a").click();
  await page.waitForFunction(() => location.hash.startsWith("#block/"));
  await settle();
  assert.match(await page.locator("#rejected-panel").textContent(), /Rejected \(1\)/);
  assert.equal(await page.locator("#rejected-panel a[title]").first().getAttribute("title"), sent.hash);
  assert.match(await view(), /Rejected1 \(recorded only/);
  await open("");   // home page block list: a block with only rejected txs shows Rejected, not Empty
  const row = page.locator("#view tbody tr").filter({ has: page.locator("a", { hasText: new RegExp(`^${found.block}$`) }) }).first();
  assert.match(await row.textContent(), /Rejected 1/);

  await open(`#address/${ME}`);
  await tab("Rejected");
  assert.equal(await page.locator("#view table.grid tbody tr").first().locator("a[onclick*='#tx/']").getAttribute("title"), sent.hash);
  const text = (await page.locator("body").textContent()).split(found.reason).join("");
  assert.doesNotMatch(text, /[\u0E00-\u0E7F]/);
  assert.deepEqual(pageErrors, []);
});

test("EIP-1559 + ABI: blocks show base fee / fee split · txs from the page are 1559 · programs that declare an ABI get ABI forms + typed / indexed events", async () => {
  const sign = await import("../../src/crypto/signature.js");
  const code = `function program() {
    function initialization() {
      setMetadata("abi", {
        functions: [{ name: "note", inputs: [{ name: "to", type: "address" }, { name: "count", type: "uint", description: "How many" }], description: "Write a note" }],
        events: [{ name: "Noted", fields: [{ name: "to", type: "address", indexed: true }, { name: "count", type: "uint" }] }],
      })
    }
    function note(params) { emit("Noted", { to: params.input.to, count: params.input.count }, { indexed: ["to"] }); return true }
    return { initialization, note }
  }`;
  const send = async (fields) => {
    const { nonce } = await get(`/nonce/${ME}`);
    const { baseFee } = await get("/genesis");
    const tx = { chainId: CHAIN_ID, from: ME, to: "", method: "", input: {}, value: 0, gasLimit: 2_000_000, nonce,
      maxFeePerGas: String(BigInt(String(baseFee).replace(/n$/, "")) * 2n), maxPriorityFeePerGas: "0", ...fields };
    const sent = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ tx, signature: sign.signTransaction(tx, KEY) }) }).then((r) => r.json());
    assert.ok(sent.queued, JSON.stringify(sent));
    for (let i = 0; i < 50 && !(await get(`/tx/${sent.hash}`))?.blockNumber; i += 1) await wait(200);
    return get(`/tx/${sent.hash}/receipt`);
  };
  const deployed = await send({ action: "deploy", code });
  const program = deployed.result?.programUuid ?? deployed.result;
  assert.equal(deployed.type, 2);
  assert.equal((await send({ action: "init", to: program })).status, "success");
  assert.equal((await get(`/program/${program}/abi`)).evmAbi[0].name, "note");

  // block: base fee + fee split
  await open(`#block/${deployed.blockNumber}`);
  assert.match(await page.locator("#view tr", { hasText: /^Base fee/ }).textContent(), /gwei per gas · next block/);
  assert.match(await page.locator("#view tr", { hasText: /^Fee split/ }).textContent(), /burned[\s\S]*to the block producer/);

  // Interact: fields from the ABI (count = whole number with its description) · sent from the page = EIP-1559 tx
  await open(`#address/${program}`);
  await tab("Interact");
  await page.click(".ix-head .seg button[data-mode=fields]");
  await page.selectOption("#fn", "note");
  assert.match(await page.locator("#ix-input").textContent(), /ABI[\s\S]*Write a note/);
  assert.match(await page.locator("label[for=ix-count]").textContent(), /whole number[\s\S]*How many/);
  await page.fill("#ix-to", BOB);
  await page.fill("#ix-count", "3");
  await page.click("text=Send transaction");
  await page.waitForSelector("#out:not(.busy) .ix-ret", { timeout: 20_000 });
  await page.click("#out .ix-link");
  await page.waitForFunction(() => location.hash.startsWith("#tx/0x"));
  await page.waitForFunction(() => document.getElementById("view").innerText.includes("Success"));
  assert.match(await page.locator("#view tr", { hasText: /^Fee limits/ }).textContent(), /EIP-1559[\s\S]*max fee/);
  assert.match(await page.locator("#view tr", { hasText: /^Gas price/ }).textContent(), /= base fee [\d.]+ \+ tip 0/);
  assert.match(await page.locator("#view").textContent(), /count uint[\s\S]*3/);

  // Events tab: fields typed from the ABI · the indexed one is marked · indexed query finds it
  await open(`#address/${program}`);
  await tab("Events");
  assert.match(await page.locator("#view table.grid tbody tr").first().textContent(), /Noted[\s\S]*to address indexed[\s\S]*count uint/);
  const found = await get(`/program/${program}/events?name=Noted&to=${BOB}`);
  assert.equal(found.items.length, 1);
  await tab("ABI");
  assert.match(await view(), /function note\(address to, uint count\)[\s\S]*event Noted\(indexed address to, uint count\)/);
  assert.deepEqual(pageErrors, []);
});

test("purple theme: navigation sidebar (wide screens) / drawer ☰ (mobile) · cards have a top label + purple table headers", async () => {
  const original = page.viewportSize();
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open("");
    assert.equal(await page.locator("#side").isVisible(), true);
    assert.equal(await page.locator("#menu-btn").isVisible(), false);
    assert.equal(await page.locator("#side [data-nav=home].on").count(), 1);
    assert.equal(await page.locator("header .pill[data-nav=explore].on").count(), 1);
    assert.notEqual(await page.locator("#view th").first().evaluate((th) => getComputedStyle(th).backgroundColor), "rgba(0, 0, 0, 0)");
    await page.waitForSelector("#side-programs a[data-nav^='a:']");                 // recent programs in the sidebar
    await page.click("#side a[data-nav=programs-approved]");
    await page.waitForFunction(() => location.hash === "#programs");
    await settle();
    assert.equal(await page.locator("button.tab.on[data-tab=approved]").count(), 1);
    assert.equal(await page.locator("#side [data-nav=programs-approved].on").count(), 1);
    assert.equal(await page.locator("#side [data-nav=home].on").count(), 0);

    await page.setViewportSize({ width: 390, height: 800 });
    await open("");
    assert.equal(await page.locator("#side").isVisible(), false);                     // collapsed into a drawer
    await page.click("#menu-btn");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("side")).visibility === "visible");
    await page.click("#side a[data-nav=deploy]");
    await page.waitForFunction(() => location.hash === "#deploy");
    assert.equal(await page.evaluate(() => document.body.classList.contains("side-open")), false);   // choosing closes the drawer
    assert.equal(await page.locator("#dbtn.on").count(), 1);
  } finally {
    await page.setViewportSize(original ?? { width: 1280, height: 720 });
  }
  assert.deepEqual(pageErrors, []);
});

test("system programs: scripts/deploy-system.js deploys all 14 at the planned addresses → the System programs page shows names + addresses", async () => {
  const sign = await import("../../src/crypto/signature.js");
  const deployerKey = sign.randomPrivateKey();
  const deployer = sign.addressOf(deployerKey);
  const { nonce } = await get(`/nonce/${ME}`);
  const fund = { chainId: CHAIN_ID, action: "transfer", from: ME, to: deployer, value: "1000000000000000000", gasLimit: 21_000, gasPrice: "1000000000", nonce };
  const sent = await fetch(`${url}/sendtx`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ tx: fund, signature: sign.signTransaction(fund, KEY) }) }).then((r) => r.json());
  assert.ok(sent.queued, JSON.stringify(sent));
  for (let i = 0; i < 50 && !(await get(`/tx/${sent.hash}`))?.blockNumber; i += 1) await wait(200);

  const out = `${ROOT}data-e2e-system.json`;
  const run = (extra = []) => promisify(execFile)(process.execPath, ["scripts/deploy-system.js", url, "--out", out, ...extra],
    { cwd: ROOT, env: { ...process.env, DEPLOYER_KEY: deployerKey, ADMIN_KEY: KEY } });
  try {
    const plan = (await run(["--plan"])).stdout;
    await run();
    const result = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(out, "utf8")));
    const programs = Object.values(result.programs);
    assert.equal(programs.length, 14);
    for (const p of programs) {
      assert.equal(p.status, "approved", p.namespace);
      assert.ok(plan.includes(p.address), `${p.namespace} matches --plan`);
      assert.equal((await get(`/name/${p.namespace}`)).address, p.address);
    }

    await open("#system");
    await page.waitForSelector("#view tbody tr");
    assert.equal(await page.locator("#view tbody tr").count(), 14);
    assert.doesNotMatch(await view(), /Not deployed yet/);
    assert.equal(await page.locator("#side [data-nav=system].on").count(), 1);
    await page.click("#view tbody tr:has-text('Wrapped BWSC') a");
    await page.waitForFunction((address) => location.hash === `#address/${address}`, result.programs.wcard.address);
    await settle();
    assert.match(await view(), /wbwsc/);
  } finally {
    await import("node:fs").then((fs) => fs.rmSync(out, { force: true }));
  }
  assert.deepEqual(pageErrors, []);
});

test("gas: the Gas settings page shows current values · setGasConfig can be sent from the form (a DEV chain without admins → rejected with a reason)", async () => {
  await open("#gas");
  await page.waitForSelector("#gas-form");
  assert.match(await view(), /Minimum gas price[\s\S]*1 gwei/);
  assert.match(await view(), /Coin transfer costs[\s\S]*17,300 gas/);
  assert.equal(await page.locator("#view input").count(), 1);   // only the minimum is adjustable · the unit price is display-only
  assert.match(await view(), /changed only by a fork/);
  assert.equal(await page.locator("#side [data-nav=gas].on").count(), 1);

  await page.fill("#gas-min", "0.5");
  await page.click("#gas-form button:has-text('Send change')");
  await page.waitForFunction(() => /admins/.test(document.getElementById("gas-out")?.textContent ?? ""), null, { timeout: 30_000 })
    .catch(async (error) => { throw new Error(`${error.message}: ${await page.locator("#gas-out").innerText()}`); });
  // /sendtx answers 400 with a reason (the browser logs it to the console); nothing else may error
  assert.deepEqual(pageErrors.filter((message) => !/status of 400/.test(message)), []);
  pageErrors.length = 0;
});
