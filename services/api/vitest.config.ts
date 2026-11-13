/**
 * Vitest configuration for the API service.
 *
 * Coverage is measured on the domain layer only: handlers are thin adapters whose
 * behaviour is covered by the denied-access and end-to-end suites added with them.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/domain/**/*.ts"],
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
