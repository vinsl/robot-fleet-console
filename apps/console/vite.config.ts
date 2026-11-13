/**
 * Vite configuration for the console.
 *
 * Source maps are disabled for production builds so that the bundle published to the CDN does not expose
 * original sources; errors are diagnosed through the API logs instead.
 *
 * The end-to-end fake authentication client is switched on only by `VITE_E2E=true` together with
 * `--mode e2e`. The flag is a build-time constant, so the fake is dead code everywhere else and is dropped from
 * the bundle. Setting the flag in any other mode (including the publish build) fails the build instead of
 * silently producing a bundle that accepts fixture accounts.
 */
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Mode that enables the end-to-end seam. Only the e2e build runs in it. */
const E2E_MODE = "e2e";

export default defineConfig(({ mode }) => {
  const requested = process.env.VITE_E2E === "true";
  if (requested && mode !== E2E_MODE) {
    throw new Error(`VITE_E2E=true is only allowed with --mode ${E2E_MODE} (got mode "${mode}")`);
  }
  const e2e = requested && mode === E2E_MODE;

  return {
    plugins: [react()],
    define: {
      // amazon-cognito-identity-js reads the Node global `global` at load time; without this alias the browser
      // bundle throws a ReferenceError before the first render.
      global: "globalThis",
      "import.meta.env.VITE_E2E": JSON.stringify(e2e ? "true" : "false"),
    },
    build: {
      sourcemap: false,
      // Each stylesheet is a separate file linked from index.html; no style is inlined into the page (CSP).
      cssCodeSplit: true,
    },
  };
});
