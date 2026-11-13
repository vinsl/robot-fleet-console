/**
 * Audit records of admin actions, written after their outcome is known.
 *
 * The write is best effort: a registration whose kit is already minted must not fail because its audit
 * record could not be stored. The failure is logged and counted, and CloudTrail keeps the IoT calls as
 * the independent record.
 */
import {
  AuditRecordSchema,
  type Actor,
  type AuditAction,
  type AuditResult,
  type CorrelationId,
  type RobotId,
  type SiteId,
} from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import type { RobotsDeps } from "../ports";
import type { RobotsFailureCode } from "./problems";

/** Facts of one audited outcome. The identifier and the timestamp are added by {@link recordAudit}. */
export interface AuditInput {
  /** Site of the robot. */
  readonly siteId: SiteId;
  /** Robot the action targeted. */
  readonly robotId: RobotId;
  /** Declared identity of the caller. */
  readonly actor: Actor;
  /** The admin action. */
  readonly action: AuditAction;
  /** Outcome of the action. */
  readonly result: AuditResult;
  /** Problem type, required when the result is not a success. */
  readonly problemType?: RobotsFailureCode;
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
}

/** Dependencies of the audit write. */
export type AuditDeps = Pick<RobotsDeps, "audit" | "clock" | "ids" | "logger" | "metrics">;

/**
 * Writes one audit record. Never throws: a failed write is logged with its error name and counted.
 *
 * @param deps - Audit port, clock, identifier source, logger and metrics.
 * @param input - The facts of the outcome.
 */
export async function recordAudit(deps: AuditDeps, input: AuditInput): Promise<void> {
  const { audit, clock, ids, logger, metrics } = deps;
  try {
    const record = AuditRecordSchema.parse({
      auditId: ids.uuidv7(),
      ts: clock.now().toISOString(),
      siteId: input.siteId,
      robotId: input.robotId,
      actor: input.actor,
      // The only actor source until the Cognito path of M6 exists.
      actorSource: "mfc.admin",
      action: input.action,
      result: input.result,
      ...(input.problemType === undefined ? {} : { problemType: input.problemType }),
      correlationId: input.correlationId,
    });
    await audit.write(record);
  } catch (error) {
    logger.error("audit write failed", safeErrorFields(error));
    metrics.count("AuditWriteFailed");
  }
}
