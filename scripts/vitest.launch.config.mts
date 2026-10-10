import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["scripts/launch.test.mjs"], fileParallelism: false, testTimeout: 5000 },
});
