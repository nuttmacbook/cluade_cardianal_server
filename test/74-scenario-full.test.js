import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * scripts/scenario-full.js --spawn --quick: เปิด server.js จริง (MemoryDB · BLOCK_MS 300 · UPGRADE_DELAY_BLOCKS 2)
 * แล้วไล่ทุกฟังก์ชันของเชน (token / NFT / multi-token / ERC-1271 / multicall / upgrade / clone / API / แก๊ส / /evm / REST / sync)
 * ต้องจบด้วย exit code 0 และรายงานไม่มีข้อที่ไม่ผ่าน
 */

const ROOT = path.resolve(import.meta.dirname, "..");

test("scenario-full --spawn --quick: ทุกข้อผ่าน (exit 0)", { timeout: 240_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scenario-full-"));
  const out = path.join(dir, "report.json");
  const env = { ...process.env };
  for (const name of ["BLOCK_MS", "UPGRADE_DELAY_BLOCKS", "DATA", "PORT", "ADMINS", "GAS_TARGET", "GAS_PRICE"]) delete env[name];
  const child = spawn(process.execPath, ["scripts/scenario-full.js", "--spawn", "--quick", "--tag", `test-${process.pid}`, "--out", out], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  const failed = output.split("\n").filter((line) => line.includes("❌")).join("\n");
  assert.equal(code, 0, `scenario-full ล้ม:\n${failed || output.slice(-3000)}`);
  const report = JSON.parse(fs.readFileSync(out, "utf8"));
  assert.equal(report.summary.failed, 0);
  assert.ok(report.summary.passed >= 250, `ตรวจได้แค่ ${report.summary.passed} ข้อ`);
  for (const section of ["0 ", "1 ", "4 ", "5 ", "6 ", "11 ", "13 ", "15 ", "17 "]) {
    assert.ok(report.checks.some((c) => c.section.startsWith(section) && c.ok && !c.skipped), `ไม่มีผลของหัวข้อ ${section}`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
