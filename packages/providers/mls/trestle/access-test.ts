import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { probeTrestleAccess } from "./access-probe";
import { TrestleError } from "./safety";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const validArgs =
    args.length === 0 ||
    (args.length === 1 && args[0] === "--access-test") ||
    (args.length === 3 && args[0] === "--access-test" && args[1] === "--config");
  if (!validArgs) throw new TrestleError("TRESTLE_ACCESS_ARGUMENTS_INVALID");
  const result = await probeTrestleAccess({
    enabled: args[0] === "--access-test",
    environment: process.env,
    readConfig: async () => {
      const path = resolve(args[2] ?? ".local/trestle-access.json");
      if ((await stat(path)).size > 65536) throw new TrestleError("TRESTLE_ACCESS_CONFIG_INVALID");
      const text = await readFile(path, "utf8");
      if (Buffer.byteLength(text, "utf8") > 65536) throw new TrestleError("TRESTLE_ACCESS_CONFIG_INVALID");
      try {
        return JSON.parse(text);
      } catch {
        throw new TrestleError("TRESTLE_ACCESS_CONFIG_INVALID");
      }
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

void main().catch((error) => {
  const code =
    error instanceof TrestleError && /^TRESTLE_[A-Z_]{1,60}$/.test(error.code)
      ? error.code
      : "TRESTLE_ACCESS_TEST_FAILED";
  process.stderr.write(
    `${JSON.stringify({ state: "failed", code, status: error instanceof TrestleError ? error.status : null, retryAfterSeconds: error instanceof TrestleError ? error.retryAfterSeconds : null })}\n`,
  );
  process.exitCode = 1;
});
