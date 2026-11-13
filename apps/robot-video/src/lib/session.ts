/**
 * The session the page runs with, and the rules that decide when it must be renewed.
 *
 * A session is the robot's channel and its temporary credentials. The page refreshes the credentials
 * well before they expire, so a run never stops for a lapse the agent could have prevented.
 */
import type { VideoSession } from "@mfc/protocol";
import type { VideoRegion } from "./regions";

/** The page asks the agent for fresh credentials when less than this much validity is left. */
export const REFRESH_BEFORE_EXPIRY_MS = 15 * 60_000;

/** Temporary credentials kept in page memory. */
export interface RunCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  /** Instant after which AWS stops accepting these credentials. */
  readonly expiration: Date;
}

/** A validated session in the form the page uses: dates are `Date` objects. */
export interface RunSession {
  readonly robotId: string;
  readonly region: VideoRegion;
  readonly channelName: string;
  /** Full channel ARN, handed to the AWS SDK only. It is never rendered. */
  readonly channelArn: string;
  readonly credentials: RunCredentials;
}

/**
 * Converts a validated protocol session into the page's form.
 *
 * @param session - The session received from the agent, already checked by the protocol schema.
 * @returns The same session with the expiration as a `Date`.
 */
export function toRunSession(session: VideoSession): RunSession {
  return {
    robotId: session.robotId,
    region: session.region,
    channelName: session.channelName,
    channelArn: session.channelArn,
    credentials: {
      accessKeyId: session.credentials.accessKeyId,
      secretAccessKey: session.credentials.secretAccessKey,
      sessionToken: session.credentials.sessionToken,
      expiration: new Date(session.credentials.expiration),
    },
  };
}

/**
 * Tells whether the credentials of a session must be renewed now.
 *
 * @param session - The session in use.
 * @param now - The current instant, injected for the tests.
 * @returns True when less than {@link REFRESH_BEFORE_EXPIRY_MS} of validity is left.
 */
export function needsRefresh(session: RunSession, now: Date): boolean {
  return session.credentials.expiration.getTime() - now.getTime() < REFRESH_BEFORE_EXPIRY_MS;
}

/**
 * Tells whether the credentials of a session have lapsed.
 *
 * @param session - The session in use.
 * @param now - The current instant, injected for the tests.
 * @returns True once the expiration instant is reached.
 */
export function isExpired(session: RunSession, now: Date): boolean {
  return session.credentials.expiration.getTime() - now.getTime() <= 0;
}

/**
 * Keeps the session with the later expiration, so that a late or stale refresh never shortens the
 * credentials the page is using.
 *
 * @param current - The session in use.
 * @param next - The session just received from the agent.
 * @returns `next` when it expires later than `current`, else `current`.
 */
export function pickFresherSession(current: RunSession, next: RunSession): RunSession {
  return next.credentials.expiration.getTime() > current.credentials.expiration.getTime()
    ? next
    : current;
}
