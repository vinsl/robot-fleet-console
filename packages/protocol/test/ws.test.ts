/**
 * WebSocket protocol: token shapes, client frames, server frames and the principal.
 *
 * Each schema has one valid sample that must parse, and one invalid variant per rule, so that a field
 * that loses its bound or its grammar fails here before it reaches a Lambda.
 */
import { describe, expect, it } from "vitest";
import {
  FLEET_DELTA_MAX_ROBOTS,
  FleetRobotSampleSchema,
  PrincipalSchema,
  SNAPSHOT_MAX_ROBOTS,
  WS_MAX_CLIENT_MESSAGE_BYTES,
  WS_MAX_SERVER_FRAME_BYTES,
  WS_SESSION_MAX_SECONDS,
  WS_TOKEN_TTL_SECONDS,
  WsClientMessageSchema,
  WsServerMessageSchema,
  WsTokenRequestSchema,
  WsTokenResponseSchema,
  WsTokenSchema,
} from "../src/index";

const SITE = "paris-01";
const ROBOT = "kali-01";
const BOOT = "0190a7c4-0000-7000-8000-000000000001";
const MESSAGE = "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d";
const TS = "2026-11-02T10:00:00.000Z";
const TOKEN = "A".repeat(43);
const URL_SAMPLE = "wss://abc123xyz.execute-api.eu-west-3.amazonaws.com/demo";
const SUB = "3f1c2b4a-1111-2222-3333-444455556666";

/** Site identifier of the worst-case frames: the longest the grammar allows. */
const WORST_SITE = "s".repeat(32);

/**
 * A robot sample that takes the most bytes the schema allows: the longest identifiers and mission, the
 * longest fault and state, full-precision numbers, and the largest sequence and receive time.
 */
const WORST_SAMPLE = {
  robotId: "a".repeat(32),
  bootId: BOOT,
  seq: Number.MAX_SAFE_INTEGER,
  ts: TS,
  x: -999.9999999999999,
  y: -999.9999999999999,
  heading: -Math.PI,
  speed: 4.999999999999999,
  battery: 99.99999999999999,
  state: "CHARGING",
  missionId: "m".repeat(64),
  errorCode: "SENSOR_FAULT",
} as const;

/** The same worst case as a snapshot record, which also carries the site, a pose object and the receive time. */
const WORST_LIVE_STATE = {
  robotId: WORST_SAMPLE.robotId,
  siteId: WORST_SITE,
  state: WORST_SAMPLE.state,
  battery: WORST_SAMPLE.battery,
  pose: {
    x: WORST_SAMPLE.x,
    y: WORST_SAMPLE.y,
    heading: WORST_SAMPLE.heading,
    speed: WORST_SAMPLE.speed,
  },
  missionId: WORST_SAMPLE.missionId,
  errorCode: WORST_SAMPLE.errorCode,
  bootId: BOOT,
  seq: Number.MAX_SAFE_INTEGER,
  ts: TS,
  receivedAt: Number.MAX_SAFE_INTEGER,
} as const;

/**
 * Size of a text in UTF-8 bytes, the unit of the frame limit.
 *
 * @param text - The serialised frame.
 * @returns Its byte length.
 */
function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

const SAMPLE_ROBOT = {
  robotId: ROBOT,
  bootId: BOOT,
  seq: 42,
  ts: TS,
  x: 12.5,
  y: 3.25,
  heading: 0.5,
  speed: 0.8,
  battery: 76,
  state: "MOVING",
  missionId: "pick-42",
};

const ACK = {
  schemaVersion: "1.0.0",
  messageId: MESSAGE,
  robotId: ROBOT,
  siteId: SITE,
  ts: TS,
  seq: 42,
  bootId: BOOT,
  commandId: "0190a7c5-1f00-7a00-8b00-00000000c001",
  correlationId: "corr-0001-abcd",
  robotTs: TS,
  state: "TELEOP",
  result: "ACK",
};

const ROBOT_EVENT = {
  schemaVersion: "1.0.0",
  messageId: MESSAGE,
  robotId: ROBOT,
  siteId: SITE,
  ts: TS,
  seq: 42,
  bootId: BOOT,
  kind: "HEARTBEAT",
  state: "IDLE",
  battery: 90,
};

const ALERT = {
  alertId: "0123456789abcdef0123456789abcdef",
  siteId: SITE,
  robotId: ROBOT,
  kind: "BLOCKED",
  severity: "MAJOR",
  status: "OPEN",
  openedAt: TS,
};

const LIVE_STATE = {
  robotId: ROBOT,
  siteId: SITE,
  state: "IDLE",
  battery: 90,
  bootId: BOOT,
  seq: 0,
  ts: TS,
  receivedAt: 1_793_000_000_000,
};

describe("WS limits", () => {
  it("keeps the token lifetime, the session lifetime and the frame limits in the documented ranges", () => {
    expect(WS_TOKEN_TTL_SECONDS).toBe(60);
    expect(WS_SESSION_MAX_SECONDS).toBe(3600);
    expect(WS_MAX_CLIENT_MESSAGE_BYTES).toBe(2048);
    expect(WS_MAX_SERVER_FRAME_BYTES).toBeLessThan(32 * 1024);
    expect(FLEET_DELTA_MAX_ROBOTS).toBe(70);
    expect(SNAPSHOT_MAX_ROBOTS).toBe(60);
  });

  it("serialises a worst-case snapshot of SNAPSHOT_MAX_ROBOTS under the frame limit", () => {
    const frame = {
      type: "fleet.snapshot",
      siteId: WORST_SITE,
      sentAt: TS,
      robots: Array.from({ length: SNAPSHOT_MAX_ROBOTS }, () => WORST_LIVE_STATE),
    };
    const text = JSON.stringify(frame);
    expect(utf8Length(text)).toBeLessThanOrEqual(WS_MAX_SERVER_FRAME_BYTES);
    expect(WsServerMessageSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it("serialises a worst-case delta of FLEET_DELTA_MAX_ROBOTS under the frame limit", () => {
    const frame = {
      type: "fleet.delta",
      siteId: WORST_SITE,
      sentAt: TS,
      robots: Array.from({ length: FLEET_DELTA_MAX_ROBOTS }, () => WORST_SAMPLE),
    };
    const text = JSON.stringify(frame);
    expect(utf8Length(text)).toBeLessThanOrEqual(WS_MAX_SERVER_FRAME_BYTES);
    expect(WsServerMessageSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });
});

describe("WsTokenSchema", () => {
  it("accepts 43 base64url characters", () => {
    expect(WsTokenSchema.safeParse(TOKEN).success).toBe(true);
  });

  it.each([
    ["42 characters", "A".repeat(42)],
    ["44 characters", "A".repeat(44)],
    ["a plus sign", `${"A".repeat(42)}+`],
    ["a slash", `${"A".repeat(42)}/`],
    ["padding", `${"A".repeat(42)}=`],
    ["whitespace", `${"A".repeat(42)} `],
  ])("refuses %s", (_label, token) => {
    expect(WsTokenSchema.safeParse(token).success).toBe(false);
  });
});

describe("WsTokenRequestSchema", () => {
  it("accepts a site identifier", () => {
    expect(WsTokenRequestSchema.safeParse({ siteId: SITE }).success).toBe(true);
  });

  it("refuses an extra key", () => {
    expect(WsTokenRequestSchema.safeParse({ siteId: SITE, role: "Admin" }).success).toBe(false);
  });

  it("refuses a malformed site identifier", () => {
    expect(WsTokenRequestSchema.safeParse({ siteId: "Paris 01" }).success).toBe(false);
  });
});

describe("WsTokenResponseSchema", () => {
  const response = {
    token: TOKEN,
    expiresAt: TS,
    sessionExpiresAt: TS,
    url: URL_SAMPLE,
  };

  it("accepts a token, its expiry and the demo endpoint", () => {
    expect(WsTokenResponseSchema.safeParse(response).success).toBe(true);
  });

  it.each([
    ["a digit stage", "wss://abc123xyz.execute-api.eu-west-3.amazonaws.com/demo2"],
    ["a hyphenated stage", "wss://abc123xyz.execute-api.eu-west-1.amazonaws.com/demo-2"],
  ])("accepts a URL with %s", (_label, url) => {
    expect(WsTokenResponseSchema.safeParse({ ...response, url }).success).toBe(true);
  });

  it.each([
    ["another region", "wss://abc123xyz.execute-api.us-east-1.amazonaws.com/demo"],
    ["plain ws scheme", "ws://abc123xyz.execute-api.eu-west-3.amazonaws.com/demo"],
    ["another host", "wss://example.com/demo"],
    ["an uppercase stage", "wss://abc123xyz.execute-api.eu-west-3.amazonaws.com/Demo"],
  ])("refuses a URL with %s", (_label, url) => {
    expect(WsTokenResponseSchema.safeParse({ ...response, url }).success).toBe(false);
  });

  it("refuses a malformed token", () => {
    expect(WsTokenResponseSchema.safeParse({ ...response, token: "short" }).success).toBe(false);
  });

  it("refuses an extra key", () => {
    expect(WsTokenResponseSchema.safeParse({ ...response, user: SUB }).success).toBe(false);
  });
});

describe("WsClientMessageSchema", () => {
  it.each([
    ["subscribe", { type: "subscribe", siteId: SITE }],
    ["heartbeat", { type: "heartbeat", robotId: ROBOT }],
    ["ping", { type: "ping" }],
  ])("accepts %s", (_label, message) => {
    expect(WsClientMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each([
    ["an unknown type", { type: "command", siteId: SITE }],
    ["a missing type", { siteId: SITE }],
    ["a subscribe with a bad site", { type: "subscribe", siteId: "PARIS" }],
    ["a subscribe with an extra key", { type: "subscribe", siteId: SITE, all: true }],
    ["a heartbeat with a bad robot", { type: "heartbeat", robotId: "R" }],
    // The token stays in the cloud: a client that sends one is refused, whatever its length.
    [
      "a heartbeat that carries a lock token",
      { type: "heartbeat", robotId: ROBOT, lockToken: "abcdefghijklmnop" },
    ],
    [
      "a heartbeat that carries a lock token of 15 characters",
      { type: "heartbeat", robotId: ROBOT, lockToken: "a".repeat(15) },
    ],
    ["a ping with an extra key", { type: "ping", at: TS }],
  ])("refuses %s", (_label, message) => {
    expect(WsClientMessageSchema.safeParse(message).success).toBe(false);
  });
});

describe("PrincipalSchema", () => {
  const principal = {
    sub: SUB,
    role: "Operator",
    siteIds: [SITE],
    sessionExpiresAt: TS,
  };

  it("accepts a principal with one site", () => {
    expect(PrincipalSchema.safeParse(principal).success).toBe(true);
  });

  it("refuses an empty site list", () => {
    expect(PrincipalSchema.safeParse({ ...principal, siteIds: [] }).success).toBe(false);
  });

  it("refuses more than eight sites", () => {
    const siteIds = Array.from(
      { length: 9 },
      (_value, index) => `site-${String(index).padStart(2, "0")}`,
    );
    expect(PrincipalSchema.safeParse({ ...principal, siteIds }).success).toBe(false);
  });

  it("refuses a role outside the three roles", () => {
    expect(PrincipalSchema.safeParse({ ...principal, role: "Root" }).success).toBe(false);
  });

  it("refuses a subject with characters outside the subject alphabet", () => {
    expect(PrincipalSchema.safeParse({ ...principal, sub: "user@example" }).success).toBe(false);
  });

  it("refuses an extra key", () => {
    expect(PrincipalSchema.safeParse({ ...principal, email: "a@b.c" }).success).toBe(false);
  });
});

describe("FleetRobotSampleSchema", () => {
  it("accepts a telemetry-shaped sample", () => {
    expect(FleetRobotSampleSchema.safeParse(SAMPLE_ROBOT).success).toBe(true);
  });

  it.each([
    ["a negative sequence", { seq: -1 }],
    ["a position beyond the bound", { x: 1001 }],
    ["a battery above 100", { battery: 101 }],
    ["a speed above 5 m/s", { speed: 5.1 }],
    ["an uppercase boot identifier", { bootId: BOOT.toUpperCase() }],
    ["an unknown state", { state: "SLEEPING" }],
    ["an unknown fault code", { errorCode: "SMOKE" }],
    ["an extra key", { siteId: SITE }],
  ])("refuses %s", (_label, change) => {
    expect(FleetRobotSampleSchema.safeParse({ ...SAMPLE_ROBOT, ...change }).success).toBe(false);
  });
});

describe("WsServerMessageSchema", () => {
  const frames: ReadonlyArray<readonly [string, unknown]> = [
    ["fleet.delta", { type: "fleet.delta", siteId: SITE, sentAt: TS, robots: [SAMPLE_ROBOT] }],
    ["fleet.snapshot", { type: "fleet.snapshot", siteId: SITE, sentAt: TS, robots: [LIVE_STATE] }],
    ["fleet.snapshot empty", { type: "fleet.snapshot", siteId: SITE, sentAt: TS, robots: [] }],
    [
      "robot.presence",
      { type: "robot.presence", siteId: SITE, robotId: ROBOT, presence: "OFFLINE", at: TS },
    ],
    ["robot.event", { type: "robot.event", siteId: SITE, robotId: ROBOT, event: ROBOT_EVENT }],
    ["command.ack", { type: "command.ack", siteId: SITE, ack: ACK }],
    ["alert.changed", { type: "alert.changed", siteId: SITE, change: "OPENED", alert: ALERT }],
    [
      "lock.changed held",
      {
        type: "lock.changed",
        siteId: SITE,
        robotId: ROBOT,
        held: true,
        holder: SUB,
        cause: "ACQUIRED",
      },
    ],
    [
      "lock.changed released",
      { type: "lock.changed", siteId: SITE, robotId: ROBOT, held: false, cause: "RELEASED" },
    ],
    ["error", { type: "error", code: "FORBIDDEN_SITE", correlationId: "corr-0001-abcd" }],
  ];

  it.each(frames)("accepts a %s frame", (_label, frame) => {
    expect(WsServerMessageSchema.safeParse(frame).success).toBe(true);
  });

  it("refuses an empty delta, which carries nothing to draw", () => {
    expect(
      WsServerMessageSchema.safeParse({ type: "fleet.delta", siteId: SITE, sentAt: TS, robots: [] })
        .success,
    ).toBe(false);
  });

  it("refuses a delta of 101 robots", () => {
    const robots = Array.from({ length: FLEET_DELTA_MAX_ROBOTS + 1 }, () => SAMPLE_ROBOT);
    expect(
      WsServerMessageSchema.safeParse({ type: "fleet.delta", siteId: SITE, sentAt: TS, robots })
        .success,
    ).toBe(false);
  });

  it("refuses a delta with a sample that carries an extra key", () => {
    expect(
      WsServerMessageSchema.safeParse({
        type: "fleet.delta",
        siteId: SITE,
        sentAt: TS,
        robots: [{ ...SAMPLE_ROBOT, siteId: SITE }],
      }).success,
    ).toBe(false);
  });

  it("refuses a snapshot one robot over SNAPSHOT_MAX_ROBOTS", () => {
    const robots = Array.from({ length: SNAPSHOT_MAX_ROBOTS + 1 }, () => LIVE_STATE);
    expect(
      WsServerMessageSchema.safeParse({ type: "fleet.snapshot", siteId: SITE, sentAt: TS, robots })
        .success,
    ).toBe(false);
  });

  it("refuses a presence other than ONLINE or OFFLINE", () => {
    expect(
      WsServerMessageSchema.safeParse({
        type: "robot.presence",
        siteId: SITE,
        robotId: ROBOT,
        presence: "IDLE",
        at: TS,
      }).success,
    ).toBe(false);
  });

  it("refuses an alert change that is not one of the three", () => {
    expect(
      WsServerMessageSchema.safeParse({
        type: "alert.changed",
        siteId: SITE,
        change: "DELETED",
        alert: ALERT,
      }).success,
    ).toBe(false);
  });

  it("refuses an alert whose severity does not match its kind", () => {
    expect(
      WsServerMessageSchema.safeParse({
        type: "alert.changed",
        siteId: SITE,
        change: "OPENED",
        alert: { ...ALERT, severity: "INFO" },
      }).success,
    ).toBe(false);
  });

  it("refuses a lock holder that is not a user subject", () => {
    expect(
      WsServerMessageSchema.safeParse({
        type: "lock.changed",
        siteId: SITE,
        robotId: ROBOT,
        held: true,
        holder: "a b",
        cause: "ACQUIRED",
      }).success,
    ).toBe(false);
  });

  it("refuses an error code outside the list, so an internal fault name cannot leak", () => {
    expect(WsServerMessageSchema.safeParse({ type: "error", code: "ECONNRESET" }).success).toBe(
      false,
    );
  });

  it("refuses an error frame with an extra key", () => {
    expect(
      WsServerMessageSchema.safeParse({ type: "error", code: "UNSUPPORTED", stack: "at x" })
        .success,
    ).toBe(false);
  });

  it("refuses a frame with an unknown type", () => {
    expect(WsServerMessageSchema.safeParse({ type: "fleet.wipe", siteId: SITE }).success).toBe(
      false,
    );
  });

  it("refuses a delta whose timestamp has no millisecond precision", () => {
    expect(
      WsServerMessageSchema.safeParse({
        type: "fleet.delta",
        siteId: SITE,
        sentAt: "2026-11-02T10:00:00Z",
        robots: [SAMPLE_ROBOT],
      }).success,
    ).toBe(false);
  });
});
