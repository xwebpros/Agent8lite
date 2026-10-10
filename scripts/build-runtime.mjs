import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const dist = path.join(root, "dist");
const target = path.join(dist, "runtime");
const marker = ".estate-runtime-owned";
const ownership = "estate-runtime-artifact-v1\n";
let temporary;

async function existing(location) {
  try {
    return await fs.lstat(location);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function checkedDirectory(location) {
  const stat = await fs.lstat(location);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.realpath(location)) !== location)
    throw new Error("runtime_output_unsafe");
}
async function ownedTarget() {
  if (path.relative(root, target) !== path.join("dist", "runtime")) throw new Error("runtime_output_unsafe");
  if (!(await existing(target))) return false;
  await checkedDirectory(target);
  const ownershipFile = path.join(target, marker);
  const stat = await existing(ownershipFile);
  if (
    !stat ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (await fs.readFile(ownershipFile, "utf8")) !== ownership
  )
    throw new Error("runtime_output_unowned");
  return true;
}
async function emittedFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("runtime_output_unsafe");
    const absolute = path.join(directory, entry.name);
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    if (entry.isDirectory()) files.push(...(await emittedFiles(absolute, relative)));
    else if (entry.isFile()) {
      if (
        /(?:^|\/)(?:tests|migrations|\.local)(?:\/|$)|\.(?:test|spec)\.js$|\.sql$|(?:^|\/)\.env/.test(
          relative,
        ) ||
        (!relative.startsWith("apps/api/") &&
          !relative.startsWith("apps/worker/") &&
          !relative.startsWith("packages/") &&
          ![marker, "package.json"].includes(relative))
      )
        throw new Error("runtime_output_unexpected");
      const content = await fs.readFile(absolute);
      files.push({
        path: relative,
        bytes: content.length,
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    } else throw new Error("runtime_output_unsafe");
  }
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
async function build() {
  const workspace = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const compiler = JSON.parse(
    await fs.readFile(path.join(root, "node_modules/typescript/package.json"), "utf8"),
  ).version;
  if (
    process.version !== "v" + workspace.engines.node ||
    process.argv.length !== 2 ||
    compiler !== workspace.dependencies.typescript
  )
    throw new Error("runtime_build_configuration_invalid");
  if (await existing(dist)) await checkedDirectory(dist);
  else await fs.mkdir(dist);
  await checkedDirectory(dist);
  await ownedTarget();
  temporary = await fs.mkdtemp(path.join(dist, ".estate-runtime-"));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(root, "node_modules/typescript/bin/tsc"),
        "--project",
        path.join(root, "tsconfig.runtime.json"),
        "--outDir",
        temporary,
      ],
      {
        cwd: root,
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  if (code !== 0) throw new Error("runtime_compile_failed");
  await fs.writeFile(path.join(temporary, marker), ownership);
  await fs.writeFile(path.join(temporary, "package.json"), '{"private":true,"type":"commonjs"}\n');
  const files = await emittedFiles(temporary);
  const manifest = {
    schemaVersion: 1,
    node: workspace.engines.node,
    typescript: compiler,
    packageManager: workspace.packageManager,
    entrypoints: { api: "apps/api/src/main.js", worker: "apps/worker/src/main.js" },
    files,
  };
  for (const entry of Object.values(manifest.entrypoints))
    if (!files.some((file) => file.path === entry)) throw new Error("runtime_entrypoint_missing");
  await fs.writeFile(
    path.join(temporary, "artifact-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await checkedDirectory(temporary);
  if (await ownedTarget()) await fs.rm(target, { recursive: true, force: false });
  await fs.rename(temporary, target);
  temporary = undefined;
  console.log(
    JSON.stringify({
      status: "built",
      artifact: "dist/runtime",
      files: files.length,
      jsonResources: files.filter((file) => file.path !== "package.json" && file.path.endsWith(".json"))
        .length,
    }),
  );
}
try {
  await build();
} catch (error) {
  const allowed = [
    "runtime_output_unsafe",
    "runtime_output_unowned",
    "runtime_output_unexpected",
    "runtime_build_configuration_invalid",
    "runtime_compile_failed",
    "runtime_entrypoint_missing",
  ];
  console.error(
    JSON.stringify({ code: allowed.includes(error.message) ? error.message : "runtime_build_failed" }),
  );
  process.exitCode = 1;
} finally {
  if (
    temporary &&
    path.dirname(temporary) === dist &&
    /^\.estate-runtime-[A-Za-z0-9]{6}$/.test(path.basename(temporary))
  ) {
    await checkedDirectory(temporary);
    await fs.rm(temporary, { recursive: true, force: false });
  }
}
