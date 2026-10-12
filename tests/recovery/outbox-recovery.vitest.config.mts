import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/recovery/outbox-recovery.test.ts"],
    testTimeout: 10000,
    hookTimeout: 5000,
  },
});
