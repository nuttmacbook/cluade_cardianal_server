import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/*
 * the explorer = the explorerscan/ folder (index.html + theme/ + core/ + ui/) served at /explorerscan/*
 *   "/" serves the same index.html + <base href="/explorerscan/"> · no escaping the folder · every script index.html loads must exist
 */

let server, url;
before(async () => {
  process.env.GAS_PRICE ??= "1000000000";   // this test uses the dev gas price of 1 gwei (the chain default of 10,000 gwei is tested in 107)
  ({ server } = await import("../server.js"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

test("/ and /explorerscan/ return index.html · / has a <base> pointing at the folder", async () => {
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

test("every file index.html loads exists and has the right content-type", async () => {
  const html = fs.readFileSync(new URL("../explorerscan/index.html", import.meta.url), "utf8");
  const refs = [...html.matchAll(/(?:src|href)="([^"#:]+\.(js|css))"/g)].map((m) => [m[1], m[2]]);
  assert.ok(refs.length >= 20, `only ${refs.length} files loaded`);
  for (const [file, ext] of refs) {
    const res = await fetch(`${url}/explorerscan/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers.get("content-type"), ext === "js" ? /text\/javascript/ : /text\/css/, file);
  }
  assert.equal(refs[0][0], "theme/colors.css");
  assert.equal(refs.find(([, ext]) => ext === "js")[0], "config.js", "config.js must load before other scripts");
  assert.equal(refs.at(-1)[0], "core/start.js", "core/start.js must load last");
});

test("outside the folder / missing file / unknown type → 404", async () => {
  for (const path of ["/explorerscan/../server.js", "/explorerscan/%2e%2e/server.js", "/explorerscan/%2e%2e%2fpackage.json",
    "/explorerscan/nothing.js", "/explorerscan/core", "/explorerscan/%E0%A4%A", "/explorerscan/README.md"]) {
    const res = await fetch(`${url}${path}`);
    assert.equal(res.status, 404, path);
  }
});

test("OPTIONS answers preflight so an explorer hosted on another domain can send JSON POSTs", async () => {
  const res = await fetch(`${url}/sendtx`, { method: "OPTIONS" });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-headers"), /content-type/);
});
