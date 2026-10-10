import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeRuntime, NodeRuntimeError, readPinnedNode } from "./node-runtime.mjs";

try {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assertNodeRuntime(process.version, await readPinnedNode(root), false, "development_node_version_invalid");
} catch (error) {
  console.error(
    JSON.stringify({
      code: "development_node_version_invalid",
      ...(error instanceof NodeRuntimeError ? error.diagnostics() : {}),
    }),
  );
  process.exit(1);
}

const env = {
  ...process.env,
  APP_ENV: process.env.APP_ENV ?? "development",
  DEV_AUTH_ENABLED: process.env.DEV_AUTH_ENABLED ?? "true",
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  API_PORT: process.env.API_PORT ?? "3001",
  DATABASE_URL:
    process.env.DATABASE_URL ?? "postgresql://estate_runtime:local-runtime-only@127.0.0.1:55432/estate",
  CONTROL_DATABASE_URL:
    process.env.CONTROL_DATABASE_URL ??
    "postgresql://estate_control:local-control-only@127.0.0.1:55432/estate",
  STAFF_ISSUER_DATABASE_URL:
    process.env.STAFF_ISSUER_DATABASE_URL ??
    "postgresql://estate_staff_issuer:local-staff-issuer-only@127.0.0.1:55432/estate",
};
if (!["development", "test"].includes(env.APP_ENV) || env.DEV_AUTH_ENABLED !== "true")
  throw new Error("The development launcher requires explicitly enabled synthetic local mode.");
const children = [
  spawn(process.execPath, ["--watch", "--import", "tsx", "apps/api/src/main.ts"], {
    env,
    stdio: "inherit",
    windowsHide: true,
  }),
  spawn(
    process.execPath,
    ["node_modules/next/dist/bin/next", "dev", "apps/web", "--hostname", "127.0.0.1", "--port", "3000"],
    { env, stdio: "inherit", windowsHide: true },
  ),
];
await fs.mkdir(".local", { recursive: true });
await fs.writeFile(
  ".local/dev-processes.json",
  JSON.stringify({ ownedPids: children.map((p) => p.pid), startedAt: new Date().toISOString() }),
);
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children)
  child.on("exit", (code) => {
    if (!stopping && code) {
      process.exitCode = code;
      stop();
    }
  });
console.log("Synthetic workspace: http://localhost:3000 • API: http://127.0.0.1:3001");
