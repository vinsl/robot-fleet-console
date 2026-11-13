import { describe, expect, it } from "vitest";
import { WsServerMessageSchema, type AlertRecord } from "@mfc/protocol";
import { createAlertRelay } from "../../../src/domain/alerts/relay";
import type { ConnectionsPort, PushPort } from "../../../src/domain/live/ports";
import { alertOf, CountingAlertsMetrics, SITE_ID } from "../../fakes/alerts";
import { FixedClock } from "../../fakes/fixed";
import { RecordingLogger } from "../../fakes/recording";

/** Connections fake that lists one operator connection, and can be told to fail. */
class OneConnection implements ConnectionsPort {
  failure: Error | undefined = undefined;

  listSubscribed(): ReturnType<ConnectionsPort["listSubscribed"]> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve({
      connections: [
        {
          connectionId: "conn-1",
          role: "Operator",
          sessionExpiresAtMs: Date.parse("2026-11-03T11:00:00.000Z"),
        },
      ],
      truncated: false,
    });
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }
}

/** Push fake that keeps every frame it posts. */
class RecordingPush implements PushPort {
  readonly posted: string[] = [];

  post(_connectionId: string, data: string): Promise<"SENT"> {
    this.posted.push(data);
    return Promise.resolve("SENT");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Builds a relay over fakes.
 *
 * @returns The relay and the fakes behind it.
 */
function relayWorld(): {
  relay: ReturnType<typeof createAlertRelay>;
  connections: OneConnection;
  push: RecordingPush;
  logger: RecordingLogger;
  metrics: CountingAlertsMetrics;
} {
  const connections = new OneConnection();
  const push = new RecordingPush();
  const logger = new RecordingLogger();
  const metrics = new CountingAlertsMetrics();
  const relay = createAlertRelay({
    connections,
    push,
    clock: new FixedClock(new Date("2026-11-03T10:00:00.000Z")),
    logger,
    metrics,
  });
  return { relay, connections, push, logger, metrics };
}

describe("createAlertRelay", () => {
  it("posts one reliable alert.changed frame that the protocol accepts", async () => {
    const { relay, push } = relayWorld();
    const alert: AlertRecord = alertOf({
      status: "ACKNOWLEDGED",
      acknowledgedBy: "user-sub-1",
      acknowledgedAt: "2026-11-02T10:05:00.000Z",
    });

    await relay.alertChanged(SITE_ID, "ACKNOWLEDGED", alert);

    expect(push.posted).toHaveLength(1);
    const frame = WsServerMessageSchema.parse(JSON.parse(push.posted[0] ?? "null"));
    expect(frame).toEqual({
      type: "alert.changed",
      siteId: SITE_ID,
      change: "ACKNOWLEDGED",
      alert,
    });
  });

  it("swallows a failing fan-out and logs it by its error name only", async () => {
    const { relay, connections, logger, push } = relayWorld();
    connections.failure = new Error("connections table throttled");

    await expect(relay.alertChanged(SITE_ID, "RESOLVED", alertOf())).resolves.toBeUndefined();

    expect(push.posted).toHaveLength(0);
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(true);
    expect(logger.text()).not.toContain("connections table throttled");
  });
});
