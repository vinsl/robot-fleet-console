/**
 * Processing of one batch of telemetry from the queue: classification, ordering, persistence and the
 * live fan-out to the WebSocket connections of each site.
 *
 * Order of effects inside a batch: the samples are classified; the newest sample of each robot is kept; the
 * samples the container has already passed are dropped; the write policy decides which samples are stored,
 * and the store refuses the ones older than what it holds; then one aggregated frame per site is fanned out.
 * The stored state is durable before the frame is sent, and the frame is best effort.
 *
 * A failed write is reported by its queue message id, so the queue redelivers that robot's messages. Every
 * other message is acknowledged, including the rejected ones: a rejection is final.
 */
import type { FleetRobotSample, IsoMs, RobotId, SiteId, Telemetry } from "@mfc/protocol";
import type { ConnectionsPort, FleetStatePort, PushPort, StateObservation } from "../live/ports";
import { isNewer, latestPerRobot } from "../live/state-order";
import type { PersistPolicy } from "../live/persist-policy";
import type { Clock, Deadline, DomainLogger } from "../ports";
import { safeErrorFields } from "../safe-error";
import { buildFleetDelta } from "../realtime/messages";
import { fanOut } from "../realtime/fanout";
import {
  classifyTelemetryDelivery,
  type AcceptedTelemetry,
  type TelemetryOutcome,
} from "./telemetry";
import { rejectedDelivery, type IngestRejectReason } from "./classify";

/**
 * Time the invocation must still have left for the batch to write and fan out. Below it, the remaining
 * messages are returned for redelivery instead of being cut off by the function timeout.
 */
export const DEFERRAL_MARGIN_MS = 2000;

/** One queue message: its identifier and its body, which is the rule delivery as JSON text. */
export interface TelemetryRecord {
  readonly messageId: string;
  readonly body: string;
}

/** Ports and settings of a batch. */
export interface TelemetryDeps {
  readonly state: FleetStatePort;
  readonly connections: ConnectionsPort;
  readonly push: PushPort;
  readonly policy: PersistPolicy;
  readonly clock: Clock;
  readonly logger: DomainLogger;
  readonly deadline: Deadline;
}

/** Counts of one batch, published as metrics and logged once per invocation. */
export interface BatchStats {
  /** Messages received. */
  batchSize: number;
  /** Samples that passed every check. */
  accepted: number;
  /** Rejected messages, by reason. */
  rejected: Map<IngestRejectReason, number>;
  /** Samples replaced by a newer sample of the same robot in this batch. */
  superseded: number;
  /** Robots whose newest sample is older than one the container already passed. */
  stale: number;
  /** Samples written to the state store. */
  persisted: number;
  /** Samples the store refused as stale or late. */
  refused: number;
  /** Samples the store refused because it holds a sample of a later boot. */
  staleBootRefused: number;
  /** Samples whose write failed with an infrastructure error. */
  persistFailed: number;
  /** Messages returned unprocessed because the invocation was near its timeout. */
  deferred: number;
  /** Fan-out deliveries, summed over the sites. */
  fanOutSent: number;
  fanOutGone: number;
  fanOutFailed: number;
  /** Subscribed connections whose session had ended, summed over the sites. */
  fanOutExpired: number;
  /** Sites whose connection listing stopped before the end. */
  fanOutTruncated: number;
  /** Sites whose fan-out failed before any push (listing or framing). */
  fanOutListFailed: number;
  /** Age of the oldest sample fanned out, from the broker receive time. Undefined when none was. */
  ingestLatencyMs: number | undefined;
}

/** Result of a batch: the queue messages to redeliver, and the counts. */
export interface TelemetryBatchResult {
  readonly failedMessageIds: string[];
  readonly stats: BatchStats;
}

/** A sample kept for the fan-out, with the broker receive time and its site. */
interface KeptSample {
  readonly siteId: SiteId;
  readonly sample: FleetRobotSample;
  readonly receivedAt: number;
}

/**
 * Empty counts of a batch.
 *
 * @param batchSize - Messages received.
 * @returns Zeroed counts.
 */
function emptyStats(batchSize: number): BatchStats {
  return {
    batchSize,
    accepted: 0,
    rejected: new Map(),
    superseded: 0,
    stale: 0,
    persisted: 0,
    refused: 0,
    staleBootRefused: 0,
    persistFailed: 0,
    deferred: 0,
    fanOutSent: 0,
    fanOutGone: 0,
    fanOutFailed: 0,
    fanOutExpired: 0,
    fanOutTruncated: 0,
    fanOutListFailed: 0,
    ingestLatencyMs: undefined,
  };
}

/**
 * Classifies one queue body: it must be JSON, then a telemetry delivery.
 *
 * @param body - The message body.
 * @returns The accepted sample, or the rejection.
 */
function classifyBody(body: string): TelemetryOutcome {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return rejectedDelivery("NOT_JSON");
  }
  return classifyTelemetryDelivery(value);
}

/**
 * The fields of a telemetry message that a fleet delta carries.
 *
 * @param telemetry - The validated telemetry.
 * @returns The sample of the delta frame.
 */
function sampleOf(telemetry: Telemetry): FleetRobotSample {
  return {
    robotId: telemetry.robotId,
    bootId: telemetry.bootId,
    seq: telemetry.seq,
    ts: telemetry.ts,
    x: telemetry.x,
    y: telemetry.y,
    heading: telemetry.heading,
    speed: telemetry.speed,
    battery: telemetry.battery,
    state: telemetry.state,
    missionId: telemetry.missionId,
    errorCode: telemetry.errorCode,
  };
}

/**
 * The observation written for a sample.
 *
 * @param accepted - The accepted sample.
 * @returns The observation of the telemetry source.
 */
function observationOf(accepted: AcceptedTelemetry): StateObservation {
  const { telemetry } = accepted;
  return {
    siteId: accepted.siteId,
    robotId: accepted.robotId,
    bootId: telemetry.bootId,
    seq: telemetry.seq,
    ts: telemetry.ts,
    receivedAt: accepted.receivedAt,
    source: "telemetry",
    state: telemetry.state,
    battery: telemetry.battery,
    pose: { x: telemetry.x, y: telemetry.y, heading: telemetry.heading, speed: telemetry.speed },
    missionId: telemetry.missionId,
    errorCode: telemetry.errorCode,
  };
}

/**
 * Counts one rejection by reason.
 *
 * @param stats - The batch counts.
 * @param reason - The reason of the rejection.
 */
function countRejected(stats: BatchStats, reason: IngestRejectReason): void {
  stats.rejected.set(reason, (stats.rejected.get(reason) ?? 0) + 1);
}

/**
 * Fans the kept samples out, one aggregated frame per site. A failure is counted, never raised.
 *
 * @param kept - The kept samples, by site.
 * @param deps - The batch ports.
 * @param stats - The batch counts, updated in place.
 */
async function fanOutSites(
  kept: ReadonlyMap<SiteId, FleetRobotSample[]>,
  deps: TelemetryDeps,
  stats: BatchStats,
): Promise<void> {
  const sentAt: IsoMs = deps.clock.now().toISOString();
  for (const [siteId, samples] of kept) {
    try {
      const frames = buildFleetDelta(siteId, samples, sentAt);
      const result = await fanOut(siteId, frames, "droppable", {
        connections: deps.connections,
        push: deps.push,
        clock: deps.clock,
        logger: deps.logger,
      });
      stats.fanOutSent += result.sent;
      stats.fanOutGone += result.gone;
      stats.fanOutFailed += result.failed;
      stats.fanOutExpired += result.expired;
      if (result.truncated) {
        stats.fanOutTruncated += 1;
      }
    } catch (error) {
      stats.fanOutListFailed += 1;
      deps.logger.warn("fan-out failed", safeErrorFields(error));
    }
  }
}

/**
 * Processes one batch of queue messages.
 *
 * @param records - The messages of the batch.
 * @param deps - The ports, the policy and the deadline of the invocation.
 * @returns The message ids to redeliver, and the counts. Never throws on a bad message or a failed write.
 */
export async function processTelemetryBatch(
  records: readonly TelemetryRecord[],
  deps: TelemetryDeps,
): Promise<TelemetryBatchResult> {
  const stats = emptyStats(records.length);
  const failed = new Set<string>();
  const accepted: { readonly item: AcceptedTelemetry; readonly messageId: string }[] = [];

  for (const record of records) {
    const outcome = classifyBody(record.body);
    if (outcome.kind === "rejected") {
      countRejected(stats, outcome.reason);
      deps.logger.warn("telemetry rejected", { reason: outcome.reason, robotId: outcome.robotId });
      continue;
    }
    accepted.push({ item: outcome, messageId: record.messageId });
  }
  stats.accepted = accepted.length;

  const newest = latestPerRobot(
    accepted.map(({ item }) => ({
      ...item,
      bootId: item.telemetry.bootId,
      seq: item.telemetry.seq,
    })),
  );
  stats.superseded = newest.superseded;

  // Every queue message of a robot in this batch, so a failed write redelivers all of them.
  const messageIdsByRobot = new Map<RobotId, string[]>();
  for (const { item, messageId } of accepted) {
    const ids = messageIdsByRobot.get(item.robotId) ?? [];
    ids.push(messageId);
    messageIdsByRobot.set(item.robotId, ids);
  }

  const nowMs = deps.clock.now().getTime();
  const kept: KeptSample[] = [];
  for (const latest of newest.latest.values()) {
    const ids = messageIdsByRobot.get(latest.robotId) ?? [];
    if (deps.deadline.remainingMs() < DEFERRAL_MARGIN_MS) {
      stats.deferred += ids.length;
      ids.forEach((id) => failed.add(id));
      continue;
    }
    const { telemetry } = latest;
    if (!isNewer(deps.policy.lastSeen(latest.robotId), telemetry)) {
      stats.stale += 1;
      continue;
    }

    if (
      deps.policy.shouldPersist(
        {
          robotId: latest.robotId,
          bootId: telemetry.bootId,
          state: telemetry.state,
          missionId: telemetry.missionId,
        },
        nowMs,
      )
    ) {
      try {
        const outcome = await deps.state.observe(observationOf(latest));
        if (outcome !== "APPLIED") {
          stats.refused += 1;
          if (outcome === "STALE_BOOT") {
            stats.staleBootRefused += 1;
            deps.logger.warn("state refused: stored boot is later", { robotId: latest.robotId });
          }
          continue;
        }
        stats.persisted += 1;
        deps.policy.recordPersisted(
          {
            robotId: latest.robotId,
            bootId: telemetry.bootId,
            state: telemetry.state,
            missionId: telemetry.missionId,
          },
          nowMs,
        );
      } catch (error) {
        // A sample whose write failed is neither remembered nor fanned out: its redelivery must be processed,
        // and a client must not see a state the store does not hold.
        stats.persistFailed += 1;
        ids.forEach((id) => failed.add(id));
        deps.logger.error("telemetry state write failed", safeErrorFields(error));
        continue;
      }
    }
    deps.policy.recordSeen(latest.robotId, telemetry.bootId, telemetry.seq);
    kept.push({
      siteId: latest.siteId,
      sample: sampleOf(telemetry),
      receivedAt: latest.receivedAt,
    });
  }

  if (kept.length > 0 && deps.deadline.remainingMs() < DEFERRAL_MARGIN_MS) {
    // The fan-out is skipped near the timeout; the samples are already stored, so nothing is lost.
    return { failedMessageIds: [...failed], stats };
  }
  const bySite = new Map<SiteId, FleetRobotSample[]>();
  for (const entry of kept) {
    const samples = bySite.get(entry.siteId) ?? [];
    samples.push(entry.sample);
    bySite.set(entry.siteId, samples);
  }
  await fanOutSites(bySite, deps, stats);

  if (kept.length > 0) {
    const oldest = Math.min(...kept.map((entry) => entry.receivedAt));
    stats.ingestLatencyMs = nowMs - oldest;
  }
  return { failedMessageIds: [...failed], stats };
}
