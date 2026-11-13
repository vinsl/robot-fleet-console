// @vitest-environment jsdom
/**
 * The control scenario, through the whole console tree: an Operator opens a robot from the fleet map, takes control,
 * pauses it, and gives control back; a second Operator's lock disables the commands; a Viewer sees no command; an
 * e-stopped robot offers the release. The shell, the stores, the robot panel, the hooks and the HTTP and socket
 * clients are the real ones. Stubbed: the network (a scripted backend), the socket (the fake the fleet scenario
 * uses), the clock (the intervals and `Date`, pinned) and the layout hook of the map (jsdom has no layout).
 *
 * The heartbeat interval and the command clock run on a fake clock, advanced by the test, so the heartbeats of a
 * window are counted exactly. Waits use `vi.waitFor`, which advances that clock while it polls.
 */
import { act, cleanup, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSOLE_HEARTBEAT_INTERVAL_MS, type WsServerMessage } from "@mfc/protocol";
import "../../src/i18n";
import { useAuthStore } from "../../src/auth/auth-store";
import type { Session } from "../../src/auth/cognito-client";
import { useCommandStore } from "../../src/control/command-store";
import { useLockStore } from "../../src/control/lock-store";
import type { PlaneGeometry } from "../../src/fleet/map/projection";
import { renderConsole, resetConsole } from "../support/console-harness";
import {
  SCENARIO_NOW_MS,
  scenarioAuth,
  snapshotFrame,
  type FakeSocket,
  type ScenarioRequest,
} from "../fixtures/fleet-scenario";
import {
  COMMANDS_PATH,
  CONTROL_OPERATOR,
  CONTROL_VIEWER,
  LOCK_PATH,
  OTHER_OPERATOR_SUB,
  RELEASE_PATH,
  SCENARIO_ROBOT,
  ackFrame,
  commandIdOf,
  commandTypeOf,
  createControlScenarioBackend,
  estopFrame,
  lockChangedFrame,
  type ControlScenarioBackend,
} from "../fixtures/control-scenario";

const { plane } = vi.hoisted(() => {
  const geometry: PlaneGeometry = {
    stageWidth: 1000,
    stageHeight: 800,
    planeLeft: 100,
    planeTop: 100,
    planeWidth: 800,
    planeHeight: 600,
    originX: 400,
    originY: 360,
    tiltRad: 0,
    perspectivePx: 1100,
  };
  return { plane: geometry };
});

// jsdom has no layout, so the map cannot measure its stage. The plane is fixed; everything else is the real map.
vi.mock("../../src/fleet/map/geometry-hooks", () => ({
  usePlaneGeometry: () => plane,
  useCompactTilt: () => false,
}));

/** Accessible name of a robot marker on the map, for example `sim-01, Moving, battery 80.0 %`. */
const MARKER_NAME = /^sim-01, /;

/** Heading of the robot panel, which names the robot. */
const PANEL_HEADING = { level: 3, name: SCENARIO_ROBOT };

/** Fleet size of the snapshot. Only the first robot is driven; the others make the map realistic. */
const FLEET_SIZE = 10;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  // Only the intervals are faked: they drive the heartbeat, the command clock and the realtime clock, so the
  // heartbeat count is exact. Timeouts stay real, because the testing library waits on one after every action.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(SCENARIO_NOW_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  useCommandStore.getState().reset();
  useLockStore.getState().reset();
});

/**
 * Opens the console as one signed-in user, against the control backend and the fake socket.
 *
 * @param session - The user to sign in as.
 * @returns The backend the scenario drives.
 */
function openConsole(session: Session): ControlScenarioBackend {
  resetConsole();
  useCommandStore.getState().reset();
  useLockStore.getState().reset();
  const backend = createControlScenarioBackend(session.userId);
  vi.stubGlobal("fetch", backend.fetch);
  useAuthStore.getState().applySession(session, null);
  renderConsole("/", scenarioAuth(session), { createSocket: backend.createSocket });
  return backend;
}

/**
 * Delivers one server frame to the socket, inside `act` so that the screen is up to date when the call returns.
 *
 * @param socket - The socket that receives the frame.
 * @param frame - The validated frame.
 */
function deliver(socket: FakeSocket, frame: WsServerMessage): void {
  act(() => {
    socket.deliver(frame);
  });
}

/**
 * Opens the socket, delivers the fleet snapshot, and waits until the map shows every robot.
 *
 * @param backend - The scenario backend.
 * @returns The socket.
 */
async function connectFleet(backend: ControlScenarioBackend): Promise<FakeSocket> {
  const socket = await vi.waitFor(() => {
    const opened = backend.sockets.at(0);
    if (opened === undefined) {
      throw new Error("socket not opened yet");
    }
    return opened;
  });
  act(() => {
    socket.open();
  });
  deliver(socket, snapshotFrame(FLEET_SIZE, Date.now()));
  await vi.waitFor(() => {
    expect(screen.queryAllByRole("button", { name: /^sim-\d{2}, / })).toHaveLength(FLEET_SIZE);
  });
  return socket;
}

/**
 * Opens the robot from its marker on the map, as an operator does, and waits for the panel.
 *
 * @param user - The user-event instance.
 */
async function openRobot(user: UserEvent): Promise<void> {
  const marker = await vi.waitFor(() => screen.getByRole("button", { name: MARKER_NAME }));
  await user.click(marker);
  await vi.waitFor(() => {
    expect(screen.getByRole("heading", PANEL_HEADING)).toBeTruthy();
  });
}

/**
 * The recorded requests sent to one route with one method.
 *
 * @param backend - The scenario backend.
 * @param method - HTTP method.
 * @param path - Path of the route.
 * @returns The matching requests, in order.
 */
function requestsTo(
  backend: ControlScenarioBackend,
  method: string,
  path: string,
): ScenarioRequest[] {
  return backend.requests.filter((request) => request.method === method && request.path === path);
}

/**
 * The command types the console posted to the robot, in order.
 *
 * @param backend - The scenario backend.
 * @returns The types.
 */
function commandTypesSent(backend: ControlScenarioBackend): (string | undefined)[] {
  return requestsTo(backend, "POST", COMMANDS_PATH).map(commandTypeOf);
}

/**
 * The command identifier the console sent in a recorded request. A request without one is a broken scenario, so it
 * fails the test rather than being matched with an empty identifier.
 *
 * @param request - The recorded request.
 * @returns The identifier.
 */
function sentCommandId(request: ScenarioRequest): string {
  const commandId = commandIdOf(request);
  if (commandId === undefined) {
    throw new Error("the request carries no command identifier");
  }
  return commandId;
}

/**
 * The number of heartbeats the console sent on the socket.
 *
 * @param socket - The socket.
 * @returns The count.
 */
function heartbeatCount(socket: FakeSocket): number {
  return socket.sent.filter(
    (frame) =>
      typeof frame === "object" && frame !== null && "type" in frame && frame.type === "heartbeat",
  ).length;
}

describe("control scenario: an operator takes control and pauses the robot", () => {
  it("takes control, sends heartbeats while it holds the lock, pauses with the ACK latency, and stops the heartbeats on release", async () => {
    const user = userEvent.setup();
    const backend = openConsole(CONTROL_OPERATOR);
    const socket = await connectFleet(backend);
    await openRobot(user);
    await vi.waitFor(() => {
      expect(screen.getByText("No one has control")).toBeTruthy();
    });

    await user.click(screen.getByRole("button", { name: "Take control" }));
    const take = await vi.waitFor(() => {
      const [request] = requestsTo(backend, "POST", LOCK_PATH);
      if (request === undefined) {
        throw new Error("take not sent yet");
      }
      return request;
    });
    deliver(socket, ackFrame(sentCommandId(take)));
    await vi.waitFor(() => {
      expect(screen.getByText("Control: you")).toBeTruthy();
    });

    const beforeBeats = heartbeatCount(socket);
    act(() => {
      vi.advanceTimersByTime(4 * CONSOLE_HEARTBEAT_INTERVAL_MS);
    });
    expect(heartbeatCount(socket) - beforeBeats).toBe(4);

    await user.click(screen.getByRole("button", { name: "Pause" }));
    const pause = await vi.waitFor(() => {
      const found = requestsTo(backend, "POST", COMMANDS_PATH).find(
        (request) => commandTypeOf(request) === "PAUSE",
      );
      if (found === undefined) {
        throw new Error("pause not sent yet");
      }
      return found;
    });
    deliver(socket, ackFrame(sentCommandId(pause)));
    expect(screen.getByText(/^Pause · \d+ ms$/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Release control" }));
    await vi.waitFor(() => {
      expect(screen.getByText("No one has control")).toBeTruthy();
    });
    expect(requestsTo(backend, "POST", RELEASE_PATH)).toHaveLength(1);

    const beforeRelease = heartbeatCount(socket);
    act(() => {
      vi.advanceTimersByTime(4 * CONSOLE_HEARTBEAT_INTERVAL_MS);
    });
    expect(heartbeatCount(socket) - beforeRelease).toBe(0);
    expect(commandTypesSent(backend)).toEqual(["PAUSE"]);
  });
});

describe("control scenario: another operator holds the lock", () => {
  it("disables the commands and names the holder when a second operator's lock arrives on the socket", async () => {
    const user = userEvent.setup();
    const backend = openConsole(CONTROL_OPERATOR);
    const socket = await connectFleet(backend);
    await openRobot(user);

    deliver(socket, lockChangedFrame(true, OTHER_OPERATOR_SUB));

    expect(screen.getByText("Operator 5555 has control")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Resume" }).hasAttribute("disabled")).toBe(true);
    expect(commandTypesSent(backend)).toEqual([]);
  });
});

describe("control scenario: a viewer reads the robot", () => {
  it("shows the lock and no command at all", async () => {
    const user = userEvent.setup();
    const backend = openConsole(CONTROL_VIEWER);
    await connectFleet(backend);
    await openRobot(user);
    await vi.waitFor(() => {
      expect(screen.getByText("No one has control")).toBeTruthy();
    });

    for (const name of [
      "Pause",
      "Resume",
      "Return to base",
      "Release control",
      "Take control",
      "E-stop",
      "Release e-stop",
      "Simulate fault",
    ]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    expect(screen.queryByRole("group", { name: "Commands" })).toBeNull();
    expect(backend.requests.filter((request) => request.method === "POST")).toEqual([]);
  });
});

describe("control scenario: the robot is e-stopped", () => {
  it("replaces the e-stop with the release of the e-stop", async () => {
    const user = userEvent.setup();
    const backend = openConsole(CONTROL_OPERATOR);
    const socket = await connectFleet(backend);
    await openRobot(user);

    deliver(socket, estopFrame());

    expect(
      await vi.waitFor(() => screen.getByRole("button", { name: "Release e-stop" })),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "E-stop" })).toBeNull();
    expect(commandTypesSent(backend)).toEqual([]);
  });
});
