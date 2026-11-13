// @vitest-environment jsdom
/**
 * The fleet scenario, through the whole console tree: an Operator opens the console, the robots and the alerts
 * arrive on the socket, and the operator acts on what they show. The shell, the live store, the alerts feed, the
 * map, the sheets and the KPIs are the real ones. Stubbed: the network (a scripted backend), the socket (a fake the
 * test drives), the sound (a fake that records the patterns), the clock (pinned) and the layout hook of the map
 * (jsdom has no layout).
 *
 * Scenarios: a fleet that comes online; a blocked robot seen on every surface; an alert acknowledged and resolved,
 * then counted in the KPIs; a reconnection that keeps the robots and refetches the alerts; a Viewer who may only
 * read; a frame that names another site and never reaches the fleet; twenty robots fed at 1 Hz.
 */
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_SITE_ID, type WsServerMessage } from "@mfc/protocol";
import "../../src/i18n";
import { useAuthStore } from "../../src/auth/auth-store";
import type { Session } from "../../src/auth/cognito-client";
import type * as AlertSoundModule from "../../src/live/alert-sound";
import type { SoundPattern } from "../../src/live/alert-sound";
import type * as FleetReducerModule from "../../src/live/fleet-reducer";
import type { PlaneGeometry } from "../../src/fleet/map/projection";
import { applyFrame } from "../../src/live/fleet-reducer";
import { renderConsole, resetConsole } from "../support/console-harness";
import {
  ALERTS_PATH,
  OPERATOR_SESSION,
  SCENARIO_ALERT_ID,
  SCENARIO_NOW_MS,
  VIEWER_SESSION,
  alertFrame,
  blockedAlert,
  blockedEventFrame,
  createScenarioBackend,
  deltaFrame,
  foreignSiteFrame,
  scenarioAuth,
  snapshotFrame,
  type FakeSocket,
  type ScenarioBackend,
  type ScenarioRequest,
} from "../fixtures/fleet-scenario";

const { sound, plane } = vi.hoisted(() => {
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
  return {
    sound: {
      unlock: vi.fn<() => Promise<boolean>>(() => Promise.resolve(true)),
      play: vi.fn<(pattern: SoundPattern) => Promise<boolean>>(() => Promise.resolve(true)),
    },
    plane: geometry,
  };
});

// The sound is recorded, not played: the notifier decides which pattern to request, and that is what the test checks.
vi.mock("../../src/live/alert-sound", async (importOriginal) => {
  const actual = await importOriginal<typeof AlertSoundModule>();
  return { ...actual, alertSound: sound };
});

// The reducer is wrapped, not replaced, so that the test can count its calls and nothing else changes.
vi.mock("../../src/live/fleet-reducer", async (importOriginal) => {
  const actual = await importOriginal<typeof FleetReducerModule>();
  return { ...actual, applyFrame: vi.fn(actual.applyFrame) };
});

// jsdom has no layout, so the map cannot measure its stage. The plane is fixed; everything else is the real map.
vi.mock("../../src/fleet/map/geometry-hooks", () => ({
  usePlaneGeometry: () => plane,
  useCompactTilt: () => false,
}));

/** Accessible name of a robot marker, for example `sim-03, Blocked, battery 80.0 %`. */
const MARKER_NAME = /^sim-\d{2}, /;

/** Pinned clock: only `Date` is faked, so timers and the React scheduler keep running for real. */
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SCENARIO_NOW_MS);
  sound.play.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Opens the console on the fleet view, as a signed-in user, against the scenario backend and socket.
 *
 * @param session - The user to sign in as. Defaults to the Operator.
 * @returns The backend the scenario drives.
 */
function openConsole(session: Session = OPERATOR_SESSION): ScenarioBackend {
  resetConsole();
  const backend = createScenarioBackend();
  vi.stubGlobal("fetch", backend.fetch);
  useAuthStore.getState().applySession(session, null);
  renderConsole("/", scenarioAuth(session), { createSocket: backend.createSocket });
  return backend;
}

/**
 * Waits for the client to open the socket with the given index, and returns it.
 *
 * @param backend - The scenario backend.
 * @param index - Zero-based index of the socket, in opening order.
 * @returns The socket.
 */
async function socketAt(backend: ScenarioBackend, index: number): Promise<FakeSocket> {
  await waitFor(
    () => {
      expect(backend.sockets.length).toBeGreaterThan(index);
    },
    { timeout: 3000 },
  );
  const socket = backend.sockets.at(index);
  if (socket === undefined) {
    throw new Error(`socket ${String(index)} was not opened`);
  }
  return socket;
}

/**
 * Delivers one server frame to the socket, inside `act` so that the screen is up to date when the call returns.
 *
 * @param socket - The socket that receives the frame.
 * @param frame - The frame.
 */
function deliver(socket: FakeSocket, frame: WsServerMessage): void {
  act(() => {
    socket.deliver(frame);
  });
}

/**
 * The robot markers on the map, as the accessibility tree names them.
 *
 * @returns The marker buttons currently shown.
 */
function markers(): HTMLElement[] {
  return screen.queryAllByRole("button", { name: MARKER_NAME });
}

/**
 * Connects the socket, opens it, delivers the snapshot of the fleet, and waits until every robot has a marker.
 *
 * @param backend - The scenario backend.
 * @param count - Number of robots in the snapshot.
 * @returns The socket.
 */
async function connectFleet(backend: ScenarioBackend, count = 10): Promise<FakeSocket> {
  const socket = await socketAt(backend, 0);
  act(() => {
    socket.open();
  });
  deliver(socket, snapshotFrame(count, Date.now()));
  await waitFor(
    () => {
      expect(markers()).toHaveLength(count);
    },
    { timeout: 3000 },
  );
  return socket;
}

/**
 * The requests the console sent to one route.
 *
 * @param backend - The scenario backend.
 * @param method - HTTP method.
 * @param path - Path of the route.
 * @returns The matching requests, in order.
 */
function requestsTo(backend: ScenarioBackend, method: string, path: string): ScenarioRequest[] {
  return backend.requests.filter((request) => request.method === method && request.path === path);
}

/**
 * The active-alert list requests the console sent, which the alerts feed refetches after a reconnection.
 *
 * @param backend - The scenario backend.
 * @returns The matching requests, in order.
 */
function activeListRequests(backend: ScenarioBackend): ScenarioRequest[] {
  return requestsTo(backend, "GET", ALERTS_PATH).filter((request) =>
    request.search.includes("status=active"),
  );
}

/**
 * Reads the body of a request as JSON. The body was produced by the console, so a parse failure is a test failure.
 *
 * @param request - The recorded request.
 * @returns The parsed body.
 */
function bodyOf(request: ScenarioRequest): unknown {
  const parsed: unknown = JSON.parse(request.body ?? "null");
  return parsed;
}

/**
 * The availability corner of the KPI bar, which is a link to the KPI sheet.
 *
 * @returns The corner link.
 */
function availabilityCorner(): HTMLElement {
  const corners = within(screen.getByRole("navigation", { name: "KPI" }));
  return corners.getByRole("link", { name: /^Availability/ });
}

/**
 * Opens the alert the scenario uses: stores it on the server and delivers the frame that announces it.
 *
 * @param backend - The scenario backend.
 * @param socket - The socket that receives the frame.
 */
function openAlert(backend: ScenarioBackend, socket: FakeSocket): void {
  const alert = blockedAlert();
  backend.store(alert);
  deliver(socket, alertFrame("OPENED", alert));
}

describe("fleet scenario: the fleet comes online", () => {
  it("subscribes, shows ten robots, the online count and full availability once the socket opens", async () => {
    const backend = openConsole();
    const socket = await connectFleet(backend, 10);

    expect(socket.sent).toContainEqual({ type: "subscribe", siteId: DEMO_SITE_ID });
    expect(screen.getByText("10 online")).toBeTruthy();
    expect(availabilityCorner().textContent).toContain("100%");
  });

  it("refuses a frame that names another site, so that the fleet does not count its robot", async () => {
    const backend = openConsole();
    const socket = await connectFleet(backend, 10);

    deliver(socket, foreignSiteFrame());

    expect(markers()).toHaveLength(10);
    expect(screen.queryByRole("button", { name: /^sim-99, / })).toBeNull();
    expect(screen.getByText("10 online")).toBeTruthy();
  });
});

describe("fleet scenario: a robot is blocked", () => {
  it("shows the blocked robot on its marker, in the alert pill, in the live region, and plays the Major sound once", async () => {
    const backend = openConsole();
    const socket = await connectFleet(backend, 10);

    deliver(socket, blockedEventFrame("sim-03", 2));
    openAlert(backend, socket);

    expect(
      await screen.findByRole("button", { name: "sim-03, Blocked, battery 80.0 %" }),
    ).toBeTruthy();
    expect(await screen.findByText("sim-03 blocked")).toBeTruthy();
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Major alert: sim-03 blocked",
    );
    expect(sound.play).toHaveBeenCalledTimes(1);
    expect(sound.play).toHaveBeenCalledWith("major");
    expect(availabilityCorner().textContent).toContain("90%");
  });

  it("lets a Viewer see the alert, but offers no action on it", async () => {
    const user = userEvent.setup();
    const backend = openConsole(VIEWER_SESSION);
    const socket = await connectFleet(backend, 10);
    openAlert(backend, socket);

    await user.click(await screen.findByRole("link", { name: /^Alerts/ }));

    expect(await screen.findByText("Viewers can read alerts but not change them.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Acknowledge" })).toBeNull();
    expect(
      requestsTo(backend, "POST", `${ALERTS_PATH}/${SCENARIO_ALERT_ID}/acknowledge`),
    ).toHaveLength(0);
  });
});

describe("fleet scenario: an alert is acted on", () => {
  it("acknowledges an alert from the sheet, sends its opened time, and drops the pill", async () => {
    const user = userEvent.setup();
    const backend = openConsole();
    const socket = await connectFleet(backend, 10);
    openAlert(backend, socket);
    await screen.findByRole("button", { name: "View" });

    await user.click(screen.getByRole("link", { name: /^Alerts/ }));
    await user.click(await screen.findByRole("button", { name: "Acknowledge" }));

    expect(await screen.findByText(/^Acknowledged by you/)).toBeTruthy();
    const posts = requestsTo(backend, "POST", `${ALERTS_PATH}/${SCENARIO_ALERT_ID}/acknowledge`);
    expect(posts.map(bodyOf)).toEqual([{ openedAt: blockedAlert().openedAt }]);
    expect(screen.queryByRole("button", { name: "View" })).toBeNull();
  });

  it("resolves an alert, moves it to history with its time to resolve, and gives the KPI an MTTR", async () => {
    const user = userEvent.setup();
    const backend = openConsole();
    const socket = await connectFleet(backend, 10);
    openAlert(backend, socket);

    await user.click(screen.getByRole("link", { name: /^Alerts/ }));
    await user.click(await screen.findByRole("button", { name: "Acknowledge" }));
    await user.click(await screen.findByRole("button", { name: "Resolve" }));

    expect(await screen.findByText("No open alert.")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: /^History/ }));
    expect(await screen.findByText(/^Resolved by you after/)).toBeTruthy();

    await user.click(screen.getByRole("link", { name: "KPI" }));
    const heading = await screen.findByRole("heading", { name: "MTTR" });
    expect(heading.closest("section")?.textContent).not.toContain("No data yet");
  });
});

describe("fleet scenario: the connection drops", () => {
  it("keeps the robots through a reconnection, subscribes again and refetches the alerts", async () => {
    const backend = openConsole();
    const first = await connectFleet(backend, 10);

    // Full jitter draws zero, so the retry is due at once and the scenario does not wait for a backoff.
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    act(() => {
      first.drop();
    });
    // The gap is read synchronously: the retry timer cannot fire until this test yields.
    expect(screen.getByText("Reconnecting…")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: /, Offline/ })).toHaveLength(0);
    expect(markers()).toHaveLength(10);

    const second = await socketAt(backend, 1);
    random.mockRestore();
    // Counted from here, after the new socket exists, so that only the refetch of this reconnection is measured.
    const activeBefore = activeListRequests(backend).length;
    act(() => {
      second.open();
    });

    expect(second.sent).toContainEqual({ type: "subscribe", siteId: DEMO_SITE_ID });
    await waitFor(
      () => {
        expect(activeListRequests(backend).length).toBeGreaterThan(activeBefore);
      },
      { timeout: 3000 },
    );
    expect(screen.getByText("10 online")).toBeTruthy();
  });
});

describe("fleet scenario: the fleet at load", () => {
  it("draws twenty robots fed at 1 Hz for ten seconds, with one reducer call per frame", async () => {
    const backend = openConsole();
    const socket = await socketAt(backend, 0);
    act(() => {
      socket.open();
    });
    await screen.findByRole("img", { name: "Warehouse map" }, { timeout: 3000 });

    const callsBefore = vi.mocked(applyFrame).mock.calls.length;
    for (let tick = 0; tick < 10; tick += 1) {
      // Only Date is faked, so this moves the clock without freezing the timers that waitFor relies on.
      vi.setSystemTime(SCENARIO_NOW_MS + tick * 1000);
      deliver(socket, deltaFrame(20, tick + 1));
    }

    expect(vi.mocked(applyFrame).mock.calls.length - callsBefore).toBe(10);
    await waitFor(
      () => {
        expect(markers()).toHaveLength(20);
      },
      { timeout: 3000 },
    );
  });
});
