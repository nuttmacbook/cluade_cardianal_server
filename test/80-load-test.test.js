import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/*
 * dev/load-test.js --quick: a small set (20 txs · 1 + 2 blocks · native / token / mix · LMDB + memory) in-process
 * must finish with exit 0 · every tx lands in a block successfully · the JSON report has timings for every phase and the LMDB growth
 */

const ROOT = path.resolve(import.meta.dirname, "..");

test("load-test --quick: every workload × LMDB / memory closes all blocks and reports timings for every phase", { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "load-test-smoke-"));
  const out = path.join(dir, "report.json");
  const child = spawn(process.execPath, ["dev/load-test.js", "--quick", "--data-dir", dir, "--out", out], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on("close", resolve));
  try {
    assert.equal(code, 0, `load-test failed:\n${output.slice(-3000)}`);
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
      if (run.db === "lmdb") assert.ok(run.growth.usedBytes > 0 && run.bytesPerTx > 0, `${label}: LMDB must grow`);
    }
    // LMDB and memory run the same txs → same gas
    for (const workload of ["native", "token", "mix"]) {
      const [a, b] = report.runs.filter((run) => run.workload === workload);
      assert.equal(a.gasPerBlock, b.gasPerBlock, workload);
    }
    // removes its temporary LMDB folder itself when done
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith("load-test-")), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
