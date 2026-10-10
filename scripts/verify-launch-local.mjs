import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Explicit local fixtures only. Does not read secret files, mutate roles or deploy anything.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owned = [];
const demoPassword = "local-fixture-preview-password";
const demoSecret = "local-fixture-preview-signing-secret-at-least-32";
const check = (condition, code) => {
  if (!condition) throw new Error(code);
};
async function deadline(promise, ms = 40000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("launch_probe_timeout")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function environment(port, mode) {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (["systemroot", "windir", "path", "temp", "tmp"].includes(key.toLowerCase())) env[key] = value;
  return {
    ...env,
    PORT: String(port),
    WEB_ORIGIN: `http://127.0.0.1:${port}`,
    ESTATE_BUILD_DIR: process.env.ESTATE_BUILD_DIR || ".next",
    APP_ENV: "test",
    DEV_AUTH_ENABLED: "true",
    API_HOST: "0.0.0.0",
    API_PORT: "3001",
    API_ORIGIN: "https://unrelated.example.invalid",
    ...(mode === "demo"
      ? { HOSTED_DEMO_ENABLED: "true", DEMO_ACCESS_PASSWORD: demoPassword, DEMO_SESSION_SECRET: demoSecret }
      : { DATABASE_URL: "postgresql://estate_runtime:local-runtime-only@127.0.0.1:55432/estate" }),
  };
}
function launch(env, entrypoint = "start-app.mjs") {
  const child = spawn(process.execPath, [path.join(root, "scripts", entrypoint)], {
    cwd: root,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const state = { child, exited: false, output: "", ready: undefined };
  owned.push(state);
  let readyResolve;
  let readyReject;
  state.readiness = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  state.readiness.catch(() => {});
  state.exit = new Promise((resolve) => {
    child.once("error", () => {
      if (!child.pid) {
        state.exited = true;
        resolve(-1);
      }
      readyReject(new Error("launch_probe_spawn_failed"));
    });
    child.once("close", (code) => {
      state.exited = true;
      readyReject(new Error("launch_probe_not_ready"));
      resolve(code);
    });
  });
  child.on("message", (message) => {
    if (message?.type === "estate-app-ready") {
      state.ready = message;
      readyResolve(message);
    }
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      if (state.output.length + chunk.length > 65536) {
        child.kill("SIGKILL");
        return;
      }
      state.output += chunk.toString();
    });
  return state;
}
const request = (port, route, options = {}) =>
  fetch(`http://127.0.0.1:${port}${route}`, {
    ...options,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function closed(state, expected = 0) {
  check((await deadline(state.exit, 15000)) === expected, "launch_probe_exit_invalid");
  for (const pid of [state.ready?.apiPid, state.ready?.webPid])
    if (pid) check(!running(pid), "launch_probe_owned_child_leaked");
}
async function stop(state) {
  if (!state.exited) state.child.send({ type: "estate-shutdown" }, () => {});
  await closed(state);
}
let failure;
let phase = "application";
try {
  const appPort = await freePort();
  const app = launch(environment(appPort, "application"));
  const ready = await deadline(app.readiness);
  check(
    ready.port === appPort && ready.apiPort !== appPort && ready.apiPid && ready.webPid,
    "launch_probe_ports_invalid",
  );
  const health = await request(ready.apiPort, "/health");
  check(
    health.status === 200 && (await health.json()).identityMode === "unconfigured",
    "launch_probe_production_mode_invalid",
  );
  const denied = await request(appPort, "/api/v1/session");
  check(
    denied.status === 401 &&
      (await denied.json()).code === "identity_provider_unconfigured" &&
      denied.headers.get("cache-control").includes("no-store"),
    "launch_probe_bff_invalid",
  );
  const synthetic = await request(appPort, "/api/dev/session", {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${appPort}`, "content-type": "application/json" },
    body: JSON.stringify({ identity: "owner" }),
  });
  check(
    synthetic.status === 403 && !synthetic.headers.get("set-cookie"),
    "launch_probe_synthetic_identity_enabled",
  );
  const directSynthetic = await request(ready.apiPort, "/dev/session", {
    method: "POST",
    headers: { origin: `http://127.0.0.1:${appPort}`, "content-type": "application/json" },
    body: JSON.stringify({ identity: "owner" }),
  });
  check(
    directSynthetic.status === 404 && (await directSynthetic.json()).code === "synthetic_identity_disabled",
    "launch_probe_api_synthetic_identity_enabled",
  );
  for (const route of ["/", "/contacts", "/tasks"]) {
    const page = await request(appPort, route);
    const html = await page.text();
    check(
      page.status === 200 &&
        html.includes("Opening your workspace") &&
        !html.includes("Synthetic staff console") &&
        page.headers.get("cache-control")?.includes("no-store"),
      "launch_probe_workspace_route_invalid",
    );
  }
  const staffPage = await request(appPort, "/dev/staff");
  const staffHtml = await staffPage.text();
  check(
    staffPage.status === 200 &&
      staffHtml.includes("Synthetic staff console") &&
      !staffHtml.includes("Opening your workspace"),
    "launch_probe_staff_layout_invalid",
  );
  await stop(app);

  phase = "child-failure";
  const failed = launch(environment(await freePort(), "application"));
  const failedReady = await deadline(failed.readiness);
  process.kill(failedReady.webPid, "SIGKILL");
  await closed(failed, 1);

  phase = "demo";
  const port = await freePort();
  const demo = launch(environment(port, "demo"));
  const demoReady = await deadline(demo.readiness);
  check(
    demoReady.port === port && !demoReady.apiPid && !demoReady.apiPort && demoReady.webPid,
    "launch_probe_demo_started_api",
  );
  const origin = `http://127.0.0.1:${port}`;
  const loginPage = await request(port, "/demo");
  const loginHtml = await loginPage.text();
  check(
    loginPage.status === 200 &&
      loginHtml.includes("Preview password") &&
      !loginHtml.includes("Sample pipeline") &&
      !loginHtml.includes("Opening your workspace") &&
      loginPage.headers.get("cache-control")?.includes("no-store"),
    "launch_probe_demo_page_access_invalid",
  );
  const workspaceRedirect = await request(port, "/contacts");
  check(
    workspaceRedirect.status === 307 && workspaceRedirect.headers.get("location")?.endsWith("/demo"),
    "launch_probe_demo_workspace_redirect_invalid",
  );
  const signin = async (password, originHeader = origin) =>
    request(port, "/demo/session", {
      method: "POST",
      headers: { origin: originHeader },
      body: new URLSearchParams({ password }),
    });
  const crossSite = await signin(demoPassword, "https://unrelated.example.invalid");
  check(crossSite.status === 403 && !crossSite.headers.get("set-cookie"), "launch_probe_demo_origin_invalid");
  const incorrect = await signin("wrong-preview-password");
  check(
    incorrect.status === 303 &&
      !incorrect.headers.get("set-cookie") &&
      incorrect.headers.get("location").endsWith("?error=access"),
    "launch_probe_demo_password_invalid",
  );
  const accepted = await signin(demoPassword);
  const setCookie = accepted.headers.get("set-cookie");
  check(
    accepted.status === 303 &&
      setCookie?.includes("HttpOnly") &&
      setCookie.includes("Path=/demo") &&
      setCookie.includes("SameSite=strict"),
    "launch_probe_demo_cookie_invalid",
  );
  const cookie = setCookie.split(";")[0];
  const token = cookie.slice(cookie.indexOf("=") + 1);
  const privatePage = await request(port, "/demo", { headers: { cookie } });
  const privateHtml = await privatePage.text();
  check(
    privatePage.status === 200 &&
      privateHtml.includes("Sample pipeline") &&
      !privateHtml.includes(demoPassword) &&
      !privateHtml.includes(demoSecret) &&
      privatePage.headers.get("cache-control")?.includes("no-store"),
    "launch_probe_demo_render_invalid",
  );
  const { createHmac } = await import("node:crypto");
  const csrf = createHmac("sha256", demoSecret).update(`csrf:${token}`).digest("base64url");
  const csrfDenied = await request(port, "/demo/logout", {
    method: "POST",
    headers: { origin, cookie },
    body: new URLSearchParams({ csrf: "incorrect" }),
  });
  check(csrfDenied.status === 403, "launch_probe_demo_csrf_invalid");
  const logout = await request(port, "/demo/logout", {
    method: "POST",
    headers: { origin, cookie },
    body: new URLSearchParams({ csrf }),
  });
  check(
    logout.status === 303 && logout.headers.get("set-cookie")?.includes("Max-Age=0"),
    "launch_probe_demo_logout_invalid",
  );
  const isolation = await request(port, "/api/v1/session");
  check(
    isolation.status === 503 && (await isolation.json()).code === "preview_api_isolated",
    "launch_probe_demo_api_not_isolated",
  );
  await stop(demo);

  // Reproduce a host selecting npm run dev: only the assigned public port is
  // used, production guards still apply, and the production-only install works.
  for (const mode of ["application", "demo"]) {
    phase = `hosted-dev-${mode}`;
    const compatiblePort = await freePort();
    const compatible = launch(environment(compatiblePort, mode), "dev.mjs");
    const compatibleReady = await deadline(compatible.readiness);
    check(
      compatibleReady.port === compatiblePort &&
        compatibleReady.webPid &&
        (mode === "demo" ? !compatibleReady.apiPid : !!compatibleReady.apiPid),
      "launch_probe_dev_ports_invalid",
    );
    const boundary = await request(compatiblePort, "/api/v1/session");
    check(
      boundary.status === (mode === "demo" ? 503 : 401) &&
        (await boundary.json()).code ===
          (mode === "demo" ? "preview_api_isolated" : "identity_provider_unconfigured"),
      "launch_probe_dev_identity_invalid",
    );
    check(
      compatible.output.includes('"status":"hosted-launch-selected"') &&
        !compatible.output.includes("Synthetic workspace") &&
        !compatible.output.includes(demoPassword) &&
        !compatible.output.includes(demoSecret),
      "launch_probe_dev_output_invalid",
    );
    if (mode === "demo") {
      const accepted = await request(compatiblePort, "/demo/session", {
        method: "POST",
        headers: { origin: `http://127.0.0.1:${compatiblePort}` },
        body: new URLSearchParams({ password: demoPassword }),
      });
      check(
        accepted.status === 303 && accepted.headers.get("set-cookie")?.includes("HttpOnly"),
        "launch_probe_dev_demo_access_invalid",
      );
    }
    await stop(compatible);
  }

  phase = "missing-port";
  const noPort = environment(await freePort(), "demo");
  delete noPort.PORT;
  noPort.NODE_ENV = "production";
  const invalid = launch(noPort, "dev.mjs");
  await closed(invalid, 1);
  check(
    invalid.output.includes('"code":"launch_port_required"') &&
      !invalid.output.includes("Synthetic workspace"),
    "launch_probe_dev_local_fallback_invalid",
  );
} catch (error) {
  failure = /^launch_probe_[a-z_]+$/.test(error.message) ? error.message : "launch_probe_failed";
} finally {
  for (const state of owned)
    if (!state.exited) {
      try {
        await stop(state);
      } catch {
        for (const pid of [state.ready?.apiPid, state.ready?.webPid])
          if (pid && running(pid)) process.kill(pid, "SIGKILL");
        state.child.kill("SIGKILL");
        failure = "launch_probe_cleanup_failed";
      }
    }
}
if (failure) {
  console.error(JSON.stringify({ code: failure, phase }));
  process.exitCode = 1;
} else
  console.log(
    JSON.stringify({
      status: "verified",
      assignedPorts: "non-default",
      application: "owned-api-plus-web",
      productionIdentity: "denied",
      workspaceRoutes: "private-dynamic-shell-and-separate-demo-staff-verified",
      childFailure: "sibling-closed",
      demo: "web-only-no-database",
      previewAccess: "origin-password-cookie-CSRF-logout-verified",
      hostedDevCommand: "assigned-port-production-and-demo-verified-no-local-fallback",
      ownedChildren: "closed",
      externalServices: "none",
    }),
  );
