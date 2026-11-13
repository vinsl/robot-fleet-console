/**
 * Vitest configuration of the video page.
 *
 * Unit tests run in Node: the coverage target is the logic that has no DOM dependency (the library,
 * the translations and the banner mapping). The glue of the page is exercised in a browser by the
 * live checks of ADR 0036.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/lib/**/*.ts", "src/i18n/**/*.ts"],
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
