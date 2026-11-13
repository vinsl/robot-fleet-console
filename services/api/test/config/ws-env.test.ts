/**
 * Environment of the WebSocket functions. The names are pinned to the Terraform environment blocks of
 * `realtime.tf`, so a rename on either side fails a test. A malformed value is reported by name only.
 */
import { describe, expect, it } from "vitest";
import {
  WsConnectEnvSchema,
  WsDisconnectEnvSchema,
  WsMessageEnvSchema,
  WsTokenEnvSchema,
  loadWsConnectEnv,
  loadWsDisconnectEnv,
  loadWsMessageEnv,
  loadWsTokenEnv,
} from "../../src/config/env";

const TABLE = "mfc-demo-connections";
const IOT_ENDPOINT = "abc123-ats.iot.eu-west-3.amazonaws.com";
const FLEET = "mfc-demo-fleet";
const WS_URL = "wss://abc123.execute-api.eu-west-3.amazonaws.com/live";
const ORIGINS = '["http://localhost:5173"]';
/** A value that must never appear in an error message. */
const SECRET_MARKER = "SECRET-VALUE-7f3a";

describe("WS environment names match the Terraform blocks", () => {
  it("ws-token reads CONNECTIONS_TABLE_NAME and WS_URL", () => {
    expect(Object.keys(WsTokenEnvSchema.shape).sort()).toStrictEqual(
      ["AWS_REGION", "CONNECTIONS_TABLE_NAME", "WS_URL"].sort(),
    );
  });

  it("ws-connect reads CONNECTIONS_TABLE_NAME and WS_ALLOWED_ORIGINS", () => {
    expect(Object.keys(WsConnectEnvSchema.shape).sort()).toStrictEqual(
      ["AWS_REGION", "CONNECTIONS_TABLE_NAME", "WS_ALLOWED_ORIGINS"].sort(),
    );
  });

  it("ws-disconnect reads CONNECTIONS_TABLE_NAME only", () => {
    expect(Object.keys(WsDisconnectEnvSchema.shape).sort()).toStrictEqual(
      ["AWS_REGION", "CONNECTIONS_TABLE_NAME"].sort(),
    );
  });

  it("ws-message reads both tables and the IoT data endpoint, and no management endpoint", () => {
    expect(Object.keys(WsMessageEnvSchema.shape).sort()).toStrictEqual(
      ["AWS_REGION", "CONNECTIONS_TABLE_NAME", "FLEET_TABLE_NAME", "IOT_DATA_ENDPOINT"].sort(),
    );
  });
});

describe("loadWsTokenEnv", () => {
  it("returns the typed environment", () => {
    expect(
      loadWsTokenEnv({ AWS_REGION: "eu-west-3", CONNECTIONS_TABLE_NAME: TABLE, WS_URL: WS_URL }),
    ).toStrictEqual({ AWS_REGION: "eu-west-3", CONNECTIONS_TABLE_NAME: TABLE, WS_URL: WS_URL });
  });

  it.each([
    ["a URL of another host", "wss://evil.example/live"],
    ["a plain HTTP URL", "https://abc123.execute-api.eu-west-3.amazonaws.com/live"],
    ["a URL of an unknown region", "wss://abc123.execute-api.us-east-1.amazonaws.com/live"],
  ])("refuses WS_URL with %s, naming only the variable", (_label, url) => {
    expect(() =>
      loadWsTokenEnv({ AWS_REGION: "eu-west-3", CONNECTIONS_TABLE_NAME: TABLE, WS_URL: url }),
    ).toThrow("invalid environment: WS_URL");
  });

  it("names the missing variable without its value", () => {
    expect(() =>
      loadWsTokenEnv({ AWS_REGION: "eu-west-3", CONNECTIONS_TABLE_NAME: TABLE }),
    ).toThrow("invalid environment: WS_URL");
  });
});

describe("loadWsConnectEnv", () => {
  const valid = {
    AWS_REGION: "eu-west-3",
    CONNECTIONS_TABLE_NAME: TABLE,
    WS_ALLOWED_ORIGINS: ORIGINS,
  };

  it("decodes the origin list", () => {
    expect(loadWsConnectEnv(valid).WS_ALLOWED_ORIGINS).toStrictEqual(["http://localhost:5173"]);
  });

  it.each([
    ["not JSON", `${SECRET_MARKER}[`],
    ["an empty list", "[]"],
    ["a wildcard", '["*"]'],
    ["an origin with a path", '["https://console.example/app"]'],
    ["a non-string entry", "[1]"],
    [
      "more than ten origins",
      JSON.stringify(Array.from({ length: 11 }, (_v, i) => `https://o${String(i)}.example`)),
    ],
  ])("refuses an origin list with %s, naming only the variable", (_label, value) => {
    let message = "";
    try {
      loadWsConnectEnv({ ...valid, WS_ALLOWED_ORIGINS: value });
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    // Zod adds the index of a bad array item to the path; the index is not a value.
    expect(message.startsWith("invalid environment: WS_ALLOWED_ORIGINS")).toBe(true);
    expect(message).not.toContain(SECRET_MARKER);
  });
});

describe("loadWsDisconnectEnv and loadWsMessageEnv", () => {
  it("ws-disconnect parses its table", () => {
    expect(
      loadWsDisconnectEnv({ AWS_REGION: "eu-west-3", CONNECTIONS_TABLE_NAME: TABLE }),
    ).toStrictEqual({
      AWS_REGION: "eu-west-3",
      CONNECTIONS_TABLE_NAME: TABLE,
    });
  });

  it("ws-message parses both tables and names a malformed fleet table", () => {
    expect(
      loadWsMessageEnv({
        AWS_REGION: "eu-west-3",
        CONNECTIONS_TABLE_NAME: TABLE,
        FLEET_TABLE_NAME: FLEET,
        IOT_DATA_ENDPOINT: IOT_ENDPOINT,
      }),
    ).toStrictEqual({
      AWS_REGION: "eu-west-3",
      CONNECTIONS_TABLE_NAME: TABLE,
      FLEET_TABLE_NAME: FLEET,
      IOT_DATA_ENDPOINT: IOT_ENDPOINT,
    });
    expect(() =>
      loadWsMessageEnv({
        AWS_REGION: "eu-west-3",
        CONNECTIONS_TABLE_NAME: TABLE,
        FLEET_TABLE_NAME: "other",
        IOT_DATA_ENDPOINT: IOT_ENDPOINT,
      }),
    ).toThrow("invalid environment: FLEET_TABLE_NAME");
  });
});
