/**
 * HTTP contract of the control plane: commands, the robot lock, the robot list and the demo mode.
 *
 * Every schema is strict. The browser sends a command identifier it minted, never a lock token: the cloud
 * keeps the token and injects it into the commands it publishes (ADR 0062). A lock state names the holder
 * and whether that holder is the caller, and never carries the token.
 */
import { z } from "zod";
import { SimulateFaultParamsSchema } from "./commands";
import { CorrelationIdSchema, RobotIdSchema, UserSubSchema } from "./ids";
import { RobotSummarySchema } from "./robots";
import { IsoMsSchema } from "./time";
import { Uuidv7Schema } from "./uuidv7";

/** Retention of a command claim. Longer than the 15 minute access token, so a captured request cannot publish twice. */
export const COMMAND_IDEMPOTENCY_TTL_SECONDS = 3600;

/** Time after which the console shows "No answer" for a command that has not been acknowledged. */
export const COMMAND_ACK_TIMEOUT_MS = 5000;

/** The cloud refreshes a lock item at most this often, so heartbeats do not write at 4 Hz. */
export const LOCK_REFRESH_MIN_INTERVAL_SECONDS = 10;

/** Delay before the console retries an acquire refused with `NOT_LOCK_HOLDER`. */
export const LOCK_RETRY_DELAY_MS = 1000;

/** Idle time after which the console releases the lock it holds (FR-AUTH-4). */
export const CONSOLE_IDLE_RELEASE_MS = 30 * 60 * 1000;

/** Largest number of robots one registry list response carries. */
const ROBOT_LIST_MAX = 100;

/**
 * Commands the console sends through the commands route. `TAKE_CONTROL` and `RELEASE_CONTROL` go through
 * the lock routes and `HEARTBEAT` through the WebSocket, so none of them is a member here.
 */
export const ControlledCommandTypeSchema = z.enum([
  "PAUSE",
  "RESUME",
  "RETURN_TO_BASE",
  "ESTOP",
  "ESTOP_RELEASE",
  "SIMULATE_FAULT",
]);

/** A validated controlled command type. */
export type ControlledCommandType = z.infer<typeof ControlledCommandTypeSchema>;

/**
 * Body of `POST /sites/{siteId}/robots/{robotId}/commands`, discriminated on `type`. Only `SIMULATE_FAULT`
 * carries parameters, so a parameter on any other command is an unknown key and is refused.
 */
export const CommandRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({ commandId: Uuidv7Schema, type: z.literal("PAUSE") }),
  z.strictObject({ commandId: Uuidv7Schema, type: z.literal("RESUME") }),
  z.strictObject({ commandId: Uuidv7Schema, type: z.literal("RETURN_TO_BASE") }),
  z.strictObject({ commandId: Uuidv7Schema, type: z.literal("ESTOP") }),
  z.strictObject({ commandId: Uuidv7Schema, type: z.literal("ESTOP_RELEASE") }),
  z.strictObject({
    commandId: Uuidv7Schema,
    type: z.literal("SIMULATE_FAULT"),
    params: SimulateFaultParamsSchema,
  }),
]);

/** A validated command request. */
export type CommandRequest = z.infer<typeof CommandRequestSchema>;

/**
 * Answer to an accepted command. `deduplicated` is true when the same command was already accepted, in
 * which case nothing was published again and the stored identifiers are returned.
 */
export const CommandResponseSchema = z.strictObject({
  commandId: Uuidv7Schema,
  correlationId: CorrelationIdSchema,
  issuedAt: IsoMsSchema,
  deduplicated: z.boolean(),
});

/** A validated command answer. */
export type CommandResponse = z.infer<typeof CommandResponseSchema>;

/**
 * Body of `POST .../lock` and `POST .../lock/release`. The identifier names the request for the logs and the
 * audit trail; the lock itself is identified by the robot and the verified caller.
 */
export const LockRequestSchema = z.strictObject({ commandId: Uuidv7Schema });

/** A validated lock request. */
export type LockRequest = z.infer<typeof LockRequestSchema>;

/**
 * State of one robot's lock as the caller may see it. `holder` is present exactly when `held` is true, and
 * `mine` can only be true for a held lock. The token is never part of this schema.
 */
export const LockStateSchema = z
  .strictObject({
    robotId: RobotIdSchema,
    held: z.boolean(),
    holder: UserSubSchema.optional(),
    mine: z.boolean(),
    expiresAt: IsoMsSchema.optional(),
  })
  .superRefine((state, ctx) => {
    if (state.held !== (state.holder !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["holder"],
        message: "a holder is present exactly when the lock is held",
      });
    }
    if (state.mine && !state.held) {
      ctx.addIssue({
        code: "custom",
        path: ["mine"],
        message: "a lock can be mine only while it is held",
      });
    }
  });

/** A validated lock state. */
export type LockState = z.infer<typeof LockStateSchema>;

/**
 * Answer to an acquire or a release. `changed` is false when the lock was already in the requested state,
 * which makes a repeated request harmless.
 */
export const LockActionResponseSchema = z.strictObject({
  commandId: Uuidv7Schema,
  correlationId: CorrelationIdSchema,
  changed: z.boolean(),
  lock: LockStateSchema,
});

/** A validated lock answer. */
export type LockActionResponse = z.infer<typeof LockActionResponseSchema>;

/** Answer to `GET /sites/{siteId}/robots`: the registry entries of the site, summaries only. */
export const RobotListResponseSchema = z.strictObject({
  robots: z.array(RobotSummarySchema).max(ROBOT_LIST_MAX),
});

/** A validated robot list. */
export type RobotListResponse = z.infer<typeof RobotListResponseSchema>;

/** State of the demo mode of a site. Absent when it was never changed, which reads as disabled. */
export const DemoStateSchema = z.strictObject({
  enabled: z.boolean(),
  changedBy: UserSubSchema.optional(),
  changedAt: IsoMsSchema.optional(),
});

/** A validated demo state. */
export type DemoState = z.infer<typeof DemoStateSchema>;

/** Body of `PUT /sites/{siteId}/demo`. */
export const DemoUpdateRequestSchema = z.strictObject({ enabled: z.boolean() });

/** A validated demo update. */
export type DemoUpdateRequest = z.infer<typeof DemoUpdateRequestSchema>;
