/**
 * Environment parsing of the API functions: a valid environment parses, and an invalid one fails closed
 * with the names of the variables at fault and never their values.
 */
import { describe, expect, it } from "vitest";
import {
  AlertsEnvSchema,
  IngestEventsEnvSchema,
  IngestTelemetryEnvSchema,
  loadAlertsEnv,
  loadControlEnv,
  loadIngestEventsEnv,
  loadIngestTelemetryEnv,
  loadRobotsEnv,
} from "../../src/config/env";

/** A complete, valid environment of the `robots` function. */
const VALID_ROBOTS_ENV: NodeJS.ProcessEnv = {
  AWS_REGION: "eu-west-3",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  EVENTS_TABLE_NAME: "mfc-demo-events",
  IOT_DATA_ENDPOINT: "abc123-ats.iot.eu-west-3.amazonaws.com",
  IOT_CREDENTIALS_ENDPOINT: "abc123.credentials.iot.eu-west-3.amazonaws.com",
  RESOURCE_TAGS: JSON.stringify({
    project: "mfc",
    env: "demo",
    component: "robots",
    owner: "vincent",
  }),
};

/** A value that must never appear in an error message: it stands for a secret or a personal identifier. */
const SECRET_MARKER = "SECRET-VALUE-7f3a";

describe("loadRobotsEnv", () => {
  it("returns the typed environment, with the tags decoded", () => {
    const env = loadRobotsEnv(VALID_ROBOTS_ENV);
    expect(env.AWS_REGION).toBe("eu-west-3");
    expect(env.FLEET_TABLE_NAME).toBe("mfc-demo-fleet");
    expect(env.RESOURCE_TAGS).toStrictEqual({
      project: "mfc",
      env: "demo",
      component: "robots",
      owner: "vincent",
    });
  });

  it("ignores the unrelated variables of the Lambda runtime", () => {
    const env = loadRobotsEnv({ ...VALID_ROBOTS_ENV, AWS_LAMBDA_FUNCTION_NAME: "mfc-demo-robots" });
    expect(env).not.toHaveProperty("AWS_LAMBDA_FUNCTION_NAME");
  });

  it.each([
    "AWS_REGION",
    "FLEET_TABLE_NAME",
    "EVENTS_TABLE_NAME",
    "IOT_DATA_ENDPOINT",
    "IOT_CREDENTIALS_ENDPOINT",
    "RESOURCE_TAGS",
  ])("throws naming %s when it is missing", (key) => {
    const env = Object.fromEntries(
      Object.entries(VALID_ROBOTS_ENV).filter(([name]) => name !== key),
    );
    expect(() => loadRobotsEnv(env)).toThrow(new Error(`invalid environment: ${key}`));
  });

  it.each([
    ["AWS_REGION", "us-east-1"],
    ["FLEET_TABLE_NAME", "other-table"],
    ["EVENTS_TABLE_NAME", "mfc-demo-EVENTS"],
    ["IOT_DATA_ENDPOINT", `${SECRET_MARKER}.iot.eu-west-3.amazonaws.com`],
    ["IOT_CREDENTIALS_ENDPOINT", `${SECRET_MARKER}.example.com`],
  ])("throws naming %s and not the value when it is malformed", (key, value) => {
    const env: NodeJS.ProcessEnv = { ...VALID_ROBOTS_ENV, [key]: value };
    let message = "";
    try {
      loadRobotsEnv(env);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toBe(`invalid environment: ${key}`);
    expect(message).not.toContain(SECRET_MARKER);
  });

  it("refuses a tags object with an extra key", () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ROBOTS_ENV,
      RESOURCE_TAGS: JSON.stringify({
        project: "mfc",
        env: "demo",
        component: "robots",
        owner: "vincent",
        extra: "not-allowed",
      }),
    };
    expect(() => loadRobotsEnv(env)).toThrow(new Error("invalid environment: RESOURCE_TAGS"));
  });

  it("names the tag key at fault when a tag has a wrong value", () => {
    const env: NodeJS.ProcessEnv = {
      ...VALID_ROBOTS_ENV,
      RESOURCE_TAGS: JSON.stringify({
        project: "other",
        env: "demo",
        component: "robots",
        owner: "v",
      }),
    };
    expect(() => loadRobotsEnv(env)).toThrow(
      new Error("invalid environment: RESOURCE_TAGS.project"),
    );
  });

  it("refuses tags that are not JSON, without repeating them", () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ROBOTS_ENV, RESOURCE_TAGS: `{${SECRET_MARKER}` };
    let message = "";
    try {
      loadRobotsEnv(env);
    } catch (error) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/^invalid environment: /);
    expect(message).toContain("RESOURCE_TAGS");
    expect(message).not.toContain(SECRET_MARKER);
  });

  it("refuses tags whose value is not an object", () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ROBOTS_ENV, RESOURCE_TAGS: "[]" };
    expect(() => loadRobotsEnv(env)).toThrow(/^invalid environment: /);
  });

  it("refuses tags longer than 1024 characters", () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ROBOTS_ENV, RESOURCE_TAGS: "x".repeat(1025) };
    expect(() => loadRobotsEnv(env)).toThrow(/^invalid environment: /);
  });
});

/** A complete environment of the ingest functions. The values are fakes. */
const VALID_INGEST_ENV: NodeJS.ProcessEnv = {
  AWS_REGION: "eu-west-3",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  EVENTS_TABLE_NAME: "mfc-demo-events",
  CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
  WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
};

describe("loadIngestEventsEnv", () => {
  it("parses the environment of the function", () => {
    expect(loadIngestEventsEnv(VALID_INGEST_ENV)).toStrictEqual({
      AWS_REGION: "eu-west-3",
      FLEET_TABLE_NAME: "mfc-demo-fleet",
      EVENTS_TABLE_NAME: "mfc-demo-events",
      CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
      WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
    });
  });

  it("throws naming AWS_REGION when the region is missing", () => {
    expect(() => loadIngestEventsEnv({ ...VALID_INGEST_ENV, AWS_REGION: undefined })).toThrow(
      new Error("invalid environment: AWS_REGION"),
    );
  });

  it("refuses a region outside the demo deployment", () => {
    expect(
      IngestEventsEnvSchema.safeParse({ ...VALID_INGEST_ENV, AWS_REGION: "us-east-1" }).success,
    ).toBe(false);
  });

  it.each([
    [
      "an endpoint outside the demo regions",
      "https://abc123xyz.execute-api.us-east-1.amazonaws.com/live",
    ],
    ["a plain HTTP endpoint", "http://abc123xyz.execute-api.eu-west-3.amazonaws.com/live"],
    [
      "an endpoint with a path traversal",
      "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/../x",
    ],
    ["a table name outside the stack prefix", "other-table"],
  ])("refuses %s and names the variable only", (_label, value) => {
    const env = { ...VALID_INGEST_ENV, WS_MANAGEMENT_ENDPOINT: value, EVENTS_TABLE_NAME: value };
    expect(() => loadIngestEventsEnv(env)).toThrow(/^invalid environment: /);
    expect(() => loadIngestEventsEnv(env)).not.toThrow(value);
  });
});

describe("loadIngestTelemetryEnv", () => {
  it("parses the environment of the function, without the events table", () => {
    expect(loadIngestTelemetryEnv(VALID_INGEST_ENV)).toStrictEqual({
      AWS_REGION: "eu-west-3",
      FLEET_TABLE_NAME: "mfc-demo-fleet",
      CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
      WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
    });
  });

  it("names the missing variables without their values", () => {
    expect(() => loadIngestTelemetryEnv({ AWS_REGION: "eu-west-3" })).toThrow(
      new Error(
        "invalid environment: FLEET_TABLE_NAME, CONNECTIONS_TABLE_NAME, WS_MANAGEMENT_ENDPOINT",
      ),
    );
  });

  it("refuses an invalid schema through the exported schema too", () => {
    expect(IngestTelemetryEnvSchema.safeParse(VALID_INGEST_ENV).success).toBe(true);
    expect(
      IngestTelemetryEnvSchema.safeParse({ ...VALID_INGEST_ENV, AWS_REGION: "us-east-1" }).success,
    ).toBe(false);
  });
});

/** A complete, valid environment of the `alerts` function. */
const VALID_ALERTS_ENV: NodeJS.ProcessEnv = {
  AWS_REGION: "eu-west-3",
  FLEET_TABLE_NAME: "mfc-demo-fleet",
  EVENTS_TABLE_NAME: "mfc-demo-events",
  CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
  WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
};

describe("loadAlertsEnv", () => {
  it("parses the environment of the function", () => {
    expect(loadAlertsEnv(VALID_ALERTS_ENV)).toStrictEqual({
      AWS_REGION: "eu-west-3",
      FLEET_TABLE_NAME: "mfc-demo-fleet",
      EVENTS_TABLE_NAME: "mfc-demo-events",
      CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
      WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
    });
  });

  it("refuses a missing WS_MANAGEMENT_ENDPOINT and names it", () => {
    const env: NodeJS.ProcessEnv = { ...VALID_ALERTS_ENV };
    delete env.WS_MANAGEMENT_ENDPOINT;
    expect(() => loadAlertsEnv(env)).toThrow(
      new Error("invalid environment: WS_MANAGEMENT_ENDPOINT"),
    );
  });

  it("refuses a management endpoint outside the demo regions, without repeating it", () => {
    const endpoint = "https://abc123xyz.execute-api.us-east-1.amazonaws.com/live";
    const env = { ...VALID_ALERTS_ENV, WS_MANAGEMENT_ENDPOINT: endpoint };
    expect(() => loadAlertsEnv(env)).toThrow(/^invalid environment: WS_MANAGEMENT_ENDPOINT$/);
    expect(() => loadAlertsEnv(env)).not.toThrow(endpoint);
  });

  it("refuses a table name outside the stack prefix", () => {
    expect(
      AlertsEnvSchema.safeParse({ ...VALID_ALERTS_ENV, EVENTS_TABLE_NAME: "other" }).success,
    ).toBe(false);
  });
});

describe("loadControlEnv", () => {
  /** A complete, valid environment of the `control` function. */
  const VALID_CONTROL_ENV: NodeJS.ProcessEnv = {
    AWS_REGION: "eu-west-3",
    FLEET_TABLE_NAME: "mfc-demo-fleet",
    EVENTS_TABLE_NAME: "mfc-demo-events",
    CONNECTIONS_TABLE_NAME: "mfc-demo-connections",
    WS_MANAGEMENT_ENDPOINT: "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
    IOT_DATA_ENDPOINT: "abc123-ats.iot.eu-west-3.amazonaws.com",
  };

  it("returns the typed environment when every variable is valid", () => {
    expect(loadControlEnv(VALID_CONTROL_ENV).IOT_DATA_ENDPOINT).toBe(
      "abc123-ats.iot.eu-west-3.amazonaws.com",
    );
  });

  it("names the malformed variable and never its value", () => {
    expect(() =>
      loadControlEnv({ ...VALID_CONTROL_ENV, IOT_DATA_ENDPOINT: SECRET_MARKER }),
    ).toThrow("invalid environment: IOT_DATA_ENDPOINT");
    try {
      loadControlEnv({ ...VALID_CONTROL_ENV, IOT_DATA_ENDPOINT: SECRET_MARKER });
    } catch (error) {
      expect(String(error)).not.toContain(SECRET_MARKER);
    }
  });
});
