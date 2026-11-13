/**
 * Telemetry: the periodic pose and status a robot publishes on the Basic Ingest topic.
 *
 * Telemetry is best effort (QoS 0) and is never acknowledged, so its schema is the only guard
 * between a bad payload and the fleet view. Every numeric bound is therefore explicit.
 */
import { z } from "zod";
import { FaultCodeSchema, RobotReportedStateSchema } from "./robot-state";
import { MissionIdSchema } from "./ids";
import { RobotEnvelopeShape } from "./envelope";

/** Battery charge in percent, from empty to full. */
export const BatteryPercentSchema = z.number().min(0).max(100);

/** Telemetry message of a robot. */
export const TelemetrySchema = z.strictObject({
  ...RobotEnvelopeShape,
  // Metres in the site frame. The bound is the largest site the fleet console models.
  x: z.number().min(-1000).max(1000),
  y: z.number().min(-1000).max(1000),
  // Radians, normalised to one turn in each direction.
  heading: z.number().min(-Math.PI).max(Math.PI),
  state: RobotReportedStateSchema,
  battery: BatteryPercentSchema,
  // Metres per second. A robot in this fleet does not exceed 5 m/s.
  speed: z.number().min(0).max(5),
  missionId: MissionIdSchema.optional(),
  errorCode: FaultCodeSchema.optional(),
});

/** A validated telemetry message as published by a robot. */
export type Telemetry = z.infer<typeof TelemetrySchema>;
