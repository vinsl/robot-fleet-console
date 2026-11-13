/**
 * Retirement of a robot: revokes its identity and its channel, and keeps the registry entry.
 *
 * The entry is kept as `RETIRED`, so the id can never be registered again: a reused id could inherit the
 * history or a stale grant of the previous robot. Certificates are revoked, never deleted, so their
 * evidence stays in IoT.
 */
import type { RetireInvokeResult, RetireRobotRequest, AuditResult } from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import { recordAudit } from "./audit";
import type { InvocationContext, RobotsDeps } from "../ports";
import { PROBLEM_DETAILS, problemResult, RobotsError, type RobotsFailureCode } from "./problems";
import { canRetire, toSummary, type RobotRecord } from "./registry";
import { assertStepBudget, teardownRobotResources } from "./teardown";

/**
 * Retires a robot.
 *
 * A repeated retirement of a retired robot succeeds without any AWS call. A retirement that fails half way
 * leaves the record in `RETIRING`, and the same request resumes it.
 *
 * @param deps - Registry, IoT, video, audit, clock, identifiers, logger, metrics.
 * @param request - The validated retirement request.
 * @param ctx - The invocation: correlation identifier, caller and deadline.
 * @returns `200` with the summary, or a failed invocation with the problem to return.
 */
export async function retireRobot(
  deps: RobotsDeps,
  request: RetireRobotRequest,
  ctx: InvocationContext,
): Promise<RetireInvokeResult> {
  const { registry, iot, kvs, clock, logger, metrics } = deps;
  const { robotId, siteId } = request;
  const { correlationId, actor, deadline } = ctx;
  const now = clock.now();
  const nowIso = now.toISOString();

  /** Audit of this request. Problem type is given only for refusals and failures. */
  const audit = (result: AuditResult, problemType?: RobotsFailureCode): Promise<void> =>
    recordAudit(deps, {
      siteId,
      robotId,
      actor,
      action: "robots.retire",
      result,
      correlationId,
      ...(problemType === undefined ? {} : { problemType }),
    });

  const existing = await registry.get(siteId, robotId);
  if (existing === null) {
    await audit("REFUSED", "robot-not-found");
    return problemResult("robot-not-found", PROBLEM_DETAILS.robotNotFound, correlationId);
  }

  const decision = canRetire(existing, now);
  if (decision === "already-retired") {
    await audit("SUCCEEDED");
    return { ok: true, status: 200, body: { robot: toSummary(existing), alreadyRetired: true } };
  }
  if (decision === "conflict") {
    await audit("REFUSED", "robot-state-conflict");
    return problemResult("robot-state-conflict", PROBLEM_DETAILS.busy, correlationId);
  }

  let retiring: RobotRecord = existing;
  if (!(existing.status === "RETIRING" && existing.lastCorrelationId === correlationId)) {
    retiring = {
      ...existing,
      status: "RETIRING",
      version: existing.version + 1,
      updatedAt: nowIso,
      lastCorrelationId: correlationId,
    };
    if ((await registry.replace(existing.version, retiring)) === "conflict") {
      await audit("REFUSED", "robot-state-conflict");
      return problemResult("robot-state-conflict", PROBLEM_DETAILS.busy, correlationId);
    }
  }

  let retired: RobotRecord;
  try {
    assertStepBudget(deadline);
    await teardownRobotResources(
      { iot, kvs, logger },
      { thingName: retiring.thingName, knownCertificates: retiring.certificates },
    );

    retired = {
      ...retiring,
      status: "RETIRED",
      retiredAt: nowIso,
      kvsChannelArn: undefined,
      version: retiring.version + 1,
      updatedAt: nowIso,
    };
    if ((await registry.replace(retiring.version, retired)) === "conflict") {
      throw new RobotsError("retirement-failed");
    }
  } catch (error) {
    // The record stays `RETIRING`: a repeated request resumes the teardown, which is idempotent.
    logger.error("retirement failed", safeErrorFields(error));
    await audit("FAILED", "retirement-failed");
    metrics.count("RobotRetirementFailed");
    return problemResult("retirement-failed", PROBLEM_DETAILS.retirementFailed, correlationId);
  }

  await audit("SUCCEEDED");
  metrics.count("RobotRetired");
  logger.info("robot retired");
  return { ok: true, status: 200, body: { robot: toSummary(retired), alreadyRetired: false } };
}
