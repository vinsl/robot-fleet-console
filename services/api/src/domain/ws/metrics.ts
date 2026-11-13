/**
 * Metrics of the WebSocket functions: the names they count, and the port the domain writes to.
 *
 * The domain counts occurrences; the handler publishes them once per invocation as embedded metric format.
 * No metric carries a token, a subject or a site: a counter is only a count.
 */

/** Names of the counted metrics of the WebSocket functions. */
export type WsMetricName =
  | "WsTokenIssued"
  | "WsTokenRefused"
  | "WsTokenFailed"
  | "WsConnected"
  | "WsConnectRefused"
  | "WsConnectFailed"
  | "WsDisconnected"
  | "WsMessageRefused"
  | "WsSubscribed"
  | "WsSessionEnded"
  | "WsConnectionUnknown"
  | "WsPushFailed"
  | "WsSnapshotFailed"
  | "WsRateLimited"
  | "HeartbeatPublished"
  | "HeartbeatRefused"
  | "HeartbeatPublishFailed";

/** Metrics sink of the WebSocket functions. */
export interface WsMetricsPort {
  /**
   * Adds one occurrence of a metric.
   *
   * @param name - The metric.
   */
  count(name: WsMetricName): void;
  /** Publishes the stored metrics of the invocation. */
  publishStoredMetrics(): void;
}
