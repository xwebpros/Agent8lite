import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";

const migration = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
if (!["127.0.0.1", "localhost", "[::1]"].includes(migration.hostname))
  throw new Error("Isolated verification is loopback-only.");
const database = `estate_acceptance_${randomBytes(8).toString("hex")}`;
if (!/^estate_acceptance_[0-9a-f]{16}$/.test(database)) throw new Error("Unsafe disposable database name.");
const acceptanceRoot = path.resolve(process.cwd(), ".local", "acceptance");
const files = path.resolve(acceptanceRoot, database);
if (path.dirname(files) !== acceptanceRoot) throw new Error("Unsafe disposable storage directory.");
const cluster = new URL(migration);
cluster.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: cluster.href });
const urlFor = (user, password) => {
  const url = new URL(migration);
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.href;
};
const reserve = net.createServer();
await new Promise((resolve, reject) => {
  reserve.once("error", reject);
  reserve.listen(0, "127.0.0.1", resolve);
});
const port = reserve.address().port;
await new Promise((resolve) => reserve.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const verificationId = randomBytes(16).toString("hex");
const env = {
  ...process.env,
  APP_ENV: "test",
  DEV_AUTH_ENABLED: "true",
  WEB_ORIGIN: "http://localhost:3000",
  API_HOST: "127.0.0.1",
  API_PORT: String(port),
  API_VERIFICATION_ID: verificationId,
  TEST_API_ORIGIN: origin,
  TEST_WEB_ORIGIN: "http://localhost:3000",
  MIGRATION_DATABASE_URL: urlFor(migration.username, migration.password),
  DATABASE_URL: urlFor("estate_runtime", "local-runtime-only"),
  WORKER_DATABASE_URL: urlFor("estate_worker", "local-worker-only"),
  TEST_MIGRATION_DATABASE_URL: urlFor(migration.username, migration.password),
  TEST_DATABASE_URL: urlFor("estate_runtime", "local-runtime-only"),
  TEST_WORKER_DATABASE_URL: urlFor("estate_worker", "local-worker-only"),
  PRIVATE_OBJECT_DIRECTORY: path.join(files, "private-objects"),
  MLS_PROVIDER: "mock",
  DELIVERY_PROVIDER: "no-delivery",
};
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Verification command failed (${code}).`)),
    );
  });
}
let created = false;
let api;
let apiExit;
let apiError;
try {
  await mkdir(files, { recursive: true });
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await run(["--import", "tsx", "packages/db/migrate.ts"]);
  await run(["--import", "tsx", "packages/db/seed.ts"]);
  api = spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
    env,
    stdio: "inherit",
    windowsHide: true,
  });
  apiExit = new Promise((resolve) => {
    api.once("exit", resolve);
    api.once("error", (error) => {
      apiError = error;
      resolve();
    });
  });
  let ready = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && api.exitCode === null && !apiError) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      ready = response.ok && response.headers.get("x-verification-instance") === verificationId;
      await response.arrayBuffer();
      if (ready && api.exitCode === null && !apiError) break;
      ready = false;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready || api.exitCode !== null || apiError)
    throw new Error("The owned isolated API did not become ready.", { cause: apiError });
  console.log("Running non-browser acceptance against a new disposable database and isolated API.");
  const arguments_ = ["node_modules/vitest/vitest.mjs", "run", ...process.argv.slice(2)];
  if (process.env.ISOLATED_TEST_REPORT)
    arguments_.push(
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${process.env.ISOLATED_TEST_REPORT}`,
    );
  await run(arguments_);
  console.log("Isolated non-browser acceptance passed.");
} finally {
  if (api && api.exitCode === null && !apiError) {
    api.kill("SIGTERM");
    await apiExit;
  }
  // The checked generated name belongs only to this invocation, never the development database.
  try {
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
    // Both the absolute parent and generated leaf were checked before this invocation created files.
    await rm(files, { recursive: true, force: true });
  }
}
