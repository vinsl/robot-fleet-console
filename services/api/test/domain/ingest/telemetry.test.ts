/**
 * Telemetry classification: the same reject table as the events channel, the same order, the same reasons.
 */
import { uuidv7 } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { classifyTelemetryDelivery } from "../../../src/domain/ingest/telemetry";
import { telemetryBody } from "../../fakes/telemetry-body";

/**
 * The payload of a queue body, as an object a test can alter.
 *
 * @param body - The queue body.
 * @returns The payload.
 */
function payloadOf(body: string): Record<string, unknown> {
  const delivery = JSON.parse(body) as { payloadBase64: string };
  return JSON.parse(Buffer.from(delivery.payloadBase64, "base64").toString("utf8")) as Record<
    string,
    unknown
  >;
}

/** The payload of the reference telemetry message. */
const REFERENCE = payloadOf(telemetryBody());

describe("classifyTelemetryDelivery: accepted samples", () => {
  it("accepts a valid sample and carries the broker receive time", () => {
    const outcome = classifyTelemetryDelivery(
      JSON.parse(telemetryBody({ receivedAt: 1_793_595_600_123 })),
    );

    expect(outcome).toMatchObject({
      kind: "telemetry",
      robotId: "kali-01",
      siteId: "paris-01",
      receivedAt: 1_793_595_600_123,
      telemetry: { robotId: "kali-01", seq: 1, state: "MOVING" },
    });
  });
});

describe("classifyTelemetryDelivery: the reject table of the events channel", () => {
  it.each([
    [
      "UNKNOWN_TOPIC",
      telemetryBody({ topic: "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/cmd/ack" }),
    ],
    ["WRONG_CHANNEL", telemetryBody({ topic: "fleet/paris-01/kali-01/events" })],
    ["CLIENT_MISMATCH", telemetryBody({ clientId: "mfc-demo-other-01" })],
    ["SCHEMA", telemetryBody({ payload: { ...REFERENCE, battery: 101 } })],
    ["SCHEMA", telemetryBody({ payload: { ...REFERENCE, x: 1e9 } })],
    ["SCHEMA", telemetryBody({ payload: { ...REFERENCE, extra: "field" } })],
    ["SCHEMA", telemetryBody({ payload: { ...REFERENCE, state: "OFFLINE" } })],
    ["IDENTITY_MISMATCH", telemetryBody({ payload: { ...REFERENCE, robotId: "kali-02" } })],
  ] as const)("refuses %s", (reason, body) => {
    const outcome = classifyTelemetryDelivery(JSON.parse(body));

    expect(outcome).toMatchObject({ kind: "rejected", reason });
  });

  it("refuses a sample whose boot is dated more than 24 h after the receipt (BOOT_IN_FUTURE)", () => {
    const receivedAt = 1_793_595_600_123;
    const bootId = uuidv7(receivedAt + 24 * 60 * 60 * 1000 + 1);

    const outcome = classifyTelemetryDelivery(JSON.parse(telemetryBody({ receivedAt, bootId })));

    expect(outcome).toMatchObject({
      kind: "rejected",
      reason: "BOOT_IN_FUTURE",
      robotId: "kali-01",
    });
  });

  it("refuses a malformed delivery envelope", () => {
    expect(classifyTelemetryDelivery({ source: "presence" })).toMatchObject({
      kind: "rejected",
      reason: "MALFORMED_DELIVERY",
    });
    expect(classifyTelemetryDelivery(null)).toMatchObject({ reason: "MALFORMED_DELIVERY" });
  });

  it("refuses an oversize payload", () => {
    const body = telemetryBody({ payload: { ...REFERENCE, pad: "x".repeat(20_000) } });
    expect(classifyTelemetryDelivery(JSON.parse(body))).toMatchObject({ reason: "OVERSIZE" });
  });

  it("reports the schema paths of a schema rejection, never the values", () => {
    const body = telemetryBody({ payload: { ...REFERENCE, battery: 101, state: "SECRET-VALUE" } });
    const outcome = classifyTelemetryDelivery(JSON.parse(body));

    expect(outcome).toMatchObject({ reason: "SCHEMA" });
    expect(outcome.kind === "rejected" ? [...outcome.issuePaths].sort() : []).toStrictEqual([
      "battery",
      "state",
    ]);
    expect(JSON.stringify(outcome)).not.toContain("SECRET-VALUE");
  });
});
