import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launchConfiguration } from "./launch-config.mjs";
import { NodeRuntimeError, readPinnedNode } from "./node-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each readiness event comes from an owned child, never an existing port listener.
export function supervise(
  config,
  { directory = root, spawnChild = spawn, startupMs = 30000, shutdownMs = 5000 } = {},
) {
  const children = [];
  let stopping = false;
  let finish;
  let readyResolve;
  let readyReject;
  const done = new Promise((resolve) => {
    finish = resolve;
  });
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const timers = new Set();
  function timer(callback, ms) {
    const handle = setTimeout(() => {
      timers.delete(handle);
      callback();
    }, ms);
    timers.add(handle);
    return handle;
  }
  function cancel(handle) {
    clearTimeout(handle);
    timers.delete(handle);
  }
  async function stop(code = 0) {
    if (stopping) return done;
    stopping = true;
    for (const handle of timers) clearTimeout(handle);
    timers.clear();
    readyReject(new Error("application_launch_stopped"));
    await Promise.all(
      children.map(async (state) => {
        if (state.exited) return;
        if (state.kind === "api" && state.child.connected) {
          state.child.send({ type: "estate-shutdown" }, () => {});
        } else state.child.kill("SIGTERM");
        const force = setTimeout(() => {
          if (!state.exited) state.child.kill("SIGKILL");
        }, shutdownMs);
        await state.exit;
        clearTimeout(force);
      }),
    );
    finish(code);
    return done;
  }
  function launch(kind, args, env) {
    const child = spawnChild(process.execPath, args, {
      cwd: directory,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const state = { child, kind, exited: false, output: "" };
    children.push(state);
    state.exit = new Promise((resolve) => {
      child.once("error", () => {
        if (!child.pid) {
          state.exited = true;
          resolve();
        }
        void stop(1);
      });
      child.once("close", () => {
        state.exited = true;
        resolve();
        if (!stopping) void stop(1);
      });
    });
    // Drain output, but never forward arbitrary error text or configuration.
    child.stderr.on("data", () => {});
    return state;
  }
  const startup = timer(() => void stop(1), startupMs);
  function startWeb(apiPort, apiPid) {
    let web;
    try {
      web = launch(
        "web",
        [
          path.join(directory, "node_modules/next/dist/bin/next"),
          "start",
          path.join(directory, "apps/web"),
          "--hostname",
          "0.0.0.0",
          "--port",
          String(config.port),
        ],
        config.webEnvironment(apiPort),
      );
    } catch {
      void stop(1);
      return;
    }
    let webReady = false;
    web.child.stdout.on("data", (chunk) => {
      if (stopping || webReady) return;
      web.output += chunk.toString();
      if (web.output.length > 65536) {
        void stop(1);
        return;
      }
      // This is the pinned Next 16.4 CLI readiness line. Arbitrary HTTP responses cannot satisfy it.
      if (/^[^\S\r\n]*[✓✔] Ready in /m.test(web.output.replace(/\x1b\[[0-9;]*m/g, ""))) {
        webReady = true;
        web.output = "";
        cancel(startup);
        readyResolve({
          port: config.port,
          apiPort,
          apiPid,
          webPid: web.child.pid,
        });
      }
    });
  }
  if (config.mode === "demo") startWeb();
  else {
    const api = launch(
      "api",
      [path.join(directory, "dist/runtime/apps/api/src/main.js")],
      config.apiEnvironment,
    );
    api.child.stdout.on("data", () => {});
    let apiReady = false;
    api.child.on("message", (message) => {
      if (stopping || apiReady || message?.type !== "estate-api-ready") return;
      if (!Number.isInteger(message.port) || message.port < 1 || message.port > 65535) {
        void stop(1);
        return;
      }
      apiReady = true;
      startWeb(message.port, api.child.pid);
    });
  }
  return { ready, done, stop };
}

async function main() {
  const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const config = launchConfiguration(process.env, workspace, process.version, await readPinnedNode(root));
  if (process.argv.length !== 2) throw new Error("launch_configuration_invalid");
  const next = JSON.parse(await fs.readFile(path.join(root, "node_modules/next/package.json"), "utf8"));
  if (next.version !== workspace.dependencies.next) throw new Error("launch_next_version_invalid");
  if (config.mode !== "demo") await fs.access(path.join(root, "dist/runtime/apps/api/src/main.js"));
  await fs.access(path.join(root, "apps/web", config.buildDirectory, "BUILD_ID"));
  const application = supervise(config);
  const shutdown = () => void application.stop(0);
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Private supervision only. This is not an HTTP endpoint or browser capability.
  if (process.connected) {
    process.on("message", (message) => {
      if (message?.type === "estate-shutdown") shutdown();
    });
    process.on("disconnect", shutdown);
  }
  try {
    const ready = await application.ready;
    console.log(
      JSON.stringify({
        status: "ready",
        mode: config.mode,
        node: process.version,
        port: ready.port,
        identityMode: "unconfigured",
        mlsMode: "mock",
        deliveryMode: "no-delivery",
      }),
    );
    if (process.connected) process.send({ type: "estate-app-ready", ...ready });
  } catch {
    /* Only the fixed final code below is logged. */
  }
  process.exitCode = await application.done;
  if (process.exitCode) console.error(JSON.stringify({ code: "application_launch_failed" }));
  process.removeListener("SIGINT", shutdown);
  process.removeListener("SIGTERM", shutdown);
  if (process.connected) process.disconnect();
}

// Shared by npm start and the hosted npm run dev compatibility entrypoint.
export async function runApplication() {
  try {
    await main();
  } catch (error) {
    const allowed = [
      "launch_node_version_invalid",
      "launch_port_required",
      "launch_database_url_required",
      "launch_web_origin_required",
      "launch_build_directory_invalid",
      "launch_configuration_invalid",
      "launch_next_version_invalid",
      "launch_demo_secrets_required",
    ];
    console.error(
      JSON.stringify({
        code: allowed.includes(error.message) ? error.message : "application_launch_failed",
        ...(error instanceof NodeRuntimeError ? error.diagnostics() : {}),
      }),
    );
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  await runApplication();
