/**
 * Live state of one robot as the cloud stores it and as the console receives it in a snapshot.
 *
 * The cloud writes this record from telemetry, events and presence. Its ordering key is the pair
 * `(bootId, seq)`: a later boot always has a larger identifier, so a stale write is refused by a
 * conditional write rather than by comparing robot clocks, which the cloud does not trust.
 */
import { z } from "zod";
import { BatteryPercentSchema, TelemetrySchema } from "./telemetry";
import { RobotIdSchema, SiteIdSchema, MissionIdSchema } from "./ids";
import { FaultCodeSchema, RobotStateSchema } from "./robot-state";
import { IsoMsSchema } from "./time";
import { RobotEnvelopeShape } from "./envelope";

/**
 * Minimum time between two persisted samples of one robot, when its state did not change.
 *
 * Telemetry arrives at 0.5 Hz to 2 Hz per robot; writing each sample would cost one write per
 * sample for nothing, so positions in between go to the live WebSocket channel only.
 */
export const LIVE_STATE_PERSIST_INTERVAL_MS = 10_000;

/** Pose of a robot in the site frame, copied from the telemetry bounds. */
export const RobotPoseSchema = z.strictObject({
  x: TelemetrySchema.shape.x,
  y: TelemetrySchema.shape.y,
  heading: TelemetrySchema.shape.heading,
  speed: TelemetrySchema.shape.speed,
});

/** A validated pose. */
export type RobotPose = z.infer<typeof RobotPoseSchema>;

/**
 * Live state record of one robot. `pose` is absent when the last update carried no position (a
 * heartbeat or a state event), so a consumer keeps the last known pose instead of inventing one.
 */
export const RobotLiveStateSchema = z.strictObject({
  robotId: RobotIdSchema,
  siteId: SiteIdSchema,
  state: RobotStateSchema,
  battery: BatteryPercentSchema,
  pose: RobotPoseSchema.optional(),
  missionId: MissionIdSchema.optional(),
  errorCode: FaultCodeSchema.optional(),
  bootId: RobotEnvelopeShape.bootId,
  seq: RobotEnvelopeShape.seq,
  // The robot's own timestamp, kept for display; it is never used for ordering.
  ts: IsoMsSchema,
  // Milliseconds since the Unix epoch, measured by the cloud when the message was received.
  receivedAt: z.int().min(0),
});

/** A validated live state record. */
export type RobotLiveState = z.infer<typeof RobotLiveStateSchema>;
