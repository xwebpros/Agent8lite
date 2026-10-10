import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicitly local verification: no secret-file reads, migration identity, seed/reset or worker dispatch.
const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const entry = path.join(root, "dist/runtime/apps/api/src/main.js");
const origin = "http://localhost:3000";
const children = [];
let synthetic;
let cookie;
let csrf;
let failure;
let shutdowns = 0;

const childSource = `
const { createApplication } = require(process.argv[1]);
let app;
let closing = false;
process.on("message", async (message) => {
  if (message !== "close" || closing || !app) return;
  closing = true;
  try { await app.close(); process.disconnect(); }
  catch { process.exitCode = 1; process.disconnect(); }
});
createApplication().then(async (created) => {
  app = created;
  await app.listen(0, "127.0.0.1");
  process.send({ kind: "ready", port: app.getHttpServer().address().port });
}).catch(async () => {
  process.exitCode = 1;
  try { await app?.close(); } catch {}
  if (process.connected) process.disconnect();
});
`;
function environment(APP_ENV, DEV_AUTH_ENABLED) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (["systemroot", "windir", "path", "temp", "tmp"].includes(key.toLowerCase())) env[key] = value;
  return {
    ...env,
    APP_ENV,
    DEV_AUTH_ENABLED,
    DATABASE_URL: "postgresql://estate_runtime:local-runtime-only@127.0.0.1:55432/estate",
    WEB_ORIGIN: origin,
    API_HOST: "127.0.0.1",
  };
}
function launch(args, env, ipc = false) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    env,
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const state = { child, output: "", port: undefined, code: undefined, exited: false };
  let bytes = 0;
  let stoppedCapture = false;
  children.push(state);
  state.exit = new Promise((resolve) => {
    child.once("error", () => {
      if (!child.pid) {
        state.exited = true;
        resolve(-1);
      } else child.kill("SIGKILL");
    });
    child.once("close", (code) => {
      state.exited = true;
      state.code = code;
      resolve(code);
    });
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      if (stoppedCapture) return;
      bytes += chunk.length;
      if (bytes > 65536) {
        stoppedCapture = true;
        child.kill("SIGKILL");
      } else state.output += chunk;
    });
  return state;
}
async function deadline(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function start(APP_ENV, DEV_AUTH_ENABLED) {
  const state = launch(
    ["--input-type=commonjs", "-e", childSource, entry],
    environment(APP_ENV, DEV_AUTH_ENABLED),
    true,
  );
  const ready = new Promise((resolve, reject) => {
    state.child.on("message", (message) => {
      if (
        message?.kind === "ready" &&
        Number.isInteger(message.port) &&
        message.port > 0 &&
        message.port <= 65535
      ) {
        state.port = message.port;
        resolve(state);
      } else reject(new Error("runtime_local_start_failed"));
    });
    state.exit.then(() => reject(new Error("runtime_local_start_failed")));
  });
  return deadline(ready, 15000, "runtime_local_start_timeout");
}
async function request(state, route, init = {}) {
  const response = await fetch(`http://127.0.0.1:${state.port}${route}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.headers.get("cache-control")?.includes("no-store"))
    throw new Error("runtime_local_cache_invalid");
  return response;
}
function check(condition, code) {
  if (!condition) throw new Error(code);
}
async function stop(state) {
  if (state.exited) return;
  if (!state.port || state.cli) {
    await terminate(state);
    return;
  }
  try {
    await new Promise((resolve, reject) => {
      state.child.send("close", (error) => (error ? reject(error) : resolve()));
    });
    check(
      (await deadline(state.exit, 5000, "runtime_local_shutdown_timeout")) === 0,
      "runtime_local_shutdown_failed",
    );
    shutdowns++;
  } catch (error) {
    await terminate(state);
    throw error;
  }
}
async function terminate(state) {
  if (state.exited) return;
  state.child.kill();
  try {
    await deadline(state.exit, 1000, "runtime_local_kill_timeout");
  } catch {
    state.child.kill("SIGKILL");
    try {
      await deadline(state.exit, 1500, "runtime_local_force_kill_timeout");
    } catch {
      state.child.stdout.destroy();
      state.child.stderr.destroy();
      if (state.child.connected) state.child.disconnect();
      state.child.unref();
      throw new Error("runtime_local_cleanup_failed");
    }
  }
}
async function health(state, identityMode) {
  const response = await request(state, "/health");
  const body = await response.json();
  check(
    response.status === 200 &&
      body.status === "ready" &&
      body.identityMode === identityMode &&
      body.mlsMode === "mock" &&
      body.deliveryMode === "no-delivery",
    "runtime_local_health_invalid",
  );
  return response;
}
async function compiledCliHealth() {
  const reservation = createServer();
  let port;
  try {
    await new Promise((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", resolve);
    });
    port = reservation.address().port;
  } finally {
    if (reservation.listening) await new Promise((resolve) => reservation.close(resolve));
  }
  const verification = randomBytes(16).toString("hex");
  const state = launch([entry], {
    ...environment("test", "true"),
    API_PORT: String(port),
    API_VERIFICATION_ID: verification,
  });
  state.cli = true;
  await deadline(
    new Promise((resolve, reject) => {
      state.child.stdout.on("data", () => {
        if (state.output.includes('"status":"listening"')) resolve();
      });
      state.exit.then(() => reject(new Error("runtime_local_cli_start_failed")));
    }),
    15000,
    "runtime_local_cli_start_timeout",
  );
  state.port = port;
  const response = await health(state, "synthetic-loopback");
  check(
    response.headers.get("x-verification-instance") === verification,
    "runtime_local_cli_ownership_invalid",
  );
  // Windows force termination is not graceful-shutdown evidence; app.close is proved separately above.
  await stop(state);
}
try {
  const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  check(
    process.argv.length === 2 && process.version === "v" + workspace.engines.node,
    "runtime_local_configuration_invalid",
  );
  // Resource/import verification must pass before executing any API with the fixture runtime role.
  const artifact = launch(
    [path.join(root, "scripts/verify-runtime.mjs")],
    environment("production", "false"),
  );
  check(
    (await deadline(artifact.exit, 20000, "runtime_local_artifact_timeout")) === 0,
    "runtime_local_artifact_invalid",
  );
  synthetic = await start("test", "true");
  await health(synthetic, "synthetic-loopback");
  const login = await request(synthetic, "/dev/session", {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ identity: "owner" }),
  });
  cookie = login.headers
    .getSetCookie()
    .find((value) => value.startsWith("estate_session="))
    ?.split(";")[0];
  csrf = login.headers.get("x-csrf-token");
  const identity = await login.json();
  check(
    login.status === 200 && cookie && csrf && identity.userId && identity.activeOrgId,
    "runtime_local_signin_failed",
  );
  const session = await request(synthetic, "/v1/session", { headers: { cookie } });
  const retained = await session.json();
  check(
    session.status === 200 &&
      retained.userId === identity.userId &&
      retained.activeOrgId === identity.activeOrgId,
    "runtime_local_session_failed",
  );
  for (const forwarding of [
    { forwarded: "for=203.0.113.42" },
    { "x-real-ip": "203.0.113.42" },
    { "x-forwarded-host": "demo.example.test" },
    { "x-forwarded-for": "203.0.113.42" },
  ]) {
    const denied = await request(synthetic, "/v1/session", { headers: { cookie, ...forwarding } });
    check(
      denied.status === 403 && (await denied.json()).code === "loopback_required",
      "runtime_local_forwarding_boundary_failed",
    );
  }
  for (const enabled of ["false", "true"]) {
    const production = await start("production", enabled);
    await health(production, "unconfigured");
    const denied = await request(production, "/v1/session", { headers: { cookie } });
    check(
      denied.status === 401 && (await denied.json()).code === "identity_provider_unconfigured",
      "runtime_local_production_session_failed",
    );
    const signin = await request(production, "/dev/session", {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ identity: "owner" }),
    });
    check(
      signin.status === 404 && (await signin.json()).code === "synthetic_identity_disabled",
      "runtime_local_production_signin_failed",
    );
    await stop(production);
  }
  await compiledCliHealth();
  // Exercise the actual compiled CLI through its listen path, with a port held by this probe.
  const occupied = createServer();
  try {
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const cli = launch([entry], {
      ...environment("test", "true"),
      API_PORT: String(occupied.address().port),
    });
    check(
      (await deadline(cli.exit, 15000, "runtime_local_cli_timeout")) === 1 &&
        cli.output.includes('"code":"api_startup_failed"'),
      "runtime_local_cli_failure_invalid",
    );
  } finally {
    if (occupied.listening) await new Promise((resolve) => occupied.close(resolve));
  }
} catch (error) {
  failure = /^runtime_local_[a-z_]+$/.test(error?.message)
    ? error.message
    : "runtime_local_verification_failed";
} finally {
  if (synthetic?.port && cookie && csrf) {
    try {
      const logout = await request(synthetic, "/dev/logout", {
        method: "POST",
        headers: { origin, cookie, "x-csrf-token": csrf },
      });
      check(logout.status === 204, "runtime_local_logout_failed");
      const revoked = await request(synthetic, "/v1/session", { headers: { cookie } });
      check(
        revoked.status === 401 && (await revoked.json()).code === "session_expired",
        "runtime_local_revocation_failed",
      );
    } catch {
      failure = "runtime_local_cleanup_failed";
    }
  }
  for (const state of children)
    try {
      await stop(state);
    } catch {
      failure = "runtime_local_cleanup_failed";
    }
}
if (failure) {
  console.error(JSON.stringify({ code: failure }));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify({
      status: "verified",
      compiledApi: "healthy",
      compiledCli: "healthy-owned-instance",
      syntheticSession: "created-read-revoked",
      forwardedRequestsDenied: 4,
      productionModesDenied: 2,
      cliListenFailure: "closed",
      gracefulShutdowns: shutdowns,
      externalDelivery: "none",
    }),
  );
}
