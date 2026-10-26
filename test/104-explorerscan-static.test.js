import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/*
 * หน้า explorer = โฟลเดอร์ explorerscan/ (index.html + theme/ + core/ + ui/) เสิร์ฟที่ /explorerscan/*
 *   "/" เสิร์ฟ index.html เดียวกัน + <base href="/explorerscan/"> · ออกนอกโฟลเดอร์ไม่ได้ · ทุก script ที่ index.html โหลดต้องมีจริง
 */

let server, url;
before(async () => {
  ({ server } = await import("../server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("/ และ /explorerscan/ ได้ index.html · / มี <base> ชี้โฟลเดอร์", async () => {
  const root = await fetch(`${url}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-type"), /text\/html/);
  assert.match(await root.text(), /<head><base href="\/explorerscan\/">/);
  const folder = await fetch(`${url}/explorerscan/`);
  assert.equal(folder.status, 200);
  assert.doesNotMatch(await folder.text(), /<base /);
  const bare = await fetch(`${url}/explorerscan`, { redirect: "manual" });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get("location"), "/explorerscan/");
});

test("ไฟล์ที่ index.html โหลดมีครบ และได้ content-type ถูก", async () => {
  const html = fs.readFileSync(new URL("../explorerscan/index.html", import.meta.url), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+\.(js|css))"/g)].map((m) => [m[1], m[2]]);
  assert.ok(refs.length >= 20, `โหลดไฟล์แค่ ${refs.length} ไฟล์`);
  for (const [file, ext] of refs) {
    const res = await fetch(`${url}/explorerscan/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type"), ext === "js" ? /text\/javascript/ : /text\/css/, file);
  }
  assert.equal(refs[0][0], "theme/colors.css");
  assert.equal(refs.find(([, ext]) => ext === "js")[0], "config.js", "config.js ต้องโหลดก่อน script อื่น");
  assert.equal(refs.at(-1)[0], "core/start.js", "core/start.js ต้องโหลดเป็นไฟล์สุดท้าย");
});

test("ออกนอกโฟลเดอร์ / ไฟล์ที่ไม่มี / ชนิดที่ไม่รู้จัก → 404", async () => {
  for (const path of ["/explorerscan/../server.js", "/explorerscan/%2e%2e/server.js", "/explorerscan/%2e%2e%2fpackage.json",
    "/explorerscan/nothing.js", "/explorerscan/core", "/explorerscan/%E0%A4%A", "/explorerscan/README.md"]) {
    const res = await fetch(`${url}${path}`);
    assert.equal(res.status, 404, path);
  }
});

test("OPTIONS ตอบ preflight ให้ explorer ที่โฮสต์แยกโดเมนส่ง POST แบบ JSON ได้", async () => {
  const res = await fetch(`${url}/sendtx`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers"), /content-type/);
});
