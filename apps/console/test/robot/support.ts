/**
 * Fixtures of the robot panel tests: a signed-in user with a role, a live robot in the fleet store, a registry
 * entry, and an API that answers the control routes by path. The stores are reset between tests, as a page load
 * would reset them.
 */
import { uuidv7, type LockState, type Role, type RobotSummary } from "@mfc/protocol";
import { useAuthStore } from "../../src/auth/auth-store";
import { useCommandStore } from "../../src/control/command-store";
import { useLockStore } from "../../src/control/lock-store";
import { useFleetStore } from "../../src/live/fleet-store";
import type { LiveRobot } from "../../src/live/fleet-reducer";
import { useWsStore } from "../../src/ws/ws-store";
import {
  ROBOT,
  SITE,
  SUB,
  json,
  lockActionBody,
  lockState,
  type RecordedRequest,
  type Responder,
} from "../control/support";

export {
  ROBOT,
  SITE,
  SUB,
  OTHER_SUB,
  ackOf,
  createControlHarness,
  json,
  lockState,
} from "../control/support";

/** Options of the fake API that the panel tests change. */
export interface PanelApiOptions {
  /** Whether the robot is simulated, as the registry reports it. Defaults to simulated. */
  readonly simulated?: boolean;
  /** Whether demo mode is on. Defaults to off. */
  readonly demoEnabled?: boolean;
  /** The lock state the API reads. */
  readonly lock: LockState;
  /** Answers the lock take. Defaults to a successful take by the signed-in user. */
  readonly take?: (request: RecordedRequest) => Response;
}

/**
 * Builds a registry entry for the test robot.
 *
 * @param simulated - Whether the robot is simulated.
 * @returns The entry.
 */
export function registryEntry(simulated: boolean): RobotSummary {
  return {
    robotId: ROBOT,
    siteId: SITE,
    name: "Robot 03",
    type: "AMR-200",
    designDate: "2026-10-01",
    simulated,
    status: "ACTIVE",
    createdAt: "2026-10-01T08:00:00.000Z",
  };
}

/**
 * The command identifier in a request body.
 *
 * @param request - The recorded request.
 * @returns The identifier, or an empty string when the body has none.
 */
export function commandIdOf(request: RecordedRequest): string {
  const body = request.body;
  return typeof body === "object" &&
    body !== null &&
    "commandId" in body &&
    typeof body.commandId === "string"
    ? body.commandId
    : "";
}

/**
 * Answers the control routes of the panel: registry, demo mode, lock read, lock take and release, and commands.
 *
 * @param options - What the API reads and how it answers the takes.
 * @returns The responder.
 */
export function panelApi(options: PanelApiOptions): Responder {
  return (request) => {
    const { method, path } = request;
    if (method === "GET" && path.endsWith("/robots")) {
      return json(200, { robots: [registryEntry(options.simulated ?? true)] });
    }
    if (method === "GET" && path.endsWith("/demo")) {
      return json(200, { enabled: options.demoEnabled ?? false });
    }
    if (method === "GET" && path.endsWith("/lock")) {
      return json(200, options.lock);
    }
    if (method === "POST" && path.endsWith("/lock")) {
      return options.take === undefined
        ? json(200, lockActionBody(lockState(true, SUB)))
        : options.take(request);
    }
    if (method === "POST" && path.endsWith("/lock/release")) {
      return json(200, lockActionBody(lockState(false)));
    }
    if (method === "POST" && path.endsWith("/commands")) {
      return json(200, {
        commandId: commandIdOf(request),
        correlationId: "corr-0001-abcd",
        issuedAt: "2026-11-04T10:00:00.000Z",
        deduplicated: false,
      });
    }
    return json(404, {});
  };
}

/**
 * Sets the signed-in user.
 *
 * @param role - The role of the user.
 * @param userId - The subject of the user.
 */
export function signIn(role: Role, userId: string): void {
  useAuthStore.setState({ status: "authenticated", role, userId });
}

/**
 * Sets whether the realtime socket is open.
 *
 * @param open - `true` for an open socket.
 */
export function setSocket(open: boolean): void {
  useWsStore.setState({ connection: open ? "open" : "closed" });
}

/**
 * Puts a live robot into the fleet store.
 *
 * @param state - The robot's state.
 * @param now - Client time of the last frame, in milliseconds.
 */
export function putRobot(state: LiveRobot["state"], now: number): void {
  const robot: LiveRobot = {
    robotId: ROBOT,
    bootId: uuidv7(),
    seq: 1,
    state,
    presence: "ONLINE",
    battery: 80,
    pose: { x: 1.25, y: 2.5, heading: 0, speed: 0.5 },
    motion: null,
    lastSampleAt: now,
    robotTs: "2026-11-04T10:00:00.000Z",
    lastHeardAt: now,
  };
  useFleetStore.setState({ robots: { [ROBOT]: robot } });
}

/**
 * Resets every store the panel reads, as a page load does.
 */
export function resetPanelStores(): void {
  useAuthStore.setState({ status: "anonymous", role: null, userId: null });
  useWsStore.setState({ connection: "idle", lastMessageAt: null });
  useCommandStore.getState().reset();
  useLockStore.getState().reset();
  useFleetStore.getState().reset(Date.now());
}
