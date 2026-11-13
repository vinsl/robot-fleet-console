/**
 * Powertools logger, metrics and tracer of one API function.
 *
 * The factory makes no AWS call: it only builds the three utilities, so importing a handler never
 * touches the network. The metrics namespace comes from `POWERTOOLS_METRICS_NAMESPACE` in the function
 * environment, which keeps one value in Terraform rather than one in code.
 */
import { Logger } from "@aws-lambda-powertools/logger";
import { Metrics, MetricUnit } from "@aws-lambda-powertools/metrics";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { Context } from "aws-lambda";
import type { DomainLogger } from "./domain/ports";
import type { WsMetricName, WsMetricsPort } from "./domain/ws/metrics";
import type {
  IngestDimension,
  IngestDistributionName,
  IngestMetricName,
  IngestMetricsPort,
} from "./domain/ingest/metrics";

/** Names of the API functions. Each one names its own log group and metric dimension. */
export type ServiceName =
  | "robots"
  | "ingest-events"
  | "ingest-telemetry"
  | "ws-token"
  | "ws-connect"
  | "ws-disconnect"
  | "ws-message"
  | "me"
  | "health"
  | "http-ws-token"
  | "site"
  | "alerts"
  | "control"
  | "audit";

/** Logger of a handler: the domain logger, plus the per-invocation context keys. */
export interface HandlerLogger extends DomainLogger {
  /** Adds the fields of the Lambda context to every entry. */
  addContext(context: Context): void;
  /** Adds keys to every entry until they are removed. */
  appendKeys(keys: Record<string, unknown>): void;
  /** Removes keys added by `appendKeys`. */
  removeKeys(keys: string[]): void;
}

/** The three Powertools utilities of one function. */
export interface Observability {
  /** Structured JSON logger. Carries the correlation id once the handler appends it. */
  readonly logger: Logger;
  /** Embedded metric format writer. Metrics are published once per invocation by the handler. */
  readonly metrics: Metrics;
  /** X-Ray tracer. Handlers decide which clients it wraps (see the robots handler). */
  readonly tracer: Tracer;
}

/**
 * Builds the logger, metrics and tracer of one function.
 *
 * @param serviceName - The function the utilities belong to.
 * @returns The three utilities, each tagged with the service name.
 */
export function createObservability(serviceName: ServiceName): Observability {
  return {
    logger: new Logger({ serviceName }),
    metrics: new Metrics({ serviceName }),
    tracer: new Tracer({ serviceName }),
  };
}

/**
 * Adapts the Powertools logger to the domain logger interface. The attributes are copied into a plain
 * object because Powertools types its extra input as an index-signature record.
 *
 * @param logger - The Powertools logger of the function.
 * @returns The logger the handler and the domain write to.
 */
export function handlerLogger(logger: Logger): HandlerLogger {
  return {
    debug: (message, attributes) => {
      logger.debug(message, { ...attributes });
    },
    info: (message, attributes) => {
      logger.info(message, { ...attributes });
    },
    warn: (message, attributes) => {
      logger.warn(message, { ...attributes });
    },
    error: (message, attributes) => {
      logger.error(message, { ...attributes });
    },
    addContext: (context) => {
      logger.addContext(context);
    },
    appendKeys: (keys) => {
      logger.appendKeys(keys);
    },
    removeKeys: (keys) => {
      logger.removeKeys(keys);
    },
  };
}

/**
 * Adapts the Powertools metrics to the ingest metrics port. Dimensions accumulate until the invocation
 * publishes them, so each invocation writes one embedded metric document.
 *
 * @param metrics - The Powertools metrics of the function.
 * @returns The ingest metrics port.
 */
export function ingestMetricsOf(metrics: Metrics): IngestMetricsPort {
  const addDimension = (dimension: IngestDimension | undefined): void => {
    if (dimension !== undefined) {
      metrics.addDimension(dimension.name, dimension.value);
    }
  };
  const unitOf = (name: IngestDistributionName) =>
    name === "IngestLatencyMs" ? MetricUnit.Milliseconds : MetricUnit.Count;
  return {
    count: (name: IngestMetricName, dimension?: IngestDimension, amount = 1) => {
      addDimension(dimension);
      metrics.addMetric(name, MetricUnit.Count, amount);
    },
    record: (name: IngestDistributionName, value: number) => {
      metrics.addMetric(name, unitOf(name), value);
    },
    publishStoredMetrics: () => {
      metrics.publishStoredMetrics();
    },
  };
}

/**
 * Adapts the Powertools metrics to the WebSocket metrics port. Each occurrence is added as one count; the
 * handler publishes the stored metrics once per invocation.
 *
 * @param metrics - The Powertools metrics of the function.
 * @returns The WebSocket metrics port.
 */
export function wsMetricsOf(metrics: Metrics): WsMetricsPort {
  return {
    count: (name: WsMetricName) => {
      metrics.addMetric(name, MetricUnit.Count, 1);
    },
    publishStoredMetrics: () => {
      metrics.publishStoredMetrics();
    },
  };
}
