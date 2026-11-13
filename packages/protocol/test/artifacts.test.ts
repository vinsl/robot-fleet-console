/**
 * Generated artifacts: determinism, the exact set of output paths, and the content the Python side reads.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildArtifacts, withoutSchemaKeyword } from "../scripts/artifacts";
import { TOPIC_VECTORS } from "../scripts/topic-vectors";
import { TRANSITIONS } from "../src/index";

const openApiDocument = z.object({
  openapi: z.literal("3.1.1"),
  components: z.object({
    schemas: z.object({
      HealthResponse: z.record(z.string(), z.unknown()),
    }),
  }),
});

/** Schemas exported as JSON Schema: one file each, in addition to the fixed artifacts below. */
const JSON_SCHEMA_NAMES = [
  "ack",
  "admin-invoke-event",
  "admin-invoke-result",
  "alert-record",
  "audit-list-response",
  "audit-record",
  "command",
  "command-request",
  "command-response",
  "demo-state",
  "demo-update-request",
  "ingested-telemetry",
  "lock-action-response",
  "lock-request",
  "lock-state",
  "principal",
  "problem",
  "register-robot-request",
  "register-robot-response",
  "retire-robot-request",
  "retire-robot-response",
  "robot-event",
  "robot-kit-config",
  "robot-list-response",
  "robot-live-state",
  "robot-summary",
  "site-map",
  "telemetry",
  "video-claim-response",
  "video-session",
  "video-status",
  "ws-client-message",
  "ws-server-message",
  "ws-token-request",
  "ws-token-response",
];

/** Parses one artifact as JSON, failing the test with a clear message when it is not JSON. */
function parseArtifact(path: string): unknown {
  const text = buildArtifacts().get(path);
  expect(text, path).toBeDefined();
  return JSON.parse(text ?? "");
}

describe("buildArtifacts", () => {
  it("is deterministic across calls", () => {
    const first = [...buildArtifacts()];
    const second = [...buildArtifacts()];
    expect(second).toEqual(first);
  });

  it("produces exactly the expected repository-relative paths", () => {
    const expected = [
      "docs/STATE_MACHINE.md",
      "packages/protocol/generated/constants.json",
      "packages/protocol/generated/health-response.schema.json",
      "packages/protocol/generated/robot-id.schema.json",
      "packages/protocol/generated/site-id.schema.json",
      "packages/protocol/generated/state-machine.json",
      "packages/protocol/generated/topic-vectors.json",
      ...JSON_SCHEMA_NAMES.map((name) => `packages/protocol/generated/${name}.schema.json`),
      "services/api/openapi.json",
    ];
    expect([...buildArtifacts().keys()].sort()).toEqual(expected.sort());
  });

  it("declares OpenAPI 3.1.1 and embeds HealthResponse without a $schema keyword", () => {
    const document = openApiDocument.parse(parseArtifact("services/api/openapi.json"));
    expect(document.openapi).toBe("3.1.1");
    expect(document.components.schemas.HealthResponse).not.toHaveProperty("$schema");
  });

  it("documents the three routes, bearer security on the authenticated ones, and problem responses", () => {
    const document = z
      .object({
        paths: z.record(
          z.string(),
          z.record(z.string(), z.looseObject({ security: z.array(z.unknown()).optional() })),
        ),
        components: z.object({
          securitySchemes: z.object({ bearer: z.record(z.string(), z.unknown()) }),
        }),
      })
      .parse(parseArtifact("services/api/openapi.json"));
    expect(Object.keys(document.paths).sort()).toEqual([
      "/health",
      "/me",
      "/sites/{siteId}/alerts",
      "/sites/{siteId}/alerts/{alertId}/acknowledge",
      "/sites/{siteId}/alerts/{alertId}/resolve",
      "/sites/{siteId}/audit",
      "/sites/{siteId}/demo",
      "/sites/{siteId}/robots",
      "/sites/{siteId}/robots/{robotId}/commands",
      "/sites/{siteId}/robots/{robotId}/lock",
      "/sites/{siteId}/robots/{robotId}/lock/release",
      "/ws-token",
    ]);
    expect(document.paths["/health"]?.get?.security).toBeUndefined();
    expect(document.paths["/me"]?.get?.security).toEqual([{ bearer: [] }]);
    expect(document.paths["/ws-token"]?.post?.security).toEqual([{ bearer: [] }]);
    expect(document.components.securitySchemes.bearer).toMatchObject({ scheme: "bearer" });
    expect(JSON.stringify(document)).toContain("application/problem+json");
  });

  it("documents the alert routes with their operation ids, bearer security and error responses", () => {
    const document = z
      .object({
        paths: z.record(
          z.string(),
          z.record(
            z.string(),
            z.looseObject({
              operationId: z.string(),
              security: z.array(z.unknown()).optional(),
              responses: z.record(z.string(), z.unknown()),
            }),
          ),
        ),
      })
      .parse(parseArtifact("services/api/openapi.json"));
    const list = document.paths["/sites/{siteId}/alerts"]?.get;
    const acknowledge = document.paths["/sites/{siteId}/alerts/{alertId}/acknowledge"]?.post;
    const resolve = document.paths["/sites/{siteId}/alerts/{alertId}/resolve"]?.post;
    expect(list?.operationId).toBe("listAlerts");
    expect(acknowledge?.operationId).toBe("acknowledgeAlert");
    expect(resolve?.operationId).toBe("resolveAlert");
    for (const operation of [list, acknowledge, resolve]) {
      expect(operation?.security).toEqual([{ bearer: [] }]);
      expect(Object.keys(operation?.responses ?? {})).toContain("500");
    }
    expect(Object.keys(acknowledge?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "409", "413", "500"]),
    );
  });

  it("writes every message schema as draft 2020-12 JSON Schema", () => {
    for (const name of JSON_SCHEMA_NAMES) {
      const schema = z.object({
        $schema: z.literal("https://json-schema.org/draft/2020-12/schema"),
      });
      expect(
        schema.safeParse(parseArtifact(`packages/protocol/generated/${name}.schema.json`)).success,
        name,
      ).toBe(true);
    }
  });

  it("writes the robot table with one row per expanded line, each row once", () => {
    const table = z.object({
      rows: z.array(z.object({ from: z.string(), trigger: z.string(), guard: z.string() })),
      cloudRows: z.array(z.object({ from: z.string(), trigger: z.string(), to: z.string() })),
    });
    const parsed = table.parse(parseArtifact("packages/protocol/generated/state-machine.json"));
    expect(parsed.rows).toHaveLength(TRANSITIONS.length);
    const keys = parsed.rows.map((row) => `${row.from}|${row.trigger}|${row.guard}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(parsed.cloudRows).toHaveLength(17);
  });

  it("writes the topic vectors that the Python parser reads", () => {
    expect(parseArtifact("packages/protocol/generated/topic-vectors.json")).toEqual(
      JSON.parse(JSON.stringify(TOPIC_VECTORS)),
    );
  });

  it("writes the constants with sorted keys", () => {
    const constants = parseArtifact("packages/protocol/generated/constants.json");
    expect(constants).toHaveProperty("REPLAY_LRU_SIZE", 1000);
    const keys = Object.keys(constants as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
  });

  it("terminates every artifact with a newline", () => {
    for (const content of buildArtifacts().values()) {
      expect(content.endsWith("\n")).toBe(true);
    }
  });
});

describe("withoutSchemaKeyword", () => {
  it("removes $schema without mutating its input", () => {
    const input: Record<string, unknown> = { $schema: "x", type: "object" };
    expect(withoutSchemaKeyword(input)).toEqual({ type: "object" });
    expect(input).toHaveProperty("$schema", "x");
  });
});

describe("secret scanning of the generated artifacts", () => {
  it("contains no complete private key header, so that secret scanners stay quiet", () => {
    // Built at run time from a string, so that this test file does not hold the header either.
    const keyHeader = new RegExp("-----BEGIN (RSA )?PRIVATE KEY-----");
    for (const [path, content] of buildArtifacts()) {
      expect(keyHeader.test(content), path).toBe(false);
    }
  });
});
