/**
 * Alert records built by the domain: the deterministic identifier and the record of a newly opened alert.
 *
 * The identifier is a digest of the robot, the kind and the source message. The same delivery therefore
 * always maps to the same alert, so a redelivery is recognised by the store instead of opening a second
 * alert.
 */
import { createHash } from "node:crypto";
import {
  ALERT_SEVERITY_BY_KIND,
  AlertRecordSchema,
  type AlertId,
  type AlertKind,
  type AlertRecord,
  type RobotId,
  type SiteId,
} from "@mfc/protocol";

/** Number of hexadecimal characters kept from the digest (128 bits). */
const ALERT_ID_LENGTH = 32;

/**
 * Computes the identifier of an alert.
 *
 * @param robotId - The robot of the alert.
 * @param kind - The kind of the alert.
 * @param sourceKey - The source of the alert: the message identifier, or a key derived from a presence event.
 * @returns The first 32 hexadecimal characters of the SHA-256 of the three values.
 */
export function alertIdOf(robotId: RobotId, kind: AlertKind, sourceKey: string): AlertId {
  const digest = createHash("sha256").update(`${robotId}|${kind}|${sourceKey}`).digest("hex");
  return digest.slice(0, ALERT_ID_LENGTH);
}

/** What the domain knows about an alert when it opens it. */
export interface OpenAlertInput {
  readonly siteId: SiteId;
  readonly robotId: RobotId;
  readonly kind: AlertKind;
  /** Source of the alert: the message identifier, or a key derived from a presence event. */
  readonly sourceKey: string;
  /** Source time of the condition, in the fixed UTC millisecond format. Deterministic under redelivery. */
  readonly openedAt: string;
  readonly sourceMessageId?: string | undefined;
  readonly cause?: string | undefined;
}

/**
 * Builds the record of a newly opened alert. The severity follows the kind, and the record is validated
 * by the protocol schema before it leaves the domain.
 *
 * @param input - The facts of the condition.
 * @returns The open alert record.
 * @throws {ZodError} When a field breaks the protocol rules, which means the caller passed bad data.
 */
export function openAlertRecord(input: OpenAlertInput): AlertRecord {
  return AlertRecordSchema.parse({
    alertId: alertIdOf(input.robotId, input.kind, input.sourceKey),
    siteId: input.siteId,
    robotId: input.robotId,
    kind: input.kind,
    severity: ALERT_SEVERITY_BY_KIND[input.kind],
    status: "OPEN",
    openedAt: input.openedAt,
    cause: input.cause,
    sourceMessageId: input.sourceMessageId,
  });
}
