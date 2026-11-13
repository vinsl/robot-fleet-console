/**
 * Ingest metadata: the fields the cloud adds to a robot message when it accepts it.
 *
 * The robot cannot set these fields itself. The broker supplies the client id, the topic and the
 * receive time, so the cloud can check them against the payload and store a trusted record.
 */
import { z } from "zod";
import { ThingNameSchema } from "./ids";
import { TelemetrySchema } from "./telemetry";

/** Upper bound on the topic kept with a record, so that a long topic cannot inflate stored items. */
const MAX_TOPIC_LENGTH = 256;

/** Fields the broker and the rule add to a message before the cloud stores it. */
export const IngestMetadataShape = {
  iotClientId: ThingNameSchema,
  iotTopic: z.string().max(MAX_TOPIC_LENGTH),
  iotReceivedAt: z.int().min(0),
};

/** Telemetry as stored by the cloud: the robot's message plus the broker-supplied metadata. */
export const IngestedTelemetrySchema = TelemetrySchema.extend(IngestMetadataShape);

/** A validated stored telemetry record. */
export type IngestedTelemetry = z.infer<typeof IngestedTelemetrySchema>;

/**
 * Largest base64 text a rule delivery may carry: the base64 of 128 KiB, the largest payload IoT
 * accepts. Bounded only so that one delivery cannot be unbounded; the robot payload limit is
 * {@link MAX_MQTT_PAYLOAD_BYTES}, checked after decoding.
 */
export const MAX_RULE_PAYLOAD_BASE64_LENGTH = 174_764;

/**
 * Standard base64 with padding, the only form `encode(*, 'base64')` produces: the alphabet excludes `*`
 * and the URL-safe characters, and at most two `=` close the text. The length check below completes the
 * grammar. Written without nested quantifiers, so that the linter's ReDoS check has nothing to flag.
 */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * A robot message as delivered by a topic rule (telemetry, events or acks). The rule adds the broker
 * metadata and carries the payload as base64, so a non-JSON or oversize payload reaches the cloud as a
 * countable rejection and not as a rule error.
 *
 * Strict: the rule emits exactly these keys, so an extra key means the rule changed without the cloud.
 */
export const RobotRuleDeliverySchema = z.strictObject({
  source: z.literal("robot"),
  iotTopic: z.string().min(1).max(MAX_TOPIC_LENGTH),
  // Not ThingNameSchema: a mismatch is a counted rejection at classification, not a parse error.
  iotClientId: z.string().min(1).max(128),
  iotReceivedAt: z.int().min(0),
  payloadBase64: z
    .string()
    .max(MAX_RULE_PAYLOAD_BASE64_LENGTH)
    .regex(BASE64_PATTERN)
    .refine((text) => text.length % 4 === 0, {
      message: "base64 length must be a multiple of four",
    }),
});

/** A validated robot rule delivery. */
export type RobotRuleDelivery = z.infer<typeof RobotRuleDeliverySchema>;

/**
 * Lifecycle event the broker publishes for a client, as the presence rule selects it (`infra/modules/iot-rules`,
 * with an explicit field list and `'presence' AS source`).
 *
 * Not strict on purpose: AWS may add fields, and unknown keys are stripped. The principal identifier,
 * the session identifier and the IP address are not selected by the rule: the IP address is personal data and
 * none of the three is needed by the cloud.
 *
 * `thingName` and `connect_failed` are defensive: AWS lifecycle events do not carry `thingName`, and the
 * cloud keys every presence decision on `clientId`, so neither field is relied upon.
 */
export const PresenceEventSchema = z.object({
  source: z.literal("presence"),
  clientId: z.string().min(1).max(128),
  eventType: z.enum(["connected", "disconnected", "connect_failed"]),
  timestamp: z.int().min(0),
  versionNumber: z.int().min(0).optional(),
  clientInitiatedDisconnect: z.boolean().optional(),
  disconnectReason: z
    .string()
    .regex(/^[A-Z_]{1,64}$/)
    .optional(),
  connectFailureReason: z
    .string()
    .regex(/^[A-Z_]{1,64}$/)
    .optional(),
  thingName: z.string().max(128).optional(),
});

/** A validated presence event. */
export type PresenceEvent = z.infer<typeof PresenceEventSchema>;

/**
 * Any delivery the ingest function receives from a topic rule, discriminated on `source`.
 */
export const IngestDeliverySchema = z.discriminatedUnion("source", [
  RobotRuleDeliverySchema,
  PresenceEventSchema,
]);

/** A validated delivery from a topic rule. */
export type IngestDelivery = z.infer<typeof IngestDeliverySchema>;
