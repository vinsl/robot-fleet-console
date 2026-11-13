/**
 * Vite configuration of the video page: one HTML entry point, built into the agent's package.
 *
 * The build is committed to `agent/src/fleet_agent/video/static/` (ADR 0037): the agent serves those
 * bytes and checks them against `MANIFEST.sha256`, so the output must be deterministic and must not
 * depend on the machine that builds it. Source maps are off: the page is served from the robot, and
 * the bundle carries code only. The base is the root, because the agent serves the page at `/`.
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/** Folder the agent packages and serves. Overridden by `vite build --outDir` for the drift check. */
const AGENT_STATIC_DIR = fileURLToPath(
  new URL("../../agent/src/fleet_agent/video/static", import.meta.url),
);

export default defineConfig({
  build: {
    outDir: AGENT_STATIC_DIR,
    emptyOutDir: true,
    sourcemap: false,
    target: "es2023",
    assetsDir: "assets",
  },
});
