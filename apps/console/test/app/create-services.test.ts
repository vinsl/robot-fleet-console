/**
 * Wiring of the services: a subscription is sent on every open, and frames reach the fleet store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WsServerMessageSchema, uuidv7, type AlertRecord, type RuntimeConfig } from "@mfc/protocol";
import { QueryClient } from "@tanstack/react-query";
import { createServices } from "../../src/app/create-services";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { useCommandStore } from "../../src/control/command-store";
import { useLockStore } from "../../src/control/lock-store";
import { applyAlertFrame, subscribeAlertOpened } from "../../src/live/alerts-feed";
import { useFleetStore } from "../../src/live/fleet-store";
import { subscribeFrames } from "../../src/live/frame-bus";
import type { WebSocketLike } from "../../src/ws/ws-client";
import { useWsStore } from "../../src/ws/ws-store";
import { alertOf } from "../live/support";

const CONFIG: RuntimeConfig = {
  apiUrl: "https://abc123defg.execute-api.eu-west-3.amazonaws.com",
  wsUrl: "wss://xyz987wvut.execute-api.eu-west-3.amazonaws.com/ws",
  region: "eu-west-3",
  userPoolId: "eu-west-3_AbCdEf123",
  userPoolClientId: "abcdefghijklmnopqrstuvwxyz",
  identityPoolId: "eu-west-3:11111111-2222-3333-4444-555555555555",
};
const TOKEN = "a".repeat(43);
const TIMESTAMP = "2026-11-03T10:00:00.000Z";
const BOOT = "0190f3a2-7b1c-7000-8000-000000000001";

/** Socket double the test drives by hand. */
class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  readonly sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.(new CloseEvent("close"));
  }
}

let sockets: FakeSocket[];

/** Removes the module-level listeners a case subscribed, after the case, even when it fails. */
const removals: (() => void)[] = [];

beforeEach(() => {
  sockets = [];
  useFleetStore.getState().reset(0);
  useWsStore.setState({ connection: "idle", lastMessageAt: null });
  // The token request goes through the API client, so answer it here.
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            token: TOKEN,
            expiresAt: TIMESTAMP,
            sessionExpiresAt: TIMESTAMP,
            url: CONFIG.wsUrl,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );
});

afterEach(() => {
  for (const remove of removals.splice(0)) {
    remove();
  }
  vi.unstubAllGlobals();
});

/**
 * Creates the services with a signed-in fake user and a socket double.
 *
 * @returns The services.
 */
async function signedInServices() {
  const auth = createFakeAuthClient();
  await auth.signIn("e2e-operator@example.test", "e2e-password");
  await auth.submitTotp("123456");
  return createServices(CONFIG, {
    auth,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
}

describe("createServices realtime wiring", () => {
  it("subscribes to the demo site on every open", async () => {
    const services = await signedInServices();
    services.ws.connect();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });

    sockets[0]?.onopen?.(new Event("open"));
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ type: "subscribe", siteId: "paris-01" })]);
    services.ws.close();
  });

  it("applies a received snapshot to the fleet store and marks the message time", async () => {
    const services = await signedInServices();
    services.ws.connect();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.onopen?.(new Event("open"));

    const frame = {
      type: "fleet.snapshot",
      siteId: "paris-01",
      sentAt: TIMESTAMP,
      robots: [
        {
          robotId: "sim-01",
          siteId: "paris-01",
          state: "IDLE",
          battery: 80,
          bootId: BOOT,
          seq: 1,
          ts: TIMESTAMP,
          receivedAt: 0,
        },
      ],
    };
    sockets[0]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));

    expect(useFleetStore.getState().robots["sim-01"]?.state).toBe("IDLE");
    expect(useWsStore.getState().lastMessageAt).not.toBeNull();
    services.ws.close();
  });

  it.each([
    ["the frame names another site", "other-site", "paris-01"],
    ["the alert it carries names another site", "paris-01", "other-site"],
  ])(
    "refuses an alert frame whose site is not the demo site, because %s",
    async (_case, envelopeSiteId, alertSiteId) => {
      const services = await signedInServices();
      services.ws.connect();
      await vi.waitFor(() => {
        expect(sockets).toHaveLength(1);
      });
      sockets[0]?.onopen?.(new Event("open"));

      const queryClient = new QueryClient();
      const alert: AlertRecord = alertOf({ siteId: alertSiteId });
      const frame = WsServerMessageSchema.parse({
        type: "alert.changed",
        siteId: envelopeSiteId,
        change: "OPENED",
        alert,
      });
      const openedAlerts: AlertRecord[] = [];
      const unsubscribeOpened = subscribeAlertOpened((opened) => {
        openedAlerts.push(opened);
      });
      const seenFrames: string[] = [];
      // The same wiring the alerts feed uses: every frame of the bus goes to applyAlertFrame.
      const unsubscribeFeed = subscribeFrames((received) => {
        seenFrames.push(received.type);
        if (received.type === "alert.changed") {
          applyAlertFrame(queryClient, received);
        }
      });

      removals.push(unsubscribeOpened, unsubscribeFeed);

      sockets[0]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));

      expect(openedAlerts).toEqual([]);
      expect(seenFrames).toEqual([]);
      expect(services.ws.droppedMessages).toBe(1);
      services.ws.close();
    },
  );

  it("refuses a fleet frame for another site before the fleet store applies it", async () => {
    const services = await signedInServices();
    services.ws.connect();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.onopen?.(new Event("open"));

    const frame = {
      type: "fleet.delta",
      siteId: "other-site",
      sentAt: TIMESTAMP,
      robots: [
        {
          robotId: "sim-01",
          bootId: BOOT,
          seq: 1,
          ts: TIMESTAMP,
          x: 0,
          y: 0,
          heading: 0,
          speed: 0,
          battery: 80,
          state: "IDLE",
        },
      ],
    };
    sockets[0]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));

    expect(useFleetStore.getState().robots["sim-01"]).toBeUndefined();
    expect(services.ws.droppedMessages).toBe(1);
    services.ws.close();
  });
});

describe("createServices control wiring", () => {
  it("routes command.ack, lock.changed and LOCK_CHANGED robot events to the control stores", async () => {
    useCommandStore.getState().reset();
    useLockStore.setState({ locks: new Map() });
    const services = await signedInServices();
    services.ws.connect();
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1);
    });
    sockets[0]?.onopen?.(new Event("open"));
    const send = (frame: unknown): void => {
      sockets[0]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
    };
    const commandId = uuidv7();
    const envelope = {
      schemaVersion: "1.0.0",
      robotId: "sim-01",
      siteId: "paris-01",
      ts: TIMESTAMP,
      seq: 1,
      bootId: BOOT,
    };

    useCommandStore
      .getState()
      .begin({ commandId, robotId: "sim-01", type: "PAUSE", sentAt: performance.now() });
    send({
      type: "command.ack",
      siteId: "paris-01",
      ack: {
        ...envelope,
        messageId: uuidv7(),
        commandId,
        correlationId: "corr-0001-abcd",
        robotTs: TIMESTAMP,
        state: "PAUSED",
        result: "ACK",
      },
    });
    expect([...useCommandStore.getState().entries.values()][0]?.status).toBe("ack");

    send({
      type: "lock.changed",
      siteId: "paris-01",
      robotId: "sim-01",
      held: true,
      holder: "11111111-2222-3333-4444-555555555555",
      cause: "ACQUIRED",
    });
    expect(useLockStore.getState().locks.get("sim-01")).toEqual({
      held: true,
      holder: "11111111-2222-3333-4444-555555555555",
    });

    send({
      type: "robot.event",
      siteId: "paris-01",
      robotId: "sim-01",
      event: {
        ...envelope,
        messageId: uuidv7(),
        seq: 2,
        kind: "LOCK_CHANGED",
        held: false,
        cause: "RELEASED",
      },
    });
    expect(useLockStore.getState().locks.get("sim-01")).toEqual({ held: false });
    services.ws.close();
  });

  it("given the control stores hold a lock and a command, when the user signs out, then both stores are empty", async () => {
    const services = await signedInServices();
    useLockStore.setState({
      locks: new Map([["sim-01", { held: true, holder: "11111111-2222-3333-4444-555555555555" }]]),
    });
    useCommandStore
      .getState()
      .begin({ commandId: uuidv7(), robotId: "sim-01", type: "PAUSE", sentAt: performance.now() });

    await services.auth.signOut();

    expect(useLockStore.getState().locks.size).toBe(0);
    expect(useCommandStore.getState().entries.size).toBe(0);
    expect(useCommandStore.getState().logByRobot.size).toBe(0);
  });
});
