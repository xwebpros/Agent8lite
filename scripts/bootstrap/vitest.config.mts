import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/bootstrap/bootstrap.test.mjs"],
    fileParallelism: false,
    testTimeout: 10000,
  },
});
