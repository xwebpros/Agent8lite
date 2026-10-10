// Source-only browser build verification; no listener, browser session, route or output directory.
import assert from "node:assert/strict";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const vitestRequire = createRequire(require.resolve("vitest/package.json"));
const { build } = await import(pathToFileURL(vitestRequire.resolve("vite")).href);
const forbiddenModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const result = await build({
  configFile: false,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  logLevel: "error",
  plugins: [
    {
      name: "cms-browser-boundary",
      resolveId(source) {
        assert(
          !source.startsWith("node:") && !forbiddenModules.has(source),
          `Node module entered the CMS browser graph: ${source}`,
        );
        return null;
      },
      buildEnd() {
        for (const id of this.getModuleIds())
          assert(
            !/\/packages\/(?:cms\/(?:index|drafts)\.ts|templates\/registry\.ts)$/.test(
              id.replaceAll("\\", "/"),
            ),
            `Server module entered browser graph: ${id}`,
          );
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    lib: {
      entry: {
        editor: "apps/web/features/cms/draft-editor.tsx",
        controller: "apps/web/features/cms/draft-controller.ts",
      },
      formats: ["es"],
    },
    rolldownOptions: { external: ["react", "react/jsx-runtime"] },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
for (const output of outputs) {
  if (output.type !== "chunk") continue;
  assert(
    !/\bBuffer\b|node:crypto|__vite-browser-external/.test(output.code),
    "Node globals or browser-external fallback entered the bundle.",
  );
}
console.log(
  `CMS browser bundle verified: ${outputs.length} in-memory outputs; no Node imports, Buffer, server CMS index or renderer.`,
);
