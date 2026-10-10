import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

const migrationUrl = new URL(
  process.env.MIGRATION_DATABASE_URL ?? "postgresql://postgres:local-migration-only@127.0.0.1:55432/estate",
);
if (!["127.0.0.1", "localhost", "[::1]"].includes(migrationUrl.hostname))
  throw new Error("Fresh schema verification is loopback-only.");
const name = `estate_acceptance_${randomBytes(8).toString("hex")}`;
if (!/^estate_acceptance_[0-9a-f]{16}$/.test(name)) throw new Error("Unsafe disposable database name.");
const adminUrl = new URL(migrationUrl);
adminUrl.pathname = "/postgres";
const admin = new pg.Pool({ connectionString: adminUrl.href });
let created = false;
function run(entry, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${entry} failed (${code}).`))));
  });
}
try {
  await admin.query(`CREATE DATABASE "${name}"`);
  created = true;
  const freshUrl = new URL(migrationUrl);
  freshUrl.pathname = `/${name}`;
  const runtimeUrl = new URL(freshUrl);
  runtimeUrl.username = "estate_runtime";
  runtimeUrl.password = "local-runtime-only";
  const env = {
    ...process.env,
    APP_ENV: "test",
    DEV_AUTH_ENABLED: "true",
    MIGRATION_DATABASE_URL: freshUrl.href,
    DATABASE_URL: runtimeUrl.href,
  };
  await run("packages/db/migrate.ts", env);
  await run("packages/db/seed.ts", env);
  await run("packages/db/migrate.ts", env);
  const fresh = new pg.Pool({ connectionString: freshUrl.href });
  try {
    const version = (await fresh.query("SELECT version(),PostGIS_Full_Version() spatial")).rows[0];
    const tables = (
      await fresh.query(
        "SELECT count(*)::int count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='app' AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity",
      )
    ).rows[0].count;
    const organizations = (await fresh.query("SELECT count(*)::int count FROM app.organization")).rows[0]
      .count;
    const roles = (
      await fresh.query(
        "SELECT rolname,rolsuper,rolbypassrls,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname IN ('estate_runtime','estate_worker','estate_control','estate_staff_issuer') ORDER BY rolname",
      )
    ).rows;
    if (
      tables < 50 ||
      organizations !== 2 ||
      roles.length !== 4 ||
      roles.some((role) => role.rolsuper || role.rolbypassrls || role.rolcreatedb || role.rolcreaterole)
    )
      throw new Error("Fresh schema acceptance failed.");
    console.log(
      JSON.stringify({
        freshSchema: "passed",
        forcedRlsTables: tables,
        seededOrganizations: organizations,
        roles,
        postgres: version.version.split(",")[0],
        postgis: version.spatial.split(" ")[0],
      }),
    );
  } finally {
    await fresh.end();
  }
} finally {
  // The checked generated name always denotes this invocation's disposable database.
  if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
  await admin.end();
}
