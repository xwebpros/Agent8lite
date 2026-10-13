import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["apps/web/features/idx-template/**/*.test.{ts,tsx}"],
    fileParallelism: false,
  },
});
