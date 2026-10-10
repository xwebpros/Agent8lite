import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const artifact = path.join(root, "dist/runtime");
const entrypoints = { api: "apps/api/src/main.js", worker: "apps/worker/src/main.js" };
const marker = ".estate-runtime-owned";

async function checkedDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.realpath(directory)) !== directory)
    throw new Error("runtime_artifact_unsafe");
}
async function records(directory, prefix = "") {
  await checkedDirectory(directory);
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("runtime_artifact_unsafe");
    if (entry.isDirectory()) result.push(...(await records(absolute, relative)));
    else if (entry.isFile()) {
      if (
        /(?:^|\/)(?:tests|migrations|\.local)(?:\/|$)|\.(?:test|spec)\.js$|\.sql$|(?:^|\/)\.env/.test(
          relative,
        ) ||
        (!relative.startsWith("apps/api/") &&
          !relative.startsWith("apps/worker/") &&
          !relative.startsWith("packages/") &&
          ![marker, "package.json", "artifact-manifest.json"].includes(relative))
      )
        throw new Error("runtime_artifact_unexpected");
      const content = await fs.readFile(absolute);
      result.push({
        path: relative,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } else throw new Error("runtime_artifact_unsafe");
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
function isolatedEnvironment() {
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (["systemroot", "windir", "path", "temp", "tmp"].includes(key.toLowerCase())) env[key] = value;
  return { ...env, APP_ENV: "production", DEV_AUTH_ENABLED: "false", WORKER_CONTEXTS: "[]" };
}
function probe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: isolatedEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let bytes = 0;
    let failure;
    let settled = false;
    let force;
    let bound;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(force);
      clearTimeout(bound);
      if (error) reject(error);
      else resolve(result);
    }
    function halt(code) {
      if (failure || settled) return;
      failure = new Error(code);
      child.kill();
      force = setTimeout(() => child.kill("SIGKILL"), 1000);
      bound = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(failure);
      }, 2500);
    }
    const timer = setTimeout(() => {
      halt("runtime_probe_timeout");
    }, 15000);
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        if (failure || settled) return;
        bytes += chunk.length;
        if (bytes > 65536) halt("runtime_probe_output_invalid");
        else output += chunk;
      });
    child.once("error", () => {
      finish(new Error("runtime_probe_start_failed"));
    });
    child.once("close", (code) => {
      finish(failure, { code, output });
    });
  });
}
try {
  const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (process.argv.length !== 2 || process.version !== "v" + workspace.engines.node)
    throw new Error("runtime_verification_configuration_invalid");
  await checkedDirectory(path.join(root, "dist"));
  const actual = await records(artifact);
  if ((await fs.readFile(path.join(artifact, marker), "utf8")) !== "estate-runtime-artifact-v1\n")
    throw new Error("runtime_artifact_unowned");
  if (
    (await fs.readFile(path.join(artifact, "package.json"), "utf8")) !==
    '{"private":true,"type":"commonjs"}\n'
  )
    throw new Error("runtime_artifact_module_invalid");
  const manifest = JSON.parse(await fs.readFile(path.join(artifact, "artifact-manifest.json"), "utf8"));
  const files = actual.filter((record) => record.path !== "artifact-manifest.json");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.node !== workspace.engines.node ||
    manifest.typescript !== workspace.devDependencies.typescript ||
    manifest.packageManager !== workspace.packageManager ||
    JSON.stringify(manifest.entrypoints) !== JSON.stringify(entrypoints) ||
    JSON.stringify(manifest.files) !== JSON.stringify(files) ||
    Object.values(entrypoints).some((entry) => !files.some((file) => file.path === entry))
  )
    throw new Error("runtime_artifact_manifest_invalid");
  const imported = await probe([
    "--require",
    path.join(root, "scripts/runtime-probe-guard.cjs"),
    "--input-type=commonjs",
    "-e",
    'const api = require(process.argv[1]); if (typeof api.createApplication !== "function") process.exitCode = 1; else console.log("api_import_inert");',
    path.join(artifact, entrypoints.api),
  ]);
  if (
    imported.code !== 0 ||
    imported.output.trim() !== 'api_import_inert\nRUNTIME_PROBE_EFFECTS={"connections":0,"listeners":0}'
  )
    throw new Error("runtime_api_import_failed");
  const worker = await probe([
    "--require",
    path.join(root, "scripts/runtime-probe-guard.cjs"),
    path.join(artifact, entrypoints.worker),
  ]);
  if (
    worker.code !== 1 ||
    !worker.output.includes(
      "Error: Trusted worker contexts required; global discovery is not implemented.",
    ) ||
    !worker.output.includes('RUNTIME_PROBE_EFFECTS={"connections":0,"listeners":0}')
  )
    throw new Error("runtime_worker_boundary_failed");
  console.log(
    JSON.stringify({
      status: "verified",
      files: files.length,
      jsonResources: files.filter((file) => file.path !== "package.json" && file.path.endsWith(".json"))
        .length,
      apiImport: "inert",
      workerEmptyContext: "denied-before-connection",
      guardedConnectionAttempts: 0,
      guardedListenerAttempts: 0,
    }),
  );
} catch (error) {
  const allowed = [
    "runtime_artifact_unsafe",
    "runtime_artifact_unexpected",
    "runtime_artifact_unowned",
    "runtime_artifact_module_invalid",
    "runtime_artifact_manifest_invalid",
    "runtime_verification_configuration_invalid",
    "runtime_probe_timeout",
    "runtime_probe_output_invalid",
    "runtime_probe_start_failed",
    "runtime_api_import_failed",
    "runtime_worker_boundary_failed",
  ];
  console.error(
    JSON.stringify({ code: allowed.includes(error.message) ? error.message : "runtime_verification_failed" }),
  );
  process.exitCode = 1;
}
