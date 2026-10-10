import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeRuntime, NodeRuntimeError, readPinnedNode } from "./node-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const kind = process.argv[2];
  if (process.argv.length !== 3 || !["api", "worker"].includes(kind))
    throw new Error("runtime_start_configuration_invalid");
  // These are always full application processes, regardless of a preview flag.
  assertNodeRuntime(process.version, await readPinnedNode(root), false, "runtime_start_node_version_invalid");
  const child = spawn(process.execPath, [path.join(root, "dist/runtime/apps", kind, "src/main.js")], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  let timer;
  const shutdown = () => {
    if (timer) return;
    child.kill("SIGTERM");
    timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", () => reject(new Error("runtime_start_failed")));
      child.once("close", (code, signal) => resolve(signal && timer ? 0 : code === null ? 1 : code));
    });
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", shutdown);
    process.removeListener("SIGTERM", shutdown);
  }
} catch (error) {
  const codes = ["runtime_start_configuration_invalid", "runtime_start_node_version_invalid"];
  console.error(
    JSON.stringify({
      code: codes.includes(error.message) ? error.message : "runtime_start_failed",
      ...(error instanceof NodeRuntimeError ? error.diagnostics() : {}),
    }),
  );
  process.exitCode = 1;
}
