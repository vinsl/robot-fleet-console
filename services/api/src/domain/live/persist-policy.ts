/**
 * Decides which live samples are written to DynamoDB, and remembers the samples this container has seen.
 *
 * Telemetry arrives several times a second per robot. A write per sample would cost one write unit for
 * nothing, so a sample is persisted when its state, boot or mission changed, or when the last persisted
 * sample is older than the interval. Positions in between reach the WebSocket channel only.
 *
 * The maps live in one warm container. They are an optimisation: losing them only causes extra writes,
 * and the conditional write in the store still orders the samples. Their size is bounded, so a container
 * that sees many robots cannot grow without limit.
 */
import { LIVE_STATE_PERSIST_INTERVAL_MS, type MissionId, type RobotState } from "@mfc/protocol";

/** What the policy needs to know about a sample. */
export interface PolicySample {
  readonly robotId: string;
  readonly bootId: string;
  readonly state: RobotState;
  readonly missionId?: MissionId | undefined;
}

/** The last sample persisted for a robot. */
interface PersistedEntry {
  readonly bootId: string;
  readonly state: RobotState;
  readonly missionId: MissionId | undefined;
  readonly atMs: number;
}

/** The newest sample seen for a robot in this container. */
interface SeenEntry {
  readonly bootId: string;
  readonly seq: number;
}

/**
 * Persist decisions and the in-container ordering memory, both bounded.
 */
export class PersistPolicy {
  private readonly persisted = new Map<string, PersistedEntry>();
  private readonly seen = new Map<string, SeenEntry>();

  /**
   * @param maxEntries - Entries kept per map. When a map is full, a new robot clears it first.
   * @param intervalMs - Longest time between two persisted samples of one robot with no change.
   */
  constructor(
    private readonly maxEntries = 1000,
    private readonly intervalMs = LIVE_STATE_PERSIST_INTERVAL_MS,
  ) {}

  /**
   * @param sample - The sample to decide on.
   * @param nowMs - The current time, in milliseconds since the epoch.
   * @returns `true` when the sample must be written: no entry for the robot, a changed boot, state or
   * mission, or the interval has elapsed since the last persisted sample.
   */
  shouldPersist(sample: PolicySample, nowMs: number): boolean {
    const last = this.persisted.get(sample.robotId);
    if (last === undefined) {
      return true;
    }
    return (
      last.bootId !== sample.bootId ||
      last.state !== sample.state ||
      last.missionId !== sample.missionId ||
      nowMs - last.atMs >= this.intervalMs
    );
  }

  /**
   * Remembers that a sample was persisted. A new robot in a full map clears the map first.
   *
   * @param sample - The persisted sample.
   * @param nowMs - The time of the write, in milliseconds since the epoch.
   */
  recordPersisted(sample: PolicySample, nowMs: number): void {
    if (!this.persisted.has(sample.robotId) && this.persisted.size >= this.maxEntries) {
      this.persisted.clear();
    }
    this.persisted.set(sample.robotId, {
      bootId: sample.bootId,
      state: sample.state,
      missionId: sample.missionId,
      atMs: nowMs,
    });
  }

  /**
   * @param robotId - The robot.
   * @returns The newest sample seen for the robot in this container, if any.
   */
  lastSeen(robotId: string): SeenEntry | undefined {
    return this.seen.get(robotId);
  }

  /**
   * Remembers the newest sample seen for a robot. A new robot in a full map clears the map first.
   *
   * @param robotId - The robot.
   * @param bootId - The boot of the sample.
   * @param seq - The sequence number of the sample.
   */
  recordSeen(robotId: string, bootId: string, seq: number): void {
    if (!this.seen.has(robotId) && this.seen.size >= this.maxEntries) {
      this.seen.clear();
    }
    this.seen.set(robotId, { bootId, seq });
  }
}
