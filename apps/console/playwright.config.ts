/**
 * Playwright configuration of the deployed-URL end-to-end test (ADR 0069).
 *
 * The test runs against the production build behind CloudFront, with the real user pool and the real API, so the
 * configuration reads the base URL from the state file of the run instead of hard-coding a host. A single worker
 * and no retries are deliberate: the operator of a run is used once, so a retry would meet an enrolled account and
 * hide the first failure. Traces, videos and screenshots are off because they would capture the passwords and the
 * TOTP secret typed by the test.
 */
import { devices, defineConfig } from "@playwright/test";
import { loadState } from "./e2e/support/state";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  // Plain-text reporters only. The HTML reporter stores its data as a compressed archive that a secret scan cannot
  // read, so it is not used. Everything the run writes lives under playwright-report/, the one folder that
  // scripts/e2e-scan-report.mjs scans before anything is uploaded.
  reporter: [["list"], ["junit", { outputFile: "playwright-report/results.xml" }]],
  outputDir: "playwright-report/artifacts",
  use: {
    baseURL: loadState().consoleUrl,
    trace: "off",
    video: "off",
    screenshot: "off",
    ignoreHTTPSErrors: false,
    locale: "en",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
