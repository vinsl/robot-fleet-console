/**
 * Identifier schemas shared by the console, the API and the robot agent.
 *
 * Identifiers are used in MQTT topics, IoT thing names and URL path segments, so the grammar is kept
 * to lowercase letters, digits and hyphens. This rules out path traversal, topic wildcards and
 * case-only duplicates by construction. Free-text identifiers (user subjects, correlation ids) use
 * the narrowest alphabet their producers emit, for the same reason.
 */
import { z } from "zod";
import { THING_NAME_PREFIX } from "./constants";

/** Robot identifier: 3 to 32 characters of `a-z`, `0-9` and `-`. */
export const RobotIdSchema = z.string().regex(/^[a-z0-9-]{3,32}$/);

/** Site identifier: same grammar as robot identifiers. */
export const SiteIdSchema = z.string().regex(/^[a-z0-9-]{3,32}$/);

/** A validated robot identifier. */
export type RobotId = z.infer<typeof RobotIdSchema>;

/** A validated site identifier. */
export type SiteId = z.infer<typeof SiteIdSchema>;

/**
 * Site of the demo. The demo runs one site (FR-SITE-1), so the HTTP API assigns this identifier to every
 * principal instead of reading a per-user attribute. It must equal the site id the robots publish under
 * (`paris-01`): the fan-out and the telemetry store key their data by site id, so a console on another site
 * receives no frame. Multi-site support replaces this constant, not the callers.
 */
export const DEMO_SITE_ID: SiteId = "paris-01";

/**
 * IoT thing name of a robot: the thing prefix followed by the robot identifier.
 *
 * The thing name is the MQTT client id and the KVS channel name, so the IoT policy can bind the
 * connection to exactly one robot by its name.
 */
export const ThingNameSchema = z.string().regex(/^mfc-demo-[a-z0-9-]{3,32}$/);

/** A validated IoT thing name. */
export type ThingName = z.infer<typeof ThingNameSchema>;

/**
 * Builds the IoT thing name of a robot.
 *
 * @param robotId - A robot identifier, validated against {@link RobotIdSchema}.
 * @returns The thing name, `mfc-demo-<robotId>`.
 * @throws TypeError If `robotId` is not a valid robot identifier.
 */
export function thingName(robotId: RobotId): ThingName {
  if (!RobotIdSchema.safeParse(robotId).success) {
    throw new TypeError("invalid robot id");
  }
  return `${THING_NAME_PREFIX}${robotId}`;
}

/**
 * Recovers the robot identifier from an IoT thing name.
 *
 * Returns `null` rather than throwing because the input comes from the broker, which is untrusted.
 *
 * @param name - A candidate thing name.
 * @returns The robot identifier, or `null` if the name does not follow the thing grammar.
 */
export function robotIdFromThingName(name: string): RobotId | null {
  // The thing grammar already fixes the robot part to the robot identifier grammar, so checking the
  // thing name alone is enough.
  const parsed = ThingNameSchema.safeParse(name);
  return parsed.success ? parsed.data.slice(THING_NAME_PREFIX.length) : null;
}

/**
 * Lock token handed to the console that holds a robot lock. The robot compares it in constant time.
 * Base64url-like alphabet, 16 to 128 characters: long enough to be unguessable, short enough for MQTT.
 */
export const LockTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

/** A validated lock token. */
export type LockToken = z.infer<typeof LockTokenSchema>;

/** Cognito user subject (`sub`): UUID characters only, bounded so that a hostile claim cannot bloat logs. */
export const UserSubSchema = z.string().regex(/^[A-Za-z0-9-]{1,128}$/);

/** A validated user subject. */
export type UserSub = z.infer<typeof UserSubSchema>;

/** Correlation identifier that follows a request from the console through the cloud to the robot and back. */
export const CorrelationIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

/** A validated correlation identifier. */
export type CorrelationId = z.infer<typeof CorrelationIdSchema>;

/**
 * Identity of the person or the job that invoked an admin action, as declared by the caller.
 *
 * No `@`: the actor is written to the audit trail and to the logs, and an e-mail address is personal data.
 */
export const ActorSchema = z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/);

/** A validated actor identity. */
export type Actor = z.infer<typeof ActorSchema>;

/** Mission identifier reported in telemetry: lowercase slug, 1 to 64 characters. */
export const MissionIdSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

/** A validated mission identifier. */
export type MissionId = z.infer<typeof MissionIdSchema>;
