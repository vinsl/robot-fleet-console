/**
 * Handling of one client frame: connection, session, rate, size, schema, then the frame's own rule.
 *
 * Every check runs before any side effect, and a refusal of a known connection is a server frame the client can
 * read, never an exception: a bad frame must not look like an infrastructure fault. A frame from a connection
 * that is unknown or whose session has ended gets no reply: the connection is closed, and nothing is said to a
 * caller that has no session. The frame is dispatched on the parsed discriminated union, never on raw fields.
 * Only infrastructure errors (DynamoDB, the management API that cannot be reached at all) propagate.
 */
import {
  SNAPSHOT_MAX_ROBOTS,
  WS_MAX_CLIENT_MESSAGE_BYTES,
  WsClientMessageSchema,
  type RobotLiveState,
  type SiteId,
  type WsClientMessage,
  type WsErrorCode,
  type WsServerMessage,
} from "@mfc/protocol";
import type { FleetStatePort, PushPort } from "../live/ports";
import type { Clock, DomainLogger } from "../ports";
import { safeErrorFields } from "../safe-error";
import { serialize } from "../realtime/messages";
import { handleHeartbeat, type HeartbeatDeps } from "./heartbeat";
import type { WsMetricsPort } from "./metrics";
import { sessionEnded, type ConnectionRecord } from "./session";
import type { WsSessionStore } from "./token";

/** A client frame as the transport delivers it. The body is untrusted and may be absent. */
export interface RawClientMessage {
  readonly body: string | null | undefined;
  readonly connectionId: string;
}

/** Dependencies of {@link handleClientMessage}. */
export interface ClientMessageDeps {
  readonly store: WsSessionStore;
  readonly fleet: FleetStatePort;
  readonly push: PushPort;
  readonly clock: Clock;
  readonly logger: DomainLogger;
  readonly metrics: WsMetricsPort;
  /** Dependencies of the heartbeat rule, which publishes for the verified lock holder only. */
  readonly heartbeat: HeartbeatDeps;
}

/**
 * Parses a client frame. Returns null on any failure: the input is never echoed, so the reason stays out of
 * the response and the logs.
 *
 * @param body - The text of the frame, already checked for size.
 * @returns The frame, or null when it is not valid JSON or does not match the protocol.
 */
function parseClientMessage(body: string): WsClientMessage | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return null;
  }
  const result = WsClientMessageSchema.safeParse(decoded);
  return result.success ? result.data : null;
}

/**
 * Sends one server frame. A connection that is gone is removed from the store, so the next fan-out does not
 * try it again. A failed push is counted and not retried: the client asks again if it needs the data.
 *
 * @param deps - The ports.
 * @param connectionId - The connection.
 * @param frame - The frame, validated before it is serialised.
 */
async function sendFrame(
  deps: ClientMessageDeps,
  connectionId: string,
  frame: WsServerMessage,
): Promise<void> {
  const result = await deps.push.post(connectionId, serialize(frame));
  if (result === "GONE") {
    await deps.store.remove(connectionId);
  } else if (result === "FAILED") {
    deps.metrics.count("WsPushFailed");
  }
}

/**
 * Refuses a frame: counts it, logs the rule by name only, and tells the client with an error frame.
 *
 * @param deps - The ports.
 * @param connectionId - The connection.
 * @param code - The rule that refused the frame.
 */
async function refuse(
  deps: ClientMessageDeps,
  connectionId: string,
  code: WsErrorCode,
): Promise<void> {
  deps.metrics.count("WsMessageRefused");
  deps.logger.warn("client message refused", { reason: code });
  await sendFrame(deps, connectionId, { type: "error", code });
}

/**
 * Splits a site's live states into snapshot frames. An empty site still gets one frame, so the client knows
 * the snapshot is complete.
 *
 * @param siteId - The site.
 * @param robots - The live states of the site.
 * @param sentAt - The instant the frames are sent.
 * @returns The frames, each within the protocol's robot bound.
 */
function snapshotFrames(
  siteId: SiteId,
  robots: readonly RobotLiveState[],
  sentAt: string,
): WsServerMessage[] {
  if (robots.length === 0) {
    return [{ type: "fleet.snapshot", siteId, sentAt, robots: [] }];
  }
  const frames: WsServerMessage[] = [];
  for (let offset = 0; offset < robots.length; offset += SNAPSHOT_MAX_ROBOTS) {
    frames.push({
      type: "fleet.snapshot",
      siteId,
      sentAt,
      robots: robots.slice(offset, offset + SNAPSHOT_MAX_ROBOTS),
    });
  }
  return frames;
}

/**
 * Handles `subscribe`: the connection's own site only, then the subscription, then a snapshot of the fleet.
 *
 * A connection that is already subscribed gets nothing: the snapshot is sent once per connection, so a repeated
 * subscribe cannot make the server send the whole fleet again. A listing that fails is answered with an error
 * frame; the subscription is kept, so the client reconnects for a fresh snapshot.
 *
 * @param deps - The ports.
 * @param connectionId - The connection.
 * @param connection - The stored connection, which fixes the one site it may watch.
 * @param siteId - The site the client asks for.
 */
async function subscribe(
  deps: ClientMessageDeps,
  connectionId: string,
  connection: ConnectionRecord,
  siteId: SiteId,
): Promise<void> {
  if (siteId !== connection.siteId) {
    await refuse(deps, connectionId, "FORBIDDEN_SITE");
    return;
  }
  if (connection.subscribed) {
    return;
  }
  const attached = await deps.store.subscribe(connectionId, siteId);
  if (!attached) {
    deps.metrics.count("WsConnectionUnknown");
    await deps.push.close(connectionId);
    return;
  }
  let robots: RobotLiveState[];
  try {
    robots = await deps.fleet.listSite(siteId);
  } catch (error) {
    deps.metrics.count("WsSnapshotFailed");
    deps.logger.error("snapshot failed", safeErrorFields(error));
    await sendFrame(deps, connectionId, { type: "error", code: "SNAPSHOT_FAILED" });
    return;
  }
  const sentAt = deps.clock.now().toISOString();
  for (const frame of snapshotFrames(siteId, robots, sentAt)) {
    await sendFrame(deps, connectionId, frame);
  }
  deps.metrics.count("WsSubscribed");
}

/**
 * Closes a connection that sent too many frames, and removes its record.
 *
 * @param deps - The ports.
 * @param connectionId - The connection.
 */
async function closeForRate(deps: ClientMessageDeps, connectionId: string): Promise<void> {
  deps.metrics.count("WsRateLimited");
  deps.logger.warn("client frame rate exceeded, connection closed");
  await deps.push.close(connectionId);
  await deps.store.remove(connectionId);
}

/**
 * Handles one client frame of an open connection.
 *
 * Steps, in order: the connection record, the session end, the frame rate, then size (2 KB), schema, and the
 * frame's rule. A frame for a connection that has no record, or whose session ended, gets no reply: the first is
 * closed, the second is closed and removed. A connection that exceeds the frame rate is closed and removed.
 *
 * @param raw - The frame and the connection it came from.
 * @param deps - The ports.
 * @returns Nothing: the outcome is the frames sent to the client.
 * @throws On infrastructure errors only (a store read or write, a listing).
 */
export async function handleClientMessage(
  raw: RawClientMessage,
  deps: ClientMessageDeps,
): Promise<void> {
  const { connectionId } = raw;
  const connection = await deps.store.getConnection(connectionId);
  if (connection === null) {
    deps.metrics.count("WsConnectionUnknown");
    await deps.push.close(connectionId);
    return;
  }
  const nowMs = deps.clock.now().getTime();
  if (sessionEnded(connection.sessionExpiresAtMs, nowMs)) {
    deps.metrics.count("WsSessionEnded");
    await deps.push.close(connectionId);
    await deps.store.remove(connectionId);
    return;
  }
  if (!(await deps.store.countFrame(connectionId, nowMs))) {
    await closeForRate(deps, connectionId);
    return;
  }

  if (
    typeof raw.body !== "string" ||
    Buffer.byteLength(raw.body, "utf8") > WS_MAX_CLIENT_MESSAGE_BYTES
  ) {
    await refuse(deps, connectionId, "INVALID_MESSAGE");
    return;
  }
  const message = parseClientMessage(raw.body);
  if (message === null) {
    await refuse(deps, connectionId, "INVALID_MESSAGE");
    return;
  }

  switch (message.type) {
    case "ping":
      return;
    case "subscribe":
      await subscribe(deps, connectionId, connection, message.siteId);
      return;
    case "heartbeat":
      // A Viewer cannot drive a robot, so the refusal is an error frame, as for any other rule. Every other refusal
      // of a heartbeat is silent (see handleHeartbeat).
      if (connection.role !== "Admin" && connection.role !== "Operator") {
        await refuse(deps, connectionId, "FORBIDDEN_ROLE");
        return;
      }
      await handleHeartbeat(deps.heartbeat, connection, message.robotId);
      return;
  }
}
