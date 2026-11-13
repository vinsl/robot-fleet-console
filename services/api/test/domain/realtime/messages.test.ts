/**
 * Fleet delta frames and frame serialisation: the frame bounds hold for the worst case, and every frame is
 * valid for the protocol schema before it leaves the cloud.
 */
import {
  FLEET_DELTA_MAX_ROBOTS,
  WS_MAX_SERVER_FRAME_BYTES,
  type FleetRobotSample,
  type WsServerMessage,
} from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { buildFleetDelta, serialize } from "../../../src/domain/realtime/messages";
import { BOOT_A, sampleOf } from "../../fakes/live";

/** The instant of the frames. */
const SENT_AT = "2026-11-02T10:00:00.000Z";

/**
 * A worst-case sample: the longest identifiers, a mission and a fault, and full-precision numbers.
 *
 * @param n - The robot number, which makes the identifier unique.
 * @returns The sample.
 */
function worstCase(n: number): FleetRobotSample {
  return sampleOf(`r${String(n).padStart(31, "0")}`, {
    bootId: BOOT_A,
    seq: Number.MAX_SAFE_INTEGER - n,
    x: -123.45678901234567,
    y: 987.6543210987654,
    heading: 3.141592653589793,
    speed: 4.999999999999999,
    battery: 99.99999999999999,
    state: "BLOCKED",
    missionId: "m".repeat(64),
    errorCode: "SENSOR_FAULT",
  });
}

describe("buildFleetDelta", () => {
  it("splits 100 worst-case robots into frames under the size and robot-count bounds, each robot once", () => {
    const samples = Array.from({ length: 100 }, (_, i) => worstCase(i));

    const frames = buildFleetDelta("paris-01", samples, SENT_AT);

    expect(frames.length).toBeGreaterThan(1);
    const robotIds: string[] = [];
    for (const frame of frames) {
      expect(frame.type).toBe("fleet.delta");
      if (frame.type !== "fleet.delta") {
        continue;
      }
      expect(frame.robots.length).toBeLessThanOrEqual(FLEET_DELTA_MAX_ROBOTS);
      expect(Buffer.byteLength(JSON.stringify(frame), "utf8")).toBeLessThanOrEqual(
        WS_MAX_SERVER_FRAME_BYTES,
      );
      robotIds.push(...frame.robots.map((robot) => robot.robotId));
    }
    expect(robotIds).toHaveLength(100);
    expect(new Set(robotIds).size).toBe(100);
  });

  it("keeps the order of the samples", () => {
    const samples = [sampleOf("kali-01"), sampleOf("sim-01"), sampleOf("sim-02")];

    const [frame] = buildFleetDelta("paris-01", samples, SENT_AT);

    expect(frame).toMatchObject({
      type: "fleet.delta",
      siteId: "paris-01",
      sentAt: SENT_AT,
      robots: [{ robotId: "kali-01" }, { robotId: "sim-01" }, { robotId: "sim-02" }],
    });
  });

  it("builds no frame for no sample", () => {
    expect(buildFleetDelta("paris-01", [], SENT_AT)).toStrictEqual([]);
  });

  it("refuses a sample that alone exceeds the frame bound (a programming error)", () => {
    const oversized = {
      ...sampleOf("kali-01"),
      pad: "x".repeat(WS_MAX_SERVER_FRAME_BYTES),
    } as FleetRobotSample;

    expect(() => buildFleetDelta("paris-01", [oversized], SENT_AT)).toThrow(
      "a fleet sample exceeds the frame size bound",
    );
  });
});

describe("serialize", () => {
  it("returns the JSON text of a valid frame", () => {
    const frame: WsServerMessage = {
      type: "robot.presence",
      siteId: "paris-01",
      robotId: "kali-01",
      presence: "ONLINE",
      at: SENT_AT,
    };

    expect(JSON.parse(serialize(frame))).toStrictEqual(frame);
  });

  it("refuses a frame that breaks the protocol schema", () => {
    const invalid = {
      type: "robot.presence",
      siteId: "paris-01",
      robotId: "kali-01",
      presence: "AWAY",
      at: SENT_AT,
    };

    expect(() => serialize(invalid as unknown as WsServerMessage)).toThrow();
  });
});
