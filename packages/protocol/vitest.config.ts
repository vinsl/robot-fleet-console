/**
 * Vitest configuration for the protocol package.
 *
 * Coverage is enforced at 80 % because every schema here is a trust boundary: an
 * untested branch is an input we have not proven we reject.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
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
