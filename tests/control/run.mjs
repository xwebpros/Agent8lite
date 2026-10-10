import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

// This runner owns only its newly generated database. It never starts the shared application.
const migration = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
if (!["127.0.0.1", "localhost", "[::1]"].includes(migration.hostname))
  throw new Error("Control verification is loopback-only.");
const database = `estate_control_test_${randomBytes(8).toString("hex")}`;
if (!/^estate_control_test_[0-9a-f]{16}$/.test(database)) throw new Error("Invalid owned database name.");
const cluster = new URL(migration);
cluster.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: cluster.href });
function databaseUrl(username, password) {
  const url = new URL(migration);
  url.pathname = `/${database}`;
  url.username = username;
  url.password = password;
  return url.href;
}
const env = {
  ...process.env,
  APP_ENV: "test",
  DEV_AUTH_ENABLED: "true",
  MIGRATION_DATABASE_URL: databaseUrl(migration.username, migration.password),
  TEST_MIGRATION_DATABASE_URL: databaseUrl(migration.username, migration.password),
  DATABASE_URL: databaseUrl("estate_runtime", "local-runtime-only"),
  WORKER_DATABASE_URL: databaseUrl("estate_worker", "local-worker-only"),
  CONTROL_DATABASE_URL: databaseUrl("estate_control", "local-control-only"),
  STAFF_ISSUER_DATABASE_URL: databaseUrl("estate_staff_issuer", "local-staff-issuer-only"),
  CONTROL_OWNED_DATABASE: database,
};
async function run(arguments_) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, arguments_, { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("Owned control verification command failed.")),
    );
  });
}
let created = false;
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await run(["--import", "tsx", "packages/db/migrate.ts"]);
  await run(["--import", "tsx", "packages/db/seed.ts"]);
  const arguments_ = [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "tests/control/vitest.config.mts",
    ...(process.argv.slice(2).length ? process.argv.slice(2) : ["tests/control"]),
  ];
  if (process.env.ISOLATED_TEST_REPORT)
    arguments_.push(
      "--reporter=default",
      "--reporter=json",
      `--outputFile=${process.env.ISOLATED_TEST_REPORT}`,
    );
  await run(arguments_);
} finally {
  try {
    if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
