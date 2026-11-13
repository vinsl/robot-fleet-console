/**
 * Loader of the runtime configuration, fetched from `/config.json` when the page loads.
 *
 * The schema lives in `@mfc/protocol`; this module only fetches the file and reports why it could not be used.
 */
import { RuntimeConfigSchema, type RuntimeConfig } from "@mfc/protocol";

/** Path of the runtime configuration, served with `no-cache` by the CDN. */
export const RUNTIME_CONFIG_PATH = "/config.json";

/** Why the configuration could not be loaded. The reason is for the developer, never shown to the user. */
export type ConfigErrorReason = "unavailable" | "invalid";

/**
 * Raised when `/config.json` cannot be fetched or does not match the protocol schema.
 * The console does not start without a valid configuration.
 */
export class ConfigError extends Error {
  /** Why loading failed. */
  readonly reason: ConfigErrorReason;

  /**
   * @param reason - The failure category.
   */
  constructor(reason: ConfigErrorReason) {
    super(`runtime configuration ${reason}`);
    this.name = "ConfigError";
    this.reason = reason;
  }
}

/**
 * Fetches and validates the runtime configuration.
 *
 * The request bypasses the cache so that a republished configuration takes effect on the next load, and it
 * sends no credentials because the file is public.
 *
 * @param fetchFn - Fetch implementation. Injected for tests.
 * @returns The validated configuration.
 * @throws {ConfigError} `unavailable` when the request fails or is not 2xx; `invalid` when the body is not
 *   JSON or does not match the schema.
 */
export async function loadRuntimeConfig(fetchFn: typeof fetch = fetch): Promise<RuntimeConfig> {
  let response: Response;
  try {
    response = await fetchFn(RUNTIME_CONFIG_PATH, { cache: "no-store", credentials: "omit" });
  } catch {
    throw new ConfigError("unavailable");
  }
  if (!response.ok) {
    throw new ConfigError("unavailable");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConfigError("invalid");
  }

  const parsed = RuntimeConfigSchema.safeParse(body);
  if (!parsed.success) {
    throw new ConfigError("invalid");
  }
  return parsed.data;
}
