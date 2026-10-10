import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const suites = process.argv.slice(2);
if (!suites.length)
  suites.push("tests/mls/repository.integration.test.ts", "tests/mls/read-api.integration.test.ts");
const migration = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
if (!["127.0.0.1", "localhost", "[::1]"].includes(migration.hostname))
  throw new Error("W07 isolation is loopback-only.");
const cluster = new URL(migration);
cluster.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: cluster.href });
function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`W07 verification failed (${code}).`)),
    );
  });
}
try {
  for (const suite of suites) {
    if (!/^tests\/mls\/[a-z-]+\.integration\.test\.ts$/.test(suite))
      throw new Error("Specify an owned W07 integration suite.");
    const database = `estate_w07_${randomBytes(8).toString("hex")}`;
    const base = path.resolve(process.cwd(), ".local", "w07-acceptance");
    const directory = path.resolve(base, database);
    if (!/^estate_w07_[a-f0-9]{16}$/.test(database) || path.dirname(directory) !== base)
      throw new Error("Unsafe disposable target.");
    const url = (user, password) => {
      const value = new URL(migration);
      value.username = user;
      value.password = password;
      value.pathname = `/${database}`;
      return value.href;
    };
    const env = {
      ...process.env,
      APP_ENV: "test",
      DEV_AUTH_ENABLED: "true",
      MLS_PROVIDER: "mock",
      W07_ISOLATED_DATABASE: "true",
      MIGRATION_DATABASE_URL: url(migration.username, migration.password),
      DATABASE_URL: url("estate_runtime", "local-runtime-only"),
      TEST_DATABASE_URL: url("estate_runtime", "local-runtime-only"),
      TEST_MIGRATION_DATABASE_URL: url(migration.username, migration.password),
      PRIVATE_OBJECT_DIRECTORY: path.join(directory, "private-objects"),
    };
    let created = false;
    try {
      await mkdir(directory, { recursive: true });
      await admin.query(`CREATE DATABASE "${database}"`);
      created = true;
      await run(["--import", "tsx", "packages/db/migrate.ts"], env);
      await run(["--import", "tsx", "packages/db/seed.ts"], env);
      await run(
        ["node_modules/vitest/vitest.mjs", "run", "--config", "tests/mls/vitest.config.mts", suite],
        env,
      );
    } finally {
      // Absolute parent and generated owned leaf were validated before creation. No shared estate target.
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await rm(directory, { recursive: true, force: true });
    }
  }
} finally {
  await admin.end();
}
