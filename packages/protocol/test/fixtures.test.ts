/**
 * Fixture corpus: every schema marked for JSON Schema generation is checked against valid and invalid
 * JSON files. The same files are checked by the Python mirror, so both languages agree on each case.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AckSchema,
  AdminInvokeEventSchema,
  AdminInvokeResultSchema,
  CommandSchema,
  IngestedTelemetrySchema,
  ProblemSchema,
  RegisterRobotRequestSchema,
  RegisterRobotResponseSchema,
  RetireRobotRequestSchema,
  RetireRobotResponseSchema,
  RobotEventSchema,
  RobotKitConfigSchema,
  RobotSummarySchema,
  TelemetrySchema,
  VideoClaimResponseSchema,
  VideoSessionSchema,
  VideoStatusSchema,
} from "../src/index";

/** Root of the fixture corpus, one directory per schema, each with `valid/` and `invalid/`. */
const FIXTURES_DIR = fileURLToPath(new URL("../fixtures/", import.meta.url));

/** Label of the PEM block. Kept apart from the header so that no key header is stored in the repository. */
const PEM_PRIVATE_KEY_LABEL = "PRIVATE KEY";

/** Label of the RSA form of a PEM key. Kept apart from the header, like the label above. */
const PEM_RSA_PRIVATE_KEY_LABEL = `RSA ${PEM_PRIVATE_KEY_LABEL}`;

/** Fake key body. It is not key material: it only needs the PEM shape the schemas check. */
const FAKE_PEM_BODY = "MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7AgEAAkEA";

/**
 * Placeholders of the corpus and the text each one stands for. A literal key header would be flagged by
 * secret scanners, so the JSON files carry the token and the header is assembled here at run time.
 */
const PLACEHOLDERS: ReadonlyArray<readonly [string, string]> = [
  [
    '"{{PEM:PRIVATE_KEY}}"',
    [
      `-----BEGIN ${PEM_PRIVATE_KEY_LABEL}-----`,
      FAKE_PEM_BODY,
      `-----END ${PEM_PRIVATE_KEY_LABEL}-----`,
      "",
    ].join("\n"),
  ],
  [
    // The footer names the other form than the header: the schema must refuse it.
    '"{{PEM:MISMATCHED}}"',
    [
      `-----BEGIN ${PEM_RSA_PRIVATE_KEY_LABEL}-----`,
      FAKE_PEM_BODY,
      `-----END ${PEM_PRIVATE_KEY_LABEL}-----`,
      "",
    ].join("\n"),
  ],
];

/** Schema checked by each fixture directory. A directory without an entry here fails the coverage test. */
const SCHEMAS: ReadonlyMap<string, z.ZodType> = new Map<string, z.ZodType>([
  ["ack", AckSchema],
  ["admin-invoke-event", AdminInvokeEventSchema],
  ["admin-invoke-result", AdminInvokeResultSchema],
  ["command", CommandSchema],
  ["ingested-telemetry", IngestedTelemetrySchema],
  ["problem", ProblemSchema],
  ["register-robot-request", RegisterRobotRequestSchema],
  ["register-robot-response", RegisterRobotResponseSchema],
  ["retire-robot-request", RetireRobotRequestSchema],
  ["retire-robot-response", RetireRobotResponseSchema],
  ["robot-event", RobotEventSchema],
  ["robot-kit-config", RobotKitConfigSchema],
  ["robot-summary", RobotSummarySchema],
  ["telemetry", TelemetrySchema],
  ["video-claim-response", VideoClaimResponseSchema],
  ["video-session", VideoSessionSchema],
  ["video-status", VideoStatusSchema],
]);

/** Minimum cases per schema, as required by the M4 design: enough to show both sides of each rule. */
const MIN_VALID = 3;
const MIN_INVALID = 5;

/**
 * Lists the JSON files of one fixture directory, sorted so that failures are reported in a stable order.
 *
 * @param schemaName - Name of the fixture directory.
 * @param kind - `valid` or `invalid`.
 * @returns Absolute paths of the JSON files.
 */
function listCases(schemaName: string, kind: "valid" | "invalid"): string[] {
  const directory = `${FIXTURES_DIR}${schemaName}/${kind}`;
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => `${directory}/${name}`);
}

/**
 * Reads a fixture and expands the private key token.
 *
 * @param path - Absolute path of the JSON file.
 * @returns The parsed JSON value, typed `unknown` until a schema validates it.
 */
function readFixture(path: string): unknown {
  const text = readFileSync(path, "utf8");
  const expanded = PLACEHOLDERS.reduce(
    (current, [token, value]) => current.replaceAll(token, JSON.stringify(value)),
    text,
  );
  return JSON.parse(expanded);
}

describe("fixture corpus", () => {
  it("has exactly one directory per schema checked here, so no schema is left untested", () => {
    const directories = readdirSync(FIXTURES_DIR).sort();
    expect(directories).toEqual([...SCHEMAS.keys()].sort());
  });

  for (const [schemaName, schema] of SCHEMAS) {
    describe(schemaName, () => {
      it(`has at least ${String(MIN_VALID)} valid and ${String(MIN_INVALID)} invalid cases`, () => {
        expect(listCases(schemaName, "valid").length).toBeGreaterThanOrEqual(MIN_VALID);
        expect(listCases(schemaName, "invalid").length).toBeGreaterThanOrEqual(MIN_INVALID);
      });

      for (const path of listCases(schemaName, "valid")) {
        it(`accepts ${path.slice(FIXTURES_DIR.length)}`, () => {
          const result = schema.safeParse(readFixture(path));
          expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
        });
      }

      for (const path of listCases(schemaName, "invalid")) {
        it(`rejects ${path.slice(FIXTURES_DIR.length)}`, () => {
          expect(schema.safeParse(readFixture(path)).success).toBe(false);
        });
      }
    });
  }
});
