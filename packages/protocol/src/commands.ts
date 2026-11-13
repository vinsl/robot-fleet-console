/**
 * Commands: instructions the cloud sends to one robot on its command topic.
 *
 * A command is validated against this schema before anything else is read from it, and every field
 * that is not in the schema is rejected. The robot then applies the rules of the command pipeline
 * (age, replay, lock, state), which live in the agent and in the state machine, not here.
 */
import { z } from "zod";
import { CloudEnvelopeShape } from "./envelope";
import { CorrelationIdSchema, LockTokenSchema, UserSubSchema } from "./ids";
import { IsoMsSchema } from "./time";
import { FaultCodeSchema } from "./robot-state";
import { Uuidv7Schema } from "./uuidv7";

/** The ten command types of the protocol. */
export const CommandTypeSchema = z.enum([
  "PAUSE",
  "RESUME",
  "RETURN_TO_BASE",
  "ESTOP",
  "ESTOP_RELEASE",
  "TAKE_CONTROL",
  "RELEASE_CONTROL",
  "HEARTBEAT",
  "DRIVE",
  "SIMULATE_FAULT",
]);

/** A validated command type. */
export type CommandType = z.infer<typeof CommandTypeSchema>;

/**
 * Commands that need the robot lock held by the sender. `SIMULATE_FAULT` and `ESTOP` are not in
 * this list: an operator must always be able to stop a robot, and a demo fault is not a motion.
 */
export const LOCK_REQUIRED_COMMANDS = [
  "PAUSE",
  "RESUME",
  "RETURN_TO_BASE",
  "ESTOP_RELEASE",
  "RELEASE_CONTROL",
  "HEARTBEAT",
  "DRIVE",
] as const;

/** Commands that are accepted without the lock. */
export const LOCK_FREE_COMMANDS = ["ESTOP", "TAKE_CONTROL", "SIMULATE_FAULT"] as const;

/**
 * Commands the schema accepts but the robot refuses with `INVALID`. `DRIVE` is part of the protocol
 * as a bonus that this demo does not build, so the schema stays stable when it is added later.
 */
export const UNSUPPORTED_COMMANDS = ["DRIVE"] as const;

/** Parameters of commands that take none. Strict, so an operator cannot smuggle a value through. */
const NoParamsSchema = z.strictObject({});

/** Fields shared by every command. The cloud envelope is spread in front of them. */
const CommandBaseShape = {
  ...CloudEnvelopeShape,
  commandId: Uuidv7Schema,
  issuedAt: IsoMsSchema,
  issuedBy: UserSubSchema,
  correlationId: CorrelationIdSchema,
  // Optional here; required for `TAKE_CONTROL`, and checked against the lock holder for the others.
  lockToken: LockTokenSchema.optional(),
};

/**
 * Parameters of `SIMULATE_FAULT`: the fault to inject and, optionally, for how long. Shared with the
 * control route that asks for the fault, so the cloud and the robot read one definition.
 */
export const SimulateFaultParamsSchema = z.strictObject({
  fault: FaultCodeSchema,
  durationS: z.int().min(1).max(300).optional(),
});

/**
 * A command of any type. Discriminated on `type`, so a command with the wrong parameters for its
 * type is rejected as a whole.
 */
export const CommandSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...CommandBaseShape, type: z.literal("PAUSE"), params: NoParamsSchema }),
  z.strictObject({ ...CommandBaseShape, type: z.literal("RESUME"), params: NoParamsSchema }),
  z.strictObject({
    ...CommandBaseShape,
    type: z.literal("RETURN_TO_BASE"),
    params: NoParamsSchema,
  }),
  z.strictObject({ ...CommandBaseShape, type: z.literal("ESTOP"), params: NoParamsSchema }),
  z.strictObject({ ...CommandBaseShape, type: z.literal("ESTOP_RELEASE"), params: NoParamsSchema }),
  z.strictObject({
    ...CommandBaseShape,
    type: z.literal("TAKE_CONTROL"),
    // The lock token is what the robot will later compare; a take without one is meaningless.
    lockToken: LockTokenSchema,
    params: NoParamsSchema,
  }),
  z.strictObject({
    ...CommandBaseShape,
    type: z.literal("RELEASE_CONTROL"),
    params: NoParamsSchema,
  }),
  z.strictObject({ ...CommandBaseShape, type: z.literal("HEARTBEAT"), params: NoParamsSchema }),
  z.strictObject({
    ...CommandBaseShape,
    type: z.literal("DRIVE"),
    params: z.strictObject({
      // Normalised joystick axes; the robot clamps nothing and rejects anything outside the range.
      linear: z.number().min(-1).max(1),
      angular: z.number().min(-1.5).max(1.5),
      // Short bursts only: a DRIVE that is not refreshed is stopped by the deadman.
      durationMs: z.int().min(50).max(500),
    }),
  }),
  z.strictObject({
    ...CommandBaseShape,
    type: z.literal("SIMULATE_FAULT"),
    params: SimulateFaultParamsSchema,
  }),
]);

/** A validated command. */
export type Command = z.infer<typeof CommandSchema>;
