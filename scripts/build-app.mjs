import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
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
  if (process.version !== `v${workspace.engines.node}` || process.argv.length !== 2)
    throw new Error("application_build_configuration_invalid");
  if (![".next", ".next-build"].includes(process.env.ESTATE_BUILD_DIR || ".next"))
    throw new Error("application_build_configuration_invalid");
  await run([path.join(root, "scripts/build-runtime.mjs")]);
  await run([path.join(root, "node_modules/next/dist/bin/next"), "build", path.join(root, "apps/web")]);
} catch (error) {
  console.error(
    JSON.stringify({
      code:
        error.message === "application_build_configuration_invalid"
          ? error.message
          : "application_build_failed",
    }),
  );
  process.exitCode = 1;
}
