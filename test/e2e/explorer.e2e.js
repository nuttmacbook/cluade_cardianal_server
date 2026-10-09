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
  assert.equal(await page.locator("#view a", { hasText: /^#1$/ }).count(), 1);
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
  assert.match(await page.locator("#storage-box").textContent(), /owner/);          // variable: key 1 ชั้น
  await page.click("#storage-panel [data-sub=contract] [role=button]");
  await page.waitForFunction(() => document.getElementById("storage-box").textContent.includes("balances / key"));

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
  assert.equal(await page.locator("#view .ico:not(.person):not(.program)").count(), 0);
  assert.deepEqual(pageErrors, []);
});

test("แถบข้อมูล: variable / contract (dropdown key แรก) / get storage (กรอก key ทีละชั้น + ปุ่ม +)", async () => {
  const { address } = await get("/name/mytoken");
  await open(`#address/${address}`);
  await tab("ข้อมูล");
  await page.click("#storage-panel .tab:has-text('variable')");                    // แถบที่เลือกไว้จากเทสต์ก่อนถูกจำไว้
  assert.match(await page.locator("#storage-box").textContent(), /owner/);
  await page.waitForSelector("#storage-box .ico.person");                          // ค่า owner เป็น address         // ค่า owner เป็น address

  await page.click("#storage-panel [data-sub=contract] [role=button]");
  await page.waitForFunction(() => document.getElementById("storage-box").textContent.includes("balances / key"));
  assert.match(await page.locator("#storage-box").textContent(), /แสดง \d+ จาก \d+ รายการ/);
  assert.equal(await page.locator("#storage-box tbody tr").count() >= 3, true);

  await page.click("#storage-panel .tab:has-text('get storage')");
  assert.equal(await page.locator("#gk-name option").allTextContents().then((o) => o.join()), "allowance");
  const parts = page.locator(".gk-part");
  await parts.nth(0).fill(wallet.address);                                        // ตัวพิมพ์ผสม
  await parts.nth(1).fill(BOB);
  await page.click("button[title='เพิ่มช่อง key']");
  assert.equal(await parts.count(), 3);
  assert.equal(await parts.nth(0).inputValue(), wallet.address);                  // กด + แล้วค่าที่กรอกไม่หาย
  await page.click("button[title='ลบช่อง key สุดท้าย']");
  assert.equal(await parts.count(), 2);
  await page.click("text=อ่านค่า");
  await page.waitForFunction(() => /allowance \/ 0x/.test(document.getElementById("storage-box").textContent));
  assert.match(await page.locator("#storage-box").textContent(), /300/);

  await parts.nth(1).fill("0x0000000000000000000000000000000000000001");
  await parts.nth(1).press("Enter");
  await page.waitForFunction(() => document.getElementById("storage-box").textContent.includes("ไม่มีค่า"));

  // แตะ dropdown ของ contract จากแถบอื่น → สลับไป contract ทันที
  await page.focus("#storage-panel [data-sub=contract] select");
  await page.waitForFunction(() => document.getElementById("storage-box").textContent.includes("balances / key"));
  assert.equal(await page.locator("#storage-panel [data-sub=contract].on").count(), 1);
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
  const out = JSON.parse(await page.locator("#out").innerText());
  assert.equal(out.status, "success");
  assert.match(out.result, /^\d+n$/);
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
