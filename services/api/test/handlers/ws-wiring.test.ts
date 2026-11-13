/**
 * Production wiring of the WebSocket handlers: each module builds its handler from a valid environment without
 * any AWS call, and refuses to load when a variable it needs is missing, naming the variable and not its value.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A complete, valid environment of the four WebSocket functions. */
const VALID_ENV: Record<string, string> = {
  AWS_REGION: "eu-west-3",
  CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  IOT_DATA_ENDPOINT: "abc123-ats.iot.eu-west-3.amazonaws.com",
  WS_URL: "wss://abc123.execute-api.eu-west-3.amazonaws.com/live",
  WS_ALLOWED_ORIGINS: '["https://console.example"]',
};

/** Each function, its module, and the variable it cannot start without. */
const FUNCTIONS: readonly {
  readonly name: string;
  readonly load: () => Promise<{ readonly handler: unknown }>;
  readonly requires: string;
}[] = [
  { name: "ws-token", load: () => import("../../src/handlers/ws-token"), requires: "WS_URL" },
  {
    name: "ws-connect",
    load: () => import("../../src/handlers/ws-connect"),
    requires: "WS_ALLOWED_ORIGINS",
  },
  {
    name: "ws-disconnect",
    load: () => import("../../src/handlers/ws-disconnect"),
    requires: "CONNECTIONS_TABLE_NAME",
  },
  {
    name: "ws-message",
    load: () => import("../../src/handlers/ws-message"),
    requires: "FLEET_TABLE_NAME",
  },
];

beforeEach(() => {
  for (const [name, value] of Object.entries(VALID_ENV)) {
    vi.stubEnv(name, value);
  }
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("production WebSocket handlers", () => {
  it.each(FUNCTIONS)("$name builds its handler from a valid environment", async ({ load }) => {
    const module = await load();
    expect(typeof module.handler).toBe("function");
  });

  it("ws-message refuses to start without IOT_DATA_ENDPOINT, naming the variable only", async () => {
    vi.stubEnv("IOT_DATA_ENDPOINT", undefined);
    await expect(import("../../src/handlers/ws-message")).rejects.toThrow(
      "invalid environment: IOT_DATA_ENDPOINT",
    );
  });

  it.each(FUNCTIONS)(
    "$name refuses to start without $requires, naming the variable only",
    async ({ load, requires }) => {
      vi.stubEnv(requires, undefined);
      await expect(load()).rejects.toThrow(`invalid environment: ${requires}`);
    },
  );
});
