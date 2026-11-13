/**
 * Fan-out: the expired and gone connections, the retry rule of each mode, the bounded closes, the site
 * isolation, and the failures that must not escape.
 */
import type { ConnectionRef, ConnectionsPort, PushPort } from "../../../src/domain/live/ports";
import { describe, expect, it } from "vitest";
import { fanOut, type FanOutDeps } from "../../../src/domain/realtime/fanout";
import type { WsServerMessage } from "@mfc/protocol";
import { FixedClock } from "../../fakes/fixed";
import { RecordingLogger } from "../../fakes/recording";
import { FakeConnections, FakePush, connection } from "../../fakes/live";

/** The instant of the tests. */
const NOW = new Date("2026-11-02T10:00:00.000Z");

/** A session expiring in the future. */
const LIVE = NOW.getTime() + 3_600_000;

/** A session that has already expired. */
const EXPIRED = NOW.getTime() - 1;

/** A frame of the tests. */
const FRAME: WsServerMessage = {
  type: "robot.presence",
  siteId: "paris-01",
  robotId: "kali-01",
  presence: "ONLINE",
  at: NOW.toISOString(),
};

/**
 * Builds the dependencies of a fan-out over the fakes.
 *
 * @param connections - The connection store.
 * @param push - The push port.
 * @param extra - Settings to override.
 * @returns The dependencies and the logger.
 */
function depsOf(
  connections: ConnectionsPort,
  push: PushPort,
  extra: Partial<FanOutDeps> = {},
): { deps: FanOutDeps; logger: RecordingLogger } {
  const logger = new RecordingLogger();
  return {
    deps: { connections, push, clock: new FixedClock(NOW), logger, ...extra },
    logger,
  };
}

describe("fanOut: one connection of each kind", () => {
  it("closes and removes the expired one, removes the gone one, and sends to the live one", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [
      connection("expired", EXPIRED),
      connection("gone", LIVE),
      connection("ok", LIVE),
    ]);
    const push = new FakePush();
    push.script("gone", "GONE");
    const { deps } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result).toStrictEqual({
      recipients: 2,
      sent: 1,
      gone: 1,
      failed: 0,
      expired: 1,
      truncated: false,
    });
    expect(push.closed).toStrictEqual(["expired"]);
    expect(connections.removed.sort()).toStrictEqual(["expired", "gone"]);
    expect(push.posted.map((entry) => entry.connectionId).sort()).toStrictEqual(["gone", "ok"]);
  });

  it("sends the serialised frame, once per message and connection", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("a", LIVE), connection("b", LIVE)]);
    const push = new FakePush();
    const { deps } = depsOf(connections, push);

    await fanOut("paris-01", [FRAME, FRAME], "reliable", deps);

    expect(push.posted).toHaveLength(4);
    expect(push.posted[0]?.data).toBe(JSON.stringify(FRAME));
  });
});

describe("fanOut: retries", () => {
  it("retries a failed reliable push once and counts the success", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("ok", LIVE)]);
    const push = new FakePush();
    push.script("ok", "FAILED", "SENT");
    const { deps } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "reliable", deps);

    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(push.posted).toHaveLength(2);
  });

  it("counts a reliable push that fails twice, after one retry", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("ok", LIVE)]);
    const push = new FakePush();
    push.script("ok", "FAILED", "FAILED");
    const { deps } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "reliable", deps);

    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(push.posted).toHaveLength(2);
  });

  it("never retries a droppable frame", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("ok", LIVE)]);
    const push = new FakePush();
    push.script("ok", "FAILED");
    const { deps } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result).toMatchObject({ sent: 0, failed: 1 });
    expect(push.posted).toHaveLength(1);
  });
});

describe("fanOut: bounds and isolation", () => {
  it("closes at most the bound of expired sessions per call and skips the rest", async () => {
    const connections = new FakeConnections();
    const expired: ConnectionRef[] = [];
    for (let i = 0; i < 7; i += 1) {
      expired.push(connection(`e-${String(i)}`, EXPIRED));
    }
    connections.bySite.set("paris-01", expired);
    const push = new FakePush();
    const { deps } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result.expired).toBe(7);
    expect(push.closed).toHaveLength(5);
    expect(connections.removed).toHaveLength(5);
  });

  it("never sends to a connection of another site", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("site-a", LIVE)]);
    connections.bySite.set("lyon-02", [connection("site-b", LIVE)]);
    const push = new FakePush();
    const { deps } = depsOf(connections, push);

    await fanOut("paris-01", [FRAME], "reliable", deps);

    expect(push.posted.map((entry) => entry.connectionId)).toStrictEqual(["site-a"]);
  });

  it("sends the frames of one connection one after the other, in order", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("ok", LIVE)]);
    let inFlight = 0;
    let maxInFlight = 0;
    const posted: string[] = [];
    const push: PushPort = {
      post: async (_connectionId, data) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        posted.push(data);
        inFlight -= 1;
        return "SENT";
      },
      close: () => Promise.resolve(),
    };
    const { deps } = depsOf(connections, push);

    await fanOut(
      "paris-01",
      [FRAME, { ...FRAME, at: "2026-11-02T10:00:01.000Z" }],
      "droppable",
      deps,
    );

    expect(maxInFlight).toBe(1);
    expect(posted.map((data) => (JSON.parse(data) as { at: string }).at)).toStrictEqual([
      NOW.toISOString(),
      "2026-11-02T10:00:01.000Z",
    ]);
  });

  it("does not hold a push back while an expired session is being closed", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("expired", EXPIRED), connection("ok", LIVE)]);
    const posted: string[] = [];
    let releaseClose: () => void = () => undefined;
    const push: PushPort = {
      post: (connectionId) => {
        posted.push(connectionId);
        return Promise.resolve("SENT");
      },
      close: () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    };
    const { deps } = depsOf(connections, push);

    const pending = fanOut("paris-01", [FRAME], "droppable", deps);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(posted).toStrictEqual(["ok"]);
    releaseClose();
    await expect(pending).resolves.toMatchObject({ recipients: 1, expired: 1 });
  });

  it("sends a command acknowledgement only to the roles of the audience", async () => {
    const connections = new FakeConnections();
    const viewer = { ...connection("viewer", LIVE), role: "Viewer" as const };
    const operator = { ...connection("operator", LIVE), role: "Operator" as const };
    connections.bySite.set("paris-01", [viewer, operator]);
    const push = new FakePush();
    const { deps } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "reliable", deps, ["Admin", "Operator"]);

    expect(result).toMatchObject({ recipients: 1, sent: 1 });
    expect(push.posted.map((entry) => entry.connectionId)).toStrictEqual(["operator"]);
  });

  it("counts the expired sessions and warns when the listing is truncated", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("expired", EXPIRED)]);
    connections.truncatedSites.add("paris-01");
    const { deps, logger } = depsOf(connections, new FakePush());

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result).toMatchObject({ expired: 1, truncated: true });
    expect(logger.entries).toContainEqual(
      expect.objectContaining({ level: "warn", message: "fan-out listing truncated" }),
    );
  });

  it("reports the truncation of the listing", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("a", LIVE)]);
    connections.truncatedSites.add("paris-01");
    const { deps } = depsOf(connections, new FakePush());

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result.truncated).toBe(true);
  });

  it("sends nothing when no connection is subscribed", async () => {
    const push = new FakePush();
    const { deps } = depsOf(new FakeConnections(), push);

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result).toMatchObject({ recipients: 0, sent: 0 });
    expect(push.posted).toStrictEqual([]);
  });

  it("rejects when the listing fails, so the caller can count it", async () => {
    const connections = new FakeConnections();
    connections.failingSites.add("paris-01");
    const { deps } = depsOf(connections, new FakePush());

    await expect(fanOut("paris-01", [FRAME], "droppable", deps)).rejects.toThrow(
      "listing unavailable",
    );
  });
});

describe("fanOut: failures that must not escape", () => {
  it("treats a push that throws as failed, never as a rejection", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("ok", LIVE)]);
    const push: PushPort = {
      post: () => Promise.reject(new Error("socket reset")),
      close: () => Promise.resolve(),
    };
    const { deps } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result).toMatchObject({ sent: 0, failed: 1 });
  });

  it("logs a failed record removal by name and carries on", async () => {
    const connections: ConnectionsPort = {
      listSubscribed: () =>
        Promise.resolve({ connections: [connection("gone", LIVE)], truncated: false }),
      remove: () => Promise.reject(new Error("table unavailable")),
    };
    const push = new FakePush();
    push.script("gone", "GONE");
    const { deps, logger } = depsOf(connections, push);

    const result = await fanOut("paris-01", [FRAME], "droppable", deps);

    expect(result.gone).toBe(1);
    expect(logger.entries).toHaveLength(1);
    expect(logger.entries[0]?.message).toBe("connection record removal failed");
  });

  it("refuses to serialise a frame that breaks the protocol schema", async () => {
    const connections = new FakeConnections();
    connections.bySite.set("paris-01", [connection("ok", LIVE)]);
    const invalid = { type: "robot.presence", siteId: "paris-01" } as unknown as WsServerMessage;
    const { deps } = depsOf(connections, new FakePush());

    await expect(fanOut("paris-01", [invalid], "droppable", deps)).rejects.toThrow();
  });
});
