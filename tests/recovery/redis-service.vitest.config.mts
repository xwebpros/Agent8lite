import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/recovery/redis-service.acceptance.ts"],
    testTimeout: 15000,
    hookTimeout: 10000,
    fileParallelism: false,
  },
});
