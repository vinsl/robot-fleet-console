/**
 * Classification of one telemetry delivery: the same checks, in the same order, and the same reject
 * reasons as the events channel, so telemetry is never held to a weaker rule than an event.
 *
 * Telemetry is best effort (QoS 0). A rejected sample is dropped and never retried: the broker would
 * deliver the same bytes again, so a rejection is a normal outcome, not a batch failure.
 */
import {
  RobotRuleDeliverySchema,
  TelemetrySchema,
  type RobotId,
  type SiteId,
  type Telemetry,
} from "@mfc/protocol";
import {
  bootInFuture,
  identityMatches,
  issuePathsOf,
  openRobotDelivery,
  rejectedDelivery,
  type RejectedOutcome,
} from "./classify";

/** A telemetry sample that passed every check, with the broker receive time. */
export interface AcceptedTelemetry {
  readonly kind: "telemetry";
  readonly robotId: RobotId;
  readonly siteId: SiteId;
  readonly telemetry: Telemetry;
  /** Broker receive time, in milliseconds since the epoch. */
  readonly receivedAt: number;
}

/** Result of classifying one telemetry delivery. */
export type TelemetryOutcome = AcceptedTelemetry | RejectedOutcome;

/**
 * Classifies one telemetry delivery from the telemetry topic rule.
 *
 * Never throws on input: any value the queue carries becomes a `telemetry` or a `rejected` outcome.
 * The rejected outcome carries no payload and no network address.
 *
 * @param raw - The decoded JSON of the queue body, not yet validated.
 * @returns The accepted sample, or the rejection with its reason.
 */
export function classifyTelemetryDelivery(raw: unknown): TelemetryOutcome {
  const delivery = RobotRuleDeliverySchema.safeParse(raw);
  if (!delivery.success) {
    return rejectedDelivery("MALFORMED_DELIVERY");
  }
  const opened = openRobotDelivery(delivery.data, ["telemetry"]);
  if (!opened.ok) {
    return opened.rejection;
  }
  const { topic, value } = opened;
  const parsed = TelemetrySchema.safeParse(value);
  if (!parsed.success) {
    return rejectedDelivery("SCHEMA", topic.robotId, issuePathsOf(parsed.error));
  }
  if (!identityMatches(parsed.data, topic)) {
    return rejectedDelivery("IDENTITY_MISMATCH", topic.robotId);
  }
  if (bootInFuture(parsed.data.bootId, delivery.data.iotReceivedAt)) {
    return rejectedDelivery("BOOT_IN_FUTURE", topic.robotId);
  }
  return {
    kind: "telemetry",
    robotId: topic.robotId,
    siteId: topic.siteId,
    telemetry: parsed.data,
    receivedAt: delivery.data.iotReceivedAt,
  };
}
