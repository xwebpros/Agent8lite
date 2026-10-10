import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/mls/**/*.test.ts", "tests/unit/provider-contracts.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
