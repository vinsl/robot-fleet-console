/**
 * @vitest-environment jsdom
 *
 * The video pane of a real robot: its states and overlay, the viewer's lifetime, the channel it names, and the
 * simulated robot that opens no channel. The viewer itself is replaced by a fake that records its callbacks.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RobotId, RobotState } from "@mfc/protocol";
import "../../src/i18n";
import { createServices } from "../../src/app/create-services";
import { ServicesProvider } from "../../src/app/services";
import { createFakeAuthClient } from "../../src/auth/fake-auth-client";
import { VideoSlot } from "../../src/robot/VideoSlot";
import type { ViewerDeps } from "../../src/video/kvs-viewer";
import { TEST_CONFIG } from "../support/console-harness";

const { connect } = vi.hoisted(() => ({
  connect: vi.fn<(deps: ViewerDeps) => () => void>(),
}));

vi.mock("../../src/video/kvs-viewer", () => ({ connectViewer: connect }));

const ROBOT: RobotId = "robot-03";

const OVERLAY = { name: "Robot 03", state: "IDLE" as RobotState, pose: null };

/**
 * Renders the slot inside the services provider, as the console does.
 *
 * @param simulated - Whether the robot is simulated, or `undefined` while the registry loads.
 * @param robotId - The robot the slot shows.
 * @returns The render result.
 */
function renderSlot(simulated: boolean | undefined, robotId: RobotId = ROBOT) {
  const services = createServices(TEST_CONFIG, { auth: createFakeAuthClient() });
  return render(
    <ServicesProvider value={services}>
      <VideoSlot robotId={robotId} simulated={simulated} overlay={OVERLAY} />
    </ServicesProvider>,
  );
}

/**
 * Returns the callbacks of the most recent viewer.
 *
 * @returns The viewer dependencies.
 * @throws {Error} When no viewer was started.
 */
function lastViewer(): ViewerDeps {
  const deps = connect.mock.calls.at(-1)?.[0];
  if (deps === undefined) {
    throw new Error("no viewer was started");
  }
  return deps;
}

afterEach(() => {
  cleanup();
  connect.mockReset();
});

describe("VideoPane", () => {
  it("video-pane-states: shows connecting, then live with the latency, then unavailable", () => {
    connect.mockReturnValue(() => undefined);
    renderSlot(false);

    expect(screen.getByRole("status").textContent).toBe("Connecting video…");

    act(() => {
      lastViewer().onState("live");
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("LIVE")).toBeTruthy();

    act(() => {
      lastViewer().onStats({ rttMs: 212.4 });
    });
    expect(screen.getByText("LIVE · 212 ms")).toBeTruthy();

    act(() => {
      lastViewer().onState("unavailable");
    });
    expect(screen.getByRole("status").textContent).toBe("Video unavailable");
    expect(screen.queryByText(/LIVE/)).toBeNull();
  });

  it("video-pane-states: the overlay keeps the name and the state chip in every state", () => {
    connect.mockReturnValue(() => undefined);
    renderSlot(false);
    act(() => {
      lastViewer().onState("unavailable");
    });

    expect(screen.getByText("Robot 03")).toBeTruthy();
    expect(screen.getByText("Idle")).toBeTruthy();
  });

  it("info-overlay-can-be-hidden: the toggle hides the details, keeps the latency, and shows them again", async () => {
    const user = userEvent.setup();
    renderSlot(false);
    act(() => {
      lastViewer().onState("live");
    });
    expect(screen.getByText("Robot 03")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Hide the information" }));
    expect(screen.queryByText("Robot 03")).toBeNull();
    expect(screen.getByText(/LIVE/)).toBeTruthy();
    const show = screen.getByRole("button", { name: "Show the information" });
    expect(show.getAttribute("aria-pressed")).toBe("true");
    await user.click(show);
    expect(screen.getByText("Robot 03")).toBeTruthy();
  });

  it("the video element is muted, plays inline and has no controls", () => {
    connect.mockReturnValue(() => undefined);
    renderSlot(false);

    const video = screen.getByLabelText("Live camera");
    expect(video).toBeInstanceOf(HTMLVideoElement);
    expect(video).toHaveProperty("muted", true);
    expect(video).toHaveProperty("autoplay", true);
    expect(video.hasAttribute("playsinline")).toBe(true);
    expect(video.hasAttribute("controls")).toBe(false);
  });

  it("viewer-disposed-on-unmount: stops the viewer when the panel closes", () => {
    const dispose = vi.fn();
    connect.mockReturnValue(dispose);
    const { unmount } = renderSlot(false);
    expect(connect).toHaveBeenCalledTimes(1);

    unmount();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("viewer-disposed-on-unmount: stops the old viewer and starts one for the new robot on a route change", () => {
    const dispose = vi.fn();
    connect.mockReturnValue(dispose);
    const services = createServices(TEST_CONFIG, { auth: createFakeAuthClient() });
    const { rerender } = render(
      <ServicesProvider value={services}>
        <VideoSlot robotId={ROBOT} simulated={false} overlay={OVERLAY} />
      </ServicesProvider>,
    );

    rerender(
      <ServicesProvider value={services}>
        <VideoSlot robotId="robot-04" simulated={false} overlay={OVERLAY} />
      </ServicesProvider>,
    );

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(lastViewer().channelName).toBe("mfc-demo-robot-04");
  });

  it("channel-name-from-validated-robot-id: the channel is the thing name of the robot id", () => {
    connect.mockReturnValue(() => undefined);
    renderSlot(false);

    expect(lastViewer().channelName).toBe("mfc-demo-robot-03");
    expect(lastViewer().region).toBe("eu-west-3");
  });
});

describe("VideoSlot without a camera", () => {
  it("simulated-robot-shows-no-camera: a simulated robot shows the sentence and opens no channel", () => {
    renderSlot(true);

    expect(screen.getByText("No camera")).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });

  it("does not open a viewer while the registry loads, and says the video is unavailable", () => {
    renderSlot(undefined);

    expect(screen.getByText("Video unavailable")).toBeTruthy();
    expect(connect).not.toHaveBeenCalled();
  });
});
