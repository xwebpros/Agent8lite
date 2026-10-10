import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["html", { open: "never", outputFolder: "test-results/playwright-report" }]],
  outputDir: "test-results/browser",
  use: {
    baseURL: process.env.TEST_WEB_ORIGIN ?? "http://localhost:3000",
    ...(process.platform === "win32" ? { channel: "chrome" } : {}),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-360", use: { ...devices["Pixel 5"], viewport: { width: 360, height: 800 } } },
  ],
});
