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
import { Wallet } from "ethers";

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
const settle = () => page.waitForFunction(() => !document.getElementById("view").textContent.includes("กำลังโหลด"));
const view = () => page.locator("#view").textContent();   // textContent: ไม่โดน text-transform ของ CSS
const tab = async (label) => { await page.click(`button.tab:has-text('${label}')`); await settle(); };

test("หน้าแรก: ภาพรวม + รายการ block", async () => {
  await open("");
  const text = await view();
  assert.match(text, /block ล่าสุด/);
  assert.equal(await page.locator("#view a", { hasText: /^1$/ }).count(), 1);
  assert.ok(await page.locator("#view .ico.blk").count() >= 1);                  // เลข block มีไอคอนกล่อง
  assert.ok(await page.locator("#view .ico.gas").count() >= 1);                  // ค่าแก๊สมีไอคอนไฟ
  assert.deepEqual(pageErrors, []);
});

test("หน้า block: header + รายการ tx ที่ replay ได้", async () => {
  await open("#block/1");
  const text = await view();
  assert.match(text, /block #1/);
  assert.match(text, /transactions \(\d+\)/);
  assert.match(text, /deploy/);
  assert.deepEqual(pageErrors, []);
});

test("หน้า tx: ค้นด้วย hash ของระบบและ hash ที่ผู้ใช้เซ็นได้ทั้งคู่", async () => {
  const [first] = (await get(`/address/${ME}`)).transactions;
  const { digest } = await get(`/tx/${first.hash}`);
  for (const hash of [first.hash, digest]) {
    await open(`#tx/${hash}`);
    const text = await view();
    assert.match(text, /สำเร็จ/);
    assert.match(text, /hash ที่ผู้ใช้เซ็น/);
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

  await tab("event");
  assert.match(await view(), /Transfer/);

  await tab("ข้อมูล");
  assert.match(await page.locator("#storage-box").textContent(), /owner/);          // program info: key 1 ชั้น
  await page.click("#storage-panel [data-sub=storage]");
  await page.waitForSelector("#storage-box #map-name");

  await tab("โค้ด");
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
  await tab("ข้อมูล");
  await page.click("#storage-panel [data-sub=info]");                              // แถบที่เลือกไว้จากเทสต์ก่อนถูกจำไว้
  const info = await page.locator("#storage-box").textContent();
  for (const key of ["owner", "name", "ticker", "decimals", "totalSupply"]) assert.match(info, new RegExp(key));
  await page.waitForSelector("#storage-box .ico.person");                          // ค่า owner เป็น address
  assert.ok(await page.locator("#storage-box .kchip").count() >= 5);              // key เป็น badge

  await page.click("#storage-panel [data-sub=storage]");
  await page.waitForSelector("#storage-box thead #map-name");                      // dropdown อยู่ที่หัวตาราง
  assert.deepEqual(await page.locator("#map-name option").allTextContents(), ["balances (3)"]);
  assert.match(await page.locator("#storage-box").textContent(), /แสดง 3 จาก 3 รายการ/);

  await page.click("#storage-panel [data-sub=get]");
  assert.deepEqual(await page.locator("#gk-name option").allTextContents(), ["allowance"]);
  const parts = page.locator(".gk-part");
  await parts.nth(0).fill(wallet.address);                                        // ตัวพิมพ์ผสม
  await parts.nth(1).fill(BOB);
  await page.click("button[title='เพิ่มช่อง key']");
  assert.equal(await parts.count(), 3);
  const [y1, y2] = await Promise.all([parts.nth(1).boundingBox(), parts.nth(2).boundingBox()]);
  assert.ok(y2.y > y1.y, "ช่อง key เรียงลงมาแนวตั้ง");
  assert.equal(await parts.nth(0).inputValue(), wallet.address);                  // กด + แล้วค่าที่กรอกไม่หาย
  await page.click("button[title='ลบช่อง key สุดท้าย']");
  assert.equal(await parts.count(), 2);
  await page.click("#storage-box button:has-text('อ่านค่า')");
  await page.waitForSelector("#storage-box tbody .kchips");
  assert.equal(await page.locator("#storage-box tbody tr:first-child .kchip").count(), 3);
  assert.match(await page.locator("#storage-box tbody").textContent(), /300,000,000/);

  await parts.nth(1).fill("0x0000000000000000000000000000000000000001");
  await parts.nth(1).press("Enter");
  await page.waitForFunction(() => document.getElementById("storage-box").textContent.includes("ไม่มีค่า"));
  assert.deepEqual(pageErrors, []);
});

test("เหรียญที่ถือ: นับจาก event Transfer · ยอดแสดงตาม decimals (6) · ข้อมูล token บนหน้าโปรแกรม", async () => {
  await open(`#address/${BOB}`);
  await page.waitForSelector("#view button.tab.on:has-text('เหรียญที่ถือ')");        // แถบแรกของกระเป๋าที่มีเหรียญ
  const text = await view();
  assert.match(text, /MTK/);
  assert.match(text, /1,200\.5(?!\d)/);                                          // 1_200_500_000 หน่วย ÷ 10^6

  await open(`#address/${ME}`);
  assert.match(await view(), /998,799\.499993/);

  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  assert.match(await view(), /My Token/);
  assert.match(await view(), /6 decimals/);
  assert.match(await view(), /supply 1,000,000(?!\.)/);
  assert.deepEqual(pageErrors, []);
});

test("ข้อมูลแบบ { } อยู่ในกรอบดำแบบ JSON (input / event ของหน้า tx)", async () => {
  const { address } = await get("/name/mytoken");
  const [last] = (await get(`/address/${ME}`)).transactions;
  await open(`#tx/${last.hash}`);
  assert.ok(await page.locator("#view pre.json").count() >= 2);
  const bg = await page.locator("#view pre.json").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(bg, "rgb(4, 5, 13)");
  assert.match(await page.locator("#view pre.json").first().textContent(), /^\{\n  "/);
  // แถว block มีไอคอนกล่อง + เลข block ของ tx
  const blockRow = page.locator("#view tr", { hasText: /^block/ }).first();
  assert.equal(await blockRow.locator(".ico.blk").count(), 1);
  assert.equal(await blockRow.locator("a").textContent(), String((await get(`/tx/${last.hash}`)).blockNumber));
  assert.ok(address);
  assert.deepEqual(pageErrors, []);
});

test("อ่านค่าโปรแกรมจากฟอร์ม (ไม่ต้องเชื่อม wallet)", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("เรียกใช้โปรแกรม");
  await page.selectOption("#fn", "balanceOf");
  await page.fill("#args", JSON.stringify({ who: ME }));
  await page.click("text=อ่านค่า (ไม่เสียค่าแก๊ส)");
  await page.waitForFunction(() => document.getElementById("out").textContent.includes('"status"'));
  const out = JSON.parse(await page.locator("#out").innerText());                 // แสดงเป็น JSON (ตัวเลข bigint ไม่มี n)
  assert.equal(out.status, "success");
  assert.equal(typeof out.result, "number");
});

test("ส่ง tx ผ่าน wallet: ลายเซ็นจากหน้าเว็บผ่าน /sendtx และเข้า block (address ใน input เป็นตัวพิมพ์ผสม)", async () => {
  const { address } = await get("/name/mytoken");
  const before = (await get(`/program/${address}/storage?prefix=balances`)).items;
  const bobBefore = before.find((s) => s.key[1] === BOB.toLowerCase())?.value ?? "0n";

  await open(`#address/${address}`);
  await tab("เรียกใช้โปรแกรม");
  await page.selectOption("#fn", "transfer");
  await page.fill("#args", JSON.stringify({ to: BOB, amount: "7n" }));
  await page.click("text=ส่ง transaction");
  await page.waitForFunction(() => /"queued"/.test(document.getElementById("out").textContent));
  const out = JSON.parse(await page.locator("#out").innerText());
  assert.equal(out.queued, true, JSON.stringify(out));
  assert.equal(out.sender, ME);

  await page.waitForFunction((hash) => location.hash === `#tx/${hash}`, out.hash, { timeout: 10_000 });
  for (let i = 0; i < 50 && !(await get(`/tx/${out.hash}`)).blockNumber; i += 1) await wait(200);
  await page.reload();
  await page.waitForFunction(() => document.getElementById("view").innerText.includes("สำเร็จ"));
  assert.match(await view(), /transfer/);

  const after = (await get(`/program/${address}/storage?prefix=balances`)).items;
  const bobAfter = after.find((s) => s.key[1] === BOB.toLowerCase()).value;
  assert.equal(BigInt(bobAfter.slice(0, -1)) - BigInt(bobBefore.slice(0, -1)), 7n);
  assert.deepEqual(pageErrors, []);
});

test("responsive: จอ 180px ถึง PC ไม่มีอะไรล้นจอหรือถูกตัด · มือถือแสดงตารางเป็นการ์ดที่มีชื่อคอลัมน์", async () => {
  const { address: token } = await get("/name/mytoken");
  const [last] = (await get(`/address/${ME}`)).transactions;
  const pages = [["#", null], [`#tx/${last.hash}`, null], [`#address/${BOB}`, null],
    [`#address/${token}`, "#view button.tab:has-text('เรียกใช้โปรแกรม')"], [`#address/${token}`, "#storage-panel [data-sub=storage]"]];
  const original = page.viewportSize();
  try {
    for (const width of [180, 240, 360, 768, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [hash, action] of pages) {
        await open(hash);
        if (action) { if (action.includes("storage-panel")) await page.click("#view button.tab:has-text('ข้อมูล')"); await page.click(action); }
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
    assert.equal(await cell.getAttribute("data-label"), "block");
    assert.equal(await cell.evaluate((td) => getComputedStyle(td).display), "grid");
    assert.equal(await page.locator("#view table.grid thead th").first().isVisible(), false);
  } finally {
    await page.setViewportSize(original ?? { width: 1280, height: 720 });
  }
  assert.deepEqual(pageErrors, []);
});
