/**
 * A WebSocket connection as the cloud records it, and the rules that bound its life.
 *
 * A connection lives as long as its session: the session end comes from the token, which is bound to the
 * principal. API Gateway also closes every connection after two hours, so the stored time to live never exceeds
 * that cap: a record outlives its connection by one minute at most.
 */
import { RoleSchema, SiteIdSchema, UserSubSchema } from "@mfc/protocol";
import { z } from "zod";

/** Hard cap of a WebSocket connection set by API Gateway, in milliseconds. */
export const CONNECTION_MAX_LIFETIME_MS = 2 * 60 * 60 * 1000;

/** Seconds a connection record stays after its end, so that a late fan-out read still finds a clean state. */
export const CONNECTION_TTL_GRACE_SECONDS = 60;

/** Length of the window in which a connection's client frames are counted, in milliseconds. */
export const WS_FRAME_WINDOW_MS = 1000;

/**
 * Client frames a connection may send per window. Above it the connection is closed: a console sends a few
 * frames per minute, so the limit only stops a runaway client, never a person.
 */
export const WS_FRAME_LIMIT = 10;

/**
 * Shape of a connection identifier as API Gateway issues it. Checked at the handler boundary, because the
 * identifier becomes part of a storage key.
 */
export const ConnectionIdSchema = z.string().regex(/^[A-Za-z0-9_=-]{6,32}$/);

/** A connection record, as the domain reads and writes it. */
export const ConnectionRecordSchema = z.strictObject({
  connectionId: ConnectionIdSchema,
  sub: UserSubSchema,
  role: RoleSchema,
  siteId: SiteIdSchema,
  connectedAtMs: z.int().min(0),
  sessionExpiresAtMs: z.int().min(0),
  subscribed: z.boolean(),
});

/** A validated connection record. */
export type ConnectionRecord = z.infer<typeof ConnectionRecordSchema>;

/** The fields of a connection that the time to live depends on. */
export type ConnectionLifetime = Pick<ConnectionRecord, "connectedAtMs" | "sessionExpiresAtMs">;

/**
 * Tells whether a session has ended. A session that ends at exactly the current instant has ended.
 *
 * @param sessionExpiresAtMs - The end of the session, in epoch milliseconds.
 * @param nowMs - The current instant, in epoch milliseconds.
 * @returns True when the session is over.
 */
export function sessionEnded(sessionExpiresAtMs: number, nowMs: number): boolean {
  return sessionExpiresAtMs <= nowMs;
}

/**
 * Time-to-live attribute of a connection record: the earlier of the session end and the API Gateway cap,
 * in epoch seconds, plus a grace period.
 *
 * @param connection - The connection.
 * @returns The expiry instant in epoch seconds, as the table's TTL attribute expects it.
 */
export function connectionExpiresAtSeconds(connection: ConnectionLifetime): number {
  const endMs = Math.min(
    connection.sessionExpiresAtMs,
    connection.connectedAtMs + CONNECTION_MAX_LIFETIME_MS,
  );
  return Math.ceil(endMs / 1000) + CONNECTION_TTL_GRACE_SECONDS;
}
