import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertNodeRuntime, NodeRuntimeError, readPinnedNode } from "./node-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      stdio: "inherit",
      windowsHide: true,
      env: {
        ...process.env,
        NODE_ENV: "production",
        APP_ENV: "production",
        DEV_AUTH_ENABLED: "false",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    });
    child.once("error", () => reject(new Error("application_build_failed")));
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error("application_build_failed"))));
  });
try {
  const demo = process.env.HOSTED_DEMO_ENABLED === "true";
  assertNodeRuntime(
    process.version,
    await readPinnedNode(root),
    demo,
    "application_build_node_version_invalid",
  );
  if (process.argv.length !== 2) throw new Error("application_build_configuration_invalid");
  if (![".next", ".next-build"].includes(process.env.ESTATE_BUILD_DIR || ".next"))
    throw new Error("application_build_configuration_invalid");
  if (!demo) await run([path.join(root, "scripts/build-runtime.mjs")]);
  await run([path.join(root, "node_modules/next/dist/bin/next"), "build", path.join(root, "apps/web")]);
  console.log(
    JSON.stringify({
      status: "application-built",
      mode: demo ? "demo" : "application",
      node: process.version,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      code: ["application_build_configuration_invalid", "application_build_node_version_invalid"].includes(
        error.message,
      )
        ? error.message
        : "application_build_failed",
      ...(error instanceof NodeRuntimeError ? error.diagnostics() : {}),
    }),
  );
  process.exitCode = 1;
}
