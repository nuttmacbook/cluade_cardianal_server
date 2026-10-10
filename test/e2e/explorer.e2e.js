/**
 * explorer ในเบราว์เซอร์จริง (Chromium ผ่าน Playwright) กับ server จริง
 *   npm run test:e2e
 *
 * wallet ถูกจำลองด้วย window.ethereum ที่เซ็นด้วย ethers.Wallet.signTypedData
 * → เซ็นข้อมูลที่หน้าเว็บประกอบเองทุกตัวอักษร เหมือน MetaMask (ไม่ได้ประกอบใหม่ฝั่ง Node)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { chromium } from "playwright";
import { Wallet, JsonRpcProvider, Contract } from "ethers";

const ROOT = new URL("../../", import.meta.url).pathname;
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";  // มียอดใน genesis.json
const wallet = new Wallet(KEY);
const ME = wallet.address.toLowerCase();
const BOB = "0xFABB0ac9d68B0B445fB7357272Ff202C5651694a";                          // ตัวพิมพ์ผสมแบบ checksum

let server, browser, page, url;
const pageErrors = [];

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const get = (path) => fetch(url + path).then((r) => r.json());
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  const port = await freePort();
  url = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), BLOCK_MS: "300" }, stdio: "pipe" });
  for (let i = 0; i < 50; i += 1) {
    if (await fetch(`${url}/genesis`).then(() => true, () => false)) break;
    await wait(100);
  }
  // ข้อมูลตั้งต้น: โทเคน "mytoken" + tx ทุกประเภท
  await promisify(execFile)(process.execPath, ["scripts/seed.js", url], { cwd: ROOT });

  browser = await chromium.launch();
  const context = await browser.newContext();
  await context.exposeFunction("__signTypedData", (json) => {
    const { domain, types, message } = JSON.parse(json);
    const { EIP712Domain, ...rest } = types;          // ethers สร้าง EIP712Domain เอง
    return wallet.signTypedData(domain, rest, message);
  });
  await context.addInitScript((account) => {
    window.ethereum = {
      request: async ({ method, params }) => {
        if (method === "eth_requestAccounts") return [account];
        if (method === "eth_signTypedData_v4") return window.__signTypedData(params[1]);
        throw new Error(`ไม่รองรับ ${method}`);
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
const view = () => page.locator("#view").textContent();   // textContent: ไม่โดน text-transform ของ CSS
const tab = async (label) => { await page.click(`button.tab:has-text('${label}')`); await page.waitForSelector(`button.tab.on:has-text('${label}')`); await settle(); };

test("หน้าแรก: ภาพรวม + รายการ block", async () => {
  await open("");
  const text = await view();
  assert.match(text, /Latest blocks/);
  assert.equal(await page.locator("#view a", { hasText: /^1$/ }).count(), 1);
  assert.ok(await page.locator("#view .ico.blk").count() >= 1);                  // เลข block มีไอคอนกล่อง
  assert.ok(await page.locator("#view .ico.gas").count() >= 1);                  // ค่าแก๊สมีไอคอนไฟ
  assert.deepEqual(pageErrors, []);
});

test("หน้า block: header + รายการ tx ที่ replay ได้", async () => {
  await open("#block/1");
  const text = await view();
  assert.match(text, /Block #1/);
  assert.match(text, /Transactions \(\d+\)/);
  assert.match(text, /deploy/);
  assert.deepEqual(pageErrors, []);
});

test("หน้า tx: ค้นด้วย hash ของระบบและ hash ที่ผู้ใช้เซ็นได้ทั้งคู่", async () => {
  const [first] = (await get(`/address/${ME}`)).transactions;
  const { digest } = await get(`/tx/${first.hash}`);
  for (const hash of [first.hash, digest]) {
    await open(`#tx/${hash}`);
    const text = await view();
    assert.match(text, /Success/);
    assert.match(text, /Signed hash/);
  }
  assert.deepEqual(pageErrors, []);
});

test("ค้นหาด้วยชื่อ → หน้าโปรแกรม พร้อมแท็บ event / ข้อมูล / โค้ด", async () => {
  await open("");
  await page.fill("#q", "mytoken");
  await page.press("#q", "Enter");
  await page.waitForFunction(() => location.hash.startsWith("#address/"));
  await settle();
  assert.match(await view(), /mytoken/);

  await tab("Events");
  assert.match(await view(), /Transfer/);

  await tab("Storage");
  assert.match(await page.locator("#storage-box").textContent(), /owner/);          // program info: key 1 ชั้น
  await page.click("#storage-panel [data-sub=storage]");
  await page.waitForSelector("#storage-box #map-name");

  await tab("Code");
  assert.match(await view(), /function program\(\)/);
  assert.deepEqual(pageErrors, []);
});

test("ไอคอน address: โปรแกรม = คอมพิวเตอร์ · กระเป๋า = คน", async () => {
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

test("แถบข้อมูล: program info / storage (dropdown ที่หัวตาราง) / get storage (key แนวตั้ง + ปุ่ม +)", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Storage");
  await page.click("#storage-panel [data-sub=info]");                              // แถบที่เลือกไว้จากเทสต์ก่อนถูกจำไว้
  const info = await page.locator("#storage-box").textContent();
  for (const key of ["owner", "name", "ticker", "decimals", "totalSupply"]) assert.match(info, new RegExp(key));
  await page.waitForSelector("#storage-box .ico.person");                          // ค่า owner เป็น address
  assert.ok(await page.locator("#storage-box .kchip").count() >= 5);              // key เป็น badge

  await page.click("#storage-panel [data-sub=storage]");
  await page.waitForSelector("#storage-box thead #map-name");                      // dropdown อยู่ที่หัวตาราง
  assert.deepEqual(await page.locator("#map-name option").allTextContents(), ["balances (63)"]);
  assert.match(await page.locator("#storage-box").textContent(), /Showing 1–25 of 63/);

  await page.click("#storage-panel [data-sub=get]");
  assert.deepEqual(await page.locator("#gk-name option").allTextContents(), ["allowance"]);
  const parts = page.locator(".gk-part");
  await parts.nth(0).fill(wallet.address);                                        // ตัวพิมพ์ผสม
  await parts.nth(1).fill(BOB);
  await page.click("button[title='Add a key part']");
  assert.equal(await parts.count(), 3);
  const [y1, y2] = await Promise.all([parts.nth(1).boundingBox(), parts.nth(2).boundingBox()]);
  assert.ok(y2.y > y1.y, "ช่อง key เรียงลงมาแนวตั้ง");
  assert.equal(await parts.nth(0).inputValue(), wallet.address);                  // กด + แล้วค่าที่กรอกไม่หาย
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

test("เหรียญที่ถือ: นับจาก event Transfer · ยอดแสดงตาม decimals (6) · ข้อมูล token บนหน้าโปรแกรม", async () => {
  await open(`#address/${BOB}`);
  await page.waitForSelector("#view button.tab.on:has-text('Tokens')");        // แถบแรกของกระเป๋าที่มีเหรียญ
  const text = await view();
  assert.match(text, /MTK/);
  assert.match(text, /1,200\.5(?!\d)/);                                          // 1_200_500_000 หน่วย ÷ 10^6

  await open(`#address/${ME}`);
  assert.match(await view(), /998,799\.499933/);

  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  assert.match(await view(), /My Token/);
  assert.match(await view(), /6 decimals/);
  assert.match(await view(), /supply 1,000,000(?!\.)/);
  assert.deepEqual(pageErrors, []);
});

test("ข้อมูลแบบ { } อยู่ในกรอบดำแบบ JSON (input / event ของหน้า tx)", async () => {
  const { address } = await get("/name/mytoken");
  const [last] = (await get(`/address/${ME}/txs?limit=1`)).items;   // tx ล่าสุดของ seed: โปรแกรมเรียกโปรแกรม
  await open(`#tx/${last.hash}`);
  assert.ok(await page.locator("#view pre.json").count() >= 2);
  const bg = await page.locator("#view pre.json").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(bg, "rgb(4, 5, 13)");
  assert.match(await page.locator("#view pre.json").first().textContent(), /^\{\n  "/);
  // แถว block มีไอคอนกล่อง + เลข block ของ tx
  const blockRow = page.locator("#view tr", { hasText: /^Block/ }).first();
  assert.equal(await blockRow.locator(".ico.blk").count(), 1);
  assert.equal(await blockRow.locator("a").textContent(), String((await get(`/tx/${last.hash}`)).blockNumber));
  assert.ok(address);
  assert.deepEqual(pageErrors, []);
});

test("อ่านค่าโปรแกรมจากฟอร์ม (ไม่ต้องเชื่อม wallet)", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Interact");
  await page.click(".ix-head .seg button[data-mode=fields]");
  await page.selectOption("#fn", "balanceOf");
  await page.fill("#ix-who", ME);                                                   // ช่องกรอกที่เดาจาก params.input.who
  await page.evaluate(() => { window.__swaps = 0; new MutationObserver((ms) => { for (const m of ms) if (m.target.id === "view") window.__swaps += 1; })
    .observe(document.getElementById("view"), { childList: true }); });
  await page.click("text=Read (no gas)");
  await page.waitForSelector("#out .ix-ret");
  const { balance } = await get(`/address/${address}`).then(() => get(`/token/${address}/holders?limit=100`))
    .then((h) => h.items.find((x) => x.address === ME.toLowerCase()) ?? { balance: "0n" });
  assert.match(await page.locator("#out .ix-status").innerText(), /Success[\s\S]*Read · balanceOf\(\)/);
  assert.equal(await page.locator("#out .ix-ret .mono").innerText(), BigInt(String(balance).replace(/n$/, "")).toLocaleString("en-US")); // ค่าที่ return จริง
  assert.equal(await page.locator("#out details.ix-full").getAttribute("open"), null);   // ข้อมูลเต็มพับไว้
  const full = JSON.parse(await page.locator("#out details.ix-full pre").textContent());
  assert.equal(full.status, "success");
  assert.equal(typeof full.result, "number");
  assert.equal(await page.evaluate(() => window.__swaps), 0, "กด Read แล้วหน้าไม่ถูกวาดใหม่");
  assert.equal(await page.locator("#fn").inputValue(), "balanceOf");
});

test("Interact: สร้างช่องกรอกจาก params.input ของฟังก์ชันที่เลือก · สลับ Fields ↔ JSON แล้วค่าไม่หาย", async () => {
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
  assert.deepEqual(JSON.parse(await page.inputValue("#args")), { to: BOB, amount: "7n" });   // ตัวเลขกลายเป็น bigint "7n"
  await page.fill("#args", JSON.stringify({ to: BOB, amount: "9n", memo: "hi" }));
  await page.click(".ix-head .seg button[data-mode=fields]");
  assert.equal(await page.inputValue("#ix-amount"), "9");
  assert.match(await page.locator("#ix-input").innerText(), /Also sent from the JSON: memo/);

  await page.fill("#ix-amount", "1.5");
  await page.click("text=Read (no gas)");
  assert.match(await page.locator("#out .ix-ret").innerText(), /amount must be a whole number/);

  await page.selectOption("#fn", "multiTransfer");                                     // list ของ object: ตัวอย่างจาก item.to / item.amount
  assert.deepEqual(await fields(), ["transfers:list"]);
  assert.deepEqual(JSON.parse(await page.getAttribute("#ix-transfers", "placeholder")), [{ to: "0x…", amount: 1 }]);
  await page.selectOption("#fn", "balanceOf");
  assert.deepEqual(await fields(), ["who:address"]);
  await page.selectOption("#fn", "totalSupply");
  assert.match(await page.locator("#ix-input").innerText(), /reads nothing from params.input/);
  assert.deepEqual(pageErrors, []);
});

test("ส่ง tx ผ่าน wallet: ลายเซ็นจากหน้าเว็บผ่าน /sendtx และเข้า block (address ใน input เป็นตัวพิมพ์ผสม)", async () => {
  const { address } = await get("/name/mytoken");
  const before = (await get(`/program/${address}/storage?prefix=balances&limit=200`)).items;
  const bobBefore = before.find((s) => s.key[1] === BOB.toLowerCase())?.value ?? "0n";

  await open(`#address/${address}`);
  await tab("Interact");
  await page.selectOption("#fn", "transfer");
  await page.click(".ix-head .seg button[data-mode=json]");                         // แบบ JSON เดิมยังใช้ได้
  await page.fill("#args", JSON.stringify({ to: BOB, amount: "7n" }));
  await page.click("text=Send transaction");
  // อยู่หน้าเดิม: รอเข้า block แล้วโชวค่าที่ return (transfer คืน true) + ข้อมูลเต็มแบบพับ
  await page.waitForSelector("#out:not(.busy) .ix-ret", { timeout: 20_000 });
  assert.match(await page.locator("#out .ix-status").innerText(), /Success[\s\S]*Transaction · transfer\(\) · block/);
  assert.equal(await page.locator("#out .ix-ret .mono").innerText(), "true");
  const receipt = JSON.parse(await page.locator("#out details.ix-full pre").textContent());
  assert.equal(receipt.from, ME);
  assert.equal(receipt.method, "transfer");

  await page.click("#out .ix-link");                                                 // ลิงก์ไปหน้า tx
  await page.waitForFunction(() => location.hash.startsWith("#tx/0x"));
  await page.waitForFunction(() => document.getElementById("view").innerText.includes("Success"));
  assert.match(await view(), /transfer/);
  assert.match(await page.locator("#view tr", { hasText: /^Return value/ }).innerText(), /true/);

  const after = (await get(`/program/${address}/storage?prefix=balances&limit=200`)).items;
  const bobAfter = after.find((s) => s.key[1] === BOB.toLowerCase()).value;
  assert.equal(BigInt(bobAfter.slice(0, -1)) - BigInt(bobBefore.slice(0, -1)), 7n);
  assert.deepEqual(pageErrors, []);
});

test("responsive: จอ 180px ถึง PC ไม่มีอะไรล้นจอหรือถูกตัด · มือถือแสดงตารางเป็นการ์ดที่มีชื่อคอลัมน์", async () => {
  const { address: token } = await get("/name/mytoken");
  const [last] = (await get(`/address/${ME}/txs?limit=1`)).items;   // tx ล่าสุดของ seed: โปรแกรมเรียกโปรแกรม
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
          if (document.documentElement.scrollWidth > vw + 1) found.push(`หน้าเลื่อนข้าง ${document.documentElement.scrollWidth}`);
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
    // มือถือ: ตาราง block ล่าสุดเป็นการ์ด แต่ละช่องมีชื่อคอลัมน์
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

test("metadata: information (ไอคอนสี่เหลี่ยม + namespace) และ links (url / contact เปิดออกไปข้างนอก) · โปรแกรมไม่มีปุ่มแก้ไข", async () => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { address: token } = await get("/name/mytoken");
  await open(`#address/${token}`);
  const info = page.locator("#meta-info");
  assert.match(await info.locator(".avatar img").getAttribute("src"), /^data:image\/svg\+xml/);
  const box = await info.locator(".avatar").boundingBox();
  assert.equal(Math.round(box.width), Math.round(box.height));                      // สี่เหลี่ยมจัตุรัส
  assert.match(await info.textContent(), /mytoken/);
  assert.equal(await info.locator("button").count(), 0);                             // โปรแกรมตั้ง metadata จากโค้ดเท่านั้น
  assert.equal(await page.locator("button.tab[data-tab=meta]").count(), 0);         // ไม่มีแถบแก้ metadata
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

test("metadata: เจ้าของกระเป๋ากดตั้งค่าเองได้ (เซ็นด้วย wallet) · ลิงก์อันตรายไม่ถูกส่ง · กระเป๋าคนอื่นแก้ไม่ได้", async () => {
  await open(`#address/${BOB}`);
  await tab("Edit metadata");                                                        // แก้ metadata อยู่ในแถบเดียวกับ Interact
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
    { url: "https://me.example", contact: "me@example.com", icon: "🦊", namespace: "alice" });   // ช่องที่ไม่เปลี่ยนไม่ถูกส่ง

  await open(`#address/${ME}`);
  assert.equal(await page.locator("#view a.ext").nth(1).getAttribute("href"), "mailto:me@example.com");
  assert.deepEqual(pageErrors, []);
});

test("แบ่งหน้า: ผู้ถือ token กดเลขหน้า / ถัดไป / ข้ามไปหน้าที่พิมพ์ได้ · ยอดเรียงมากไปน้อย", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("Holders");
  const pager = page.locator("#view .pager");
  assert.match(await pager.textContent(), /Showing 1–25 of 63/);
  assert.deepEqual(await pager.locator(".pg").allTextContents(), ["‹", "1", "2", "3", "›", "Go"]);
  assert.match(await page.locator("#view table.grid tbody tr").first().textContent(), /998,799\.4999/);   // เทสต์ก่อนหน้าโอนออกไปแล้ว 7 หน่วย

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

test("address ย่อเป็น 0x + 4 ตัวหน้า … 4 ตัวหลัง · ทั้งหน้าเป็นภาษาอังกฤษ", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  const short = await page.locator("#view table.grid tbody a[title]").first().textContent();
  assert.match(short, /^0x[0-9a-f]{4}…[0-9a-f]{4}$/);
  for (const hash of ["", `#address/${address}`, "#block/2"]) {
    await open(hash);
    const text = (await page.locator("body").textContent()).replace(/เหรียญตัวอย่าง|ผู้ใช้คนแรก/g, "");   // คำอธิบายใน metadata เป็นข้อมูลของผู้ใช้
    assert.doesNotMatch(text, /[\u0E00-\u0E7F]/, hash);
  }
  assert.deepEqual(pageErrors, []);
});

test("trace การเรียกโปรแกรม: แผนผังต้นไม้กล่องเลขลำดับเล็ก ๆ อยู่กึ่งกลาง + ลูกศรตามลำดับ · กดกล่องแล้วรายละเอียดของ call นั้นโชวด้านล่าง", async () => {
  let relay;
  for (const t of (await get(`/address/${ME}/txs?limit=50`)).items) {
    if ((await get(`/tx/${t.hash}/receipt`)).trace?.length === 2) { relay = t; break; }
  }
  await open(`#tx/${relay.hash}`);
  // แถว Return value = ค่าที่โปรแกรม return เต็ม ๆ แบบเดียวกับผล Read
  assert.equal((await page.locator("#view tr", { hasText: /^Return value/ }).locator("td").last().innerText()).trim(), "1,200,500,000");
  const nodes = page.locator("#view .flow .node[data-call]");
  assert.equal(await nodes.count(), 2);
  assert.equal(await page.locator("#view .flow .node.start").count(), 1);              // กล่องผู้ส่ง tx
  assert.equal(await page.locator("#view .flow svg path[marker-end]").count(), 2);     // ลูกศร ผู้ส่ง→#1 และ #1→#2
  assert.deepEqual(await nodes.allTextContents(), ["1", "2"]);                         // กล่องโชวแค่เลขลำดับ
  const [w, h] = await nodes.nth(0).evaluate((n) => [n.offsetWidth, n.offsetHeight]);
  assert.ok(w <= 32 && h <= 32, `กล่องเล็ก (${w}×${h})`);
  const [a, b] = await Promise.all([nodes.nth(0).boundingBox(), nodes.nth(1).boundingBox()]);
  assert.ok(b.y > a.y && Math.abs(b.x - a.x) < 1, "ต้นไม้บนลงล่าง: call ที่ถูกเรียกอยู่ใต้ผู้เรียกตรงกลาง");
  const [wrap, start] = await Promise.all([page.locator("#view .flowwrap").boundingBox(), page.locator("#view .flow .node.start").boundingBox()]);
  assert.ok(Math.abs(start.x + start.width / 2 - (wrap.x + wrap.width / 2)) <= 2, "แผนผังอยู่กึ่งกลางกรอบ");
  const [flow, side] = await Promise.all([page.locator("#view .flowwrap").boundingBox(), page.locator("#call-detail").boundingBox()]);
  assert.ok(side.x >= flow.x + flow.width && side.y < flow.y + flow.height, "จอกว้าง: รายละเอียดอยู่ข้างขวาแผนผัง");
  assert.ok(Math.abs(side.height - flow.height) <= 1, `กล่องรายละเอียดสูงเท่าแผนผัง (${side.height} vs ${flow.height})`);

  // เริ่มต้นโชวรายละเอียดของ #1 เท่านั้น
  const detail = page.locator("#call-detail");
  assert.equal(await page.locator("#view .call").count(), 1);
  assert.match(await detail.textContent(), /Call #1[\s\S]*\.check\(\)[\s\S]*Input[\s\S]*"who"[\s\S]*Result[\s\S]*1,200,500,000/);
  await nodes.nth(1).click();
  assert.match(await detail.textContent(), /Call #2[\s\S]*depth 1[\s\S]*mytoken[\s\S]*\.balanceOf\(\)[\s\S]*Origin/);
  assert.equal(await page.locator("#view .flow .node.on").getAttribute("data-call"), "1");
  assert.deepEqual(pageErrors, []);
});

test("เวลา: ทุกจุดที่บอก ... ago มีวันเวลา UTC ตัวเล็ก · จอกว้างถึงวินาที จอแคบถึงนาที", async () => {
  const { address } = await get("/name/mytoken");
  const latest = await get("/block/latest");
  const stamp = new Date(latest.timestamp).toISOString();
  for (const hash of ["", `#address/${address}`, `#block/${latest.number}`]) {
    await open(hash);
    if (hash.startsWith("#address")) await tab("Calls");
    const smalls = page.locator("#view .utc");
    assert.ok(await smalls.count() > 0, `มี UTC ใน ${hash || "หน้าแรก"}`);
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

test("Calls ของโปรแกรม: call ซ้อนที่ล้มแต่ชั้นบน catch ไว้ → Status = Success ตรงกับหน้า tx + ข้อความเตือนสีส้ม ⚠ caught", async () => {
  const { address: token } = await get("/name/mytoken");
  await open(`#address/${token}`);
  await tab("Calls");
  const row = page.locator("#view tr", { hasText: "⚠ caught" });
  assert.equal(await row.count(), 1);
  assert.equal(await row.locator(".warn").evaluate((n) => getComputedStyle(n).color), "rgb(251, 146, 60)");   // ส้ม ไม่ใช่แดง
  assert.match(await row.textContent(), /Nested · depth 1[\s\S]*transfer[\s\S]*Success/);
  await row.locator("a[title^='0x']").first().click();
  await page.waitForFunction(() => location.hash.startsWith("#tx/0x"));
  await settle();
  assert.match(await page.locator("#view tr", { hasText: /^Status/ }).textContent(), /Success/);
});

test("/evm: ethers JsonRpcProvider ต่อกับเชนได้ (chainId, block, ยอด, tx, receipt, ERC-20) · ส่ง tx ไม่ได้ · ลิงก์ explorer ของกระเป๋าพาไปหน้าเดิม", async () => {
  const provider = new JsonRpcProvider(`${url}/evm`);
  const genesis = await get("/genesis");
  assert.equal((await provider.getNetwork()).chainId, BigInt(genesis.chainId));
  const latest = await provider.getBlock("latest");
  assert.ok(latest.number >= 1 && latest.timestamp < Date.now() / 1000 + 5);
  const native = (await get(`/address/${ME}`)).native.balance;
  assert.equal(await provider.getBalance(ME), BigInt(native) * 10n ** 18n);
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

