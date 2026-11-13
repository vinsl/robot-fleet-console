/**
 * Classification of one topic-rule delivery. Every rejection reason is reached by a delivery that a robot
 * could really produce, and the protocol fixtures run through the same path as live deliveries.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_MQTT_PAYLOAD_BYTES, uuidv7, type RobotEvent } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  BOOT_FUTURE_TOLERANCE_MS,
  classifyDelivery,
  type IngestOutcome,
} from "../../../src/domain/ingest/classify";

/** Directory of the protocol fixtures, shared with the protocol package. */
const FIXTURES = fileURLToPath(
  new URL("../../../../../packages/protocol/fixtures/", import.meta.url),
);

/** Receive time the deliveries carry, in milliseconds. */
const RECEIVED_AT = 1_793_000_000_000;

/* eslint-disable security/detect-non-literal-fs-filename -- the folders are fixed names of this test; no input reaches these reads */
/**
 * Reads the JSON fixtures of one folder, sorted by name.
 *
 * @param folder - Folder under `packages/protocol/fixtures`, a fixed name chosen by the tests.
 * @returns The file names and their raw text.
 */
function fixtureTexts(folder: string): { name: string; text: string }[] {
  const directory = path.join(FIXTURES, folder);
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({ name, text: readFileSync(path.join(directory, name), "utf8") }));
}
/* eslint-enable security/detect-non-literal-fs-filename */

/**
 * Encodes a value as the broker's `encode(*, 'base64')` does: the JSON text of the message, in base64.
 *
 * @param value - The value to encode, or the raw text when it is a string already.
 * @returns The base64 payload.
 */
function base64Of(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Buffer.from(text, "utf8").toString("base64");
}

/** A robot rule delivery, with the broker metadata of a message from the reference robot. */
interface DeliveryOptions {
  readonly topic?: string;
  readonly clientId?: string;
  readonly payloadBase64?: string;
  readonly payload?: unknown;
}

/**
 * Builds the delivery a topic rule hands to the function.
 *
 * @param options - Overrides of the reference message: topic, client id, payload.
 * @returns The delivery as the Lambda runtime passes it.
 */
function delivery(options: DeliveryOptions = {}): Record<string, unknown> {
  return {
    source: "robot",
    iotTopic: options.topic ?? "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/events",
    iotClientId: options.clientId ?? "mfc-demo-kali-01",
    iotReceivedAt: RECEIVED_AT,
    payloadBase64: options.payloadBase64 ?? base64Of(options.payload ?? referenceEvent()),
  };
}

/**
 * The reference robot event: the BOOT fixture, which is valid and names the reference robot.
 *
 * @returns The event as a JSON object.
 */
function referenceEvent(): Record<string, unknown> {
  const [first] = fixtureTexts("robot-event/valid/");
  if (first === undefined) {
    throw new Error("missing robot-event fixture");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

/**
 * Asserts that an outcome is a rejection and returns it, so that the reason is checked in one place.
 *
 * @param outcome - The outcome to check.
 * @returns The rejected outcome.
 */
function expectRejected(outcome: IngestOutcome): Extract<IngestOutcome, { kind: "rejected" }> {
  expect(outcome.kind).toBe("rejected");
  if (outcome.kind !== "rejected") {
    throw new Error("expected a rejection");
  }
  return outcome;
}

describe("classifyDelivery: accepted robot messages", () => {
  it.each(fixtureTexts("robot-event/valid/"))(
    "accepts the valid event fixture $name on the events channel",
    ({ text }) => {
      const outcome = classifyDelivery(delivery({ payloadBase64: base64Of(text) }));

      expect(outcome).toMatchObject({
        kind: "event",
        robotId: "kali-01",
        siteId: "paris-01",
        receivedAt: RECEIVED_AT,
      });
    },
  );

  it.each(fixtureTexts("ack/valid/"))(
    "accepts the valid ack fixture $name through the acks rule",
    ({ text }) => {
      const outcome = classifyDelivery(
        delivery({
          topic: "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack",
          payloadBase64: base64Of(text),
        }),
      );

      expect(outcome).toMatchObject({ kind: "ack", robotId: "kali-01", siteId: "paris-01" });
    },
  );

  it("accepts an ack on the bare topic, as the parser allows both forms", () => {
    const [first] = fixtureTexts("ack/valid/");
    if (first === undefined) {
      throw new Error("missing ack fixture");
    }
    const outcome = classifyDelivery(
      delivery({ topic: "fleet/paris-01/kali-01/cmd/ack", payloadBase64: base64Of(first.text) }),
    );

    expect(outcome.kind).toBe("ack");
  });

  it("returns the parsed event with the broker receive time", () => {
    const outcome = classifyDelivery(delivery());

    expect(outcome.kind).toBe("event");
    if (outcome.kind !== "event") {
      throw new Error("expected an event");
    }
    const event: RobotEvent = outcome.event;
    expect(event.kind).toBe("BOOT");
    expect(outcome.receivedAt).toBe(RECEIVED_AT);
  });

  it("accepts a payload of exactly the maximum size", () => {
    const padded = JSON.stringify(referenceEvent()).padEnd(MAX_MQTT_PAYLOAD_BYTES, " ");

    const outcome = classifyDelivery(delivery({ payloadBase64: base64Of(padded) }));

    expect(outcome.kind).toBe("event");
  });
});

describe("classifyDelivery: rejections of the robot delivery", () => {
  it("refuses a payload robot id that differs from the topic (IDENTITY_MISMATCH)", () => {
    const spoofed = { ...referenceEvent(), robotId: "sim-02" };

    const outcome = expectRejected(
      classifyDelivery(
        delivery({
          topic: "fleet/paris-01/sim-01/events",
          clientId: "mfc-demo-sim-01",
          payload: spoofed,
        }),
      ),
    );

    expect(outcome.reason).toBe("IDENTITY_MISMATCH");
    expect(outcome.robotId).toBe("sim-01");
  });

  it("refuses a robot event whose boot is dated more than 24 h after the receipt (BOOT_IN_FUTURE)", () => {
    const bootId = uuidv7(RECEIVED_AT + BOOT_FUTURE_TOLERANCE_MS + 1);

    const outcome = expectRejected(
      classifyDelivery(delivery({ payload: { ...referenceEvent(), bootId } })),
    );

    expect(outcome).toMatchObject({ reason: "BOOT_IN_FUTURE", robotId: "kali-01" });
  });

  it("refuses an ack whose boot is dated more than 24 h after the receipt (BOOT_IN_FUTURE)", () => {
    const [first] = fixtureTexts("ack/valid/");
    if (first === undefined) {
      throw new Error("missing ack fixture");
    }
    const ack = {
      ...(JSON.parse(first.text) as Record<string, unknown>),
      bootId: uuidv7(RECEIVED_AT + BOOT_FUTURE_TOLERANCE_MS + 1),
    };

    const outcome = expectRejected(
      classifyDelivery(delivery({ topic: "fleet/paris-01/kali-01/cmd/ack", payload: ack })),
    );

    expect(outcome.reason).toBe("BOOT_IN_FUTURE");
  });

  it("accepts a boot dated 23 h after the receipt, the robot clock being ahead", () => {
    const bootId = uuidv7(RECEIVED_AT + 23 * 60 * 60 * 1000);

    const outcome = classifyDelivery(delivery({ payload: { ...referenceEvent(), bootId } }));

    expect(outcome.kind).toBe("event");
  });

  it("refuses a payload site that differs from the topic (IDENTITY_MISMATCH)", () => {
    const spoofed = { ...referenceEvent(), siteId: "lyon-01" };

    const outcome = expectRejected(classifyDelivery(delivery({ payload: spoofed })));

    expect(outcome.reason).toBe("IDENTITY_MISMATCH");
  });

  it("refuses an ack whose identity differs from its topic (IDENTITY_MISMATCH)", () => {
    const [first] = fixtureTexts("ack/valid/");
    if (first === undefined) {
      throw new Error("missing ack fixture");
    }
    const spoofed = { ...(JSON.parse(first.text) as object), robotId: "sim-02" };

    const outcome = expectRejected(
      classifyDelivery(
        delivery({
          topic: "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack",
          payload: spoofed,
        }),
      ),
    );

    expect(outcome.reason).toBe("IDENTITY_MISMATCH");
  });

  it("refuses a client id that is not the thing of the topic robot (CLIENT_MISMATCH)", () => {
    const outcome = expectRejected(
      classifyDelivery(
        delivery({ topic: "fleet/paris-01/sim-01/events", clientId: "mfc-demo-sim-02" }),
      ),
    );

    expect(outcome.reason).toBe("CLIENT_MISMATCH");
    expect(outcome.robotId).toBe("sim-01");
  });

  it.each([
    ["the telemetry rule", "$aws/rules/mfc_demo_telemetry/fleet/paris-01/sim-01/telemetry"],
    ["the bare telemetry topic", "fleet/paris-01/sim-01/telemetry"],
    ["the command topic", "fleet/paris-01/sim-01/cmd"],
  ])("refuses %s as a channel that is not an event or an ack (WRONG_CHANNEL)", (_, topic) => {
    const outcome = expectRejected(
      classifyDelivery(delivery({ topic, clientId: "mfc-demo-sim-01" })),
    );

    expect(outcome.reason).toBe("WRONG_CHANNEL");
    expect(outcome.robotId).toBe("sim-01");
  });

  it.each([
    [
      "a rule prefix that names another channel",
      "$aws/rules/mfc_demo_events/fleet/paris-01/kali-01/cmd/ack",
    ],
    ["a wildcard in the topic", "fleet/+/kali-01/events"],
    ["an uppercase robot id", "fleet/paris-01/KALI-01/events"],
    ["an unknown rule", "$aws/rules/other_rule/fleet/paris-01/kali-01/events"],
    ["an extra level", "fleet/paris-01/kali-01/events/extra"],
  ])("refuses a topic with %s (UNKNOWN_TOPIC)", (_, topic) => {
    const outcome = expectRejected(classifyDelivery(delivery({ topic })));

    expect(outcome.reason).toBe("UNKNOWN_TOPIC");
    expect(outcome.robotId).toBeNull();
  });

  it("refuses a payload one byte over the maximum size before parsing it (OVERSIZE)", () => {
    const oversize = `{"pad":"${"x".repeat(MAX_MQTT_PAYLOAD_BYTES)}"}`;

    const outcome = expectRejected(
      classifyDelivery(delivery({ payloadBase64: base64Of(oversize) })),
    );

    expect(outcome.reason).toBe("OVERSIZE");
    expect(outcome.robotId).toBe("kali-01");
  });

  it("refuses bytes that are not valid UTF-8 (NOT_JSON)", () => {
    const bytes = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString("base64");

    const outcome = expectRejected(classifyDelivery(delivery({ payloadBase64: bytes })));

    expect(outcome.reason).toBe("NOT_JSON");
  });

  it("refuses valid UTF-8 that is not JSON (NOT_JSON)", () => {
    const outcome = expectRejected(
      classifyDelivery(delivery({ payloadBase64: base64Of("{not json") })),
    );

    expect(outcome.reason).toBe("NOT_JSON");
  });

  it.each(fixtureTexts("robot-event/invalid/"))(
    "refuses the invalid event fixture $name by schema (SCHEMA)",
    ({ text }) => {
      const outcome = expectRejected(classifyDelivery(delivery({ payloadBase64: base64Of(text) })));

      expect(outcome.reason).toBe("SCHEMA");
    },
  );

  it.each(fixtureTexts("ack/invalid/"))(
    "refuses the invalid ack fixture $name by schema (SCHEMA)",
    ({ text }) => {
      const outcome = expectRejected(
        classifyDelivery(
          delivery({
            topic: "$aws/rules/mfc_demo_acks/fleet/paris-01/kali-01/cmd/ack",
            payloadBase64: base64Of(text),
          }),
        ),
      );

      expect(outcome.reason).toBe("SCHEMA");
    },
  );

  it("lists the schema paths of a SCHEMA rejection, without the values", () => {
    const bad = { ...referenceEvent(), messageId: "0190A7C4-5B1E-7D2A-9C3F-4E5D6A7B8C9D" };

    const outcome = expectRejected(classifyDelivery(delivery({ payload: bad })));

    expect(outcome.reason).toBe("SCHEMA");
    expect(outcome.issuePaths).toContain("messageId");
    expect(JSON.stringify(outcome)).not.toContain("0190A7C4");
  });

  it("refuses a delivery whose base64 is not well formed (MALFORMED_DELIVERY)", () => {
    const outcome = expectRejected(classifyDelivery(delivery({ payloadBase64: "e30" })));

    expect(outcome.reason).toBe("MALFORMED_DELIVERY");
    expect(outcome.robotId).toBeNull();
  });

  it.each([
    ["a missing field", { source: "robot" }],
    ["an extra key", { ...delivery(), extra: true }],
    ["a value of the wrong type", null],
  ])("refuses %s (MALFORMED_DELIVERY)", (_, raw) => {
    const outcome = expectRejected(classifyDelivery(raw));

    expect(outcome.reason).toBe("MALFORMED_DELIVERY");
  });
});

describe("classifyDelivery: presence notices", () => {
  it("names the robot of a thing client id", () => {
    const outcome = classifyDelivery({
      source: "presence",
      clientId: "mfc-demo-kali-01",
      eventType: "connected",
      timestamp: RECEIVED_AT,
      versionNumber: 3,
    });

    expect(outcome).toStrictEqual({
      kind: "presence",
      clientId: "mfc-demo-kali-01",
      robotId: "kali-01",
      eventType: "connected",
      timestamp: RECEIVED_AT,
      disconnectReason: undefined,
      versionNumber: 3,
    });
  });

  it("keeps a client that is not a robot, with no robot attached", () => {
    const outcome = classifyDelivery({
      source: "presence",
      clientId: "other",
      eventType: "disconnected",
      timestamp: RECEIVED_AT,
      disconnectReason: "CLIENT_INITIATED_DISCONNECT",
    });

    expect(outcome).toMatchObject({
      kind: "presence",
      robotId: null,
      disconnectReason: "CLIENT_INITIATED_DISCONNECT",
    });
  });

  it("drops the principal, the session and the address of the broker notice", () => {
    const outcome = classifyDelivery({
      source: "presence",
      clientId: "mfc-demo-kali-01",
      eventType: "connect_failed",
      timestamp: RECEIVED_AT,
      connectFailureReason: "AUTHENTICATION_FAILURE",
      ipAddress: "203.0.113.7",
      principalIdentifier: "principal-secret",
      sessionIdentifier: "session-secret",
    });

    expect(JSON.stringify(outcome)).not.toContain("203.0.113.7");
    expect(JSON.stringify(outcome)).not.toContain("principal-secret");
    expect(JSON.stringify(outcome)).not.toContain("session-secret");
  });

  it("refuses an event type the broker does not publish for presence", () => {
    const outcome = expectRejected(
      classifyDelivery({
        source: "presence",
        clientId: "mfc-demo-kali-01",
        eventType: "subscribed",
        timestamp: RECEIVED_AT,
      }),
    );

    expect(outcome.reason).toBe("MALFORMED_DELIVERY");
  });
});
