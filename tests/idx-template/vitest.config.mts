import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/idx-template/**/*.test.{ts,tsx}", "apps/web/features/idx-template/**/*.test.{ts,tsx}"],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
