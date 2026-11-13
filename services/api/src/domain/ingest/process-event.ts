/**
 * Processing of one classified delivery of the events, acknowledgement and presence channels.
 *
 * The order of effects is fixed: the durable writes first (state, history, alerts), then the live relay to
 * the WebSocket connections. The relay never throws, so a failed push cannot fail a delivery that already
 * changed the store. The state write is not a gate: a retried delivery sees `STALE` and still completes the
 * other steps, because the fact it reports happened.
 *
 * Alerts are opened here and only here, from reliable events and presence. Telemetry never opens an alert,
 * so one condition has one writer.
 */
import type {
  AlertKind,
  AlertRecord,
  IsoMs,
  Role,
  RobotId,
  RobotReportedState,
  SiteId,
  WsServerMessage,
} from "@mfc/protocol";
import type {
  AlertPort,
  ConnectionsPort,
  FleetStatePort,
  HistoryPort,
  PushPort,
  StateObservation,
} from "../live/ports";
import { openAlertRecord } from "../live/alerts";
import type { Clock, DomainLogger } from "../ports";
import { safeErrorFields } from "../safe-error";
import { fanOut, type DeliveryMode, type FanOutResult } from "../realtime/fanout";
import type { IngestMetricsPort } from "./metrics";
import type { IngestOutcome } from "./classify";

/** Ports of the processing of an event, an acknowledgement or a presence notice. */
export interface ProcessDeps {
  readonly state: FleetStatePort;
  readonly alerts: AlertPort;
  readonly history: HistoryPort;
  readonly connections: ConnectionsPort;
  readonly push: PushPort;
  readonly clock: Clock;
  readonly logger: DomainLogger;
  readonly metrics: IngestMetricsPort;
}

/** The accepted robot event. */
type EventOutcome = Extract<IngestOutcome, { kind: "event" }>;

/** The accepted presence notice. */
type PresenceOutcome = Extract<IngestOutcome, { kind: "presence" }>;

/** The accepted acknowledgement. */
type AckOutcome = Extract<IngestOutcome, { kind: "ack" }>;

/**
 * Converts a broker millisecond time into the protocol's UTC format. An out-of-range value falls back to
 * the cloud clock, so a malformed lifecycle timestamp cannot make the presence relay throw.
 *
 * @param ms - The broker time, in milliseconds since the epoch.
 * @param clock - The cloud clock, used for the fallback.
 * @returns The time in the fixed UTC millisecond format.
 */
function isoOf(ms: number, clock: Clock): IsoMs {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? clock.now().toISOString() : date.toISOString();
}

/**
 * Counts the outcome of a fan-out, one metric per kind of delivery that happened.
 *
 * @param metrics - The metrics sink.
 * @param result - The counts of the fan-out.
 */
function countFanOut(metrics: IngestMetricsPort, result: FanOutResult): void {
  if (result.sent > 0) {
    metrics.count("FanOutSent", undefined, result.sent);
  }
  if (result.gone > 0) {
    metrics.count("FanOutGone", undefined, result.gone);
  }
  if (result.failed > 0) {
    metrics.count("FanOutFailed", undefined, result.failed);
  }
  if (result.expired > 0) {
    metrics.count("FanOutExpired", undefined, result.expired);
  }
  if (result.truncated) {
    metrics.count("FanOutTruncated");
  }
}

/**
 * Sends one frame to the subscribers of a site. Never throws: a failure is counted and logged by name.
 *
 * @param deps - The ports.
 * @param siteId - The site of the frame.
 * @param message - The frame.
 * @param mode - The delivery mode of the frame.
 */
async function relay(
  deps: ProcessDeps,
  siteId: SiteId,
  message: WsServerMessage,
  mode: DeliveryMode,
  audience?: readonly Role[],
): Promise<void> {
  try {
    const result = await fanOut(
      siteId,
      [message],
      mode,
      {
        connections: deps.connections,
        push: deps.push,
        clock: deps.clock,
        logger: deps.logger,
      },
      audience,
    );
    countFanOut(deps.metrics, result);
  } catch (error) {
    deps.metrics.count("FanOutListFailed");
    deps.logger.warn("relay failed", safeErrorFields(error));
  }
}

/**
 * Writes an observation and counts how the store answered.
 *
 * @param deps - The ports.
 * @param observation - The observation.
 */
async function observe(deps: ProcessDeps, observation: StateObservation): Promise<void> {
  const outcome = await deps.state.observe(observation);
  deps.metrics.count("StateObserved", { name: "outcome", value: outcome });
  if (outcome === "STALE_BOOT") {
    deps.metrics.count("StaleBootRefused");
    deps.logger.warn("state refused: stored boot is later", { robotId: observation.robotId });
  }
}

/**
 * Opens an alert and counts the result. A duplicate or an alert already open for the robot opens nothing.
 *
 * @param deps - The ports.
 * @param input - The alert facts.
 * @returns The record when this call opened the alert, otherwise undefined.
 */
async function openAlert(
  deps: ProcessDeps,
  input: Parameters<typeof openAlertRecord>[0],
): Promise<AlertRecord | undefined> {
  const alert = openAlertRecord(input);
  const outcome = await deps.alerts.open(alert);
  if (outcome === "OPENED") {
    deps.metrics.count("AlertOpened", { name: "kind", value: alert.kind });
    return alert;
  }
  deps.metrics.count("AlertDeduplicated");
  return undefined;
}

/**
 * Sends the frame announcing an opened alert.
 *
 * @param deps - The ports.
 * @param siteId - The site of the alert.
 * @param alert - The opened alert.
 */
function relayAlert(deps: ProcessDeps, siteId: SiteId, alert: AlertRecord): Promise<void> {
  return relay(
    deps,
    siteId,
    { type: "alert.changed", siteId, change: "OPENED", alert },
    "reliable",
  );
}

/**
 * The alert a state opens, if any: an emergency stop is Critical, a block is Major.
 *
 * @param state - The state the robot entered.
 * @returns The kind of alert, or undefined when the state opens none.
 */
function alertKindOfState(state: RobotReportedState): AlertKind | undefined {
  switch (state) {
    case "ESTOP":
      return "ESTOP";
    case "BLOCKED":
      return "BLOCKED";
    default:
      return undefined;
  }
}

/**
 * Processes a robot event: the state, the history and the alerts it implies, then the live relay.
 *
 * @param outcome - The accepted event.
 * @param deps - The ports.
 */
async function processEvent(outcome: EventOutcome, deps: ProcessDeps): Promise<void> {
  const { event, robotId, siteId, receivedAt } = outcome;
  const base = {
    siteId,
    robotId,
    bootId: event.bootId,
    seq: event.seq,
    ts: event.ts,
    receivedAt,
    source: "event" as const,
  };
  const relayEvent = (): Promise<void> =>
    relay(deps, siteId, { type: "robot.event", siteId, robotId, event }, "reliable");

  switch (event.kind) {
    case "HEARTBEAT":
      // A heartbeat carries the state and the battery: no history, no alert, no relay.
      await observe(deps, { ...base, state: event.state, battery: event.battery });
      return;
    case "BOOT":
      await observe(deps, { ...base, state: event.state });
      await relayEvent();
      return;
    case "STATE_CHANGED": {
      await observe(deps, { ...base, state: event.to });
      await deps.history.putState({
        siteId,
        robotId,
        ts: event.ts,
        messageId: event.messageId,
        from: event.from,
        to: event.to,
        cause: event.cause,
        commandId: event.commandId,
      });
      const kind = alertKindOfState(event.to);
      const opened =
        kind === undefined
          ? undefined
          : await openAlert(deps, {
              siteId,
              robotId,
              kind,
              sourceKey: event.messageId,
              sourceMessageId: event.messageId,
              openedAt: event.ts,
              cause: event.cause,
            });
      if (event.cause === "WORK_DONE" && event.to === "IDLE") {
        await deps.history.putMission({
          siteId,
          robotId,
          ts: event.ts,
          messageId: event.messageId,
        });
      }
      await relayEvent();
      if (opened !== undefined) {
        await relayAlert(deps, siteId, opened);
      }
      return;
    }
    case "FAULT_RAISED": {
      const opened =
        event.fault === "BATTERY_LOW"
          ? await openAlert(deps, {
              siteId,
              robotId,
              kind: "LOW_BATTERY",
              sourceKey: event.messageId,
              sourceMessageId: event.messageId,
              openedAt: event.ts,
              cause: event.fault,
            })
          : undefined;
      await relayEvent();
      if (opened !== undefined) {
        await relayAlert(deps, siteId, opened);
      }
      return;
    }
    case "GOING_OFFLINE":
      await deps.state.markGoodbye({ siteId, robotId, bootId: event.bootId });
      await relayEvent();
      return;
    case "FAULT_CLEARED":
    case "LOCK_CHANGED":
      await relayEvent();
      return;
  }
}

/**
 * Roles that receive a command acknowledgement. The acknowledgement carries the command identifier, which
 * names an operator's action, so a viewer (read-only) does not receive it.
 */
const COMMAND_ACK_AUDIENCE: readonly Role[] = ["Admin", "Operator"];

/**
 * Processes an acknowledgement: relayed to the console, which correlates it with its request.
 *
 * @param outcome - The accepted acknowledgement.
 * @param deps - The ports.
 */
function processAck(outcome: AckOutcome, deps: ProcessDeps): Promise<void> {
  return relay(
    deps,
    outcome.siteId,
    { type: "command.ack", siteId: outcome.siteId, ack: outcome.ack },
    "reliable",
    COMMAND_ACK_AUDIENCE,
  );
}

/**
 * Whether a robot's disconnect was a clean shutdown: it announced a goodbye for the boot it was running.
 *
 * @param deps - The ports.
 * @param siteId - The site of the robot.
 * @param robotId - The robot.
 * @returns `true` when the last goodbye is for the boot of the stored state.
 */
async function isCleanShutdown(
  deps: ProcessDeps,
  siteId: SiteId,
  robotId: RobotId,
): Promise<boolean> {
  const goodbye = await deps.state.readGoodbye(siteId, robotId);
  return goodbye.goodbyeBootId !== undefined && goodbye.goodbyeBootId === goodbye.bootId;
}

/**
 * Processes a presence notice. A connection that fails changes nothing: it is logged and counted (R28).
 *
 * @param outcome - The presence notice.
 * @param deps - The ports.
 */
async function processPresence(outcome: PresenceOutcome, deps: ProcessDeps): Promise<void> {
  if (outcome.robotId === null || outcome.eventType === "connect_failed") {
    if (outcome.robotId === null) {
      deps.metrics.count("PresenceUnknownRobot");
    }
    return;
  }
  const robotId = outcome.robotId;
  const siteId = await deps.state.siteOf(robotId);
  if (siteId === null) {
    deps.metrics.count("PresenceUnknownRobot");
    return;
  }
  const change = { siteId, robotId, atMs: outcome.timestamp, version: outcome.versionNumber };

  if (outcome.eventType === "connected") {
    const applied = await deps.state.markOnline(change);
    if (applied === "APPLIED") {
      await relay(
        deps,
        siteId,
        {
          type: "robot.presence",
          siteId,
          robotId,
          presence: "ONLINE",
          at: isoOf(outcome.timestamp, deps.clock),
        },
        "reliable",
      );
    }
    return;
  }

  const applied = await deps.state.markOffline(change);
  if (applied !== "APPLIED") {
    return;
  }
  const at = isoOf(outcome.timestamp, deps.clock);
  const cleanShutdown =
    outcome.clientInitiatedDisconnect === true && (await isCleanShutdown(deps, siteId, robotId));
  const opened = cleanShutdown
    ? undefined
    : await openAlert(deps, {
        siteId,
        robotId,
        kind: "OFFLINE",
        sourceKey: `disconnect:${String(outcome.timestamp)}`,
        openedAt: at,
        cause: outcome.disconnectReason,
      });
  await relay(
    deps,
    siteId,
    { type: "robot.presence", siteId, robotId, presence: "OFFLINE", at },
    "reliable",
  );
  if (opened !== undefined) {
    await relayAlert(deps, siteId, opened);
  }
}

/**
 * Processes one classified delivery. A rejected delivery has no effect here: the handler logs it.
 *
 * @param outcome - The outcome of the classification.
 * @param deps - The ports.
 * @throws On infrastructure errors of the store, so the runtime retries the delivery.
 */
export async function processOutcome(outcome: IngestOutcome, deps: ProcessDeps): Promise<void> {
  switch (outcome.kind) {
    case "event":
      await processEvent(outcome, deps);
      return;
    case "ack":
      await processAck(outcome, deps);
      return;
    case "presence":
      await processPresence(outcome, deps);
      return;
    case "rejected":
      return;
  }
}
