/**
 * Rule deliveries and presence events, as the ingest function receives them from the topic rules:
 * the base64 payload grammar and bound, the strictness of the robot delivery, and the stripping of the
 * presence fields that must never reach the logs.
 */
import { describe, expect, it } from "vitest";
import {
  IngestDeliverySchema,
  MAX_RULE_PAYLOAD_BASE64_LENGTH,
  PresenceEventSchema,
  RobotRuleDeliverySchema,
} from "../src/index";

/** Base64 of the JSON object `{}`, the smallest valid robot payload. */
const EMPTY_OBJECT_BASE64 = "e30=";

const ROBOT_DELIVERY = {
  source: "robot",
  iotTopic: "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/events",
  iotClientId: "mfc-demo-kali-01",
  iotReceivedAt: 1_793_000_000_000,
  payloadBase64: EMPTY_OBJECT_BASE64,
};

const PRESENCE = {
  source: "presence",
  clientId: "mfc-demo-kali-01",
  eventType: "connected",
  timestamp: 1_793_000_000_000,
  versionNumber: 4,
  principalIdentifier: "certificate-principal-id",
  sessionIdentifier: "session-id",
  ipAddress: "203.0.113.7:50123",
};

describe("RobotRuleDeliverySchema", () => {
  it("accepts a delivery whose payload is the base64 of an empty JSON object", () => {
    expect(IngestDeliverySchema.safeParse(ROBOT_DELIVERY).success).toBe(true);
  });

  it.each([
    ["a wildcard", "e3*="],
    ["a URL-safe character", "e3-_"],
    ["a length that is not a multiple of four", "e30"],
    ["padding in the middle", "e3=0"],
    ["whitespace", "e3 0"],
  ])("refuses a payload with %s", (_label, payloadBase64) => {
    expect(RobotRuleDeliverySchema.safeParse({ ...ROBOT_DELIVERY, payloadBase64 }).success).toBe(
      false,
    );
  });

  it("accepts a payload of exactly the largest bounded length", () => {
    const payloadBase64 = "A".repeat(MAX_RULE_PAYLOAD_BASE64_LENGTH);
    expect(MAX_RULE_PAYLOAD_BASE64_LENGTH % 4).toBe(0);
    expect(RobotRuleDeliverySchema.safeParse({ ...ROBOT_DELIVERY, payloadBase64 }).success).toBe(
      true,
    );
  });

  it("refuses a payload longer than the bound", () => {
    const payloadBase64 = "A".repeat(MAX_RULE_PAYLOAD_BASE64_LENGTH + 4);
    expect(RobotRuleDeliverySchema.safeParse({ ...ROBOT_DELIVERY, payloadBase64 }).success).toBe(
      false,
    );
  });

  it("refuses a delivery with an extra key", () => {
    expect(
      RobotRuleDeliverySchema.safeParse({ ...ROBOT_DELIVERY, robotIdOverride: "sim-02" }).success,
    ).toBe(false);
  });

  it("refuses a delivery whose source is not robot", () => {
    expect(
      RobotRuleDeliverySchema.safeParse({ ...ROBOT_DELIVERY, source: "presence" }).success,
    ).toBe(false);
  });

  it("refuses a timestamp that is negative", () => {
    expect(
      RobotRuleDeliverySchema.safeParse({ ...ROBOT_DELIVERY, iotReceivedAt: -1 }).success,
    ).toBe(false);
  });
});

describe("PresenceEventSchema", () => {
  it("strips the principal, session and IP address, which are never logged", () => {
    const parsed = PresenceEventSchema.safeParse(PRESENCE);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(parsed.data).not.toHaveProperty("principalIdentifier");
    expect(parsed.data).not.toHaveProperty("sessionIdentifier");
    expect(parsed.data).not.toHaveProperty("ipAddress");
    expect(parsed.data.clientId).toBe("mfc-demo-kali-01");
  });

  it("accepts a disconnect with its reason", () => {
    const parsed = IngestDeliverySchema.safeParse({
      source: "presence",
      clientId: "mfc-demo-kali-01",
      eventType: "disconnected",
      timestamp: 1_793_000_000_000,
      disconnectReason: "CLIENT_INITIATED_DISCONNECT",
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an event type outside the three lifecycle events", () => {
    expect(PresenceEventSchema.safeParse({ ...PRESENCE, eventType: "subscribed" }).success).toBe(
      false,
    );
  });

  it("refuses a disconnect reason that is not an upper-case code", () => {
    expect(
      PresenceEventSchema.safeParse({ ...PRESENCE, disconnectReason: "client closed" }).success,
    ).toBe(false);
  });
});

describe("IngestDeliverySchema", () => {
  it("refuses a delivery that matches neither source", () => {
    expect(IngestDeliverySchema.safeParse({ source: "other", clientId: "x" }).success).toBe(false);
  });
});
