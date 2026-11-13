/**
 * Use cases of the robot lock: read the state, take control, release control.
 *
 * The cloud mints the lock token and keeps it (ADR 0062). The browser proves it is the holder by its verified
 * identity, never by a secret it could leak, and the token is injected into the commands the cloud publishes after
 * that check. No response, log record or metric carries the token.
 */
import {
  LOCK_IDLE_EXPIRY_MS,
  LOCK_REFRESH_MIN_INTERVAL_SECONDS,
  LockTokenSchema,
  commandTopic,
  type LockActionResponse,
  type LockRequest,
  type LockState,
  type LockToken,
  type RobotId,
  type SiteId,
  type UserSub,
} from "@mfc/protocol";
import type { Principal } from "../authz";
import { safeErrorFields } from "../safe-error";
import { refuse, succeed, type UseCaseProblem, type UseCaseResult } from "../result";
import { writeControlAudit } from "./audit";
import { abandonClaim, claimExpiry, isSameRequest } from "./claim";
import { buildCommand } from "./build-command";
import { CONTROL_PROBLEMS } from "./problems";
import type { ControlCall, ControlDeps, LockChangeCause, LockItem, RandomBytes } from "./ports";

/** Idle time after which a lock expires, in seconds. The robot expires its own copy after the same time. */
const LOCK_IDLE_EXPIRY_SECONDS = LOCK_IDLE_EXPIRY_MS / 1000;

/**
 * Remaining time below which a lock-holding command moves the expiry. The expiry was last moved at most
 * {@link LOCK_REFRESH_MIN_INTERVAL_SECONDS} ago, so the store is written at most that often, not at heartbeat rate.
 */
const LOCK_REFRESH_THRESHOLD_SECONDS = LOCK_IDLE_EXPIRY_SECONDS - LOCK_REFRESH_MIN_INTERVAL_SECONDS;

/** Bytes of entropy of a lock token: 32 bytes encode to 43 base64url characters. */
const LOCK_TOKEN_BYTES = 32;

/** The robot and site a lock request names. Both come from validated path parameters. */
export interface LockTarget {
  /** Site of the robot, the verified site of the caller. */
  readonly siteId: SiteId;
  /** Robot whose lock is read or changed. */
  readonly robotId: RobotId;
}

/**
 * Epoch seconds of an instant, rounded down. The lock expiry is stored in seconds, the table TTL attribute's unit.
 *
 * @param date - The instant.
 * @returns The whole number of seconds since the epoch.
 */
export function epochSecondsOf(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Tells whether a lock item is live at an instant. The TTL of the table deletes expired items with a delay of up to
 * 48 hours, so the expiry is checked explicitly everywhere.
 *
 * @param item - The stored lock.
 * @param nowSeconds - The current instant in epoch seconds.
 * @returns True while the expiry is in the future.
 */
export function isLive(item: LockItem, nowSeconds: number): boolean {
  return item.expiresAt > nowSeconds;
}

/**
 * Tells whether a lock-holding command should move the expiry of the lock. The write is rate limited by this
 * threshold, so a console sending commands does not write the lock item on every command.
 *
 * @param item - The stored lock the caller holds.
 * @param nowSeconds - The current instant in epoch seconds.
 * @returns True when less than the refresh threshold remains.
 */
export function shouldRefreshLock(item: LockItem, nowSeconds: number): boolean {
  return item.expiresAt - nowSeconds < LOCK_REFRESH_THRESHOLD_SECONDS;
}

/**
 * The lock as the caller may see it. An absent or expired item reads as free. The token is never part of the result.
 *
 * @param robotId - The robot the state is about.
 * @param item - The stored lock, or null.
 * @param userId - The subject of the caller.
 * @param nowSeconds - The current instant in epoch seconds.
 * @returns The lock state, with `mine` computed from the caller.
 */
export function lockStateOf(
  robotId: RobotId,
  item: LockItem | null,
  userId: UserSub,
  nowSeconds: number,
): LockState {
  if (item === null || !isLive(item, nowSeconds)) {
    return { robotId, held: false, mine: false };
  }
  return {
    robotId,
    held: true,
    holder: item.holder,
    mine: item.holder === userId,
    expiresAt: new Date(item.expiresAt * 1000).toISOString(),
  };
}

/**
 * Mints a lock token from the injected random source. The token is what the robot compares with the holder subject.
 *
 * @param randomBytes - Source of random bytes; the production source is the Node crypto generator.
 * @returns A 43-character base64url token that satisfies {@link LockTokenSchema}.
 */
export function newLockToken(randomBytes: RandomBytes): LockToken {
  const bytes = randomBytes(LOCK_TOKEN_BYTES);
  return LockTokenSchema.parse(Buffer.from(bytes).toString("base64url"));
}

/**
 * Reads the lock state of a robot as the caller may see it.
 *
 * @param deps - The lock store and clock.
 * @param principal - The verified caller.
 * @param target - The robot.
 * @returns The lock state. Never a refusal: an absent lock reads as free.
 */
export async function getLock(
  deps: Pick<ControlDeps, "locks" | "clock">,
  principal: Principal,
  target: LockTarget,
): Promise<UseCaseResult<LockState>> {
  const nowSeconds = epochSecondsOf(deps.clock.now());
  const item = await deps.locks.get(target.siteId, target.robotId);
  return succeed(lockStateOf(target.robotId, item, principal.userId, nowSeconds));
}

/**
 * Takes control of a robot: writes the lock (conditional), publishes `TAKE_CONTROL` with the token, relays the
 * change and audits it. A repeated request with the same identifier publishes nothing and answers `changed: false`.
 *
 * Known windows, accepted on purpose (availability only, never a second holder):
 * - Two tabs of the same holder that both see the lock absent can each mint a token. The second write replaces the
 *   first, and the robot keeps the token of the last `TAKE_CONTROL` it received. The first tab's commands are then
 *   refused until its next take repairs the token.
 * - A claim written and then lost before the write or the publish (a crash, or an abandon that failed) answers a
 *   retry with the same identifier as `changed: false`, with the lock as it is in the store. Nothing is published
 *   for that retry, so the console mints a new identifier for each attempt.
 *
 * @param deps - The control dependencies.
 * @param principal - The verified caller.
 * @param target - The robot.
 * @param request - The validated body: the client identifier of the request.
 * @param call - The verified caller's correlation identifier and the time left.
 * @returns The lock state after the request, or the refusal.
 */
export async function acquireLock(
  deps: ControlDeps,
  principal: Principal,
  target: LockTarget,
  request: LockRequest,
  call: ControlCall,
): Promise<UseCaseResult<LockActionResponse>> {
  const { siteId, robotId } = target;
  const actor = principal.userId;
  const nowDate = deps.clock.now();
  const nowSeconds = epochSecondsOf(nowDate);
  const refusal = (problem: UseCaseProblem): Promise<UseCaseResult<LockActionResponse>> =>
    refuseLock(deps, { siteId, robotId, actor, action: "lock.acquire", call }, problem);

  const robot = await deps.robots.get(siteId, robotId);
  if (robot === null) {
    return refusal(CONTROL_PROBLEMS.robotNotFound);
  }
  if (robot.status !== "ACTIVE") {
    return refusal(CONTROL_PROBLEMS.robotRetired);
  }

  const existing = await deps.locks.get(siteId, robotId);
  // A live lock of another holder is a refusal; the item of an expired one is replaced below.
  const live: LockItem | null = existing !== null && isLive(existing, nowSeconds) ? existing : null;
  if (live !== null && live.holder !== actor) {
    return refusal(CONTROL_PROBLEMS.lockHeld);
  }

  // The claim comes after the holder check and before the write, so a replay answers from the claim and never
  // takes the lock again after a release.
  const claimed = await deps.claims.claim(
    siteId,
    {
      commandId: request.commandId,
      robotId,
      type: "TAKE_CONTROL",
      actor,
      correlationId: call.correlationId,
      issuedAt: nowDate.toISOString(),
    },
    claimExpiry(nowSeconds),
  );
  if (claimed.kind === "EXISTS") {
    if (isSameRequest(claimed.claim, { actor, robotId, type: "TAKE_CONTROL" })) {
      return succeed({
        commandId: request.commandId,
        correlationId: claimed.claim.correlationId,
        changed: false,
        lock: lockStateOf(robotId, live, actor, nowSeconds),
      });
    }
    return refusal(CONTROL_PROBLEMS.commandConflict);
  }

  // An own live lock keeps its token, so a second console tab does not invalidate the first one's holder copy.
  const token = live === null ? newLockToken(deps.randomBytes) : live.token;
  const next: LockItem = {
    robotId,
    holder: actor,
    token,
    acquiredAt: live === null ? nowDate.toISOString() : live.acquiredAt,
    expiresAt: nowSeconds + LOCK_IDLE_EXPIRY_SECONDS,
  };
  const outcome = await deps.locks.acquire(siteId, next, nowSeconds);
  if (outcome === "HELD") {
    await abandonClaim(deps, siteId, request.commandId);
    return refusal(CONTROL_PROBLEMS.lockHeld);
  }

  const command = buildCommand({
    type: "TAKE_CONTROL",
    robotId,
    siteId,
    commandId: request.commandId,
    correlationId: call.correlationId,
    messageId: deps.ids.uuidv7(),
    issuedBy: actor,
    now: nowDate,
    lockToken: token,
  });
  try {
    await deps.publisher.publish(commandTopic(siteId, robotId), JSON.stringify(command));
  } catch (error) {
    deps.logger.error("take control publish failed", safeErrorFields(error));
    deps.metrics.count("CommandPublishFailed");
    await abandonClaim(deps, siteId, request.commandId);
    // Only a lock this call created is removed. A refreshed own lock stays, because the robot still holds its copy.
    if (outcome === "ACQUIRED") {
      await deps.locks.release(siteId, robotId, actor, token);
    }
    await writeControlAudit(deps, {
      siteId,
      robotId,
      actor,
      action: "lock.acquire",
      result: "FAILED",
      problemType: CONTROL_PROBLEMS.publishFailed.type,
      correlationId: call.correlationId,
    });
    return refuse(CONTROL_PROBLEMS.publishFailed);
  }

  const cause: LockChangeCause =
    existing !== null && existing.holder !== actor ? "TAKEOVER" : "ACQUIRED";
  deps.metrics.count("LockAcquired");
  await deps.relay.lockChanged(siteId, robotId, true, actor, cause);
  await writeControlAudit(deps, {
    siteId,
    robotId,
    actor,
    action: "lock.acquire",
    result: "SUCCEEDED",
    correlationId: call.correlationId,
  });
  return succeed({
    commandId: request.commandId,
    correlationId: call.correlationId,
    changed: outcome === "ACQUIRED",
    lock: lockStateOf(robotId, next, actor, nowSeconds),
  });
}

/**
 * Releases control of a robot: publishes `RELEASE_CONTROL` with the token, deletes the lock (conditional), relays the
 * change and audits it. A failed publish keeps the lock, so the operator can retry; the robot expires its own copy
 * after the idle expiry in any case.
 *
 * Once the publish has gone out the robot has released, whatever happens to the store. A lost conditional delete (the
 * holder or the token changed meanwhile) answers `409 lock-not-held`, although the robot did release: the audit then
 * says `REFUSED` for an action the robot performed. A delete that throws is logged by its error name and answered as a
 * success, since the robot has released; the item then expires on its own schedule.
 *
 * @param deps - The control dependencies.
 * @param principal - The verified caller.
 * @param target - The robot.
 * @param request - The validated body: the client identifier of the request.
 * @param call - The verified caller's correlation identifier and the time left.
 * @returns The lock state after the request, or the refusal.
 */
export async function releaseLock(
  deps: ControlDeps,
  principal: Principal,
  target: LockTarget,
  request: LockRequest,
  call: ControlCall,
): Promise<UseCaseResult<LockActionResponse>> {
  const { siteId, robotId } = target;
  const actor = principal.userId;
  const nowDate = deps.clock.now();
  const nowSeconds = epochSecondsOf(nowDate);
  const refusal = (problem: UseCaseProblem): Promise<UseCaseResult<LockActionResponse>> =>
    refuseLock(deps, { siteId, robotId, actor, action: "lock.release", call }, problem);

  const existing = await deps.locks.get(siteId, robotId);
  if (existing === null || !isLive(existing, nowSeconds)) {
    return succeed({
      commandId: request.commandId,
      correlationId: call.correlationId,
      changed: false,
      lock: lockStateOf(robotId, null, actor, nowSeconds),
    });
  }
  if (existing.holder !== actor) {
    return refusal(CONTROL_PROBLEMS.lockHeld);
  }

  const claimed = await deps.claims.claim(
    siteId,
    {
      commandId: request.commandId,
      robotId,
      type: "RELEASE_CONTROL",
      actor,
      correlationId: call.correlationId,
      issuedAt: nowDate.toISOString(),
    },
    claimExpiry(nowSeconds),
  );
  if (claimed.kind === "EXISTS") {
    if (isSameRequest(claimed.claim, { actor, robotId, type: "RELEASE_CONTROL" })) {
      return succeed({
        commandId: request.commandId,
        correlationId: claimed.claim.correlationId,
        changed: false,
        lock: lockStateOf(robotId, existing, actor, nowSeconds),
      });
    }
    return refusal(CONTROL_PROBLEMS.commandConflict);
  }

  const command = buildCommand({
    type: "RELEASE_CONTROL",
    robotId,
    siteId,
    commandId: request.commandId,
    correlationId: call.correlationId,
    messageId: deps.ids.uuidv7(),
    issuedBy: actor,
    now: nowDate,
    lockToken: existing.token,
  });
  try {
    await deps.publisher.publish(commandTopic(siteId, robotId), JSON.stringify(command));
  } catch (error) {
    deps.logger.error("release control publish failed", safeErrorFields(error));
    deps.metrics.count("CommandPublishFailed");
    await abandonClaim(deps, siteId, request.commandId);
    await writeControlAudit(deps, {
      siteId,
      robotId,
      actor,
      action: "lock.release",
      result: "FAILED",
      problemType: CONTROL_PROBLEMS.publishFailed.type,
      correlationId: call.correlationId,
    });
    return refuse(CONTROL_PROBLEMS.publishFailed);
  }

  let released: boolean;
  try {
    released = await deps.locks.release(siteId, robotId, actor, existing.token);
  } catch (error) {
    // The robot is already released: a store error here must not turn the release into a failure.
    deps.logger.error("lock delete failed after the release publish", safeErrorFields(error));
    released = true;
  }
  if (!released) {
    return refusal(CONTROL_PROBLEMS.lockNotHeld);
  }
  deps.metrics.count("LockReleased");
  await deps.relay.lockChanged(siteId, robotId, false, undefined, "RELEASED");
  await writeControlAudit(deps, {
    siteId,
    robotId,
    actor,
    action: "lock.release",
    result: "SUCCEEDED",
    correlationId: call.correlationId,
  });
  return succeed({
    commandId: request.commandId,
    correlationId: call.correlationId,
    changed: true,
    lock: lockStateOf(robotId, null, actor, nowSeconds),
  });
}

/** What a refused lock request writes to the audit trail. */
interface LockRefusalFacts {
  readonly siteId: SiteId;
  readonly robotId: RobotId;
  readonly actor: UserSub;
  readonly action: "lock.acquire" | "lock.release";
  readonly call: ControlCall;
}

/**
 * Counts and audits a refused lock request, then returns the refusal. The audit is best effort and never delays the
 * answer.
 *
 * @param deps - The control dependencies.
 * @param facts - The request facts to audit.
 * @param problem - The refusal.
 * @returns The refused outcome.
 */
async function refuseLock(
  deps: ControlDeps,
  facts: LockRefusalFacts,
  problem: UseCaseProblem,
): Promise<UseCaseResult<LockActionResponse>> {
  deps.metrics.count("LockRefused");
  await writeControlAudit(deps, {
    siteId: facts.siteId,
    robotId: facts.robotId,
    actor: facts.actor,
    action: facts.action,
    result: "REFUSED",
    problemType: problem.type,
    correlationId: facts.call.correlationId,
  });
  return refuse(problem);
}
