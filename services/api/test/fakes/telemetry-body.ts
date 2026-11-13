/**
 * Builds the queue body of a telemetry message as the telemetry topic rule writes it: the rule delivery
 * (source, topic, client id, receive time, base64 payload) as JSON text.
 */
import { RobotRuleDeliverySchema } from "@mfc/protocol";

/** What a test varies about one telemetry message. Every field has a valid default. */
export interface TelemetryBodyOptions {
  readonly robotId?: string;
  readonly siteId?: string;
  readonly bootId?: string;
  readonly seq?: number;
  readonly state?: string;
  readonly battery?: number;
  readonly missionId?: string;
  readonly errorCode?: string;
  readonly ts?: string;
  readonly messageId?: string;
  readonly topic?: string;
  readonly clientId?: string;
  readonly receivedAt?: number;
  /** Replaces the whole payload, to build an invalid message. */
  readonly payload?: unknown;
}

/**
 * A telemetry body as the queue carries it.
 *
 * @param options - What differs from the reference message.
 * @param messageNumber - Distinguishes the message identifiers of one batch.
 * @returns The JSON text of the rule delivery.
 */
export function telemetryBody(options: TelemetryBodyOptions = {}, messageNumber = 1): string {
  const robotId = options.robotId ?? "kali-01";
  const siteId = options.siteId ?? "paris-01";
  const payload = options.payload ?? {
    schemaVersion: "1.0.0",
    messageId: messageIdOf(messageNumber),
    robotId,
    siteId,
    ts: options.ts ?? "2026-11-02T10:00:00.000Z",
    seq: options.seq ?? 1,
    bootId: options.bootId ?? "0190a7c4-0000-7000-8000-00000000000a",
    state: options.state ?? "MOVING",
    x: 12.5,
    y: -3.25,
    heading: 1.57,
    battery: options.battery ?? 81.5,
    speed: 0.8,
    ...(options.missionId === undefined ? {} : { missionId: options.missionId }),
    ...(options.errorCode === undefined ? {} : { errorCode: options.errorCode }),
  };
  const delivery = RobotRuleDeliverySchema.parse({
    source: "robot",
    iotTopic: options.topic ?? `$aws/rules/mfc_demo_telemetry/fleet/${siteId}/${robotId}/telemetry`,
    iotClientId: options.clientId ?? `mfc-demo-${robotId}`,
    iotReceivedAt: options.receivedAt ?? 1_793_595_600_123,
    payloadBase64: Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
  });
  return JSON.stringify(delivery);
}

/**
 * A distinct UUIDv7 message identifier per message number.
 *
 * @param n - The message number.
 * @returns The identifier.
 */
export function messageIdOf(n: number): string {
  return `0190a7c4-5b1e-7d2a-9c3f-${n.toString(16).padStart(12, "0")}`;
}
