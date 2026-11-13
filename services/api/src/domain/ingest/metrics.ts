/**
 * Metrics of the ingest functions: the names and dimensions they count, and the port the domain writes to.
 *
 * The domain counts occurrences; the handler publishes them once per invocation as embedded metric format.
 */
import type { AlertKind } from "@mfc/protocol";
import type { ObserveOutcome } from "../live/ports";
import type { IngestRejectReason, PresenceEventType } from "./classify";

/** Names of the counted metrics of the ingest functions. */
export type IngestMetricName =
  | "RobotMessageAccepted"
  | "RobotMessageRejected"
  | "PresenceEvent"
  | "PresenceUnknownRobot"
  | "AlertOpened"
  | "AlertDeduplicated"
  | "StateObserved"
  | "FanOutSent"
  | "FanOutGone"
  | "FanOutFailed"
  | "FanOutListFailed"
  | "FanOutExpired"
  | "FanOutTruncated"
  | "TelemetryAccepted"
  | "TelemetryRejected"
  | "TelemetrySuperseded"
  | "TelemetryStale"
  | "TelemetryPersisted"
  | "TelemetryRefused"
  | "TelemetryDeferred"
  | "TelemetryPersistFailed"
  | "StaleBootRefused";

/** Names of the distributions the ingest functions record. */
export type IngestDistributionName = "BatchSize" | "IngestLatencyMs";

/** One dimension of a counted metric. */
export type IngestDimension =
  | { readonly name: "channel"; readonly value: "events" | "ack" }
  | { readonly name: "reason"; readonly value: IngestRejectReason }
  | { readonly name: "eventType"; readonly value: PresenceEventType }
  | { readonly name: "kind"; readonly value: AlertKind }
  | { readonly name: "outcome"; readonly value: ObserveOutcome };

/** Metrics sink of the ingest functions, published once per invocation. */
export interface IngestMetricsPort {
  /**
   * Counts occurrences of a metric.
   *
   * @param name - The metric.
   * @param dimension - The dimension of the occurrences, when the metric has one.
   * @param amount - How many occurrences to add. Defaults to one.
   */
  count(name: IngestMetricName, dimension?: IngestDimension, amount?: number): void;
  /**
   * Records one value of a distribution.
   *
   * @param name - The distribution.
   * @param value - The value, in the distribution's unit.
   */
  record(name: IngestDistributionName, value: number): void;
  /** Publishes the stored metrics of the invocation. */
  publishStoredMetrics(): void;
}
