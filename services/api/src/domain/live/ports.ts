/**
 * Ports of the live fleet state: the interfaces the ingest consumers and the WebSocket fan-out depend on.
 *
 * The adapters implement them over DynamoDB and the API Gateway management API; the tests over in-memory
 * fakes. Each port states the outcome the domain acts on, never the SDK condition behind it.
 */
import type {
  AlertRecord,
  FaultCode,
  MissionId,
  RobotId,
  RobotLiveState,
  RobotPose,
  RobotReportedState,
  Role,
  SiteId,
  RobotEvent,
} from "@mfc/protocol";

/** The source of a live-state observation: the telemetry channel, or a reliable event. */
export type ObserveSource = "telemetry" | "event";

/**
 * One observation of a robot's live state. Fields the source does not carry are absent: a BOOT or a
 * STATE_CHANGED event has no battery and no pose, and the write keeps the stored values for them.
 */
export interface StateObservation {
  readonly siteId: SiteId;
  readonly robotId: RobotId;
  readonly bootId: string;
  readonly seq: number;
  readonly ts: string;
  /** Broker receive time, in milliseconds since the epoch. */
  readonly receivedAt: number;
  readonly source: ObserveSource;
  readonly state: RobotReportedState;
  readonly battery?: number | undefined;
  readonly pose?: RobotPose | undefined;
  readonly missionId?: MissionId | undefined;
  readonly errorCode?: FaultCode | undefined;
}

/**
 * Outcome of an observation: applied; refused because a newer sample is stored; refused because the stored
 * sample belongs to a later boot (`STALE_BOOT`, counted apart: it reveals a robot that restarted or a clock fault);
 * or refused because the robot was marked OFFLINE after the sample was received (a late message must not revive it).
 */
export type ObserveOutcome = "APPLIED" | "STALE" | "STALE_BOOT" | "BEFORE_OFFLINE";

/** A presence change of a robot, with the version the broker assigned to the connection event. */
export interface PresenceChange {
  readonly siteId: SiteId;
  readonly robotId: RobotId;
  /** Time of the connection event, in milliseconds since the epoch. */
  readonly atMs: number;
  /** Version number of the lifecycle event, when the broker supplies one. */
  readonly version: number | undefined;
}

/** Outcome of a presence write: applied, or refused because a newer presence event is stored. */
export type PresenceOutcome = "APPLIED" | "STALE";

/** The goodbye of a robot: the boot it announced before leaving, and the boot the state holds. */
export interface GoodbyeRecord {
  /** Boot of the stored live state, when the robot has reported one. */
  readonly bootId: string | undefined;
  /** Boot named by the last `GOING_OFFLINE` event, when one was accepted. */
  readonly goodbyeBootId: string | undefined;
}

/** Live state of the fleet. */
export interface FleetStatePort {
  /**
   * Writes an observation when it is newer than the stored one (ordered by boot, then sequence) and the
   * robot was not marked OFFLINE after it was received.
   *
   * @throws On infrastructure errors only. A refused write is an outcome, not an error.
   */
  observe(observation: StateObservation): Promise<ObserveOutcome>;

  /** Marks a robot OFFLINE after a presence event, when that event is newer than the stored one. */
  markOffline(change: PresenceChange): Promise<PresenceOutcome>;

  /** Records a robot's connection, when that event is newer than the stored one. Does not change the state. */
  markOnline(change: PresenceChange): Promise<PresenceOutcome>;

  /** Records the boot a robot announced before leaving. */
  markGoodbye(change: { siteId: SiteId; robotId: RobotId; bootId: string }): Promise<void>;

  /** Reads the boot of the stored state and the boot of the last goodbye, for the offline rule. */
  readGoodbye(siteId: SiteId, robotId: RobotId): Promise<GoodbyeRecord>;

  /** Live state of every robot of a site that has reported at least once. */
  listSite(siteId: SiteId): Promise<RobotLiveState[]>;

  /** The site a robot is registered to, or `null` when it has no claim. */
  siteOf(robotId: RobotId): Promise<SiteId | null>;
}

/** Outcome of opening an alert: opened now, already stored for this message, or already open for the robot. */
export type AlertOpenOutcome = "OPENED" | "DUPLICATE" | "ALREADY_OPEN";

/** Alerts: opened once per condition and per source message. */
export interface AlertPort {
  /**
   * Stores an alert and marks its robot and kind as open, in one transaction.
   *
   * @param alert - The alert record, with its deterministic identifier.
   */
  open(alert: AlertRecord): Promise<AlertOpenOutcome>;
}

/** Outcome of a history write: written, or already stored for this message. */
export type HistoryWriteOutcome = "WRITTEN" | "DUPLICATE";

/** A state change of a robot, kept for the robot page timeline. */
export interface StateHistoryRecord {
  readonly siteId: SiteId;
  readonly robotId: RobotId;
  readonly ts: string;
  readonly messageId: string;
  readonly from: RobotReportedState;
  readonly to: RobotReportedState;
  readonly cause: string;
  readonly commandId?: string | undefined;
}

/** A completed mission, kept for the KPI view. */
export interface MissionHistoryRecord {
  readonly siteId: SiteId;
  readonly robotId: RobotId;
  readonly ts: string;
  readonly messageId: string;
  readonly missionId?: MissionId | undefined;
}

/** Durable history of state changes and missions. */
export interface HistoryPort {
  /** Stores one state change; a repeated message is `DUPLICATE`. */
  putState(record: StateHistoryRecord): Promise<HistoryWriteOutcome>;
  /** Stores one completed mission; a repeated message is `DUPLICATE`. */
  putMission(record: MissionHistoryRecord): Promise<HistoryWriteOutcome>;
}

/** A WebSocket connection subscribed to a site. */
export interface ConnectionRef {
  readonly connectionId: string;
  readonly role: Role;
  readonly sessionExpiresAtMs: number;
}

/** Connections of a site, with a flag when the listing stopped before the end. */
export interface SubscribedConnections {
  readonly connections: ConnectionRef[];
  /** `true` when more connections exist than the listing reads. */
  readonly truncated: boolean;
}

/** Store of the WebSocket connections. */
export interface ConnectionsPort {
  /** Connections subscribed to a site. Reads a bounded number of pages. */
  listSubscribed(siteId: SiteId): Promise<SubscribedConnections>;
  /** Removes a connection record. Removing an absent record succeeds. */
  remove(connectionId: string): Promise<void>;
}

/** Outcome of one push to a connection: sent, the connection is gone, or the push failed. */
export type PushResult = "SENT" | "GONE" | "FAILED";

/** Sends frames to WebSocket connections. */
export interface PushPort {
  /**
   * Posts one serialised frame to a connection. Never throws: a failure is `FAILED`.
   *
   * @param connectionId - The connection to post to.
   * @param data - The serialised frame.
   */
  post(connectionId: string, data: string): Promise<PushResult>;
  /** Closes a connection from the server side. Errors are swallowed. */
  close(connectionId: string): Promise<void>;
}

/** Type of the state change event, as the robot reports it. */
export type StateChangedEvent = Extract<RobotEvent, { kind: "STATE_CHANGED" }>;
