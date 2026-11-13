/**
 * Registration of a robot: claims the id, provisions the IoT identity and the video channel, and returns
 * the kit exactly once.
 *
 * Idempotency comes from the registry state, never from a cache of the response: the response holds the
 * private key, and a cached copy would break the rule that the key is never stored. A failed step is
 * compensated at once, and the record moves to `PROVISIONING_FAILED`, so the same request can resume it.
 */
import {
  RegisterRobotResponseSchema,
  ROBOT_POLICY_NAME,
  thingName,
  type RegisterRobotRequest,
  type RegisterRobotResponse,
  type RegisterInvokeResult,
  type AuditResult,
  type ThingName,
} from "@mfc/protocol";
import { safeErrorFields } from "../safe-error";
import { buildKit } from "./kit";
import {
  problemResult,
  PROBLEM_DETAILS,
  type ProblemDetail,
  type RobotsFailureCode,
  RobotsError,
} from "./problems";
import { recordAudit } from "./audit";
import type { CreatedCertificate, InvocationContext, RegistryPort, RobotsDeps } from "../ports";
import {
  canResumeRegistration,
  isStaleProvisioning,
  MAX_CERTIFICATES_PER_ROBOT,
  toSummary,
  type ProvisioningStep,
  type RobotRecord,
} from "./registry";
import { assertStepBudget, teardownRobotResources } from "./teardown";

/** Outcome of the claim of the robot id: either the registration may proceed, or it is refused. */
type Claim =
  | { readonly kind: "claimed"; readonly current: RobotRecord }
  | { readonly kind: "refused"; readonly code: RobotsFailureCode; readonly detail: ProblemDetail };

/**
 * Registers a robot and returns its kit.
 *
 * Steps 3 to 12 run under the step budget. Any failure in them triggers the compensation: every certificate
 * recorded or created is revoked, the session is ended, the policy is detached and the channel is deleted.
 * The record then becomes `PROVISIONING_FAILED` and the audit trail gets a `FAILED` entry.
 *
 * @param deps - Registry, IoT, video, audit, clock, identifiers, logger, metrics and configuration.
 * @param request - The validated registration request.
 * @param ctx - The invocation: correlation identifier, caller and deadline.
 * @returns `201` with the summary and the kit, or a failed invocation with the problem to return.
 */
export async function registerRobot(
  deps: RobotsDeps,
  request: RegisterRobotRequest,
  ctx: InvocationContext,
): Promise<RegisterInvokeResult> {
  const { iot, kvs, clock, logger, metrics, config, registry } = deps;
  const { robotId, siteId } = request;
  const { correlationId, actor, deadline } = ctx;
  const thing = thingName(robotId);
  const now = clock.now();
  const nowIso = now.toISOString();

  /** Audit of this request. Problem type is given only for refusals and failures. */
  const audit = (result: AuditResult, problemType?: RobotsFailureCode): Promise<void> =>
    recordAudit(deps, {
      siteId,
      robotId,
      actor,
      action: "robots.register",
      result,
      correlationId,
      ...(problemType === undefined ? {} : { problemType }),
    });

  const fresh: RobotRecord = {
    ...request,
    thingName: thing,
    status: "PROVISIONING",
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    certificates: [],
    lastCorrelationId: correlationId,
  };

  let claim: Claim;
  try {
    claim = await claimRobot(deps, request, ctx, fresh, now, nowIso);
  } catch (error) {
    if (!(error instanceof RobotsError) || error.code !== "internal") {
      throw error;
    }
    logger.error("registry record unreadable", safeErrorFields(error));
    await audit("FAILED", "internal");
    return problemResult("internal", PROBLEM_DETAILS.internal, correlationId);
  }

  if (claim.kind === "refused") {
    await audit("REFUSED", claim.code);
    metrics.count("RobotRegistrationRefused");
    return problemResult(claim.code, claim.detail, correlationId);
  }

  let current = claim.current;
  let issued: CreatedCertificate | undefined;
  let response: RegisterRobotResponse;
  const progress: { step: ProvisioningStep } = { step: "CLEANUP" };

  /**
   * Runs one provisioning step: records its name for the failure log, refuses to start it without budget,
   * and logs its completion.
   */
  const run = async <T>(name: ProvisioningStep, fn: () => T | Promise<T>): Promise<T> => {
    progress.step = name;
    assertStepBudget(deadline);
    const value = await fn();
    logger.debug("step done", { step: name });
    return value;
  };

  try {
    const report = await run("CLEANUP", () =>
      teardownRobotResources(deps, { thingName: thing, knownCertificates: current.certificates }),
    );
    if (report.revoked > 0 || report.channelDeleted) {
      logger.warn("leftover resources removed", {
        revoked: report.revoked,
        channelDeleted: report.channelDeleted,
      });
      metrics.count("LeftoverResourcesRemoved");
    }

    await run("THING", () => iot.createThing(thing, { robotId, siteId }));

    // From here the private key exists only in this local variable and in the kit.
    const created = await run("CERTIFICATE", () => iot.createInactiveCertificate());
    issued = created;

    const recorded: RobotRecord = {
      ...current,
      certificates: [
        ...current.certificates,
        { certificateId: created.certificateId, certificateArn: created.certificateArn },
      ],
      version: current.version + 1,
      updatedAt: nowIso,
    };
    await run("RECORD_CERTIFICATE", () => replaceOrFail(registry, current.version, recorded));
    current = recorded;

    await run("POLICY", () => iot.attachPolicy(ROBOT_POLICY_NAME, created.certificateArn));
    await run("THING_PRINCIPAL", () => iot.attachExclusiveThing(thing, created.certificateArn));
    const channel = await run("CHANNEL", () => kvs.createChannel(thing, config.resourceTags));
    await run("ACTIVATE", () => iot.activateCertificate(created.certificateId));

    const active: RobotRecord = {
      ...current,
      status: "ACTIVE",
      kvsChannelArn: channel.channelArn,
      version: current.version + 1,
      updatedAt: nowIso,
    };
    response = await run("KIT", () =>
      RegisterRobotResponseSchema.parse({
        robot: toSummary(active),
        kit: buildKit({ record: current, cert: created, channelArn: channel.channelArn, config }),
      }),
    );
    await run("COMMIT", () => replaceOrFail(registry, current.version, active));
  } catch (error) {
    logger.error("registration failed", { step: progress.step, ...safeErrorFields(error) });
    await compensate(deps, {
      thing,
      current,
      issued,
      step: progress.step,
      nowIso,
    });
    await audit("FAILED", "provisioning-failed");
    metrics.count("RobotRegistrationFailed");
    return problemResult("provisioning-failed", PROBLEM_DETAILS.provisioningFailed, correlationId);
  }

  await audit("SUCCEEDED");
  metrics.count("RobotRegistered");
  // The certificate of this registration is the last one recorded: it was appended at RECORD_CERTIFICATE.
  logger.info("robot registered", { certificateId: current.certificates.at(-1)?.certificateId });
  return { ok: true, status: 201, body: response };
}

/**
 * Claims the robot id, or decides why the registration must not proceed.
 *
 * A claim that is already ours (a retried call) or stale or failed (a resumable record) is taken over.
 * Every other existing record refuses the request. Errors from the registry propagate.
 *
 * @param deps - The registry port and the identifier source.
 * @param request - The validated registration request.
 * @param ctx - The invocation context.
 * @param fresh - The record to create if the id is free.
 * @param now - The current instant.
 * @param nowIso - The current instant as an ISO string, the write timestamp.
 * @returns The record to provision, or the refusal.
 */
async function claimRobot(
  deps: RobotsDeps,
  request: RegisterRobotRequest,
  ctx: InvocationContext,
  fresh: RobotRecord,
  now: Date,
  nowIso: string,
): Promise<Claim> {
  const { registry, ids } = deps;
  const { robotId, siteId } = request;
  const claimed = (current: RobotRecord): Claim => ({ kind: "claimed", current });
  const refused = (code: RobotsFailureCode, detail: ProblemDetail): Claim => ({
    kind: "refused",
    code,
    detail,
  });

  const reserved = await registry.reserve(fresh, ids.uuidv7());
  if (reserved === "reserved") {
    return claimed(fresh);
  }

  const existing = await registry.get(siteId, robotId);
  if (existing === null) {
    // The id is claimed, but not at this site: the thing name is global, so the id is not free.
    return refused("robot-exists", PROBLEM_DETAILS.robotExists);
  }
  if (
    existing.status === "PROVISIONING" &&
    existing.lastCorrelationId === ctx.correlationId &&
    isStaleProvisioning(existing, now)
  ) {
    // Our own earlier reserve, replayed by a retried call after it went stale: continue where it stopped.
    // A live reserve of this same invocation is not resumed: it is still running, so it is refused below.
    return claimed(existing);
  }
  if (!canResumeRegistration(existing, now)) {
    if (existing.status === "PROVISIONING") {
      return refused("robot-state-conflict", PROBLEM_DETAILS.busy);
    }
    return refused("robot-exists", PROBLEM_DETAILS.robotExists);
  }
  if (existing.certificates.length >= MAX_CERTIFICATES_PER_ROBOT) {
    return refused("robot-state-conflict", PROBLEM_DETAILS.tooManyAttempts);
  }

  const next: RobotRecord = {
    ...existing,
    ...request,
    status: "PROVISIONING",
    version: existing.version + 1,
    updatedAt: nowIso,
    lastCorrelationId: ctx.correlationId,
    failedStep: undefined,
    kvsChannelArn: undefined,
  };
  const outcome = await registry.replace(existing.version, next);
  if (outcome === "conflict") {
    return refused("robot-state-conflict", PROBLEM_DETAILS.busy);
  }
  return claimed(next);
}

/**
 * Writes a record under a version check, and treats a refused write as a failed step.
 *
 * @param registry - The registry port.
 * @param expectedVersion - The version the caller read.
 * @param next - The record to store.
 * @throws {RobotsError} With code `provisioning-failed` when another writer moved the record on.
 */
async function replaceOrFail(
  registry: RegistryPort,
  expectedVersion: number,
  next: RobotRecord,
): Promise<void> {
  if ((await registry.replace(expectedVersion, next)) === "conflict") {
    throw new RobotsError("provisioning-failed");
  }
}

/** What the compensation of a failed registration needs to know. */
interface CompensationInput {
  /** Thing of the robot. */
  readonly thing: ThingName;
  /** The last record the registration wrote. */
  readonly current: RobotRecord;
  /** The certificate created in this attempt, if the failure came after its creation. */
  readonly issued: CreatedCertificate | undefined;
  /** Step that failed. */
  readonly step: ProvisioningStep;
  /** Instant of the failure, the write timestamp. */
  readonly nowIso: string;
}

/**
 * Undoes a failed registration as far as possible, then records the failure.
 *
 * The certificate created in this attempt is included even when its reference was never recorded, so that
 * it is revoked. A failed compensation is counted and logged, and the record is still marked failed: the
 * next registration then revokes whatever remains, because the certificates stay in the record.
 *
 * @param deps - The ports used by the teardown and the registry write.
 * @param input - The state at the moment of the failure.
 */
async function compensate(deps: RobotsDeps, input: CompensationInput): Promise<void> {
  const { logger, metrics, registry } = deps;
  const { thing, current, issued, step, nowIso } = input;
  const knownCertificates =
    issued === undefined
      ? current.certificates
      : [
          ...current.certificates,
          { certificateId: issued.certificateId, certificateArn: issued.certificateArn },
        ];

  try {
    await teardownRobotResources(deps, { thingName: thing, knownCertificates });
  } catch (error) {
    metrics.count("CompensationFailed");
    logger.error("compensation failed", { step, ...safeErrorFields(error) });
  }

  try {
    const outcome = await registry.replace(current.version, {
      ...current,
      status: "PROVISIONING_FAILED",
      failedStep: step,
      version: current.version + 1,
      updatedAt: nowIso,
    });
    if (outcome === "conflict") {
      logger.error("failure not recorded", { step });
    }
  } catch (error) {
    logger.error("failure not recorded", { step, ...safeErrorFields(error) });
  }
}
