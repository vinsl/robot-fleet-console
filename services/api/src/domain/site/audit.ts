/**
 * Audit records of the site actions, written after their outcome is known.
 *
 * The write is best effort, as for the robot actions: a map that is already stored must not be reported as
 * failed because its audit record could not be written. The failure is logged by its error name and counted;
 * the object versions and the CloudTrail data events are the independent record.
 */
import {
  AuditRecordSchema,
  type Actor,
  type AuditAction,
  type AuditResult,
  type CorrelationId,
  type MapVersionNumber,
  type SiteId,
} from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import type { SiteDeps } from "./ports";
import type { SiteProblemType } from "./result";

/** Facts of one audited site outcome. The identifier and the timestamp are added by {@link writeSiteAudit}. */
export interface SiteAuditInput {
  /** Site the action targeted. */
  readonly siteId: SiteId;
  /** Declared identity of the verified caller. */
  readonly actor: Actor;
  /** The site action. */
  readonly action: AuditAction;
  /** Outcome of the action. */
  readonly result: AuditResult;
  /** Problem type, required when the result is not a success. */
  readonly problemType?: SiteProblemType;
  /** Map version the action concerned, for the map actions. */
  readonly mapVersion?: MapVersionNumber;
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
}

/**
 * Writes one audit record of a site action. Never throws: a failed write is logged with its error name and
 * counted.
 *
 * The actor source is `mfc.jwt`: the caller is identified by a verified Cognito access token, not by an
 * IAM invocation as the robot functions are.
 *
 * @param deps - The audit port, clock, identifier source, logger and metrics of the site use cases.
 * @param input - The facts of the outcome.
 */
export async function writeSiteAudit(deps: SiteDeps, input: SiteAuditInput): Promise<void> {
  const { audit, clock, ids, logger, metrics } = deps;
  try {
    const record = AuditRecordSchema.parse({
      auditId: ids.uuidv7(),
      ts: clock.now().toISOString(),
      siteId: input.siteId,
      actor: input.actor,
      actorSource: "mfc.jwt",
      action: input.action,
      result: input.result,
      ...(input.problemType === undefined ? {} : { problemType: input.problemType }),
      ...(input.mapVersion === undefined ? {} : { mapVersion: input.mapVersion }),
      correlationId: input.correlationId,
    });
    await audit.write(record);
  } catch (error) {
    logger.error("audit write failed", safeErrorFields(error));
    metrics.count("AuditWriteFailed");
  }
}
