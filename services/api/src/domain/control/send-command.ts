/**
 * Use case: send a controlled command to a robot (`POST .../commands`).
 *
 * The order of the checks is the safety contract: the role, then the robot registry, the demo flag, the simulated flag,
 * the lock, the claim, and only then the publish. Every refusal after authentication is audited (D13), the role
 * refusal included. The e-stop is the exception to the store checks: it never waits for DynamoDB, a failed registry
 * read or claim store does not stop it, and it publishes first and audits after.
 */
import {
  LOCK_IDLE_EXPIRY_MS,
  commandTopic,
  type AuditAction,
  type CommandRequest,
  type CommandResponse,
  type RobotId,
  type SiteId,
  type UserSub,
  type Uuidv7,
} from "@mfc/protocol";
import type { Principal } from "../authz";
import { safeErrorFields } from "../safe-error";
import { refuse, succeed, type UseCaseProblem, type UseCaseResult } from "../result";
import type { RobotRecord } from "../robots/registry";
import { writeControlAudit } from "./audit";
import { abandonClaim, claimExpiry, isSameRequest } from "./claim";
import { buildCommand } from "./build-command";
import { COMMAND_POLICY } from "./policy";
import { CONTROL_PROBLEMS } from "./problems";
import { epochSecondsOf, isLive, shouldRefreshLock } from "./lock";
import type {
  CommandClaim,
  CommandClaimOutcome,
  ControlCall,
  ControlDeps,
  LockItem,
} from "./ports";

/**
 * Remaining time below which a command is not published: the robot's answer would arrive after the API Gateway
 * timeout, and an effect the user never saw is worse than a clean refusal. The e-stop is exempt.
 */
const MIN_PUBLISH_REMAINING_MS = 1500;

/** The robot and site a command names. Both come from validated path parameters. */
export interface CommandTarget {
  /** Site of the robot, the verified site of the caller. */
  readonly siteId: SiteId;
  /** Robot the command is for. */
  readonly robotId: RobotId;
}

/**
 * What the registry read of a command found. `unknown` is only possible for an e-stop, whose read may fail: the checks
 * that need the record then do not apply to a stop.
 */
type RegistryRead =
  | { readonly kind: "found"; readonly robot: RobotRecord }
  | { readonly kind: "absent" }
  | { readonly kind: "unknown" };

/** Facts of one command outcome that the audit trail needs. */
interface CommandFacts {
  readonly target: CommandTarget;
  readonly actor: UserSub;
  readonly commandId: Uuidv7;
  readonly call: ControlCall;
  readonly action: AuditAction;
}

/**
 * Sends one controlled command.
 *
 * @param deps - The control dependencies.
 * @param principal - The verified caller. The role was checked by the route; the policy checks it again per type.
 * @param target - The robot and the verified site.
 * @param request - The validated body.
 * @param call - The verified caller's correlation identifier and the time left.
 * @returns The answer: published (`deduplicated: false`), a replay of a stored command (`deduplicated: true`), or the
 * refusal.
 */
export async function sendCommand(
  deps: ControlDeps,
  principal: Principal,
  target: CommandTarget,
  request: CommandRequest,
  call: ControlCall,
): Promise<UseCaseResult<CommandResponse>> {
  const policy = COMMAND_POLICY[request.type];
  const { siteId, robotId } = target;
  const actor = principal.userId;
  const facts: CommandFacts = {
    target,
    actor,
    commandId: request.commandId,
    call,
    action: policy.auditAction,
  };
  const refusal = (problem: UseCaseProblem): Promise<UseCaseResult<CommandResponse>> =>
    refuseCommand(deps, facts, problem);

  if (!policy.roles.includes(principal.role)) {
    return refusal(CONTROL_PROBLEMS.roleNotAllowed);
  }

  const registry = await readRegistry(deps, request.type, siteId, robotId);
  if (registry.kind === "absent") {
    return refusal(CONTROL_PROBLEMS.robotNotFound);
  }
  if (registry.kind === "found") {
    // An e-stop is also sent to a retiring robot: stopping it is the safe direction, whatever its status.
    if (registry.robot.status !== "ACTIVE" && request.type !== "ESTOP") {
      return refusal(CONTROL_PROBLEMS.robotRetired);
    }
    if (policy.needsDemoMode && !(await deps.demo.get(siteId)).enabled) {
      return refusal(CONTROL_PROBLEMS.demoModeOff);
    }
    // Third layer of the fault rule (D17): the robot also rejects `NOT_SIMULATED`, but a real robot must never reach
    // it.
    if (policy.needsSimulated && !registry.robot.simulated) {
      return refusal(CONTROL_PROBLEMS.notSimulated);
    }
  }

  const nowDate = deps.clock.now();
  const nowSeconds = epochSecondsOf(nowDate);
  let lock: LockItem | null = null;
  if (policy.needsLock) {
    const item = await deps.locks.get(siteId, robotId);
    if (item === null || !isLive(item, nowSeconds) || item.holder !== actor) {
      return refusal(CONTROL_PROBLEMS.lockNotHeld);
    }
    lock = item;
  }

  // Checked before the claim: a claim written and then abandoned here would turn the retry into a deduplicated
  // answer for a command that was never sent.
  if (request.type !== "ESTOP" && call.remainingMs() < MIN_PUBLISH_REMAINING_MS) {
    return refusal(CONTROL_PROBLEMS.tooLate);
  }

  const claimed = await claimRequest(
    deps,
    request.type,
    siteId,
    {
      commandId: request.commandId,
      robotId,
      type: request.type,
      actor,
      correlationId: call.correlationId,
      issuedAt: nowDate.toISOString(),
    },
    claimExpiry(nowSeconds),
  );
  if (claimed?.kind === "EXISTS") {
    return replayOf(deps, facts, claimed.claim, request.type);
  }

  const command = buildCommand({
    type: request.type,
    robotId,
    siteId,
    commandId: request.commandId,
    correlationId: call.correlationId,
    messageId: deps.ids.uuidv7(),
    issuedBy: actor,
    now: nowDate,
    ...(lock === null ? {} : { lockToken: lock.token }),
    params: request.type === "SIMULATE_FAULT" ? request.params : undefined,
  });
  try {
    await deps.publisher.publish(commandTopic(siteId, robotId), JSON.stringify(command));
  } catch (error) {
    deps.logger.error("command publish failed", safeErrorFields(error));
    deps.metrics.count("CommandPublishFailed");
    await abandonClaim(deps, siteId, request.commandId);
    await writeControlAudit(deps, {
      siteId,
      robotId,
      commandId: request.commandId,
      actor,
      action: policy.auditAction,
      result: "FAILED",
      problemType: CONTROL_PROBLEMS.publishFailed.type,
      correlationId: call.correlationId,
    });
    return refuse(CONTROL_PROBLEMS.publishFailed);
  }

  // The publish came first; from here the answer does not depend on the audit or on the lock refresh.
  if (lock !== null && shouldRefreshLock(lock, nowSeconds)) {
    await refreshLockQuietly(deps, target, lock, nowSeconds);
  }
  deps.metrics.count("CommandSent");
  if (request.type === "SIMULATE_FAULT") {
    deps.metrics.count("FaultInjected");
  }
  await writeControlAudit(deps, {
    siteId,
    robotId,
    commandId: request.commandId,
    actor,
    action: policy.auditAction,
    result: "SUCCEEDED",
    correlationId: call.correlationId,
  });
  return succeed({
    commandId: request.commandId,
    correlationId: call.correlationId,
    issuedAt: command.issuedAt,
    deduplicated: false,
  });
}

/**
 * Reads the registry record a command is checked against. A failed read is fatal for every command but the e-stop,
 * which is logged by its error name and published anyway: the checks that need the record do not apply to a stop.
 *
 * @param deps - The registry port and logger.
 * @param type - The command type.
 * @param siteId - Site of the robot.
 * @param robotId - Robot of the command.
 * @returns The record, its absence, or `unknown` for an e-stop whose read failed.
 * @throws The read error for any other command type.
 */
async function readRegistry(
  deps: ControlDeps,
  type: CommandRequest["type"],
  siteId: SiteId,
  robotId: RobotId,
): Promise<RegistryRead> {
  try {
    const robot = await deps.robots.get(siteId, robotId);
    return robot === null ? { kind: "absent" } : { kind: "found", robot };
  } catch (error) {
    if (type !== "ESTOP") {
      throw error;
    }
    deps.logger.error("robot registry read failed during e-stop", safeErrorFields(error));
    return { kind: "unknown" };
  }
}

/**
 * Claims the identifier of a request. An e-stop whose claim store fails is published without a claim: a stop must not
 * wait for DynamoDB. The cost is that a replay of that identifier can publish again, which a stop tolerates, since
 * stopping a stopped robot is harmless.
 *
 * @param deps - The claim port and logger.
 * @param type - The command type.
 * @param siteId - Site of the request.
 * @param claim - The claim to write.
 * @param expiresAtSeconds - Retention of the claim, in epoch seconds.
 * @returns The claim outcome, or `null` when an e-stop went on without a claim.
 * @throws The store error for any other command type.
 */
async function claimRequest(
  deps: ControlDeps,
  type: CommandRequest["type"],
  siteId: SiteId,
  claim: CommandClaim,
  expiresAtSeconds: number,
): Promise<CommandClaimOutcome | null> {
  try {
    return await deps.claims.claim(siteId, claim, expiresAtSeconds);
  } catch (error) {
    if (type !== "ESTOP") {
      throw error;
    }
    deps.logger.error("command claim failed during e-stop", safeErrorFields(error));
    return null;
  }
}

/**
 * Answers a command whose identifier was already claimed. The same caller, robot and type is a replay: it is
 * answered with the stored identifiers and publishes nothing. Anything else reusing the identifier is a conflict.
 *
 * @param deps - The control dependencies.
 * @param facts - The facts of the request.
 * @param stored - The claim as first written.
 * @param type - The type of the request.
 * @returns The replayed answer, or the conflict refusal.
 */
async function replayOf(
  deps: ControlDeps,
  facts: CommandFacts,
  stored: CommandClaim,
  type: CommandRequest["type"],
): Promise<UseCaseResult<CommandResponse>> {
  if (!isSameRequest(stored, { actor: facts.actor, robotId: facts.target.robotId, type })) {
    return refuseCommand(deps, facts, CONTROL_PROBLEMS.commandConflict);
  }
  deps.metrics.count("CommandDeduplicated");
  return succeed({
    commandId: facts.commandId,
    correlationId: stored.correlationId,
    issuedAt: stored.issuedAt,
    deduplicated: true,
  });
}

/**
 * Counts and audits a refused command, then returns the refusal.
 *
 * @param deps - The control dependencies.
 * @param facts - The facts of the request.
 * @param problem - The refusal.
 * @returns The refused outcome.
 */
async function refuseCommand(
  deps: ControlDeps,
  facts: CommandFacts,
  problem: UseCaseProblem,
): Promise<UseCaseResult<CommandResponse>> {
  deps.metrics.count("CommandRefused");
  await writeControlAudit(deps, {
    siteId: facts.target.siteId,
    robotId: facts.target.robotId,
    commandId: facts.commandId,
    actor: facts.actor,
    action: facts.action,
    result: "REFUSED",
    problemType: problem.type,
    correlationId: facts.call.correlationId,
  });
  return refuse(problem);
}

/**
 * Moves the expiry of the held lock after a successful command. Best effort: the command is already on its way, and a
 * refresh that fails leaves the lock to expire on its own schedule, which the console heartbeat renews.
 *
 * @param deps - The control dependencies.
 * @param target - The robot.
 * @param lock - The lock the caller held when the command was checked.
 * @param nowSeconds - The current instant in epoch seconds.
 */
async function refreshLockQuietly(
  deps: ControlDeps,
  target: CommandTarget,
  lock: LockItem,
  nowSeconds: number,
): Promise<void> {
  try {
    await deps.locks.refresh(
      target.siteId,
      target.robotId,
      lock.holder,
      lock.token,
      nowSeconds + LOCK_IDLE_EXPIRY_MS / 1000,
      nowSeconds,
    );
  } catch (error) {
    deps.logger.warn("lock refresh failed", safeErrorFields(error));
  }
}
