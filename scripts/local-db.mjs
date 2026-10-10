import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import pg from "pg";

// Local synthetic cluster only. Never reads or modifies another installation.
if (process.platform !== "win32") throw new Error("Use docker compose on non-Windows hosts.");
const require = createRequire(import.meta.url);
const workspace = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = path.join(workspace, ".local");
const binRoot = path.join(root, "postgres");
const dataRoot = path.join(root, "pgdata");
const extensionRoot = path.join(root, "postgis", "postgis-bundle-pg17-3.6.2x64");
const native = path.resolve(path.dirname(require.resolve("@embedded-postgres/windows-x64")), "../native");
const command = process.argv[2] ?? "start";
await fs.mkdir(root, { recursive: true });
const run = (program, args, optional = false) => {
  // pg_ctl's detached server must not inherit the command's output pipe.
  const detachedStart = program === "pg_ctl.exe" && args.includes("start");
  const result = spawnSync(path.join(binRoot, "bin", program), args, {
    encoding: "utf8",
    windowsHide: true,
    ...(detachedStart ? { stdio: "ignore" } : {}),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status && !optional) throw new Error(`${program} failed (${result.status}).`);
  if (result.error) throw result.error;
  return result.status;
};
if (command === "stop") {
  run("pg_ctl.exe", ["-D", dataRoot, "-m", "fast", "-w", "stop"], true);
  process.exit(0);
}
if (!(await fs.stat(path.join(binRoot, "bin", "postgres.exe")).catch(() => null))) {
  await fs.cp(native, binRoot, { recursive: true });
}
if (!(await fs.stat(path.join(binRoot, "share", "extension", "postgis.control")).catch(() => null))) {
  if (!(await fs.stat(extensionRoot).catch(() => null)))
    throw new Error(
      "Extract the verified official PostGIS bundle into .local/postgis first. See docs/runbooks/local-development.md.",
    );
  for (const directory of ["bin", "lib", "share"])
    await fs.cp(path.join(extensionRoot, directory), path.join(binRoot, directory), { recursive: true });
}
if (!(await fs.stat(path.join(dataRoot, "PG_VERSION")).catch(() => null))) {
  const passwordFile = path.join(root, "initdb-password.txt");
  await fs.writeFile(passwordFile, "local-migration-only", { mode: 0o600 });
  try {
    run("initdb.exe", [
      "-D",
      dataRoot,
      "-U",
      "postgres",
      "--pwfile",
      passwordFile,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
    ]);
  } finally {
    await fs.unlink(passwordFile);
  }
}
if (run("pg_ctl.exe", ["-D", dataRoot, "status"], true) !== 0) {
  run("pg_ctl.exe", [
    "-D",
    dataRoot,
    "-l",
    path.join(root, "postgres.log"),
    "-o",
    "-p 55432 -h 127.0.0.1",
    "-w",
    "start",
  ]);
}
const client = new pg.Client({
  connectionString: "postgresql://postgres:local-migration-only@127.0.0.1:55432/postgres",
});
await client.connect();
try {
  const exists = await client.query("SELECT 1 FROM pg_database WHERE datname=$1", ["estate"]);
  if (!exists.rowCount) await client.query("CREATE DATABASE estate");
  const version = await client.query("SELECT version()");
  console.log(version.rows[0].version);
} finally {
  await client.end();
}
console.log("Synthetic PostgreSQL cluster ready at 127.0.0.1:55432. Run pnpm db:migrate then pnpm db:seed.");
