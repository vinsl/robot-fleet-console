/**
 * Relay of the `lock.changed` frames: every role receives them, the frame is valid, and a failure never escapes.
 */
import { WsServerMessageSchema } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { createControlRelay } from "../../../src/domain/control/relay";
import type { ConnectionsPort, PushPort } from "../../../src/domain/live/ports";
import { CONTROL_ROBOT, CONTROL_SITE, CONTROL_START } from "../../fakes/control";
import { FixedClock } from "../../fakes/fixed";
import { RecordingLogger } from "../../fakes/recording";

/** Connections fake listing one connection per role, and failing when told to. */
class ThreeRoles implements ConnectionsPort {
  failure: Error | undefined = undefined;

  listSubscribed(): ReturnType<ConnectionsPort["listSubscribed"]> {
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve({
      connections: [
        {
          connectionId: "c-admin",
          role: "Admin",
          sessionExpiresAtMs: Date.parse("2026-11-04T11:00:00.000Z"),
        },
        {
          connectionId: "c-operator",
          role: "Operator",
          sessionExpiresAtMs: Date.parse("2026-11-04T11:00:00.000Z"),
        },
        {
          connectionId: "c-viewer",
          role: "Viewer",
          sessionExpiresAtMs: Date.parse("2026-11-04T11:00:00.000Z"),
        },
      ],
      truncated: false,
    });
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }
}

/** Push fake that keeps every frame it posts, by connection. */
class RecordingPush implements PushPort {
  readonly posted: { readonly connectionId: string; readonly data: string }[] = [];

  post(connectionId: string, data: string): Promise<"SENT"> {
    this.posted.push({ connectionId, data });
    return Promise.resolve("SENT");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Builds the relay over fakes.
 *
 * @returns The relay and the fakes behind it.
 */
function relayWorld() {
  const connections = new ThreeRoles();
  const push = new RecordingPush();
  const logger = new RecordingLogger();
  const relay = createControlRelay({
    connections,
    push,
    clock: new FixedClock(CONTROL_START),
    logger,
  });
  return { relay, connections, push, logger };
}

describe("createControlRelay", () => {
  it("sends one reliable lock.changed frame to every role, and the protocol accepts it", async () => {
    const { relay, push } = relayWorld();
    await relay.lockChanged(
      CONTROL_SITE,
      CONTROL_ROBOT,
      true,
      "00000000-0000-4000-8000-0000000000a1",
      "ACQUIRED",
    );

    expect(push.posted.map((entry) => entry.connectionId).sort()).toEqual([
      "c-admin",
      "c-operator",
      "c-viewer",
    ]);
    const frame = WsServerMessageSchema.parse(JSON.parse(push.posted[0]?.data ?? "null"));
    expect(frame).toEqual({
      type: "lock.changed",
      siteId: CONTROL_SITE,
      robotId: CONTROL_ROBOT,
      held: true,
      holder: "00000000-0000-4000-8000-0000000000a1",
      cause: "ACQUIRED",
    });
  });

  it("omits the holder of a free lock", async () => {
    const { relay, push } = relayWorld();
    await relay.lockChanged(CONTROL_SITE, CONTROL_ROBOT, false, undefined, "RELEASED");

    const frame: unknown = JSON.parse(push.posted[0]?.data ?? "null");
    expect(frame).not.toHaveProperty("holder");
    expect(WsServerMessageSchema.safeParse(frame).success).toBe(true);
  });

  it("relay-never-throws", async () => {
    const { relay, connections, logger } = relayWorld();
    connections.failure = new Error("connections table throttled");

    await expect(
      relay.lockChanged(CONTROL_SITE, CONTROL_ROBOT, false, undefined, "RELEASED"),
    ).resolves.toBeUndefined();
    expect(logger.entries.some((entry) => entry.level === "warn")).toBe(true);
  });
});
