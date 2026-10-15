import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import synthetic from "./synthetic-environment.json" with { type: "json" };

const normalKeys = new Set([
  "systemroot",
  "windir",
  "path",
  "temp",
  "tmp",
  "userprofile",
  "appdata",
  "localappdata",
  "home",
  "lang",
  "lc_all",
  "tz",
  "comspec",
  "pathext",
  "number_of_processors",
  "processor_architecture",
  "processor_architew6432",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "node_extra_ca_certs",
]);
function canonicalPath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) return null;
  if (!path.isAbsolute(value) && !path.win32.isAbsolute(value)) return null;
  return (path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.resolve(value))
    .replaceAll("\\", "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}
export function workspaceId(root) {
  const canonical = canonicalPath(root);
  if (!canonical) throw new Error("bootstrap_workspace_invalid");
  return "agent8lite-" + createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
export function bootstrapEnvironment(parent, root, { instanceId, nodeDirectory = "" } = {}) {
  if (!canonicalPath(root)) throw new Error("bootstrap_workspace_invalid");
  if (instanceId !== undefined && !/^[0-9a-f]{32}$/.test(instanceId))
    throw new Error("bootstrap_instance_invalid");
  const environment = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && normalKeys.has(key.toLowerCase())) {
      environment[key.toLowerCase() === "path" ? "PATH" : key] = String(value);
    }
  }
  Object.assign(environment, synthetic);
  // false is explicit; neither a copied .env nor inherited hosted settings can select demo mode.
  environment.PRIVATE_OBJECT_DIRECTORY = path.join(root, ".local", "private-objects");
  environment.npm_config_userconfig = path.join(root, ".local", "bootstrap", "npmrc");
  environment.npm_config_registry = "https://registry.npmjs.org";
  if (nodeDirectory) environment.PATH = nodeDirectory + path.delimiter + (environment.PATH || "");
  if (instanceId !== undefined) environment.API_VERIFICATION_ID = instanceId;
  return environment;
}
export async function assertAvailablePorts(checkPort) {
  for (const port of [3000, 3001]) {
    if (await checkPort(port)) throw new Error("bootstrap_port_in_use:" + port);
  }
}
export async function apiReady(response, instanceId) {
  if (
    !/^[0-9a-f]{32}$/.test(instanceId) ||
    !response?.ok ||
    response.headers?.get("x-verification-instance") !== instanceId
  )
    return false;
  try {
    const body = await response.json();
    return (
      body?.status === "ready" &&
      body.identityMode === "synthetic-loopback" &&
      body.mlsMode === "mock" &&
      body.deliveryMode === "no-delivery"
    );
  } catch {
    return false;
  }
}
export function canReuseState(state, current) {
  if (!state || state.ready !== true || !/^[0-9a-f]{32}$/.test(state.instanceId || "")) return false;
  if (!Number.isInteger(state.processId) || state.processId < 1 || state.processId !== current.processId)
    return false;
  for (const key of ["root", "nodeExecutable"]) {
    const expected = canonicalPath(current[key]);
    if (!expected || canonicalPath(state[key]) !== expected) return false;
  }
  const started = Date.parse(state.processStartedAt);
  const actual = Date.parse(current.processStartedAt);
  return Number.isFinite(started) && Number.isFinite(actual) && Math.abs(started - actual) <= 2000;
}
function isListening(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(true) : reject(error)));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => resolve(false)));
  });
}
export async function supervise({
  root,
  environment,
  spawnChild = spawn,
  fetchResponse = fetch,
  writeState = async () => {},
  startupMs = 180000,
  delay = (ms) => new Promise((r) => setTimeout(r, ms)),
  checkPort = isListening,
  output = (chunk) => process.stdout.write(chunk),
  now = Date.now,
}) {
  await assertAvailablePorts(checkPort);
  const instanceId = environment.API_VERIFICATION_ID;
  if (!/^[0-9a-f]{32}$/.test(instanceId || "")) throw new Error("bootstrap_instance_invalid");
  const children = [];
  let nextReady = false;
  let failed = false;
  let nextOutput = "";
  let stopping = false;
  let finish;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
    finish(code);
  }
  function launch(args, kind) {
    const child = spawnChild(process.execPath, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    child.once("error", () => {
      failed = true;
      stop(1);
    });
    child.once("exit", () => {
      if (!stopping) {
        failed = true;
        stop(1);
      }
    });
    child.stdout?.on("data", (chunk) => {
      output(chunk);
      if (kind === "web" && !nextReady) {
        nextOutput = (nextOutput + chunk.toString()).slice(-65536);
        nextReady = /^[^\S\r\n]*[✓✔] Ready in /m.test(nextOutput.replace(/\x1b\[[0-9;]*m/g, ""));
      }
    });
    child.stderr?.on("data", output);
    return child;
  }
  const onInterrupt = () => stop(0);
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    launch(["--import", "tsx", "apps/api/src/main.ts"], "api");
    if (failed) throw new Error("bootstrap_child_failed");
    launch(
      ["node_modules/next/dist/bin/next", "dev", "apps/web", "--hostname", "127.0.0.1", "--port", "3000"],
      "web",
    );
    const deadline = now() + startupMs;
    while (!stopping && now() < deadline) {
      try {
        const response = await fetchResponse("http://127.0.0.1:3001/health", {
          signal: AbortSignal.timeout(1500),
        });
        if ((await apiReady(response, instanceId)) && nextReady && !failed) {
          const web = await fetchResponse("http://localhost:3000", { signal: AbortSignal.timeout(5000) });
          await web.arrayBuffer();
          if (web.ok && !stopping && !failed) {
            await writeState({ ready: true });
            output(
              "\nAgent8lite is ready at http://localhost:3000. Keep this window open; Ctrl+C stops the app.\n",
            );
            return await done;
          }
        }
      } catch {
        /* Readiness cannot be inferred from an unrelated or incomplete response. */
      }
      await delay(500);
    }
    throw new Error(failed ? "bootstrap_child_failed" : "bootstrap_startup_timeout");
  } finally {
    stop(failed ? 1 : 0);
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
}
async function handshake() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bootstrap_parent_handshake_timeout")), 10000);
    process.stdin.once("data", (value) => {
      clearTimeout(timer);
      if (value.toString().trim() !== "START") reject(new Error("bootstrap_parent_handshake_invalid"));
      else resolve();
      process.stdin.pause();
    });
    process.stdin.resume();
  });
}
async function main() {
  if (process.platform !== "win32" || process.argv.slice(2).join(" ") !== "--bootstrap-handshake")
    throw new Error("bootstrap_windows_parent_required");
  // Windows parent assigns the kill-on-close Job Object before allowing any child process.
  await handshake();
  const root = await fs.realpath(fileURLToPath(new URL("../..", import.meta.url)));
  const pin = (await fs.readFile(path.join(root, ".node-version"), "utf8")).trim();
  if (process.version !== "v" + pin) throw new Error("bootstrap_node_version_invalid");
  const instanceId = randomBytes(16).toString("hex");
  const environment = bootstrapEnvironment(process.env, root, {
    instanceId,
    nodeDirectory: path.dirname(process.execPath),
  });
  const statePath = path.join(root, ".local", "bootstrap", "running.json");
  const state = {
    root,
    nodeExecutable: process.execPath,
    processId: process.pid,
    processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    instanceId,
    ready: false,
  };
  const writeState = async (change) => {
    Object.assign(state, change);
    await fs.writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  };
  await writeState({});
  try {
    process.exitCode = await supervise({ root, environment, writeState });
  } finally {
    await writeState({ ready: false });
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(() => {
    console.error(
      "bootstrap_app_failed: inspect the startup messages above, then click Start-Agent8lite.cmd again.",
    );
    process.exitCode = 1;
  });
}
