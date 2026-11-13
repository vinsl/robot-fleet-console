/**
 * In-memory fakes of the live-state ports, and builders of valid protocol messages for the tests.
 *
 * The fakes keep what the domain did, so tests assert on effects. Their outcomes follow the adapters'
 * contract: a duplicate or a stale write is an outcome, never an error.
 */
import {
  type AlertRecord,
  type RobotId,
  type RobotLiveState,
  type SiteId,
  type WsServerMessage,
  type FleetRobotSample,
} from "@mfc/protocol";
import type {
  AlertOpenOutcome,
  AlertPort,
  ConnectionRef,
  ConnectionsPort,
  FleetStatePort,
  GoodbyeRecord,
  HistoryPort,
  HistoryWriteOutcome,
  MissionHistoryRecord,
  ObserveOutcome,
  PresenceChange,
  PresenceOutcome,
  PushPort,
  PushResult,
  StateHistoryRecord,
  StateObservation,
  SubscribedConnections,
} from "../../src/domain/live/ports";
import type {
  IngestDimension,
  IngestDistributionName,
  IngestMetricName,
  IngestMetricsPort,
} from "../../src/domain/ingest/metrics";

/** The site of the reference fixtures. */
export const SITE: SiteId = "paris-01";

/** A UUIDv7 boot identifier, lowercase. */
export const BOOT_A = "0190a7c4-0000-7000-8000-00000000000a";

/** A later UUIDv7 boot identifier: sorts after {@link BOOT_A}. */
export const BOOT_B = "0190a7c4-0000-7000-8000-00000000000b";

/**
 * A fleet state fake. Observations are kept in order; outcomes can be scripted per robot.
 */
export class FakeFleetState implements FleetStatePort {
  /** Every observation the domain wrote, in order. */
  readonly observations: StateObservation[] = [];
  /** Presence changes, in order, by kind. */
  readonly presence: { kind: "online" | "offline"; change: PresenceChange }[] = [];
  /** Goodbyes recorded, by robot. */
  readonly goodbyes = new Map<RobotId, string>();
  /** Claims: the site of each robot. */
  readonly claims = new Map<RobotId, SiteId>();
  /** The boot each robot's stored state holds, for the offline rule. */
  readonly storedBoot = new Map<RobotId, string>();
  /** Robots whose observation throws an infrastructure error. */
  readonly failingObservations = new Set<RobotId>();
  /** Outcome of every observation, unless a robot has a failure scripted. */
  observeOutcome: ObserveOutcome = "APPLIED";
  /** Outcome of every presence write. */
  presenceOutcome: PresenceOutcome = "APPLIED";
  /** Live states returned by the site listing. */
  listed: RobotLiveState[] = [];

  /**
   * @param observation - The observation.
   * @returns The scripted outcome.
   * @throws When the robot's write is scripted to fail.
   */
  observe(observation: StateObservation): Promise<ObserveOutcome> {
    if (this.failingObservations.has(observation.robotId)) {
      return Promise.reject(new Error("store unavailable"));
    }
    this.observations.push(observation);
    return Promise.resolve(this.observeOutcome);
  }

  /** @param change - The presence change. */
  markOffline(change: PresenceChange): Promise<PresenceOutcome> {
    this.presence.push({ kind: "offline", change });
    return Promise.resolve(this.presenceOutcome);
  }

  /** @param change - The presence change. */
  markOnline(change: PresenceChange): Promise<PresenceOutcome> {
    this.presence.push({ kind: "online", change });
    return Promise.resolve(this.presenceOutcome);
  }

  /** @param change - The goodbye. */
  markGoodbye(change: { siteId: SiteId; robotId: RobotId; bootId: string }): Promise<void> {
    this.goodbyes.set(change.robotId, change.bootId);
    return Promise.resolve();
  }

  /**
   * @param _siteId - The site.
   * @param robotId - The robot.
   * @returns The boot of the stored state, and the last goodbye.
   */
  readGoodbye(siteId: SiteId, robotId: RobotId): Promise<GoodbyeRecord> {
    // The fake holds the robots of the test site only.
    if (siteId !== SITE) {
      return Promise.resolve({ bootId: undefined, goodbyeBootId: undefined });
    }
    return Promise.resolve({
      bootId: this.storedBoot.get(robotId),
      goodbyeBootId: this.goodbyes.get(robotId),
    });
  }

  /** @param _siteId - The site. */
  listSite(siteId: SiteId): Promise<RobotLiveState[]> {
    if (siteId !== SITE) {
      return Promise.resolve([]);
    }
    return Promise.resolve(this.listed);
  }

  /** @param robotId - The robot. */
  siteOf(robotId: RobotId): Promise<SiteId | null> {
    return Promise.resolve(this.claims.get(robotId) ?? null);
  }
}

/**
 * Alert fake with the store's rules: one alert per identifier, one open alert per robot and kind.
 */
export class FakeAlerts implements AlertPort {
  /** Alerts opened, in order. */
  readonly opened: AlertRecord[] = [];
  private readonly ids = new Set<string>();
  private readonly markers = new Set<string>();

  /** @param alert - The alert. */
  open(alert: AlertRecord): Promise<AlertOpenOutcome> {
    if (this.ids.has(alert.alertId)) {
      return Promise.resolve("DUPLICATE");
    }
    const marker = `${alert.robotId}|${alert.kind}`;
    if (this.markers.has(marker)) {
      return Promise.resolve("ALREADY_OPEN");
    }
    this.ids.add(alert.alertId);
    this.markers.add(marker);
    this.opened.push(alert);
    return Promise.resolve("OPENED");
  }
}

/** History fake: duplicates are detected by message identifier. */
export class FakeHistory implements HistoryPort {
  /** State changes written. */
  readonly states: StateHistoryRecord[] = [];
  /** Missions written. */
  readonly missions: MissionHistoryRecord[] = [];
  private readonly seen = new Set<string>();

  /** @param record - The state change. */
  putState(record: StateHistoryRecord): Promise<HistoryWriteOutcome> {
    return Promise.resolve(this.once(`STATE#${record.messageId}`, () => this.states.push(record)));
  }

  /** @param record - The mission. */
  putMission(record: MissionHistoryRecord): Promise<HistoryWriteOutcome> {
    return Promise.resolve(
      this.once(`MISSION#${record.messageId}`, () => this.missions.push(record)),
    );
  }

  private once(key: string, write: () => void): HistoryWriteOutcome {
    if (this.seen.has(key)) {
      return "DUPLICATE";
    }
    this.seen.add(key);
    write();
    return "WRITTEN";
  }
}

/** Connections fake: subscribed connections per site, and the removals made. */
export class FakeConnections implements ConnectionsPort {
  /** Subscribed connections by site. */
  readonly bySite = new Map<SiteId, ConnectionRef[]>();
  /** Sites whose listing is truncated. */
  readonly truncatedSites = new Set<SiteId>();
  /** Sites whose listing throws. */
  readonly failingSites = new Set<SiteId>();
  /** Connection identifiers removed, in order. */
  readonly removed: string[] = [];

  /** @param siteId - The site. */
  listSubscribed(siteId: SiteId): Promise<SubscribedConnections> {
    if (this.failingSites.has(siteId)) {
      return Promise.reject(new Error("listing unavailable"));
    }
    return Promise.resolve({
      connections: this.bySite.get(siteId) ?? [],
      truncated: this.truncatedSites.has(siteId),
    });
  }

  /** @param connectionId - The connection. */
  remove(connectionId: string): Promise<void> {
    this.removed.push(connectionId);
    return Promise.resolve();
  }
}

/** Push fake: scripted outcomes per connection, the frames received, and the closes. */
export class FakePush implements PushPort {
  /** Frames posted, in order. */
  readonly posted: { connectionId: string; data: string }[] = [];
  /** Connections closed by the server. */
  readonly closed: string[] = [];
  private readonly scripts = new Map<string, PushResult[]>();

  /**
   * Scripts the outcomes of the next pushes to one connection. Once the script is spent, pushes succeed.
   *
   * @param connectionId - The connection.
   * @param outcomes - The outcomes, in order.
   */
  script(connectionId: string, ...outcomes: PushResult[]): void {
    this.scripts.set(connectionId, outcomes);
  }

  /** @param connectionId - The connection. @param data - The frame. */
  post(connectionId: string, data: string): Promise<PushResult> {
    this.posted.push({ connectionId, data });
    const queue = this.scripts.get(connectionId);
    const next = queue?.shift();
    return Promise.resolve(next ?? "SENT");
  }

  /** @param connectionId - The connection. */
  close(connectionId: string): Promise<void> {
    this.closed.push(connectionId);
    return Promise.resolve();
  }

  /**
   * @returns The frames received, parsed.
   */
  frames(): WsServerMessage[] {
    return this.posted.map((entry) => JSON.parse(entry.data) as WsServerMessage);
  }
}

/** One counted metric, as the domain recorded it. */
export interface CountedMetric {
  readonly name: IngestMetricName;
  readonly dimension: IngestDimension | undefined;
  readonly amount: number;
}

/** Metrics fake that keeps every count and distribution. */
export class FakeIngestMetrics implements IngestMetricsPort {
  /** Every count, in order. */
  readonly counts: CountedMetric[] = [];
  /** Every distribution value, in order. */
  readonly records: { name: IngestDistributionName; value: number }[] = [];
  /** Number of publications. */
  publishes = 0;

  /**
   * @param name - The metric.
   * @param dimension - The dimension.
   * @param amount - The occurrences.
   */
  count(name: IngestMetricName, dimension?: IngestDimension, amount = 1): void {
    this.counts.push({ name, dimension, amount });
  }

  /** @param name - The distribution. @param value - The value. */
  record(name: IngestDistributionName, value: number): void {
    this.records.push({ name, value });
  }

  /** Counts one publication. */
  publishStoredMetrics(): void {
    this.publishes += 1;
  }

  /**
   * @param name - The metric.
   * @returns The sum of its occurrences.
   */
  total(name: IngestMetricName): number {
    return this.counts
      .filter((count) => count.name === name)
      .reduce((sum, count) => sum + count.amount, 0);
  }
}

/**
 * A subscribed connection fake record.
 *
 * @param connectionId - The connection identifier.
 * @param sessionExpiresAtMs - The session expiry, in milliseconds.
 * @returns The reference.
 */
export function connection(connectionId: string, sessionExpiresAtMs: number): ConnectionRef {
  return {
    connectionId,
    role: "Operator",
    sessionExpiresAtMs,
  };
}

/**
 * A telemetry sample of the fleet delta, with the fields the delta carries.
 *
 * @param robotId - The robot.
 * @param overrides - Fields to change.
 * @returns The sample.
 */
export function sampleOf(
  robotId: RobotId,
  overrides: Partial<FleetRobotSample> = {},
): FleetRobotSample {
  return {
    robotId,
    bootId: BOOT_A,
    seq: 1,
    ts: "2026-11-02T10:00:00.000Z",
    x: 1,
    y: 2,
    heading: 0.5,
    speed: 0.4,
    battery: 80,
    state: "MOVING",
    ...overrides,
  };
}
