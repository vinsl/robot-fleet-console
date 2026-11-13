/**
 * @vitest-environment jsdom
 *
 * The robot panel, rendered with the real stores, hooks and HTTP client. The API answers by path (`panelApi`), and
 * the socket is a flag the tests set, because the panel reads it from the realtime store.
 */
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { StateChip } from "../../src/components/StateChip";
import { useCommandStore } from "../../src/control/command-store";
import { useFleetStore } from "../../src/live/fleet-store";
import { RobotPage } from "../../src/pages/RobotPage";
import { RobotPanel } from "../../src/robot/RobotPanel";
import { robotVisibility } from "../../src/robot/use-robot-context";
import { STATE_VISUALS } from "../../src/theme/robot-state-visuals";
import type { RobotState } from "@mfc/protocol";
import {
  ackOf,
  createControlHarness,
  lockState,
  OTHER_SUB,
  ROBOT,
  SUB,
  json,
  type ControlHarness,
  type RecordedRequest,
} from "../control/support";
import { commandIdOf, panelApi, putRobot, resetPanelStores, setSocket, signIn } from "./support";

/** Every role the panel distinguishes. */
type Who = "Admin" | "Operator" | "Viewer";

/** The holder label of `OTHER_SUB`: `Operator` and the last four characters of the subject. */
const OTHER_LABEL = "Operator 5555";

afterEach(() => {
  cleanup();
  resetPanelStores();
});

/**
 * The type of a command body.
 *
 * @param request - The recorded request.
 * @returns The `type` field, or an empty string.
 */
function bodyType(request: RecordedRequest): string {
  const body = request.body;
  return typeof body === "object" &&
    body !== null &&
    "type" in body &&
    typeof body.type === "string"
    ? body.type
    : "";
}

/**
 * The POSTs of the harness that end with a suffix.
 *
 * @param harness - The harness.
 * @param suffix - The path suffix.
 * @returns The matching requests, in order.
 */
function postsTo(harness: ControlHarness, suffix: string): RecordedRequest[] {
  return harness.requests.filter(
    (request) => request.method === "POST" && request.path.endsWith(suffix),
  );
}

/**
 * The command POSTs, optionally of one type.
 *
 * @param harness - The harness.
 * @param type - The command type to keep, or `undefined` for all.
 * @returns The matching requests.
 */
function commandPosts(harness: ControlHarness, type?: string): RecordedRequest[] {
  return postsTo(harness, "/commands").filter(
    (request) => type === undefined || bodyType(request) === type,
  );
}

/**
 * Renders the panel of the test robot.
 *
 * @param harness - The harness whose services and query cache the panel uses.
 */
function renderPanel(harness: ControlHarness): void {
  const Wrapper = harness.wrapper();
  render(
    <Wrapper>
      <RobotPanel robotId={ROBOT} />
    </Wrapper>,
  );
}

/**
 * Builds a harness and a signed-in user, then renders the panel.
 *
 * @param who - The role of the signed-in user.
 * @param options - The lock the API reports, the socket state and the robot's state.
 * @returns The harness.
 */
function setUp(
  who: Who,
  options: {
    readonly lock: ReturnType<typeof lockState>;
    readonly socket?: boolean;
    readonly state?: RobotState;
    readonly simulated?: boolean;
    readonly demoEnabled?: boolean;
    readonly take?: (request: RecordedRequest) => Response;
  },
): ControlHarness {
  signIn(who, SUB);
  setSocket(options.socket ?? true);
  putRobot(options.state ?? "IDLE", Date.now());
  const harness = createControlHarness(
    panelApi({
      lock: options.lock,
      ...(options.simulated === undefined ? {} : { simulated: options.simulated }),
      ...(options.demoEnabled === undefined ? {} : { demoEnabled: options.demoEnabled }),
      ...(options.take === undefined ? {} : { take: options.take }),
    }),
  );
  renderPanel(harness);
  return harness;
}

describe("who sees which controls", () => {
  it("panel-viewer-has-no-command-ui", async () => {
    setUp("Viewer", { lock: lockState(true, OTHER_SUB), state: "ESTOP" });

    expect(await screen.findByText(`${OTHER_LABEL} has control`)).toBeTruthy();
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
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("panel-operator-no-lock-buttons-disabled-with-hint", async () => {
    setUp("Operator", { lock: lockState(false) });

    const pause = await screen.findByRole("button", { name: "Pause" });
    expect(pause.hasAttribute("disabled")).toBe(true);
    const hintId = pause.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(hintId)?.textContent).toBe("Take control first");
    expect(
      (await screen.findByRole("button", { name: "Take control" })).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("panel-mine-buttons-enabled", async () => {
    setUp("Operator", { lock: lockState(true, SUB) });

    const pause = await screen.findByRole("button", { name: "Pause" });
    await waitFor(() => {
      expect(pause.hasAttribute("disabled")).toBe(false);
    });
    expect(screen.getByRole("button", { name: "Resume" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "Release control" }).hasAttribute("disabled")).toBe(
      false,
    );
    expect(screen.getByText("Control: you")).toBeTruthy();
  });

  it("panel-other-shows-holder-label-and-disabled", async () => {
    setUp("Operator", { lock: lockState(true, OTHER_SUB) });

    expect(await screen.findByText(`${OTHER_LABEL} has control`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  it("estop-visible-for-operator-even-without-lock", async () => {
    setUp("Operator", { lock: lockState(false) });

    const estop = await screen.findByRole("button", { name: "E-stop" });
    expect(estop.hasAttribute("disabled")).toBe(false);
  });

  it("estop-enabled-when-ws-down", async () => {
    const harness = setUp("Operator", { lock: lockState(false), socket: false });
    const user = userEvent.setup();

    const estop = await screen.findByRole("button", { name: "E-stop" });
    expect(estop.hasAttribute("disabled")).toBe(false);
    await user.click(estop);

    await waitFor(() => {
      expect(commandPosts(harness, "ESTOP")).toHaveLength(1);
    });
  });

  it("commands-disabled-when-ws-down", async () => {
    setUp("Operator", { lock: lockState(true, SUB), socket: false });

    const pause = await screen.findByRole("button", { name: "Pause" });
    expect(pause.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Resume" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Release control" }).hasAttribute("disabled")).toBe(
      true,
    );
  });

  it("fault-injector-visibility-table", async () => {
    const rows: readonly [Who | null, boolean, boolean | undefined, boolean][] = [
      ["Admin", true, true, true],
      ["Admin", false, true, false],
      ["Admin", true, false, false],
      ["Admin", true, undefined, false],
      ["Operator", true, true, false],
      ["Viewer", true, true, false],
      [null, true, true, false],
    ];
    for (const [role, demoEnabled, simulated, expected] of rows) {
      expect(robotVisibility({ role, demoEnabled, simulated }).canInjectFault).toBe(expected);
    }

    setUp("Admin", { lock: lockState(false), simulated: true, demoEnabled: true });
    expect(await screen.findByRole("button", { name: "Simulate fault" })).toBeTruthy();
  });

  it("fault-injector-hidden-for-operator-even-in-demo", async () => {
    setUp("Operator", { lock: lockState(false), simulated: true, demoEnabled: true });

    expect(await screen.findByText("Robot 03")).toBeTruthy();
    await act(() => Promise.resolve());
    expect(screen.queryByRole("button", { name: "Simulate fault" })).toBeNull();
  });
});

describe("state history", () => {
  it("panel-history-is-per-robot: opening another robot starts its own history", async () => {
    signIn("Operator", SUB);
    setSocket(true);
    putRobot("MOVING", Date.now());
    const harness = createControlHarness(panelApi({ lock: lockState(false) }));
    const Wrapper = harness.wrapper();
    const { rerender } = render(
      <Wrapper>
        <RobotPanel robotId={ROBOT} />
      </Wrapper>,
    );
    const history = (): HTMLElement => screen.getByRole("list");
    await within(history()).findByText("Moving");

    const other = "robot-04";
    const [first] = Object.values(useFleetStore.getState().robots);
    if (first === undefined) {
      throw new Error("the robot was not put in the fleet");
    }
    act(() => {
      useFleetStore.setState({
        robots: {
          ...useFleetStore.getState().robots,
          [other]: { ...first, robotId: other, state: "IDLE" },
        },
      });
    });
    rerender(
      <Wrapper>
        <RobotPanel robotId={other} />
      </Wrapper>,
    );

    await waitFor(() => {
      expect(within(history()).queryByText("Moving")).toBeNull();
    });
    expect(within(history()).getByText("Idle")).toBeTruthy();
    expect(within(history()).getAllByRole("listitem")).toHaveLength(1);
  });
});

describe("e-stop and release", () => {
  it("estop-one-click-new-command-id-each-press", async () => {
    const harness = setUp("Operator", { lock: lockState(false) });
    const user = userEvent.setup();
    const estop = await screen.findByRole("button", { name: "E-stop" });

    await user.click(estop);
    await user.click(estop);

    await waitFor(() => {
      expect(commandPosts(harness, "ESTOP")).toHaveLength(2);
    });
    const [first, second] = commandPosts(harness, "ESTOP");
    expect(commandIdOf(first as RecordedRequest)).not.toBe(commandIdOf(second as RecordedRequest));
    expect(postsTo(harness, "/lock")).toHaveLength(0);
  });

  it("release-estop-confirm-flow", async () => {
    const harness = setUp("Operator", { lock: lockState(true, OTHER_SUB), state: "ESTOP" });
    const user = userEvent.setup();
    const release = await screen.findByRole("button", { name: "Release e-stop" });

    await user.click(release);
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Confirm" });
    expect(document.activeElement).toBe(confirm);

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Release e-stop" }));

    await user.click(screen.getByRole("button", { name: "Release e-stop" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm" }),
    );

    await waitFor(() => {
      expect(postsTo(harness, "/lock")).toHaveLength(1);
    });
    const take = postsTo(harness, "/lock")[0] as RecordedRequest;
    act(() => {
      useCommandStore.getState().applyAck(ackOf(commandIdOf(take)), performance.now());
    });

    await waitFor(() => {
      expect(commandPosts(harness, "ESTOP_RELEASE")).toHaveLength(1);
    });
  });

  it("release-estop-failure-keeps-button", async () => {
    const harness = setUp("Operator", {
      lock: lockState(true, OTHER_SUB),
      state: "ESTOP",
      take: () =>
        json(409, {
          type: "https://mfc.example/problems/lock-held",
          title: "Lock held",
          status: 409,
        }),
    });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Release e-stop" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Confirm" }),
    );

    expect(await screen.findByText("Take control · Failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Release e-stop" })).toBeTruthy();
    expect(commandPosts(harness, "ESTOP_RELEASE")).toHaveLength(0);
  });
});

describe("command log", () => {
  it("command-log-shows-latency-and-reason", async () => {
    const harness = setUp("Operator", { lock: lockState(true, SUB) });
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Pause" }));
    await waitFor(() => {
      expect(commandPosts(harness, "PAUSE")).toHaveLength(1);
    });
    act(() => {
      useCommandStore
        .getState()
        .applyAck(
          ackOf(commandIdOf(commandPosts(harness, "PAUSE")[0] as RecordedRequest)),
          performance.now(),
        );
    });

    await user.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => {
      expect(commandPosts(harness, "RESUME")).toHaveLength(1);
    });
    act(() => {
      useCommandStore
        .getState()
        .applyAck(
          ackOf(
            commandIdOf(commandPosts(harness, "RESUME")[0] as RecordedRequest),
            "NOT_LOCK_HOLDER",
          ),
          performance.now(),
        );
    });

    expect(await screen.findByText(/^Pause · \d+ ms$/)).toBeTruthy();
    expect(screen.getByText("Resume · not the lock holder")).toBeTruthy();
  });
});

describe("state language", () => {
  it("no-colour-only-state", () => {
    for (const state of Object.keys(STATE_VISUALS) as RobotState[]) {
      const { container, unmount } = render(<StateChip state={state} />);
      expect(container.textContent).toMatch(/\S/);
      expect(container.querySelector("svg")).not.toBeNull();
      unmount();
    }
  });
});

describe("robot page guard", () => {
  it("viewer-on-robot-page-readonly", async () => {
    signIn("Viewer", SUB);
    setSocket(true);
    putRobot("IDLE", Date.now());
    const harness = createControlHarness(panelApi({ lock: lockState(true, OTHER_SUB) }));
    const Wrapper = harness.wrapper();
    render(
      <Wrapper>
        <MemoryRouter initialEntries={["/robots/sim-01"]}>
          <Routes>
            <Route path="/robots/:robotId" element={<RobotPage />} />
          </Routes>
        </MemoryRouter>
      </Wrapper>,
    );

    expect(await screen.findByText(`${OTHER_LABEL} has control`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
    expect(screen.queryByRole("button", { name: "E-stop" })).toBeNull();
  });
});
