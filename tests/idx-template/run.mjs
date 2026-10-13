import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { assertNodeRuntime, readPinnedNode } from "../../scripts/node-runtime.mjs";
import {
  ciContainerId,
  verifyCiContainerOwnership,
  verifyCiImageAndNetwork,
  verifyCiDatabaseTarget,
} from "./ci-ownership.mjs";

export const idxTestPort = 54434;
const root = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const expectedData = path.join(root, ".local", "idx-test-pgdata");
const clusterUrl = `postgresql://postgres:idx-migration-only@127.0.0.1:${idxTestPort}/postgres`;
const canonical = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();

export function idxTestEnvironment(parent = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(parent))
    if (
      value !== undefined &&
      [
        "systemroot",
        "windir",
        "path",
        "temp",
        "tmp",
        "userprofile",
        "appdata",
        "localappdata",
        "comspec",
        "pathext",
        "lang",
        "lc_all",
        "tz",
      ].includes(key.toLowerCase())
    )
      env[key] = value;
  return {
    ...env,
    APP_ENV: "test",
    NODE_ENV: "test",
    DEV_AUTH_ENABLED: "true",
    API_HOST: "127.0.0.1",
    WEB_ORIGIN: "http://localhost:3000",
    MLS_PROVIDER: "mock",
    DELIVERY_PROVIDER: "no-delivery",
    HOSTED_DEMO_ENABLED: "false",
    NEXT_TELEMETRY_DISABLED: "1",
    TEST_IDX_ISOLATED: "true",
    MIGRATION_DATABASE_URL: clusterUrl,
  };
}

async function inspectCiObject(kind, id) {
  try {
    const result = await promisify(execFile)(
      "/usr/bin/docker",
      ["--host", "unix:///var/run/docker.sock", kind, "inspect", id],
      {
        env: idxTestEnvironment(),
        timeout: 5000,
        maxBuffer: 1024 * 1024,
      },
    );
    const values = JSON.parse(result.stdout);
    if (!Array.isArray(values) || values.length !== 1) throw new Error();
    return values[0];
  } catch {
    // Inspection may contain environment values. Never forward Docker output or its raw error.
    throw new Error("idx_test_ci_inspection_failed");
  }
}

async function verifyCiCluster(id) {
  const first = verifyCiContainerOwnership(
    await inspectCiObject("container", id),
    id,
    process.env,
    process.platform,
  );
  verifyCiImageAndNetwork(
    first,
    await inspectCiObject("image", first.imageId),
    await inspectCiObject("network", first.networkId),
  );
  const pool = new pg.Pool({ connectionString: clusterUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const actual = (
      await pool.query(
        "SELECT current_setting('data_directory') AS directory,current_setting('port') AS port,current_database() AS database,current_user,session_user",
      )
    ).rows[0];
    const postgis =
      (await pool.query("SELECT name FROM pg_available_extensions WHERE name='postgis'")).rowCount === 1;
    verifyCiDatabaseTarget(first, actual, postgis);
    const current = verifyCiContainerOwnership(
      await inspectCiObject("container", id),
      id,
      process.env,
      process.platform,
    );
    if (JSON.stringify(current) !== JSON.stringify(first)) throw new Error("idx_test_ci_container_changed");
    return {
      mode: "github-actions-service",
      port: idxTestPort,
      containerId: first.containerId,
      dataDirectory: first.dataDirectory,
      internalPort: first.internalPort,
      postgisAvailable: true,
    };
  } finally {
    await pool.end();
  }
}

export async function verifyIdxCluster() {
  const container = ciContainerId(process.env, process.platform);
  if (container) return verifyCiCluster(container);
  const actualRoot = await fs.realpath(root);
  const expectedBinary = await fs.realpath(
    process.env.IDX_TEST_POSTGRES_BINARY ?? path.join(root, ".local", "postgres", "bin", "postgres.exe"),
  );
  const actualData = await fs.realpath(expectedData);
  if (
    canonical(actualRoot) !== canonical(root) ||
    canonical(actualData) !== canonical(expectedData) ||
    !canonical(expectedData).startsWith(`${canonical(root)}/.local/`)
  )
    throw new Error("idx_test_workspace_invalid");
  const record = JSON.parse(
    (await fs.readFile(path.join(root, ".local", "idx-test-postgres-owner.json"), "utf8")).replace(
      /^\uFEFF/,
      "",
    ),
  );
  if (
    record.kind !== "idx-test-postgres" ||
    record.synthetic !== true ||
    record.port !== idxTestPort ||
    !Number.isInteger(record.pid) ||
    record.pid < 1 ||
    canonical(record.worktree) !== canonical(root) ||
    canonical(record.dataDirectory) !== canonical(expectedData) ||
    canonical(record.executable) !== canonical(expectedBinary)
  )
    throw new Error("idx_test_cluster_ownership_invalid");
  if (canonical(await fs.realpath(record.executable)) !== canonical(expectedBinary))
    throw new Error("idx_test_cluster_binary_invalid");
  const postmaster = (await fs.readFile(path.join(expectedData, "postmaster.pid"), "utf8"))
    .trim()
    .split(/\r?\n/);
  if (
    Number(postmaster[0]) !== record.pid ||
    canonical(postmaster[1]) !== canonical(expectedData) ||
    Number(postmaster[3]) !== idxTestPort
  )
    throw new Error("idx_test_cluster_process_invalid");
  const pool = new pg.Pool({ connectionString: clusterUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const result = (
      await pool.query(
        "SELECT current_setting('data_directory') AS directory,current_setting('port') AS port,current_database() AS database",
      )
    ).rows[0];
    if (
      canonical(result.directory) !== canonical(expectedData) ||
      Number(result.port) !== idxTestPort ||
      result.database !== "postgres"
    )
      throw new Error("idx_test_cluster_target_invalid");
    const extension = await pool.query("SELECT name FROM pg_available_extensions WHERE name='postgis'");
    if (extension.rowCount !== 1) throw new Error("idx_test_postgis_unavailable");
    return { port: idxTestPort, ownedPid: record.pid, dataDirectory: expectedData, postgisAvailable: true };
  } finally {
    await pool.end();
  }
}

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`idx_test_command_failed:${code}`)),
    );
  });
}

async function testReportArguments(args) {
  if (!process.env.ISOLATED_TEST_REPORT) return args;
  const report = path.resolve(root, process.env.ISOLATED_TEST_REPORT);
  if (!canonical(report).startsWith(`${canonical(root)}/.local/`))
    throw new Error("idx_test_report_outside_owned_workspace");
  await fs.mkdir(path.dirname(report), { recursive: true });
  if (!canonical(await fs.realpath(path.dirname(report))).startsWith(`${canonical(root)}/.local/`))
    throw new Error("idx_test_report_linked_outside_workspace");
  return [...args, "--reporter=default", "--reporter=json", `--outputFile=${report}`];
}

async function runDisposableSuite(file, config = "tests/idx-template/vitest.config.mts") {
  const database = `estate_acceptance_${randomBytes(8).toString("hex")}`;
  if (!/^estate_acceptance_[0-9a-f]{16}$/.test(database)) throw new Error("idx_test_database_name_invalid");
  const acceptanceRoot = path.resolve(root, ".local", "acceptance");
  const files = path.join(acceptanceRoot, database);
  if (path.dirname(files) !== acceptanceRoot || !canonical(files).startsWith(`${canonical(root)}/.local/`))
    throw new Error("idx_test_files_outside_workspace");
  const urlFor = (user, password) => {
    const url = new URL(clusterUrl);
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
  if ([3000, 3001].includes(port)) throw new Error("idx_test_reserved_application_port");
  const origin = `http://127.0.0.1:${port}`;
  let webOrigin;
  if (file === "tests/idx-template/web.integration.test.ts") {
    const webReserve = net.createServer();
    await new Promise((resolve, reject) => {
      webReserve.once("error", reject);
      webReserve.listen(0, "127.0.0.1", resolve);
    });
    const webPort = webReserve.address().port;
    await new Promise((resolve) => webReserve.close(resolve));
    if ([3000, 3001, port].includes(webPort)) throw new Error("idx_test_web_reserved_port");
    webOrigin = `http://127.0.0.1:${webPort}`;
  }
  const verificationId = randomBytes(16).toString("hex");
  const env = {
    ...idxTestEnvironment(),
    API_PORT: String(port),
    API_VERIFICATION_ID: verificationId,
    TEST_API_ORIGIN: origin,
    TEST_WEB_ORIGIN: "http://localhost:3000",
    ...(webOrigin
      ? {
          TEST_IDX_WEB_ORIGIN: webOrigin,
          IDX_TEMPLATE_WEB_ORIGINS: `http://localhost:3000,${webOrigin}`,
        }
      : {}),
    MIGRATION_DATABASE_URL: urlFor("postgres", "idx-migration-only"),
    DATABASE_URL: urlFor("estate_runtime", "local-runtime-only"),
    WORKER_DATABASE_URL: urlFor("estate_worker", "local-worker-only"),
    CONTROL_DATABASE_URL: urlFor("estate_control", "idx-control-only"),
    STAFF_ISSUER_DATABASE_URL: urlFor("estate_staff_issuer", "idx-staff-issuer-only"),
    TEST_MIGRATION_DATABASE_URL: urlFor("postgres", "idx-migration-only"),
    TEST_DATABASE_URL: urlFor("estate_runtime", "local-runtime-only"),
    TEST_WORKER_DATABASE_URL: urlFor("estate_worker", "local-worker-only"),
    TEST_CONTROL_DATABASE_URL: urlFor("estate_control", "idx-control-only"),
    TEST_STAFF_ISSUER_DATABASE_URL: urlFor("estate_staff_issuer", "idx-staff-issuer-only"),
    PRIVATE_OBJECT_DIRECTORY: path.join(files, "private-objects"),
  };
  const admin = new pg.Pool({ connectionString: clusterUrl, max: 1 });
  let created = false;
  let api;
  let apiExit;
  let apiError;
  try {
    await fs.mkdir(files, { recursive: true });
    await admin.query(`CREATE DATABASE "${database}"`);
    created = true;
    await run(["--import", "tsx", "packages/db/migrate.ts"], env);
    await run(["--import", "tsx", "packages/db/seed.ts"], env);
    // Fresh clusters deliberately have no control-role credentials in SQL migrations.
    // This approved tool only initializes an unconfigured synthetic role and preserves an existing password.
    await run(["scripts/local-control-identities.mjs"], env);
    const apiStartedAt = Date.now();
    api = spawn(process.execPath, ["--import", "tsx", "apps/api/src/main.ts"], {
      cwd: root,
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
    const deadline = Date.now() + 60_000;
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
    console.log(
      JSON.stringify({
        verification: "idx-test-api-startup",
        ownedPid: api.pid,
        elapsedMs: Date.now() - apiStartedAt,
        ready,
        childExited: api.exitCode !== null || api.signalCode !== null,
        childError: Boolean(apiError),
      }),
    );
    if (!ready || api.exitCode !== null || apiError)
      throw new Error("idx_test_owned_api_not_ready", { cause: apiError });
    console.log("Running IDX adapter acceptance against owned 54434 disposable PostgreSQL/PostGIS.");
    const testArguments = await testReportArguments([
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      config,
      file,
    ]);
    await run(testArguments, env);
  } finally {
    if (api && api.exitCode === null && !apiError) {
      api.kill("SIGTERM");
      await apiExit;
    }
    try {
      if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
    } finally {
      await admin.end();
      // The checked generated leaf belongs solely to this invocation.
      await fs.rm(files, { recursive: true, force: true });
    }
  }
}

async function main() {
  assertNodeRuntime(process.version, await readPinnedNode(root), false, "idx_test_node_version_invalid");
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--check") {
    console.log(JSON.stringify(await verifyIdxCluster()));
    return;
  }
  if (args.length === 1 && args[0] === "--unit") {
    const unitFiles = (await fs.readdir(path.join(root, "tests", "idx-template")))
      .filter((name) => name.endsWith(".test.ts") && !name.endsWith(".integration.test.ts"))
      .sort()
      .map((name) => `tests/idx-template/${name}`);
    await run(
      await testReportArguments([
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "tests/idx-template/vitest.config.mts",
        ...unitFiles,
        "apps/web/features/idx-template/inquiry-recovery.test.ts",
        "apps/web/features/idx-template/components/PropertyInquiryForm.test.tsx",
      ]),
      idxTestEnvironment(),
    );
    return;
  }
  await verifyIdxCluster();
  if (args[0] === "--regression") {
    const approved = new Set([
      "tests/cms/native-drafts.integration.test.ts",
      "tests/integration/lead-capture-api.test.ts",
      "tests/integration/routing-capture-api.test.ts",
    ]);
    const files = args.length > 1 ? args.slice(1) : [...approved];
    if (files.some((file) => !approved.has(file))) throw new Error("idx_test_regression_not_approved");
    for (const file of files) await runDisposableSuite(file, "vitest.config.mts");
    return;
  }
  const files = args.length
    ? args
    : (await fs.readdir(path.join(root, "tests", "idx-template")))
        .filter((name) => name.endsWith(".integration.test.ts"))
        .sort()
        .map((name) => `tests/idx-template/${name}`);
  if (
    !files.length ||
    files.some((file) => !/^tests\/idx-template\/[a-z-]+\.integration\.test\.ts$/.test(file))
  )
    throw new Error("idx_test_owned_suite_required");
  const migrations = await fs.readdir(path.join(root, "packages", "db", "migrations"));
  if (!migrations.some((name) => /^0036-.*idx.*\.sql$/.test(name)))
    throw new Error("idx_test_reviewed_migration_required");
  for (const file of files) await runDisposableSuite(file);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
