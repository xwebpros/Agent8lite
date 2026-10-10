import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

const requested = process.argv.slice(2);
function batch(filters, report) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/test-isolated-batch.mjs", ...filters], {
      env: { ...process.env, ISOLATED_TEST_REPORT: report ?? "" },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === 0));
  });
}
async function main() {
  if (requested.length) {
    if (!(await batch(requested))) process.exitCode = 1;
    return;
  }
  const base = path.resolve(process.cwd(), ".local", "acceptance-reports");
  const name = `run_${randomBytes(8).toString("hex")}`;
  const directory = path.resolve(base, name);
  if (!/^run_[0-9a-f]{16}$/.test(name) || path.dirname(directory) !== base)
    throw new Error("Unsafe verification report directory.");
  const integration = (await readdir("tests/integration", { recursive: true }))
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => path.join("tests/integration", file));
  const scopedFiles = (
    await Promise.all(
      ["tests/cms", "tests/mls"].map(async (root) => {
        try {
          return (await readdir(root, { recursive: true }))
            .filter((file) => file.endsWith(".test.ts"))
            .map((file) => path.join(root, file));
        } catch (error) {
          if (error.code === "ENOENT") return [];
          throw error;
        }
      }),
    )
  )
    .flat()
    .sort();
  const scopedIntegration = scopedFiles.filter((file) => file.endsWith(".integration.test.ts"));
  const scopedUnit = scopedFiles.filter((file) => !file.endsWith(".integration.test.ts"));
  const suites = [
    ["tests/unit", "packages", ...scopedUnit],
    ...[...integration, ...scopedIntegration].map((file) => [file]),
  ];
  const totals = { files: 0, tests: 0, passed: 0, failed: 0, skipped: 0, failedBatches: 0 };
  await mkdir(directory, { recursive: true });
  try {
    for (const [index, filters] of suites.entries()) {
      console.log(`Isolated batch ${index + 1}/${suites.length}: ${filters.join(", ")}`);
      const report = path.join(directory, `${index}.json`);
      if (!(await batch(filters, report))) totals.failedBatches++;
      try {
        const result = JSON.parse(await readFile(report, "utf8"));
        totals.files += result.testResults.length;
        totals.tests += result.numTotalTests;
        totals.passed += result.numPassedTests;
        totals.failed += result.numFailedTests;
        totals.skipped += result.numPendingTests;
      } catch {
        console.error("Batch did not produce an acceptance report.");
        if (!totals.failedBatches) totals.failedBatches++;
      }
    }
    console.log(`Isolated acceptance: ${JSON.stringify(totals)}`);
    if (totals.failedBatches || totals.failed || totals.skipped) process.exitCode = 1;
  } finally {
    // Exact absolute parent/generated leaf were validated before this invocation created the directory.
    await rm(directory, { recursive: true, force: true });
  }
}
await main();
