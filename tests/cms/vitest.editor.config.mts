import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/cms/editor.test.tsx",
      "packages/cms/browser.test.ts",
      "packages/cms/recovery.test.ts",
      "packages/cms/history.test.ts",
    ],
    fileParallelism: false,
  },
});
