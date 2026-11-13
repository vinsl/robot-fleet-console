/**
 * Vitest configuration for the console.
 *
 * Pure logic runs in Node. Component tests opt into jsdom with a `@vitest-environment jsdom` pragma at the top
 * of their file, so the default environment stays fast. The coverage target is the pure logic under `src/lib` and the
 * e2e helpers that hold the test's own TOTP and state validation. `e2e/support/steps.ts` drives a real browser, so it
 * is exercised by the deployed end-to-end run and left out of the coverage target.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "e2e/support/**/*.ts"],
      exclude: ["e2e/support/steps.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
