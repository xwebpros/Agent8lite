import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.{ts,tsx}",
      "tests/integration/**/*.test.ts",
      "tests/cms/**/*.test.{ts,tsx}",
      "tests/mls/**/*.test.ts",
      "tests/idx-template/**/*.test.{ts,tsx}",
      "apps/web/features/idx-template/**/*.test.{ts,tsx}",
      "packages/**/*.test.ts",
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
