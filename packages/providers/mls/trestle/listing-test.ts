import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { probeTrestleListing } from "./listing-probe";
import { listingInspectionHtml } from "./listing-report";
import { TrestleError } from "./safety";

const run = promisify(execFile);
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (
    !(
      args.length === 0 ||
      (args.length === 1 && args[0] === "--listing-test") ||
      (args.length === 3 && args[0] === "--listing-test" && args[1] === "--config")
    )
  )
    throw new TrestleError("TRESTLE_LISTING_ARGUMENTS_INVALID");
  const enabled = args[0] === "--listing-test" && process.env.TRESTLE_LISTING_TEST_ENABLED === "true";
  const configPath = resolve(args[2] ?? ".local/trestle-listing-test.json");
  let outputDirectory: string | null = null;
  if (enabled) {
    const local = resolve(".local");
    const localStat = await lstat(local);
    if (localStat.isSymbolicLink() || !localStat.isDirectory())
      throw new TrestleError("TRESTLE_OUTPUT_PATH_DENIED");
    outputDirectory = join(local, `trestle-listing-${Date.now()}`);
    const git = process.env.TRESTLE_GIT_EXECUTABLE ?? "git";
    try {
      const ignored = await run(git, [
        "check-ignore",
        "--",
        join(outputDirectory, "report.json"),
        join(outputDirectory, "report.html"),
      ]);
      if (ignored.stdout.trim().split(/\r?\n/).length !== 2) throw new Error();
    } catch {
      throw new TrestleError("TRESTLE_OUTPUT_NOT_IGNORED");
    }
    await mkdir(outputDirectory, { mode: 0o700 });
  }
  const result = await probeTrestleListing({
    enabled,
    environment: process.env,
    readConfig: async () => {
      if ((await stat(configPath)).size > 65536) throw new TrestleError("TRESTLE_LISTING_CONFIG_INVALID");
      const text = await readFile(configPath, "utf8");
      if (Buffer.byteLength(text, "utf8") > 65536) throw new TrestleError("TRESTLE_LISTING_CONFIG_INVALID");
      try {
        return JSON.parse(text.replace(/^\uFEFF/, ""));
      } catch {
        throw new TrestleError("TRESTLE_LISTING_CONFIG_INVALID");
      }
    },
  });
  if (result.state === "disabled") {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (!outputDirectory) throw new TrestleError("TRESTLE_OUTPUT_PATH_DENIED");
  const jsonPath = join(outputDirectory, "report.json");
  const htmlPath = join(outputDirectory, "report.html");
  await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await writeFile(htmlPath, listingInspectionHtml(result), { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ state: result.state, ...result.summary, jsonPath, htmlPath })}\n`);
}
void main().catch((error) => {
  const safe = error instanceof TrestleError;
  process.stderr.write(
    `${JSON.stringify({ state: "failed", code: safe ? error.code : "TRESTLE_LISTING_TEST_FAILED", status: safe ? error.status : null, retryAfterSeconds: safe ? error.retryAfterSeconds : null })}\n`,
  );
  process.exitCode = 1;
});
