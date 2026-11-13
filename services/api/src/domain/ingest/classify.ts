/**
 * Classification of one delivery from an IoT topic rule: decides whether the message is a robot event, a
 * command acknowledgement, a presence notice, or a rejected delivery, and says why it was rejected.
 *
 * The function is pure. It makes no AWS call and writes no log, so every rule of the ingest path is
 * tested without a broker. The handler turns the outcome into logs and metrics.
 *
 * The checks run in a fixed order, cheapest and most trusted first: the envelope of the rule, then the
 * topic (the broker enforces it through the robot's IoT policy), then the client id, then the payload.
 * The identity of the payload is checked last, against the topic, because the payload is written by the
 * robot and the topic is not.
 */
import {
  AckSchema,
  IngestDeliverySchema,
  MAX_MQTT_PAYLOAD_BYTES,
  RobotEventSchema,
  parseFleetTopic,
  robotIdFromThingName,
  thingName,
  type Ack,
  type FleetChannel,
  type FleetTopic,
  type PresenceEvent,
  type RobotEvent,
  type RobotId,
  type RobotRuleDelivery,
  type SiteId,
} from "@mfc/protocol";
import { z } from "zod";

/** Why a delivery was rejected. Each value is one counted reason in the metrics and in the logs. */
export const IngestRejectReasonSchema = z.enum([
  "MALFORMED_DELIVERY",
  "UNKNOWN_TOPIC",
  "WRONG_CHANNEL",
  "CLIENT_MISMATCH",
  "OVERSIZE",
  "NOT_JSON",
  "SCHEMA",
  "IDENTITY_MISMATCH",
  "BOOT_IN_FUTURE",
]);

/** A validated rejection reason. */
export type IngestRejectReason = z.infer<typeof IngestRejectReasonSchema>;

/**
 * How far after the broker receive time a boot identifier may be dated. A robot clock that runs ahead by a day
 * is tolerated; a boot dated further ahead would win every ordering comparison for good, so it is refused.
 */
export const BOOT_FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/** Event type of a presence notice, as the broker names it. */
export type PresenceEventType = PresenceEvent["eventType"];

/**
 * Result of classifying one delivery. Discriminated on `kind`.
 *
 * A `rejected` outcome carries the robot id only when the topic was parsed, so a log line never names a
 * robot that the broker did not vouch for. `issuePaths` lists the schema paths of a `SCHEMA` rejection,
 * never their values: a value can echo the robot's input.
 */
export type IngestOutcome =
  | {
      readonly kind: "presence";
      readonly clientId: string;
      /** Robot id when the client is a robot's thing; `null` for any other client. */
      readonly robotId: RobotId | null;
      readonly eventType: PresenceEventType;
      readonly timestamp: number;
      readonly disconnectReason: string | undefined;
      readonly versionNumber: number | undefined;
      /** Set only when the broker says the robot closed its own session (a clean shutdown). */
      readonly clientInitiatedDisconnect?: boolean;
    }
  | {
      readonly kind: "event";
      readonly robotId: RobotId;
      readonly siteId: SiteId;
      readonly event: RobotEvent;
      /** Broker receive time, in milliseconds since the epoch. */
      readonly receivedAt: number;
    }
  | {
      readonly kind: "ack";
      readonly robotId: RobotId;
      readonly siteId: SiteId;
      readonly ack: Ack;
      readonly receivedAt: number;
    }
  | {
      readonly kind: "rejected";
      readonly reason: IngestRejectReason;
      readonly robotId: RobotId | null;
      readonly issuePaths: readonly string[];
    };

/** The rejected member of {@link IngestOutcome}, shared with the telemetry classification. */
export type RejectedOutcome = Extract<IngestOutcome, { kind: "rejected" }>;

/**
 * Builds a rejected outcome.
 *
 * @param reason - Why the delivery is refused.
 * @param robotId - The robot of the topic, when the topic was parsed.
 * @param issuePaths - Schema paths of a `SCHEMA` rejection; empty otherwise.
 * @returns The rejected outcome.
 */
export function rejectedDelivery(
  reason: IngestRejectReason,
  robotId: RobotId | null = null,
  issuePaths: readonly string[] = [],
): RejectedOutcome {
  return { kind: "rejected", reason, robotId, issuePaths };
}

/**
 * Classifies a presence notice. The client id names the robot only when it follows the thing grammar;
 * any other client is still a presence fact, so it is logged and counted, with no robot attached.
 *
 * @param presence - The validated presence notice.
 * @returns The presence outcome.
 */
function classifyPresence(presence: PresenceEvent): IngestOutcome {
  // The flag is copied only when the broker sent it, so an absent flag is absent in the outcome too.
  const clientInitiated =
    presence.clientInitiatedDisconnect === undefined
      ? {}
      : { clientInitiatedDisconnect: presence.clientInitiatedDisconnect };
  return {
    kind: "presence",
    clientId: presence.clientId,
    robotId: robotIdFromThingName(presence.clientId),
    eventType: presence.eventType,
    timestamp: presence.timestamp,
    disconnectReason: presence.disconnectReason,
    versionNumber: presence.versionNumber,
    ...clientInitiated,
  };
}

/**
 * Decodes the payload of a robot delivery as UTF-8 JSON. A payload that is not valid UTF-8 or not JSON is
 * refused the same way, and the decoding error is not kept: its message can echo the bytes.
 *
 * @param bytes - The decoded payload.
 * @returns The parsed JSON value, or `null` if the bytes are not JSON.
 */
function decodeJson(bytes: Buffer): { readonly value: unknown } | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const value: unknown = JSON.parse(text);
    return { value };
  } catch {
    return null;
  }
}

/**
 * Checks that the identity written in the payload is the identity of the topic. The payload comes from
 * the robot, so it is compared to the topic and never trusted on its own.
 *
 * @param payload - The validated payload, with its envelope identity.
 * @param topic - The parsed topic.
 * @returns `true` when the robot and the site of the payload are the ones of the topic.
 */
export function identityMatches(
  payload: { readonly robotId: string; readonly siteId: string },
  topic: FleetTopic,
): boolean {
  return payload.robotId === topic.robotId && payload.siteId === topic.siteId;
}

/** A robot delivery whose prefix (topic, channel, client id, size, JSON) has passed. */
export type OpenedRobotDelivery =
  | { readonly ok: true; readonly topic: FleetTopic; readonly value: unknown }
  | { readonly ok: false; readonly rejection: RejectedOutcome };

/**
 * Runs the checks every robot delivery shares, in a fixed order: the topic, the channel the caller
 * accepts, the client id, the payload size, then the JSON. The payload is decoded only after the topic
 * and the client id have passed, so a delivery that is not from the robot it claims costs no parsing.
 *
 * Events, acknowledgements and telemetry share these checks and their reject reasons, so a telemetry
 * message is held to the same rules as an event.
 *
 * @param delivery - The validated robot rule delivery.
 * @param accepted - The channels the caller accepts for this rule.
 * @returns The parsed topic and the decoded JSON value, or the rejection.
 */
export function openRobotDelivery(
  delivery: RobotRuleDelivery,
  accepted: readonly FleetChannel[],
): OpenedRobotDelivery {
  const topic = parseFleetTopic(delivery.iotTopic);
  if (topic === null) {
    return { ok: false, rejection: rejectedDelivery("UNKNOWN_TOPIC") };
  }
  const robotId = topic.robotId;
  if (!accepted.includes(topic.channel)) {
    return { ok: false, rejection: rejectedDelivery("WRONG_CHANNEL", robotId) };
  }
  // The robot id of a parsed topic follows the thing grammar, so `thingName` cannot throw here.
  if (delivery.iotClientId !== thingName(robotId)) {
    return { ok: false, rejection: rejectedDelivery("CLIENT_MISMATCH", robotId) };
  }

  const bytes = Buffer.from(delivery.payloadBase64, "base64");
  if (bytes.byteLength > MAX_MQTT_PAYLOAD_BYTES) {
    return { ok: false, rejection: rejectedDelivery("OVERSIZE", robotId) };
  }
  const decoded = decodeJson(bytes);
  if (decoded === null) {
    return { ok: false, rejection: rejectedDelivery("NOT_JSON", robotId) };
  }
  return { ok: true, topic, value: decoded.value };
}

/**
 * Classifies a robot delivery on the events or the acknowledgement channel.
 *
 * @param delivery - The validated robot rule delivery.
 * @returns The event, the acknowledgement, or the rejection.
 */
function classifyRobotDelivery(delivery: RobotRuleDelivery): IngestOutcome {
  const opened = openRobotDelivery(delivery, ["events", "ack"]);
  if (!opened.ok) {
    return opened.rejection;
  }
  const { topic, value } = opened;
  const robotId = topic.robotId;

  if (topic.channel === "events") {
    const parsed = RobotEventSchema.safeParse(value);
    if (!parsed.success) {
      return rejectedDelivery("SCHEMA", robotId, issuePathsOf(parsed.error));
    }
    if (!identityMatches(parsed.data, topic)) {
      return rejectedDelivery("IDENTITY_MISMATCH", robotId);
    }
    if (bootInFuture(parsed.data.bootId, delivery.iotReceivedAt)) {
      return rejectedDelivery("BOOT_IN_FUTURE", robotId);
    }
    return {
      kind: "event",
      robotId,
      siteId: topic.siteId,
      event: parsed.data,
      receivedAt: delivery.iotReceivedAt,
    };
  }

  const parsed = AckSchema.safeParse(value);
  if (!parsed.success) {
    return rejectedDelivery("SCHEMA", robotId, issuePathsOf(parsed.error));
  }
  if (!identityMatches(parsed.data, topic)) {
    return rejectedDelivery("IDENTITY_MISMATCH", robotId);
  }
  if (bootInFuture(parsed.data.bootId, delivery.iotReceivedAt)) {
    return rejectedDelivery("BOOT_IN_FUTURE", robotId);
  }
  return {
    kind: "ack",
    robotId,
    siteId: topic.siteId,
    ack: parsed.data,
    receivedAt: delivery.iotReceivedAt,
  };
}

/**
 * Tells whether a boot identifier is dated more than {@link BOOT_FUTURE_TOLERANCE_MS} after the broker received
 * the message. The date is the 48-bit millisecond field of the UUIDv7, which the robot writes and the cloud
 * does not trust, so only the bound is enforced here.
 *
 * @param bootId - The boot identifier, already validated as a lowercase UUIDv7.
 * @param receivedAt - The broker receive time, in milliseconds since the epoch.
 * @returns `true` when the boot is dated too far in the future.
 */
export function bootInFuture(bootId: string, receivedAt: number): boolean {
  // The first 12 hex digits of a UUID (8 + 4, skipping the separator) are its 48-bit timestamp.
  const bootMs = parseInt(bootId.slice(0, 8) + bootId.slice(9, 13), 16);
  return bootMs > receivedAt + BOOT_FUTURE_TOLERANCE_MS;
}

/**
 * Lists the paths of the issues of a schema failure. Paths only: the messages and the values of the
 * issues are dropped, since a value can echo the robot's input.
 *
 * @param error - The zod error of the payload.
 * @returns The dotted path of every issue.
 */
export function issuePathsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => issue.path.map(String).join("."));
}

/**
 * Classifies one delivery from a topic rule.
 *
 * Never throws on input: every malformed delivery, whatever its shape, is a `rejected` outcome, so the
 * function can run on any value the rule delivers. The result carries no payload bytes and no network
 * address, so it is safe to log after the handler reads its fields.
 *
 * @param raw - The delivery as the Lambda runtime passes it, not yet validated.
 * @returns The classified outcome.
 */
export function classifyDelivery(raw: unknown): IngestOutcome {
  const parsed = IngestDeliverySchema.safeParse(raw);
  if (!parsed.success) {
    return rejectedDelivery("MALFORMED_DELIVERY");
  }
  const delivery = parsed.data;
  if (delivery.source === "presence") {
    return classifyPresence(delivery);
  }
  return classifyRobotDelivery(delivery);
}
