// In-memory source verification; no browser, listener or files are created.
import assert from "node:assert/strict";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const vitestRequire = createRequire(require.resolve("vitest/package.json"));
const { build } = await import(pathToFileURL(vitestRequire.resolve("vite")).href);
const forbidden = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const result = await build({
  configFile: false,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  logLevel: "error",
  plugins: [
    {
      name: "properties-browser-boundary",
      resolveId(source) {
        assert(
          !source.startsWith("node:") && !forbidden.has(source),
          `Node module in property browser graph: ${source}`,
        );
        return null;
      },
      buildEnd() {
        for (const id of this.getModuleIds()) {
          const normalized = id.replaceAll("\\", "/");
          assert(
            !/\/packages\/(?:mls|auth|db|providers)\/|\/apps\/api\//.test(normalized),
            `Server module in property browser graph: ${id}`,
          );
        }
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    lib: { entry: "apps/web/features/properties/index.ts", formats: ["es"] },
    rolldownOptions: { external: ["react", "react/jsx-runtime"] },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
for (const output of outputs) {
  if (output.type !== "chunk") continue;
  assert(
    !/\bBuffer\b|node:crypto|__vite-browser-external/.test(output.code),
    "Node globals in property browser bundle.",
  );
}
console.log(
  `Property browser source bundle verified: ${outputs.length} in-memory outputs; no Node/server modules.`,
);
