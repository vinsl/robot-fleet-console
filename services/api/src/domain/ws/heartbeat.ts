/**
 * Handling of a console heartbeat: the verified holder of a live robot lock keeps the robot's deadman fed.
 *
 * The console sends a heartbeat several times a second while it holds the lock, and the cloud turns each valid one
 * into a `HEARTBEAT` command on the robot's topic. The lock store is read on every heartbeat, so a heartbeat from a
 * connection that is not the holder, or after the lock expired, publishes nothing (ADR 0063). The refusals are
 * silent on purpose: an error frame at this rate would flood the socket, and the console learns the lock state from
 * the `lock.changed` frames. Refusals and publish failures are counted on every occurrence, and logged at most once
 * per second, so a runaway console cannot fill the logs.
 *
 * The lock token is read from the store and put in the command only. It is never sent to the client and never logged.
 */
import { LOCK_IDLE_EXPIRY_MS, commandTopic, type LockToken, type RobotId } from "@mfc/protocol";
import { buildCommand } from "../control/build-command";
import { epochSecondsOf, isLive, shouldRefreshLock } from "../control/lock";
import type { CommandPublisherPort, LockStorePort } from "../control/ports";
import type { Clock, DomainLogger, Ids } from "../ports";
import { safeErrorFields } from "../safe-error";
import type { WsMetricsPort } from "./metrics";
import type { ConnectionRecord } from "./session";

/** Minimum time between two log entries of the heartbeat path, in milliseconds. */
export const HEARTBEAT_LOG_INTERVAL_MS = 1000;

/** Why a heartbeat was refused. Names only: the subject and the token are never part of a log entry. */
export type HeartbeatRefusalReason = "NO_LIVE_LOCK" | "NOT_HOLDER";

/**
 * Lets a log entry through at most once per interval. One throttle is built per cold start, so the state lives in the
 * function instance and never in a module, and a test builds its own instance.
 */
export class HeartbeatLogThrottle {
  private lastLoggedMs: number | undefined = undefined;

  /**
   * Tells whether a log entry may be written now, and records it when it may.
   *
   * @param nowMs - The current instant, in epoch milliseconds.
   * @returns True when the last entry is at least one interval old, or when there is none.
   */
  allow(nowMs: number): boolean {
    if (this.lastLoggedMs !== undefined && nowMs - this.lastLoggedMs < HEARTBEAT_LOG_INTERVAL_MS) {
      return false;
    }
    this.lastLoggedMs = nowMs;
    return true;
  }
}

/** Dependencies of {@link handleHeartbeat}. */
export interface HeartbeatDeps {
  /** Strongly consistent reads of the lock, and the conditional refresh. */
  readonly locks: LockStorePort;
  /** Publishes the `HEARTBEAT` command on the robot's topic. */
  readonly publisher: CommandPublisherPort;
  /** Source of the current instant. */
  readonly clock: Clock;
  /**
   * Source of identifiers. Each published heartbeat takes fresh `commandId`, `messageId` and `correlationId`
   * (decided for M9): a heartbeat is sent several times a second, and a reused identifier would look like a replay
   * to the robot.
   */
  readonly ids: Ids;
  /** Structured logger. Attributes carry the reason only. */
  readonly logger: DomainLogger;
  /** Counter sink of the WebSocket functions. */
  readonly metrics: WsMetricsPort;
  /** Log throttle shared by the refusal and publish-failure entries. */
  readonly logThrottle: Pick<HeartbeatLogThrottle, "allow">;
}

/**
 * Counts a refusal, and logs it when the throttle allows. The refusal stays silent for the client.
 *
 * @param deps - The dependencies.
 * @param reason - The rule that refused the heartbeat.
 */
function refuse(deps: HeartbeatDeps, reason: HeartbeatRefusalReason): void {
  deps.metrics.count("HeartbeatRefused");
  if (deps.logThrottle.allow(deps.clock.now().getTime())) {
    deps.logger.warn("heartbeat refused", { reason });
  }
}

/**
 * Handles one heartbeat of a connection whose role already passed the frame rules (Admin or Operator).
 *
 * Sequence: read the lock (strongly consistent); refuse silently when it is missing, expired or held by another
 * subject; build `HEARTBEAT` with the stored token and the connection's subject as `issuedBy`; publish once. A
 * publish failure is counted and logged, and never thrown: the console keeps sending, and the robot's deadman
 * stops the robot if no heartbeat arrives in time. When the lock is less than the refresh threshold from its expiry,
 * the expiry is moved forward; a refresh that fails is logged and ignored, because the next heartbeat tries again.
 *
 * @param deps - The dependencies.
 * @param connection - The stored connection. The site and the subject come from here, never from the frame.
 * @param robotId - The robot named by the frame, already validated by the protocol schema.
 * @returns Nothing: the outcome is the metric and the log entry.
 * @throws On a failed lock read: an infrastructure error, the caller answers with a failure.
 */
export async function handleHeartbeat(
  deps: HeartbeatDeps,
  connection: ConnectionRecord,
  robotId: RobotId,
): Promise<void> {
  const now = deps.clock.now();
  const nowSeconds = epochSecondsOf(now);
  const siteId = connection.siteId;

  const item = await deps.locks.get(siteId, robotId);
  if (item === null || !isLive(item, nowSeconds)) {
    refuse(deps, "NO_LIVE_LOCK");
    return;
  }
  if (item.holder !== connection.sub) {
    refuse(deps, "NOT_HOLDER");
    return;
  }

  const command = buildCommand({
    type: "HEARTBEAT",
    robotId,
    siteId,
    commandId: deps.ids.uuidv7(),
    correlationId: deps.ids.uuidv7(),
    messageId: deps.ids.uuidv7(),
    issuedBy: connection.sub,
    now,
    lockToken: item.token,
  });
  try {
    await deps.publisher.publish(commandTopic(siteId, robotId), JSON.stringify(command));
  } catch (error) {
    deps.metrics.count("HeartbeatPublishFailed");
    if (deps.logThrottle.allow(now.getTime())) {
      deps.logger.error("heartbeat publish failed", safeErrorFields(error));
    }
    return;
  }
  deps.metrics.count("HeartbeatPublished");

  if (shouldRefreshLock(item, nowSeconds)) {
    await refreshBestEffort(deps, connection, robotId, item.token, nowSeconds);
  }
}

/**
 * Moves the expiry of the lock forward. The store condition checks the holder, the token and the liveness again, so a
 * refresh that races a release changes nothing. A failure is logged, not thrown: the heartbeat itself succeeded.
 *
 * @param deps - The dependencies.
 * @param connection - The holder's connection.
 * @param robotId - The robot of the lock.
 * @param token - The token of the lock the heartbeat published with.
 * @param nowSeconds - The current instant in epoch seconds.
 */
async function refreshBestEffort(
  deps: HeartbeatDeps,
  connection: ConnectionRecord,
  robotId: RobotId,
  token: LockToken,
  nowSeconds: number,
): Promise<void> {
  try {
    await deps.locks.refresh(
      connection.siteId,
      robotId,
      connection.sub,
      token,
      nowSeconds + LOCK_IDLE_EXPIRY_MS / 1000,
      nowSeconds,
    );
  } catch (error) {
    if (deps.logThrottle.allow(deps.clock.now().getTime())) {
      deps.logger.error("heartbeat lock refresh failed", safeErrorFields(error));
    }
  }
}
