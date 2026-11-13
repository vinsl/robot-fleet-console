/**
 * Events: discrete facts a robot reports on its events topic (QoS 1, so they are not lost on a
 * short disconnect).
 *
 * Each kind is a flat object: the discriminator `kind` sits next to the fields of that kind, so a
 * consumer narrows the union with a single check and no nesting.
 */
import { z } from "zod";
import { RobotEnvelopeShape } from "./envelope";
import { BatteryPercentSchema } from "./telemetry";
import { UserSubSchema } from "./ids";
import { FaultCodeSchema, RobotReportedStateSchema } from "./robot-state";
import { StateChangeCauseSchema } from "./state-machine";
import { Uuidv7Schema } from "./uuidv7";

/** Dotted version of the agent software, as reported in the boot event. */
const AgentVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);

/** Causes of a lock change, as the robot observed them. */
export const LockChangeCauseSchema = z.enum(["ACQUIRED", "RELEASED", "EXPIRED", "TAKEOVER"]);

/**
 * Event published by a robot. Discriminated on `kind`.
 *
 * `GOING_OFFLINE` is the robot's own announcement of a clean shutdown. The cloud, not the robot,
 * sets the `OFFLINE` state, because a robot cannot report that it is unreachable.
 */
export const RobotEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...RobotEnvelopeShape,
    kind: z.literal("BOOT"),
    agentVersion: AgentVersionSchema,
    simulated: z.boolean(),
    state: RobotReportedStateSchema,
  }),
  z.strictObject({
    ...RobotEnvelopeShape,
    kind: z.literal("STATE_CHANGED"),
    from: RobotReportedStateSchema,
    to: RobotReportedStateSchema,
    cause: StateChangeCauseSchema,
    // Present only when a command caused the change; a timer or a sensor has no command.
    commandId: Uuidv7Schema.optional(),
  }),
  z.strictObject({
    ...RobotEnvelopeShape,
    kind: z.literal("HEARTBEAT"),
    state: RobotReportedStateSchema,
    battery: BatteryPercentSchema,
  }),
  z.strictObject({
    ...RobotEnvelopeShape,
    kind: z.literal("FAULT_RAISED"),
    fault: FaultCodeSchema,
  }),
  z.strictObject({
    ...RobotEnvelopeShape,
    kind: z.literal("FAULT_CLEARED"),
    fault: FaultCodeSchema,
  }),
  // A lock that is held names its holder; a lock that is free names nobody. The two shapes are
  // discriminated on `held`, so a holder on a release (or a missing holder on an acquisition) is refused.
  z.discriminatedUnion("held", [
    z.strictObject({
      ...RobotEnvelopeShape,
      kind: z.literal("LOCK_CHANGED"),
      held: z.literal(true),
      holder: UserSubSchema,
      cause: LockChangeCauseSchema,
    }),
    z.strictObject({
      ...RobotEnvelopeShape,
      kind: z.literal("LOCK_CHANGED"),
      held: z.literal(false),
      cause: LockChangeCauseSchema,
    }),
  ]),
  z.strictObject({
    ...RobotEnvelopeShape,
    kind: z.literal("GOING_OFFLINE"),
    reason: z.literal("SHUTDOWN"),
  }),
]);

/** A validated robot event. */
export type RobotEvent = z.infer<typeof RobotEventSchema>;
