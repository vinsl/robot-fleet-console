/**
 * Fixtures of the fleet scenario: the active site map and the alerts the API serves, the realtime socket the test
 * drives, the frames the server sends, and the signed-in users.
 *
 * Nothing reaches the network. The backend answers `fetch`, and the socket records what the client sends and lets
 * the test deliver what the server would send. Every frame and response goes through the protocol schemas, so a
 * fixture the wire would refuse fails here too.
 */
import { readFileSync } from "node:fs";
import {
  AlertActionRequestSchema,
  AlertRecordSchema,
  DEMO_SITE_ID,
  WsServerMessageSchema,
  type AlertRecord,
  type WsServerMessage,
} from "@mfc/protocol";
import { vi, type Mock } from "vitest";
import type { AuthClient, Session } from "../../src/auth/cognito-client";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import type { WebSocketLike } from "../../src/ws/ws-client";
import { BOOT_OLD, alertOf, deltaOf, eventOf, sampleOf } from "../live/support";
import { S3_ORIGIN, jsonResponse } from "../site/backend";
import { TEST_CONFIG } from "../support/console-harness";

/** Client time the scenario is pinned to, so that every age and window is the same on each run. */
export const SCENARIO_NOW_MS = Date.parse("2026-11-04T09:00:00.000Z");

/** The same instant, in the ISO form the API and the frames use. */
export const SCENARIO_NOW = new Date(SCENARIO_NOW_MS).toISOString();

/** Lifetime of the scenario sessions, in milliseconds. */
export const SESSION_MS = 3_600_000;

/** Identifier of the alert the scenario opens. Hex, as the protocol requires. */
export const SCENARIO_ALERT_ID = "0123456789abcdef0123456789abcdef";

/** Message identifier of the robot event that blocks sim-03 (UUIDv7). */
const BLOCKED_EVENT_MESSAGE_ID = "0190f3c0-7b1c-7000-8000-0000000000a1";

/** Path of the alerts of the demo site. */
export const ALERTS_PATH = `/sites/${DEMO_SITE_ID}/alerts`;

/** Path of an operator action on an alert. Mirrors {@link ALERTS_PATH} for the demo site. */
const ACTION_PATH = /^\/sites\/paris-01\/alerts\/([0-9a-f]{32})\/(acknowledge|resolve)$/;

/** An Operator, who may acknowledge and resolve alerts. */
export const OPERATOR_SESSION: Session = {
  userId: "scenario-operator",
  groups: ["Operator"],
  expiresAtMs: SCENARIO_NOW_MS + SESSION_MS,
};

/** A Viewer, who may read alerts but not change them. */
export const VIEWER_SESSION: Session = {
  userId: "scenario-viewer",
  groups: ["Viewer"],
  expiresAtMs: SCENARIO_NOW_MS + SESSION_MS,
};

/** Access token of the scenario. The scenario backend does not verify it. */
const ACCESS_TOKEN = "scenario-access-token";

/** A realtime token of the protocol shape (43 URL-safe characters). Single use in production, fixed here. */
const WS_TOKEN = "A".repeat(43);

/**
 * Map file of the sample warehouse, shared with the protocol tests. The path is relative to the package root, where
 * the console tests run, as in the fleet map test.
 */
const SAMPLE_MAP_TEXT = readFileSync(
  "../../packages/protocol/test/fixtures/site-map/sample-warehouse.geojson",
  "utf8",
);

/**
 * Identifiers of the first `count` robots of the fleet, `sim-01` upwards.
 *
 * @param count - Number of robots.
 * @returns The identifiers in order.
 */
export function robotIds(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `sim-${String(index + 1).padStart(2, "0")}`,
  );
}

/**
 * A position inside the sample warehouse (0 to 60 by 0 to 40 metres), one per robot index. Ten robots fill one row,
 * the next ten sit below it.
 *
 * @param index - Zero-based robot index.
 * @returns The position in site metres.
 */
export function poseOf(index: number): { readonly x: number; readonly y: number } {
  return { x: 3 + (index % 10) * 5.5, y: 8 + Math.floor(index / 10) * 20 };
}

/**
 * The snapshot that answers a subscription: every robot is known, moving, and positioned.
 *
 * @param count - Number of robots.
 * @param receivedAt - Cloud receive time of the records, in epoch milliseconds. A stale value would make every
 *   robot silent, so the caller passes the current time.
 * @returns The validated frame.
 */
export function snapshotFrame(count: number, receivedAt: number): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "fleet.snapshot",
    siteId: DEMO_SITE_ID,
    sentAt: SCENARIO_NOW,
    robots: robotIds(count).map((robotId, index) => ({
      robotId,
      siteId: DEMO_SITE_ID,
      state: "MOVING",
      battery: 80,
      pose: { ...poseOf(index), heading: 0, speed: 0.5 },
      bootId: BOOT_OLD,
      seq: 1,
      ts: SCENARIO_NOW,
      receivedAt,
    })),
  });
}

/**
 * A delta of the first `count` robots, all moving, at one sequence number.
 *
 * @param count - Number of robots.
 * @param seq - Sequence number of every sample. It must grow from one delta to the next.
 * @returns The validated frame.
 */
export function deltaFrame(count: number, seq: number): WsServerMessage {
  return deltaOf(
    robotIds(count).map((robotId, index) =>
      sampleOf(robotId, seq, { ...poseOf(index), state: "MOVING" }),
    ),
  );
}

/**
 * The event that blocks a robot: a state change from moving to blocked, caused by an obstacle.
 *
 * @param robotId - Robot identifier.
 * @param seq - Sequence number, newer than the robot's snapshot.
 * @returns The validated frame.
 */
export function blockedEventFrame(robotId: string, seq: number): WsServerMessage {
  return eventOf(robotId, BLOCKED_EVENT_MESSAGE_ID, seq, {
    kind: "STATE_CHANGED",
    from: "MOVING",
    to: "BLOCKED",
    cause: "OBSTACLE_DETECTED",
  });
}

/**
 * The major alert of sim-03 being blocked, opened at the scenario time.
 *
 * @returns The validated alert.
 */
export function blockedAlert(): AlertRecord {
  return alertOf({
    alertId: SCENARIO_ALERT_ID,
    robotId: "sim-03",
    openedAt: SCENARIO_NOW,
  });
}

/**
 * An `alert.changed` frame for the site.
 *
 * @param change - What changed.
 * @param alert - The alert as the server states it.
 * @returns The validated frame.
 */
export function alertFrame(
  change: "OPENED" | "ACKNOWLEDGED" | "RESOLVED",
  alert: AlertRecord,
): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "alert.changed",
    siteId: DEMO_SITE_ID,
    change,
    alert,
  });
}

/**
 * A delta that names another site. The console must refuse it before the fleet sees it.
 *
 * @returns The validated frame, for a robot the demo site does not have.
 */
export function foreignSiteFrame(): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "fleet.delta",
    siteId: "other-site",
    sentAt: SCENARIO_NOW,
    robots: [sampleOf("sim-99", 1)],
  });
}

/**
 * The authentication client of the scenario: the fixture client, with the session it signs in.
 *
 * @param session - The user the client is signed in as.
 * @returns The client. Sign-in itself is not used: the test sets the session in the store.
 */
export function scenarioAuth(session: Session): AuthClient {
  const base = createFakeAuthClient();
  return {
    ...base,
    getAccessToken: () => Promise.resolve(ACCESS_TOKEN),
    getSession: () => session,
  };
}

/**
 * A socket the test drives. It records the frames the client sends, parsed, and delivers server frames the way the
 * browser does: as serialised text.
 */
export class FakeSocket implements WebSocketLike {
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  /** Frames the client sent, in order, parsed from their JSON text. */
  readonly sent: unknown[] = [];
  /** URL the socket was opened with. The token it carries is never asserted. */
  readonly url: string;

  /**
   * @param url - URL the client opened the socket with.
   */
  constructor(url: string) {
    this.url = url;
  }

  /**
   * Records a frame the client sent.
   *
   * @param data - The serialised frame.
   */
  send(data: string): void {
    const parsed: unknown = JSON.parse(data);
    this.sent.push(parsed);
  }

  /** The client closed the socket. Nothing else happens: the test does not wait for a close frame. */
  close(): void {
    // The scenario does not model a close handshake.
  }

  /** The server accepted the connection. */
  open(): void {
    this.onopen?.(new Event("open"));
  }

  /**
   * The server sent a frame.
   *
   * @param frame - The validated frame; it is serialised as the server would send it.
   */
  deliver(frame: WsServerMessage): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(frame) }));
  }

  /** The connection dropped, from the network or the server. */
  drop(): void {
    this.onclose?.(new CloseEvent("close"));
  }
}

/** One API request the console sent, as the backend received it. Presigned downloads are not listed. */
export interface ScenarioRequest {
  /** HTTP method, in upper case. */
  readonly method: string;
  /** Path of the request, without its query string. */
  readonly path: string;
  /** Query string, including the leading `?`, or an empty string. */
  readonly search: string;
  /** Raw request body, or `undefined` when none was sent. */
  readonly body: string | undefined;
}

/** The scripted backend of the scenario. */
export interface ScenarioBackend {
  /** Fetch stub, installed with `vi.stubGlobal`. */
  readonly fetch: Mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  /** API requests received so far, in order. */
  readonly requests: readonly ScenarioRequest[];
  /** Sockets the client opened, in order. */
  readonly sockets: readonly FakeSocket[];
  /** Socket factory for the services. Each call records the socket it creates. */
  readonly createSocket: (url: string) => FakeSocket;
  /**
   * Records an alert as the server now holds it, so that the actions on it find it.
   *
   * @param alert - The alert.
   */
  store(alert: AlertRecord): void;
}

/**
 * A problem document with a status, as the API answers a refused request.
 *
 * @param status - HTTP status.
 * @returns The response.
 */
function problemResponse(status: number): Response {
  return new Response(JSON.stringify({ title: "request refused", status }), {
    status,
    headers: { "content-type": "application/problem+json" },
  });
}

/**
 * Creates the scripted backend: the health, the realtime token, the active map and its download, and the alert
 * list and its two actions. The alerts are kept, so that an action changes what the next list returns.
 *
 * @returns The backend.
 */
export function createScenarioBackend(): ScenarioBackend {
  const requests: ScenarioRequest[] = [];
  const sockets: FakeSocket[] = [];
  const alerts = new Map<string, AlertRecord>();

  /**
   * Applies an operator action to a stored alert. The body must name the same open time as the alert, which is how
   * the API finds the record it stores.
   *
   * @param alertId - Alert identifier from the path.
   * @param verb - `acknowledge` or `resolve`, from the path.
   * @param body - Raw request body.
   * @returns The response: the updated alert, or a refusal.
   */
  function applyAction(alertId: string, verb: string, body: string | undefined): Response {
    const current = alerts.get(alertId);
    if (current === undefined) {
      return problemResponse(404);
    }
    const parsed = AlertActionRequestSchema.safeParse(parseBody(body));
    if (!parsed.success || parsed.data.openedAt !== current.openedAt) {
      return problemResponse(400);
    }
    const at = new Date().toISOString();
    const next =
      verb === "acknowledge"
        ? {
            ...current,
            status: "ACKNOWLEDGED",
            acknowledgedBy: OPERATOR_SESSION.userId,
            acknowledgedAt: at,
          }
        : {
            ...current,
            status: "RESOLVED",
            resolvedBy: OPERATOR_SESSION.userId,
            resolvedAt: at,
          };
    const record = AlertRecordSchema.parse(next);
    alerts.set(alertId, record);
    return jsonResponse(200, { alert: record, changed: true });
  }

  /**
   * Answers one API request.
   *
   * @param method - HTTP method, in upper case.
   * @param url - Absolute URL of the request.
   * @param body - Raw request body.
   * @returns The response.
   */
  function answerApi(method: string, url: URL, body: string | undefined): Response {
    const path = url.pathname;
    if (method === "GET" && path === "/health") {
      return jsonResponse(200, { status: "ok", version: "0.0.0-scenario", time: SCENARIO_NOW });
    }
    if (method === "POST" && path === "/ws-token") {
      return jsonResponse(200, {
        token: WS_TOKEN,
        expiresAt: SCENARIO_NOW,
        sessionExpiresAt: new Date(SCENARIO_NOW_MS + SESSION_MS).toISOString(),
        url: TEST_CONFIG.wsUrl,
      });
    }
    if (method === "GET" && path === `/sites/${DEMO_SITE_ID}/maps/active`) {
      return jsonResponse(200, {
        version: 2,
        url: `${S3_ORIGIN}/sites/${DEMO_SITE_ID}/maps/2.geojson?X-Amz-Signature=scenario`,
        expiresAt: SCENARIO_NOW,
        sizeBytes: SAMPLE_MAP_TEXT.length,
      });
    }
    if (method === "GET" && path === ALERTS_PATH) {
      const resolved = url.searchParams.get("status") === "resolved";
      const listed = [...alerts.values()].filter((alert) =>
        resolved ? alert.status === "RESOLVED" : alert.status !== "RESOLVED",
      );
      return jsonResponse(200, { alerts: listed });
    }
    const action = ACTION_PATH.exec(path);
    if (method === "POST" && action !== null) {
      const [, alertId = "", verb = ""] = action;
      return applyAction(alertId, verb, body);
    }
    return problemResponse(404);
  }

  const fetchStub = vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin === S3_ORIGIN) {
      return Promise.resolve(
        new Response(SAMPLE_MAP_TEXT, {
          status: 200,
          headers: { "content-type": "application/geo+json" },
        }),
      );
    }
    if (url.origin !== TEST_CONFIG.apiUrl) {
      return Promise.reject(new Error("unexpected host"));
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : undefined;
    requests.push({ method, path: url.pathname, search: url.search, body });
    return Promise.resolve(answerApi(method, url, body));
  });

  return {
    fetch: fetchStub,
    requests,
    sockets,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    store: (alert) => {
      alerts.set(alert.alertId, alert);
    },
  };
}

/**
 * Parses a request body, or returns `undefined` for an empty or malformed body. The caller validates the result.
 *
 * @param body - Raw request body.
 * @returns The parsed value, or `undefined`.
 */
function parseBody(body: string | undefined): unknown {
  if (body === undefined) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed;
  } catch {
    return undefined;
  }
}
