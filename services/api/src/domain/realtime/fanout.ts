/**
 * Fan-out of server frames to the WebSocket connections subscribed to a site.
 *
 * Two delivery modes exist. A `droppable` frame (a fleet delta) is never retried: the next sample replaces
 * it. A `reliable` frame (an alert, an acknowledgement, a presence change) is retried once after a short
 * delay. A connection that is gone is removed from the store; a connection whose session has ended is closed
 * and removed, a bounded number per call so that one invocation cannot close a whole site.
 *
 * The frames of one connection are sent one after the other, so a client receives them in order; the
 * connections themselves are served in parallel, up to a bounded number of pushes in flight. Closing expired
 * sessions runs alongside the pushes, so a slow close never delays a delta.
 *
 * The fan-out never throws on a push failure. It throws only when the connections cannot be listed, and the
 * caller counts that and carries on.
 */
import type { Role, SiteId, WsServerMessage } from "@mfc/protocol";
import type { ConnectionRef, ConnectionsPort, PushPort, PushResult } from "../live/ports";
import type { Clock, DomainLogger } from "../ports";
import { safeErrorFields } from "../safe-error";
import { serialize } from "./messages";

/** Default number of pushes in flight at once. */
const DEFAULT_CONCURRENCY = 10;

/** Default number of sessions closed per call. The rest are skipped and left to their TTL. */
const DEFAULT_MAX_CLOSES_PER_CALL = 5;

/** Delay before the one retry of a reliable frame, in milliseconds. */
const RELIABLE_RETRY_DELAY_MS = 200;

/** How a frame is delivered: retried once when it fails (`reliable`), or never (`droppable`). */
export type DeliveryMode = "droppable" | "reliable";

/** Ports and settings of one fan-out. */
export interface FanOutDeps {
  readonly connections: ConnectionsPort;
  readonly push: PushPort;
  readonly clock: Clock;
  readonly logger: DomainLogger;
  /** Pushes in flight at once. */
  readonly concurrency?: number | undefined;
  /** Sessions closed per call. */
  readonly maxClosesPerCall?: number | undefined;
}

/** Counts of one fan-out. */
export interface FanOutResult {
  /** Connections the frames were sent to, after the audience filter. */
  readonly recipients: number;
  /** Pushes that were delivered. */
  readonly sent: number;
  /** Pushes to connections that no longer exist. */
  readonly gone: number;
  /** Pushes that failed after any retry. */
  readonly failed: number;
  /** Sessions whose expiry has passed. */
  readonly expired: number;
  /** `true` when the connection listing stopped before the end. */
  readonly truncated: boolean;
}

/** One push: a connection and the frame to send to it. */
interface PushTask {
  readonly connectionId: string;
  readonly data: string;
}

/** The frames of one connection, in the order they are sent. */
interface ConnectionPushes {
  readonly connectionId: string;
  readonly frames: readonly string[];
}

/**
 * Waits for a delay.
 *
 * @param ms - The delay, in milliseconds.
 * @returns A promise that resolves after the delay.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Pushes one frame, turning an unexpected throw into a failure. The port is specified not to throw; this
 * keeps a faulty adapter from failing the whole fan-out.
 *
 * @param push - The push port.
 * @param task - The push to make.
 * @returns The outcome.
 */
async function safePost(push: PushPort, task: PushTask): Promise<PushResult> {
  try {
    return await push.post(task.connectionId, task.data);
  } catch {
    return "FAILED";
  }
}

/**
 * Runs `work` over `items` with at most `size` calls in flight.
 *
 * @param items - The items to process.
 * @param size - The number of workers.
 * @param work - The work for one item.
 */
async function runPool<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  // One shared iterator: each worker takes the next item when it is free.
  const iterator = items.values();
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (const item of iterator) {
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * Removes a connection record, logging a failure by name only.
 *
 * @param connections - The connection store.
 * @param logger - The logger.
 * @param connectionId - The connection to remove.
 */
async function removeQuietly(
  connections: ConnectionsPort,
  logger: DomainLogger,
  connectionId: string,
): Promise<void> {
  try {
    await connections.remove(connectionId);
  } catch (error) {
    logger.warn("connection record removal failed", safeErrorFields(error));
  }
}

/**
 * Closes the sessions whose expiry has passed, up to the call's bound, and removes their records.
 *
 * @param expired - Connections past their session expiry.
 * @param deps - The fan-out ports and settings.
 */
async function closeExpired(expired: readonly ConnectionRef[], deps: FanOutDeps): Promise<void> {
  const bound = deps.maxClosesPerCall ?? DEFAULT_MAX_CLOSES_PER_CALL;
  for (const connection of expired.slice(0, bound)) {
    await deps.push.close(connection.connectionId);
    await removeQuietly(deps.connections, deps.logger, connection.connectionId);
  }
}

/**
 * Sends the frames to each connection, the frames of one connection in order, and tallies the outcomes.
 *
 * @param targets - The frames of each connection.
 * @param mode - The delivery mode of the frames.
 * @param deps - The fan-out ports and settings.
 * @returns The counts, and the connections that reported themselves gone.
 */
async function pushAll(
  targets: readonly ConnectionPushes[],
  mode: DeliveryMode,
  deps: FanOutDeps,
): Promise<{ sent: number; gone: number; failed: number; goneConnections: Set<string> }> {
  const tally = { sent: 0, failed: 0, gone: 0, goneConnections: new Set<string>() };
  await runPool(targets, deps.concurrency ?? DEFAULT_CONCURRENCY, async (target) => {
    for (const data of target.frames) {
      const task: PushTask = { connectionId: target.connectionId, data };
      let outcome = await safePost(deps.push, task);
      if (outcome === "FAILED" && mode === "reliable") {
        await delay(RELIABLE_RETRY_DELAY_MS);
        outcome = await safePost(deps.push, task);
      }
      if (outcome === "SENT") {
        tally.sent += 1;
      } else if (outcome === "GONE") {
        tally.gone += 1;
        tally.goneConnections.add(task.connectionId);
      } else {
        tally.failed += 1;
      }
    }
  });
  return tally;
}

/**
 * Sends server frames to the connections subscribed to a site.
 *
 * Frames are validated and serialised once each, before any push. A connection never receives frames of
 * another site: the listing is keyed by the site. When an audience is given, only connections whose role is
 * in it receive the frames; the others are still counted for expiry, so a session end is never skipped.
 *
 * @param siteId - The site the frames belong to.
 * @param messages - The frames to send, in order.
 * @param mode - `droppable` for fleet deltas, `reliable` for the other frames.
 * @param deps - The ports and settings.
 * @param audience - The roles that receive the frames. Absent: every subscribed connection receives them.
 * @returns The counts of the fan-out.
 * @throws {Error} When the connections cannot be listed, or a frame fails validation (programming error).
 */
export async function fanOut(
  siteId: SiteId,
  messages: readonly WsServerMessage[],
  mode: DeliveryMode,
  deps: FanOutDeps,
  audience?: readonly Role[],
): Promise<FanOutResult> {
  const listed = await deps.connections.listSubscribed(siteId);
  if (listed.truncated) {
    deps.logger.warn("fan-out listing truncated", { siteId });
  }
  const nowMs = deps.clock.now().getTime();
  const expiredConnections = listed.connections.filter(
    (connection) => connection.sessionExpiresAtMs <= nowMs,
  );
  const live = listed.connections.filter(
    (connection) =>
      connection.sessionExpiresAtMs > nowMs &&
      (audience === undefined || audience.includes(connection.role)),
  );
  // Closing runs next to the pushes, so a slow close never delays a delta. Sessions beyond the close bound
  // are only skipped; their record expires by TTL.
  const serialised = messages.map((message) => serialize(message));
  const targets: ConnectionPushes[] = live.map((connection) => ({
    connectionId: connection.connectionId,
    frames: serialised,
  }));
  const [tally] = await Promise.all([
    pushAll(targets, mode, deps),
    closeExpired(expiredConnections, deps),
  ]);
  for (const connectionId of tally.goneConnections) {
    await removeQuietly(deps.connections, deps.logger, connectionId);
  }
  return {
    recipients: live.length,
    sent: tally.sent,
    gone: tally.gone,
    failed: tally.failed,
    expired: expiredConnections.length,
    truncated: listed.truncated,
  };
}
