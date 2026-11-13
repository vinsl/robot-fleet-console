/**
 * Robot lifecycle states shared by the console, the API and the robot agent.
 *
 * The transition table that governs them lives in the state machine module; this file only
 * fixes the vocabulary so that every consumer is checked against the same list.
 */
import { z } from "zod";

/**
 * `OFFLINE` is set by the cloud on disconnect or silence, never by the robot itself.
 * A sensor fault is not a state of its own: the robot goes to `BLOCKED` and raises a sensor-fault flag.
 */
export const RobotStateSchema = z.enum([
  "IDLE",
  "WORKING",
  "MOVING",
  "CHARGING",
  "BLOCKED",
  "PAUSED",
  "TELEOP",
  "ESTOP",
  "OFFLINE",
]);

/** A validated robot state. */
export type RobotState = z.infer<typeof RobotStateSchema>;

/**
 * States a robot may report about itself. The robot never reports `OFFLINE`: it cannot tell that it
 * is unreachable, so the cloud derives that state from the absence of messages.
 */
export const RobotReportedStateSchema = RobotStateSchema.exclude(["OFFLINE"]);

/** A state the robot can report. */
export type RobotReportedState = z.infer<typeof RobotReportedStateSchema>;

/** Fault codes a robot can raise. They are the only values of `errorCode` and of fault events. */
export const FaultCodeSchema = z.enum(["OBSTACLE", "SENSOR_FAULT", "BATTERY_LOW", "LINK_LOSS"]);

/** A validated fault code. */
export type FaultCode = z.infer<typeof FaultCodeSchema>;
