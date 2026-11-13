/**
 * Browser entry point: loads the runtime configuration, then mounts the console into `#root`.
 *
 * The i18n module is imported for its side effect: it initialises the translations before the first render.
 * The stylesheets are imported here so that every view gets the tokens and the base rules.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { createServices, type ServicesOverrides } from "./app/create-services";
import { ConfigError, loadRuntimeConfig } from "./config/runtime-config";
import "./i18n";
import "./theme/tokens.css";
import "./theme/base.css";
import { BootFailure } from "./pages/BootFailure";

/**
 * Chooses the clients the build replaces. Only the end-to-end build (`VITE_E2E=true`) replaces the
 * authentication client. `vite.config.ts` turns the flag into a constant, so in production this function
 * returns at once and the fake client is not bundled.
 *
 * @returns The overrides, empty in production.
 */
async function loadOverrides(): Promise<ServicesOverrides> {
  const e2e: unknown = import.meta.env.VITE_E2E;
  if (e2e !== "true") {
    return {};
  }
  const { createFakeAuthClient } = await import("./auth/fake-auth-client");
  return { auth: createFakeAuthClient() };
}

/**
 * Mounts the console once the configuration is known. A configuration that cannot be loaded shows the
 * fixed start-up failure instead; the console never starts with guessed endpoints.
 *
 * @param container - The `#root` element.
 */
async function boot(container: HTMLElement): Promise<void> {
  const root = createRoot(container);
  try {
    const config = await loadRuntimeConfig();
    const overrides = await loadOverrides();
    root.render(
      <StrictMode>
        <App services={createServices(config, overrides)} />
      </StrictMode>,
    );
  } catch (error) {
    // Only a configuration problem has a fixed message. Anything else is a bug and must surface.
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    root.render(
      <StrictMode>
        <BootFailure />
      </StrictMode>,
    );
  }
}

const container = document.getElementById("root");
// Failing loudly here is better than mounting nothing: a missing root is a broken build.
if (container === null) {
  throw new Error("Missing #root element in index.html");
}
void boot(container);
