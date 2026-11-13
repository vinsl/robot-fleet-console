/**
 * Audit records of the alert actions.
 *
 * A SUCCEEDED record is written in the same transaction as the change it describes (ADR 0061), so a change is
 * never recorded without its audit line. A REFUSED record has no change to protect, so its write is best
 * effort, as for the site actions: a refusal is still answered when its record cannot be written, the failure is
 * logged by its error name and counted.
 */
import {
  AuditRecordSchema,
  type Actor,
  type AlertId,
  type AuditRecord,
  type AuditResult,
  type CorrelationId,
  type IsoMs,
  type RobotId,
  type SiteId,
} from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import type { ProblemType } from "../result";
import type { AlertsDeps } from "./ports";

/** Facts of one audited alert outcome. The identifier and the timestamp are added when the record is built. */
export interface AlertAuditInput {
  /**
   * Instant of the outcome. A change passes the alert timestamp of its transition, so the audit line and the alert
   * carry the same instant; a refusal passes the clock read of its write.
   */
  readonly at: IsoMs;
  /** Site of the alert. */
  readonly siteId: SiteId;
  /** Robot of the alert: the robot timeline lists the action. */
  readonly robotId: RobotId;
  /** Alert the action concerned. */
  readonly alertId: AlertId;
  /** Declared identity of the verified caller. */
  readonly actor: Actor;
  /** The operator action. */
  readonly action: "alert.acknowledge" | "alert.resolve";
  /** Outcome of the action. */
  readonly result: AuditResult;
  /** Problem type, required when the result is not a success. */
  readonly problemType?: ProblemType;
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
}

/**
 * Builds the audit record of an alert action.
 *
 * The actor source is `mfc.jwt`: the caller is a human identified by a verified Cognito access token.
 *
 * @param deps - The identifier source of the alerts use cases.
 * @param input - The facts of the outcome, with the instant they happened at.
 * @returns The record, validated by the protocol schema.
 * @throws {ZodError} When the input breaks the audit contract (a programming error).
 */
export function alertAuditRecord(
  deps: Pick<AlertsDeps, "ids">,
  input: AlertAuditInput,
): AuditRecord {
  return AuditRecordSchema.parse({
    auditId: deps.ids.uuidv7(),
    ts: input.at,
    siteId: input.siteId,
    robotId: input.robotId,
    alertId: input.alertId,
    actor: input.actor,
    actorSource: "mfc.jwt",
    action: input.action,
    result: input.result,
    ...(input.problemType === undefined ? {} : { problemType: input.problemType }),
    correlationId: input.correlationId,
  });
}

/**
 * Writes one REFUSED audit record. Never throws: a failed build or write is logged with its error name and
 * counted, and the refusal is still answered.
 *
 * @param deps - The audit port, clock, identifier source, logger and metrics of the alerts use cases.
 * @param input - The facts of the refusal. The instant is read from the clock when the record is built.
 */
export async function writeAlertAudit(
  deps: AlertsDeps,
  input: Omit<AlertAuditInput, "at">,
): Promise<void> {
  try {
    await deps.audit.write(
      alertAuditRecord(deps, { ...input, at: deps.clock.now().toISOString() }),
    );
  } catch (error) {
    deps.logger.error("audit write failed", safeErrorFields(error));
    deps.metrics.count("AuditWriteFailed");
  }
}
