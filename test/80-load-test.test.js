import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * scripts/load-test.js --quick: ชุดเล็ก (20 tx · 1 + 2 block · native / token / mix · LMDB + memory) ในโปรเซส
 * ต้องจบด้วย exit 0 · ทุกใบเข้า block สำเร็จ · รายงาน JSON มีเวลาทุกช่วงและขนาด LMDB ที่โต
 */

const ROOT = path.resolve(import.meta.dirname, "..");

test("load-test --quick: ทุก workload × LMDB / memory ปิด block ได้ครบ และรายงานเวลาทุกช่วง", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-test-smoke-"));
  const out = path.join(dir, "report.json");
  const child = spawn(process.execPath, ["scripts/load-test.js", "--quick", "--data-dir", dir, "--out", out], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  try {
    assert.equal(code, 0, `load-test ล้ม:\n${output.slice(-3000)}`);
    assert.match(output, /close p50/);
    const report = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(report.runs.length, 6);   // 3 workload × 2 DB
    for (const run of report.runs) {
      const label = `${run.db} ${run.workload}`;
      assert.equal(run.measuredBlocks, 2, label);
      assert.equal(run.txPerBlock, 20, label);
      assert.equal(run.failedTxs, 0, label);
      assert.equal(run.rejectedAdds, 0, label);
      assert.ok(run.gasPerTx > 0, label);
      for (const field of ["addMs", "simMs", "takeMs", "rootsMs", "commitMs", "writeMs", "closeMs", "slotMs"]) {
        assert.ok(run.timing[field].p50 > 0 && run.timing[field].max >= run.timing[field].p95, `${label} ${field}`);
      }
      assert.ok(run.closeTxPerSec > 0 && run.closeGasPerSec > 0, label);
      if (run.db === "lmdb") assert.ok(run.growth.usedBytes > 0 && run.bytesPerTx > 0, `${label}: LMDB ต้องโต`);
    }
    // LMDB กับ memory รัน tx ชุดเดียวกัน → แก๊สเท่ากัน
    for (const workload of ["native", "token", "mix"]) {
      const [a, b] = report.runs.filter((run) => run.workload === workload);
      assert.equal(a.gasPerBlock, b.gasPerBlock, workload);
    }
    // ลบโฟลเดอร์ LMDB ชั่วคราวเองหลังจบ
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("load-test-")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
