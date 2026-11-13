/**
 * Pure reducer of the live fleet state: applies one server frame to the robots, the session log and the
 * snapshot time, and interpolates marker positions between samples.
 *
 * Nothing here reads a clock or touches the DOM; the caller passes `now`. Ordering of samples uses the
 * protocol rule {@link isNewerSample} (boot, then sequence), never the robot clock. An unchanged frame
 * returns the same object, so selectors and components do not re-render for it.
 */
import {
  SNAPSHOT_MAX_ROBOTS,
  isNewerSample,
  type FaultCode,
  type MissionId,
  type RobotId,
  type RobotLiveState,
  type RobotPose,
  type RobotState,
  type WsServerMessage,
  type FleetRobotSample,
  type RobotEvent,
} from "@mfc/protocol";
import { live, map } from "../theme/tokens";

/** Connectivity of one robot as the cloud reports it. */
export type Presence = "ONLINE" | "OFFLINE";

/** Pose interpolation of one marker: draw from `from` at `fromAt` to `to` at `toAt` (client milliseconds). */
export interface Motion {
  readonly from: RobotPose;
  readonly fromAt: number;
  readonly to: RobotPose;
  readonly toAt: number;
}

/** The newest known view of one robot. */
export interface LiveRobot {
  readonly robotId: RobotId;
  readonly bootId: string;
  readonly seq: number;
  /** Last reported or snapshot state. May be `OFFLINE` when it comes from a snapshot. */
  readonly state: RobotState;
  readonly presence: Presence;
  readonly battery: number;
  /** Newest known pose, or `null` until one arrives. */
  readonly pose: RobotPose | null;
  /** Interpolation towards the newest pose, or `null` after a snap or before two poses. */
  readonly motion: Motion | null;
  /** Client milliseconds of the last pose sample, or `null` when none arrived. */
  readonly lastSampleAt: number | null;
  readonly missionId?: MissionId | undefined;
  readonly errorCode?: FaultCode | undefined;
  /** Robot timestamp, kept for display only. Never used for ordering. */
  readonly robotTs: string;
  /** Client milliseconds of the last frame about this robot. Drives the silence rules. */
  readonly lastHeardAt: number;
}

/** Discrete facts of the current session (since the console opened), kept for the KPIs. */
export interface SessionLog {
  readonly startedAt: number;
  /** Client times of completed missions, newest last, within the session window. */
  readonly missionsDone: readonly number[];
  /** Client times of stops (BLOCKED or ESTOP entries), within the session window. */
  readonly stops: readonly number[];
  /** Identifiers of the recent robot events, used to count a duplicated event once. */
  readonly seenEventIds: readonly string[];
}

/** The live fleet data. */
export interface FleetData {
  readonly robots: Readonly<Record<string, LiveRobot>>;
  /** Client time of the last snapshot frame, or `null` when none arrived. */
  readonly snapshotAt: number | null;
  readonly session: SessionLog;
  /**
   * Robot entries refused since the session started, because the fleet was already at its cap
   * (`SNAPSHOT_MAX_ROBOTS`). Each arrival of a refused robot counts once.
   */
  readonly droppedRobots: number;
}

/** Number of recent event identifiers kept for duplicate detection. */
const SEEN_EVENT_LIMIT = 500;

/** Full turn of a heading, in radians. */
const TWO_PI = 2 * Math.PI;

/**
 * Creates the empty fleet state.
 *
 * @param now - Client time at which the session starts.
 * @returns A fleet with no robot and an empty session log.
 */
export function emptyFleet(now: number): FleetData {
  return {
    robots: {},
    snapshotAt: null,
    session: { startedAt: now, missionsDone: [], stops: [], seenEventIds: [] },
    droppedRobots: 0,
  };
}

/**
 * Clamps a number into a closed interval.
 *
 * @param value - The number to clamp.
 * @param min - Lower bound.
 * @param max - Upper bound.
 * @returns `value` limited to `[min, max]`.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Wraps an angle into `[-pi, pi)`.
 *
 * @param angle - Any angle, in radians.
 * @returns The equivalent angle in `[-pi, pi)`.
 */
function wrapAngle(angle: number): number {
  return ((((angle + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
}

/**
 * Draws the pose of a marker at a given time, by linear interpolation of position and speed and the
 * shortest arc of the heading.
 *
 * @param motion - The interpolation to draw.
 * @param t - Client time in milliseconds. Times outside the motion are clamped to its ends.
 * @returns The pose at `t`.
 */
export function poseAt(motion: Motion, t: number): RobotPose {
  const span = motion.toAt - motion.fromAt;
  const u = span <= 0 ? 1 : clamp((t - motion.fromAt) / span, 0, 1);
  const { from, to } = motion;
  const arc = wrapAngle(to.heading - from.heading);
  return {
    x: from.x + (to.x - from.x) * u,
    y: from.y + (to.y - from.y) * u,
    heading: wrapAngle(from.heading + arc * u),
    speed: from.speed + (to.speed - from.speed) * u,
  };
}

/**
 * Computes the motion that follows a new pose sample. A snap (`null`) is used for the first pose, for a
 * new boot, and for a jump longer than `map.snapDistanceM`.
 *
 * @param robot - The robot before the sample, or `undefined` when it is new.
 * @param pose - The new pose.
 * @param bootChanged - Whether the sample comes from a different boot than the robot's last one.
 * @param now - Client time of the arrival.
 * @returns The interpolation, or `null` to snap.
 */
export function nextMotion(
  robot: LiveRobot | undefined,
  pose: RobotPose,
  bootChanged: boolean,
  now: number,
): Motion | null {
  if (robot === undefined || robot.pose === null || bootChanged) {
    return null;
  }
  const jump = Math.hypot(pose.x - robot.pose.x, pose.y - robot.pose.y);
  if (jump > map.snapDistanceM) {
    return null;
  }
  // Interpolate from where the marker is drawn now, so a new sample never makes it jump backwards.
  const from = robot.motion === null ? robot.pose : poseAt(robot.motion, now);
  const sinceLast = now - (robot.lastSampleAt ?? now);
  const duration = clamp(sinceLast, map.interpolationMinMs, map.interpolationMaxMs);
  return { from, fromAt: now, to: pose, toAt: now + duration };
}

/**
 * Looks a robot up by identifier. Identifiers have passed the protocol grammar, which rules out names of
 * object prototype properties, so a plain property read is safe.
 *
 * @param robots - The robot map.
 * @param robotId - The identifier to look up.
 * @returns The robot, or `undefined` when it is not known.
 */
function robotById(
  robots: Readonly<Record<string, LiveRobot>>,
  robotId: RobotId,
): LiveRobot | undefined {
  // eslint-disable-next-line security/detect-object-injection -- RobotId is validated by the protocol grammar
  return robots[robotId];
}

/**
 * Tells whether the fleet may hold a robot: a robot already held always may be updated, and a new one
 * only while the fleet is below `SNAPSHOT_MAX_ROBOTS`. The cap bounds the memory a flood of ids can take.
 *
 * @param robots - The robot map before the change.
 * @param robotId - The robot the frame concerns.
 * @returns `true` when the robot is held or the fleet has room for it.
 */
function canAdmit(robots: Readonly<Record<string, LiveRobot>>, robotId: RobotId): boolean {
  return (
    robotById(robots, robotId) !== undefined || Object.keys(robots).length < SNAPSHOT_MAX_ROBOTS
  );
}

/**
 * Returns a copy of the fleet with one robot replaced or added.
 *
 * @param data - The fleet before the change.
 * @param robot - The new view of the robot.
 * @returns The new fleet data.
 */
function withRobot(data: FleetData, robot: LiveRobot): FleetData {
  return withRobots(data, { ...data.robots, [robot.robotId]: robot }, data.droppedRobots);
}

/**
 * Returns a copy of the fleet with a new robot map and drop count, keeping the other fields.
 *
 * @param data - The fleet before the change.
 * @param robots - The new robot map.
 * @param droppedRobots - The new count of refused robot entries.
 * @returns The new fleet data.
 */
function withRobots(
  data: FleetData,
  robots: Readonly<Record<string, LiveRobot>>,
  droppedRobots: number,
): FleetData {
  return { robots, snapshotAt: data.snapshotAt, session: data.session, droppedRobots };
}

/**
 * Client time of the last contact a snapshot record proves: its receive time, never later than the arrival.
 *
 * @param record - The snapshot record.
 * @param now - Client time of the arrival.
 * @returns The contact time in client milliseconds.
 */
function snapshotHeardAt(record: RobotLiveState, now: number): number {
  return Math.min(now, record.receivedAt);
}

/**
 * Builds the robot view of a snapshot record. A record without a pose keeps the last known pose.
 *
 * @param existing - The robot held before, if any.
 * @param record - The snapshot record, already known to be newer.
 * @param now - Client time of the arrival.
 * @returns The new robot view.
 */
function robotFromSnapshot(
  existing: LiveRobot | undefined,
  record: RobotLiveState,
  now: number,
): LiveRobot {
  const sampled = record.pose !== undefined;
  return {
    robotId: record.robotId,
    bootId: record.bootId,
    seq: record.seq,
    state: record.state,
    presence: record.state === "OFFLINE" ? "OFFLINE" : "ONLINE",
    battery: record.battery,
    pose: record.pose ?? existing?.pose ?? null,
    // A snapshot pose is a snap: the marker is placed, not travelled to.
    motion: sampled ? null : (existing?.motion ?? null),
    lastSampleAt: sampled ? now : (existing?.lastSampleAt ?? null),
    missionId: record.missionId,
    errorCode: record.errorCode,
    robotTs: record.ts,
    lastHeardAt: snapshotHeardAt(record, now),
  };
}

/**
 * Tells whether a snapshot record is the very sample already held: same boot and same sequence number.
 * The cloud confirms such a record again, so it is a contact, not a change.
 *
 * @param held - The robot held.
 * @param record - The snapshot record.
 * @returns `true` when both identify the same sample.
 */
function isSameSample(held: LiveRobot, record: RobotLiveState): boolean {
  return held.bootId === record.bootId && held.seq === record.seq;
}

/**
 * Applies a snapshot: each record that is newer than the held sample replaces it. A record that is the
 * sample already held only refreshes the contact time, never the sample. Robots absent from the snapshot
 * are kept, because a snapshot may be split across frames. A new robot beyond the cap is refused and
 * counted in `droppedRobots`.
 *
 * @param data - The fleet before the frame.
 * @param records - The snapshot records.
 * @param now - Client time of the arrival.
 * @returns The new fleet data; `snapshotAt` is always updated.
 */
function applySnapshot(
  data: FleetData,
  records: readonly RobotLiveState[],
  now: number,
): FleetData {
  const robots: Record<string, LiveRobot> = { ...data.robots };
  let droppedRobots = data.droppedRobots;
  for (const record of records) {
    const existing = robotById(robots, record.robotId);
    if (!isNewerSample(existing, record)) {
      if (existing !== undefined && isSameSample(existing, record)) {
        // Never moves the contact time backwards: a confirmation may carry an older receive time.
        const heardAt = Math.max(existing.lastHeardAt, snapshotHeardAt(record, now));
        robots[record.robotId] = { ...existing, lastHeardAt: heardAt };
      }
      continue;
    }
    if (!canAdmit(robots, record.robotId)) {
      droppedRobots += 1;
      continue;
    }
    robots[record.robotId] = robotFromSnapshot(existing, record, now);
  }
  return { robots, snapshotAt: now, session: data.session, droppedRobots };
}

/**
 * Builds the robot view after a delta sample. The caller has checked that the sample is newer.
 *
 * @param existing - The robot held before, if any.
 * @param sample - The sample, already known to be newer.
 * @param now - Client time of the arrival.
 * @returns The new robot view.
 */
function robotFromSample(
  existing: LiveRobot | undefined,
  sample: FleetRobotSample,
  now: number,
): LiveRobot {
  const pose: RobotPose = {
    x: sample.x,
    y: sample.y,
    heading: sample.heading,
    speed: sample.speed,
  };
  const bootChanged = existing !== undefined && existing.bootId !== sample.bootId;
  return {
    robotId: sample.robotId,
    bootId: sample.bootId,
    seq: sample.seq,
    state: sample.state,
    presence: "ONLINE",
    battery: sample.battery,
    pose,
    motion: nextMotion(existing, pose, bootChanged, now),
    lastSampleAt: now,
    missionId: sample.missionId,
    errorCode: sample.errorCode,
    robotTs: sample.ts,
    lastHeardAt: now,
  };
}

/**
 * Applies a delta: each sample newer than the held one updates its robot. A new robot beyond the cap is
 * refused and counted in `droppedRobots`.
 *
 * @param data - The fleet before the frame.
 * @param samples - The samples of the frame.
 * @param now - Client time of the arrival.
 * @returns The new fleet data, or `data` itself when no sample was newer.
 */
function applyDelta(data: FleetData, samples: readonly FleetRobotSample[], now: number): FleetData {
  const robots: Record<string, LiveRobot> = { ...data.robots };
  let droppedRobots = data.droppedRobots;
  let changed = false;
  for (const sample of samples) {
    const existing = robotById(robots, sample.robotId);
    if (!isNewerSample(existing, sample)) {
      continue;
    }
    changed = true;
    if (!canAdmit(robots, sample.robotId)) {
      droppedRobots += 1;
      continue;
    }
    robots[sample.robotId] = robotFromSample(existing, sample, now);
  }
  return changed ? withRobots(data, robots, droppedRobots) : data;
}

/**
 * Returns the session log after one robot event: counts a mission when a robot goes back to idle after
 * completing work, and a stop when it enters BLOCKED or ESTOP. Both lists are trimmed to the session window.
 *
 * @param session - The session log before the event.
 * @param event - The robot event.
 * @param now - Client time of the arrival.
 * @returns The new session log.
 */
function sessionAfter(session: SessionLog, event: RobotEvent, now: number): SessionLog {
  let missionsDone = session.missionsDone;
  let stops = session.stops;
  if (event.kind === "STATE_CHANGED") {
    if (event.to === "IDLE" && event.cause === "WORK_DONE") {
      missionsDone = [...missionsDone, now];
    }
    if (event.to === "BLOCKED" || event.to === "ESTOP") {
      stops = [...stops, now];
    }
  }
  const cutoff = now - live.sessionWindowMs;
  return {
    startedAt: session.startedAt,
    missionsDone: missionsDone.filter((at) => at >= cutoff),
    stops: stops.filter((at) => at >= cutoff),
    seenEventIds: session.seenEventIds,
  };
}

/**
 * The fields a robot event changes when it is newer than the robot's last sample.
 *
 * @param robot - The robot before the event.
 * @param event - The robot event.
 * @returns The fields to overwrite; an empty object for events that change no state.
 */
function eventPatch(robot: LiveRobot, event: RobotEvent): Partial<LiveRobot> {
  switch (event.kind) {
    case "STATE_CHANGED":
      return { state: event.to };
    case "BOOT":
      return { state: event.state, presence: "ONLINE" };
    case "HEARTBEAT":
      return { state: event.state, battery: event.battery };
    case "FAULT_RAISED":
      return { errorCode: event.fault };
    case "FAULT_CLEARED":
      return { errorCode: robot.errorCode === event.fault ? undefined : robot.errorCode };
    case "LOCK_CHANGED":
    case "GOING_OFFLINE":
      return {};
  }
}

/**
 * Applies one robot event to a known robot. Its state fields change only when the event is newer; the
 * robot is heard from either way.
 *
 * @param robot - The robot before the event.
 * @param event - The robot event.
 * @param now - Client time of the arrival.
 * @returns The new robot view.
 */
function robotAfterEvent(robot: LiveRobot, event: RobotEvent, now: number): LiveRobot {
  if (!isNewerSample(robot, event)) {
    return { ...robot, lastHeardAt: now };
  }
  return {
    ...robot,
    ...eventPatch(robot, event),
    bootId: event.bootId,
    seq: event.seq,
    lastHeardAt: now,
  };
}

/**
 * Applies a robot event. A duplicated event (same message identifier) changes nothing. An event for a robot
 * that is not known creates no entry, but still counts in the session log.
 *
 * @param data - The fleet before the frame.
 * @param robotId - The robot the frame concerns.
 * @param event - The event.
 * @param now - Client time of the arrival.
 * @returns The new fleet data, or `data` itself for a duplicate.
 */
function applyRobotEvent(
  data: FleetData,
  robotId: RobotId,
  event: RobotEvent,
  now: number,
): FleetData {
  if (data.session.seenEventIds.includes(event.messageId)) {
    return data;
  }
  const seen = [...data.session.seenEventIds, event.messageId].slice(-SEEN_EVENT_LIMIT);
  const session = { ...sessionAfter(data.session, event, now), seenEventIds: seen };
  const existing = robotById(data.robots, robotId);
  if (existing === undefined) {
    return { ...data, session };
  }
  return {
    ...data,
    robots: { ...data.robots, [robotId]: robotAfterEvent(existing, event, now) },
    session,
  };
}

/**
 * Applies a presence frame. Only a known robot is affected. OFFLINE keeps the time of the last contact;
 * ONLINE counts as contact.
 *
 * @param data - The fleet before the frame.
 * @param robotId - The robot the frame concerns.
 * @param presence - The new presence.
 * @param now - Client time of the arrival.
 * @returns The new fleet data, or `data` itself for an unknown robot.
 */
function applyPresence(
  data: FleetData,
  robotId: RobotId,
  presence: Presence,
  now: number,
): FleetData {
  const existing = robotById(data.robots, robotId);
  if (existing === undefined) {
    return data;
  }
  const updated: LiveRobot =
    presence === "OFFLINE"
      ? { ...existing, presence: "OFFLINE" }
      : { ...existing, presence: "ONLINE", lastHeardAt: now };
  return withRobot(data, updated);
}

/**
 * Applies one server frame to the fleet state.
 *
 * Only fleet and robot frames change the state. Alert, command, lock and error frames are handled by their
 * own consumers, and leave `data` unchanged.
 *
 * @param data - The fleet before the frame.
 * @param frame - A validated server frame.
 * @param now - Client time of the arrival, in milliseconds.
 * @returns The new fleet data, or `data` itself when nothing changed.
 */
export function applyFrame(data: FleetData, frame: WsServerMessage, now: number): FleetData {
  switch (frame.type) {
    case "fleet.snapshot":
      return applySnapshot(data, frame.robots, now);
    case "fleet.delta":
      return applyDelta(data, frame.robots, now);
    case "robot.presence":
      return applyPresence(data, frame.robotId, frame.presence, now);
    case "robot.event":
      return applyRobotEvent(data, frame.robotId, frame.event, now);
    case "alert.changed":
    case "command.ack":
    case "lock.changed":
    case "error":
      return data;
  }
}
