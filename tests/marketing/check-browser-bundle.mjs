// Source-only verification: no output files, listener, application execution or browser session.
import assert from "node:assert/strict";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const vitestRequire = createRequire(require.resolve("vitest/package.json"));
const { build } = await import(pathToFileURL(vitestRequire.resolve("vite")).href);
const forbiddenModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const entries = {
  campaigns: "apps/web/components/campaign-workspace.tsx",
  designController: "apps/web/components/message-design-controller.ts",
  designProtocol: "apps/web/components/message-design-protocol.ts",
  workflow: "apps/web/components/campaign-workflow-workspace.tsx",
};
const normalize = (id) => id.replaceAll("\\", "/").split("?")[0];
const result = await build({
  configFile: false,
  root: fileURLToPath(new URL("../../", import.meta.url)),
  logLevel: "error",
  plugins: [
    {
      name: "marketing-browser-boundary",
      resolveId(source) {
        assert(
          !source.startsWith("node:") && !forbiddenModules.has(source),
          `Node module entered the marketing browser graph: ${source}`,
        );
        return null;
      },
      buildEnd() {
        const modules = [...this.getModuleIds()].map(normalize);
        for (const id of modules) {
          assert(
            !/\/apps\/api\/|\/packages\/(?:db|auth|providers|cms|templates)\/|\/packages\/marketing\/native-design\.ts$/.test(
              id,
            ),
            `Server or CMS/template module entered the marketing browser graph: ${id}`,
          );
          assert(!id.includes("__vite-browser-external"), `Browser external fallback entered graph: ${id}`);
        }
        for (const entry of Object.values(entries))
          assert(
            modules.some((id) => id.endsWith(`/${entry}`)),
            `Expected browser entry was not built: ${entry}`,
          );
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    lib: { entry: entries, formats: ["es"] },
    rolldownOptions: { external: ["react", "react/jsx-runtime"] },
  },
});
const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
const chunks = outputs.filter((output) => output.type === "chunk");
assert.equal(chunks.filter((chunk) => chunk.isEntry).length, Object.keys(entries).length);
for (const chunk of chunks)
  assert(
    !/\bBuffer\b|node:|__vite-browser-external/.test(chunk.code),
    `Node globals or browser external fallback entered the bundle: ${chunk.fileName}`,
  );
console.log(
  `Marketing browser bundle verified: ${Object.keys(entries).length} entries, ${outputs.length} in-memory outputs; no Node, server, provider, native preparation or CMS/template modules.`,
);
