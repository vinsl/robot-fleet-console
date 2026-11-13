/**
 * Audit records of the control actions.
 *
 * Every control record is written after its outcome, and best effort: an audit outage never delays a command or an
 * e-stop, and the failure is logged by its error name and counted (ADR 0064). The CloudWatch logs carry the same facts
 * as the backstop, as for the alerts.
 */
import {
  AuditRecordSchema,
  type AuditAction,
  type AuditRecord,
  type AuditResult,
  type CorrelationId,
  type RobotId,
  type SiteId,
  type UserSub,
  type Uuidv7,
} from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import type { ProblemType } from "../result";
import { CONTROL_PROBLEMS } from "./problems";
import type { ControlDeps } from "./ports";

/** Facts of one audited control outcome. The identifier and the timestamp are added when the record is built. */
export interface ControlAuditInput {
  /** Site of the action. */
  readonly siteId: SiteId;
  /** Robot of the action: present exactly for the `lock.*` and `command.*` actions. */
  readonly robotId?: RobotId | undefined;
  /** Client identifier of the request: present exactly for the `command.*` actions. */
  readonly commandId?: Uuidv7 | undefined;
  /** Subject of the verified caller. */
  readonly actor: UserSub;
  /** The control action. */
  readonly action: AuditAction;
  /** Outcome of the action. */
  readonly result: AuditResult;
  /** Problem type, required when the result is not a success. */
  readonly problemType?: ProblemType | undefined;
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
}

/**
 * Builds the audit record of a control outcome.
 *
 * The actor source is `mfc.jwt`: the caller is a human identified by a verified Cognito access token.
 *
 * @param deps - The clock and identifier source of the control use cases.
 * @param input - The facts of the outcome.
 * @returns The record, validated by the protocol schema.
 * @throws {ZodError} When the input breaks the audit contract, for example a command action without a command
 * identifier. That is a programming error, and {@link writeControlAudit} keeps it from reaching the caller.
 */
export function controlAuditRecord(
  deps: Pick<ControlDeps, "clock" | "ids">,
  input: ControlAuditInput,
): AuditRecord {
  return AuditRecordSchema.parse({
    auditId: deps.ids.uuidv7(),
    ts: deps.clock.now().toISOString(),
    siteId: input.siteId,
    ...(input.robotId === undefined ? {} : { robotId: input.robotId }),
    ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
    actor: input.actor,
    actorSource: "mfc.jwt",
    action: input.action,
    result: input.result,
    ...(input.problemType === undefined ? {} : { problemType: input.problemType }),
    correlationId: input.correlationId,
  });
}

/**
 * Writes one control audit record. Never throws: a failed build or write is logged with its error name and counted,
 * and the outcome is still answered.
 *
 * @param deps - The audit port, clock, identifier source, logger and metrics of the control use cases.
 * @param input - The facts of the outcome.
 */
export async function writeControlAudit(
  deps: ControlDeps,
  input: ControlAuditInput,
): Promise<void> {
  try {
    await deps.audit.write(controlAuditRecord(deps, input));
  } catch (error) {
    deps.logger.error("control audit write failed", safeErrorFields(error));
    deps.metrics.count("AuditWriteFailed");
  }
}

/** Facts of a role refusal on a control route: the caller had no right to the action, so nothing else was reached. */
export interface RoleRefusalInput {
  /** Site of the route. */
  readonly siteId: SiteId;
  /** Robot of the route. */
  readonly robotId: RobotId;
  /** Client identifier of the command the caller tried to send; absent for a lock request. */
  readonly commandId?: Uuidv7 | undefined;
  /** Subject of the verified caller. */
  readonly actor: UserSub;
  /** The action the caller tried to perform. */
  readonly action: AuditAction;
  /** Correlation identifier of the invocation. */
  readonly correlationId: CorrelationId;
}

/**
 * Audits a role refusal of a control route as a `REFUSED` record, so that every refusal after authentication is on the
 * trail (D13). The refusal itself is answered by the caller; this only writes the record and counts the refusal.
 *
 * @param deps - The audit port, clock, identifier source, logger and metrics of the control use cases.
 * @param input - The facts of the refused request. It carries no payload: the record never holds the parameters.
 */
export async function recordRoleRefusal(deps: ControlDeps, input: RoleRefusalInput): Promise<void> {
  deps.metrics.count(input.action.startsWith("lock.") ? "LockRefused" : "CommandRefused");
  await writeControlAudit(deps, {
    ...input,
    result: "REFUSED",
    problemType: CONTROL_PROBLEMS.roleNotAllowed.type,
  });
}
