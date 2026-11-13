/**
 * Pure lifecycle rules of the registry: staleness, resumption, retirement decisions and the public summary.
 */
import { RobotSummarySchema, type RobotStatus } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  canResumeRegistration,
  canRetire,
  CertificateRefSchema,
  isStaleProvisioning,
  MAX_CERTIFICATES_PER_ROBOT,
  PROVISIONING_STALE_MS,
  RobotRecordSchema,
  toSummary,
} from "../../../src/domain/robots/registry";
import { recordOf, START_TIME } from "../../fakes/world";

/** An instant `ms` milliseconds before the start of the tests. */
function before(ms: number): string {
  return new Date(START_TIME.getTime() - ms).toISOString();
}

describe("isStaleProvisioning", () => {
  it.each([
    [119_999, false],
    [120_000, false],
    [120_001, true],
  ])("is %s ms of silence stale: %s (strict threshold)", (silenceMs, stale) => {
    const record = recordOf({ status: "PROVISIONING", updatedAt: before(silenceMs) });
    expect(isStaleProvisioning(record, START_TIME)).toBe(stale);
  });

  it("measures from the last write, not from the creation", () => {
    const record = recordOf({
      status: "PROVISIONING",
      createdAt: before(10 * PROVISIONING_STALE_MS),
      updatedAt: before(1000),
    });
    expect(isStaleProvisioning(record, START_TIME)).toBe(false);
  });
});

describe("canResumeRegistration", () => {
  const cases: [RobotStatus, { updatedAt?: string }, boolean][] = [
    ["PROVISIONING_FAILED", {}, true],
    ["PROVISIONING", {}, false],
    ["PROVISIONING", { updatedAt: before(PROVISIONING_STALE_MS + 1) }, true],
    ["ACTIVE", {}, false],
    ["RETIRING", {}, false],
    ["RETIRED", {}, false],
  ];
  it.each(cases)("status %s (overrides %j) resumes: %s", (status, overrides, expected) => {
    const record = recordOf({ status, ...overrides });
    expect(canResumeRegistration(record, START_TIME)).toBe(expected);
  });
});

describe("canRetire", () => {
  const cases: [RobotStatus, { updatedAt?: string }, string][] = [
    ["ACTIVE", {}, "retire"],
    ["PROVISIONING_FAILED", {}, "retire"],
    ["RETIRING", {}, "retire"],
    ["RETIRED", {}, "already-retired"],
    ["PROVISIONING", {}, "conflict"],
    ["PROVISIONING", { updatedAt: before(PROVISIONING_STALE_MS + 1) }, "retire"],
  ];
  it.each(cases)("status %s (overrides %j) gives %s", (status, overrides, expected) => {
    const record = recordOf({ status, ...overrides });
    expect(canRetire(record, START_TIME)).toBe(expected);
  });
});

describe("toSummary", () => {
  it("keeps the summary fields and drops the provisioning state", () => {
    const summary = toSummary(
      recordOf({
        certificates: [
          {
            certificateId: "a".repeat(64),
            certificateArn: `arn:aws:iot:eu-west-3:123456789012:cert/${"a".repeat(64)}`,
          },
        ],
        kvsChannelArn: `arn:aws:kinesisvideo:eu-west-3:123456789012:channel/mfc-demo-kali-01/1001`,
      }),
    );
    expect(RobotSummarySchema.parse(summary)).toStrictEqual({
      robotId: "kali-01",
      siteId: "paris-01",
      name: "Kali 01",
      type: "KALI",
      designDate: "2026-11-02",
      simulated: true,
      status: "ACTIVE",
      createdAt: START_TIME.toISOString(),
    });
  });

  it("carries retiredAt only for a retired robot", () => {
    const retiredAt = START_TIME.toISOString();
    expect(toSummary(recordOf({ status: "RETIRED", retiredAt }))).toHaveProperty(
      "retiredAt",
      retiredAt,
    );
    expect(toSummary(recordOf())).not.toHaveProperty("retiredAt");
  });
});

describe("registry schemas", () => {
  it("refuses more certificates than a robot may accumulate", () => {
    const certificates = Array.from({ length: MAX_CERTIFICATES_PER_ROBOT + 1 }, (_, index) => {
      const id = String(index + 1).padStart(64, "0");
      return { certificateId: id, certificateArn: `arn:aws:iot:eu-west-3:123456789012:cert/${id}` };
    });
    expect(RobotRecordSchema.safeParse({ ...recordOf(), certificates }).success).toBe(false);
  });

  it("refuses a certificate ARN outside the demo regions", () => {
    const id = "b".repeat(64);
    const ref = {
      certificateId: id,
      certificateArn: `arn:aws:iot:us-east-1:123456789012:cert/${id}`,
    };
    expect(CertificateRefSchema.safeParse(ref).success).toBe(false);
  });
});
