import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/cms/**/*.integration.test.ts"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
    env: { APP_ENV: "test", DEV_AUTH_ENABLED: "true" },
  },
});
