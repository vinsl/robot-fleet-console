/**
 * Fixtures of the live-state tests. Every frame and sample goes through the protocol schemas, so a fixture
 * that the wire would refuse fails here too, and the tests stay free of casts.
 */
import {
  AlertRecordSchema,
  FleetRobotSampleSchema,
  WsServerMessageSchema,
  type AlertRecord,
  type FleetRobotSample,
  type WsServerMessage,
} from "@mfc/protocol";
import type { LiveRobot } from "../../src/live/fleet-reducer";

/** An older boot identifier (UUIDv7). */
export const BOOT_OLD = "0190f3a2-7b1c-7000-8000-000000000001";
/** A newer boot identifier (UUIDv7): string order is time order. */
export const BOOT_NEW = "0190f3c0-7b1c-7000-8000-000000000001";
/** Timestamp used for every sample; the console never orders on it. */
export const ROBOT_TS = "2026-11-03T10:00:00.000Z";

/**
 * Builds a validated delta sample.
 *
 * @param robotId - Robot identifier.
 * @param seq - Sequence number.
 * @param overrides - Fields to change from the defaults.
 * @returns The sample.
 */
export function sampleOf(
  robotId: string,
  seq: number,
  overrides: Partial<Record<keyof FleetRobotSample, unknown>> = {},
): FleetRobotSample {
  return FleetRobotSampleSchema.parse({
    robotId,
    bootId: BOOT_OLD,
    seq,
    ts: ROBOT_TS,
    x: 1,
    y: 2,
    heading: 0,
    speed: 0.5,
    battery: 80,
    state: "MOVING",
    ...overrides,
  });
}

/**
 * Builds a validated delta frame.
 *
 * @param samples - The samples of the frame.
 * @returns The frame.
 */
export function deltaOf(samples: readonly FleetRobotSample[]): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "fleet.delta",
    siteId: "paris-01",
    sentAt: ROBOT_TS,
    robots: samples,
  });
}

/**
 * Builds a validated robot-event frame with the envelope fields the event schema requires.
 *
 * @param robotId - Robot identifier.
 * @param messageId - Message identifier (UUIDv7).
 * @param seq - Sequence number.
 * @param event - The kind-specific fields.
 * @param bootId - Boot identifier.
 * @returns The frame.
 */
export function eventOf(
  robotId: string,
  messageId: string,
  seq: number,
  event: Record<string, unknown>,
  bootId: string = BOOT_OLD,
): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "robot.event",
    siteId: "paris-01",
    robotId,
    event: {
      schemaVersion: "1.0.0",
      messageId,
      robotId,
      siteId: "paris-01",
      ts: ROBOT_TS,
      seq,
      bootId,
      ...event,
    },
  });
}

/**
 * Builds a validated presence frame.
 *
 * @param robotId - Robot identifier.
 * @param presence - The presence.
 * @returns The frame.
 */
export function presenceOf(robotId: string, presence: "ONLINE" | "OFFLINE"): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "robot.presence",
    siteId: "paris-01",
    robotId,
    presence,
    at: ROBOT_TS,
  });
}

/**
 * Builds a validated snapshot frame of one record.
 *
 * @param record - The record fields (robot, state, pose, sequence, receive time).
 * @returns The frame.
 */
export function snapshotOf(record: Record<string, unknown>): WsServerMessage {
  return WsServerMessageSchema.parse({
    type: "fleet.snapshot",
    siteId: "paris-01",
    sentAt: ROBOT_TS,
    robots: [
      {
        siteId: "paris-01",
        bootId: BOOT_OLD,
        seq: 1,
        ts: ROBOT_TS,
        battery: 80,
        state: "IDLE",
        receivedAt: 0,
        ...record,
      },
    ],
  });
}

/**
 * Builds a complete live robot for the selector and motion tests.
 *
 * @param overrides - Fields to change from the defaults.
 * @returns The robot.
 */
export function robotOf(overrides: Partial<LiveRobot> = {}): LiveRobot {
  return {
    robotId: "sim-01",
    bootId: BOOT_OLD,
    seq: 1,
    state: "IDLE",
    presence: "ONLINE",
    battery: 80,
    pose: null,
    motion: null,
    lastSampleAt: null,
    robotTs: ROBOT_TS,
    lastHeardAt: 0,
    ...overrides,
  };
}

/**
 * Builds a validated alert record.
 *
 * @param overrides - Fields to change from the OPEN MAJOR BLOCKED default.
 * @returns The alert.
 */
export function alertOf(overrides: Record<string, unknown> = {}): AlertRecord {
  return AlertRecordSchema.parse({
    alertId: "0123456789abcdef0123456789abcdef",
    siteId: "paris-01",
    robotId: "sim-03",
    kind: "BLOCKED",
    severity: "MAJOR",
    status: "OPEN",
    openedAt: ROBOT_TS,
    ...overrides,
  });
}
