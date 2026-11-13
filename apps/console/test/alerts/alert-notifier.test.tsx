// @vitest-environment jsdom
/**
 * The notifier: a Major alert sounds once and is announced politely, a muted console is still announced, several
 * alerts in one burst make one sound, and an open Critical alert repeats until it is acknowledged.
 */
import { act, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DEMO_SITE_ID, WsServerMessageSchema, type AlertRecord } from "@mfc/protocol";
import { AlertNotifier } from "../../src/alerts/AlertNotifier";
import { alertSound } from "../../src/live/alert-sound";
import { applyAlertFrame } from "../../src/live/alerts-feed";
import { useSoundPreference } from "../../src/live/sound-preference";
import { alertSound as soundTokens } from "../../src/theme/tokens";
import { alertOf } from "../live/support";
import { renderAlerts, resetAlertsState, type AlertsHandle } from "./alerts-harness";

/** Pattern requested from the sound. */
type Pattern = Parameters<typeof alertSound.play>[0];

let harness: AlertsHandle;
let play: MockInstance<typeof alertSound.play>;

beforeEach(async () => {
  await resetAlertsState();
  play = vi.spyOn(alertSound, "play").mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/**
 * Mounts the notifier. The API answers every list request with `active`, so that the cache agrees with the server.
 *
 * @param active - The active alerts the API returns.
 */
function mountNotifier(active: readonly AlertRecord[] = []): void {
  harness = renderAlerts(<AlertNotifier />, {
    respond: () => ({ status: 200, body: { alerts: active } }),
  });
}

/**
 * Applies an `alert.changed` frame to the cache, as the live feed does when a frame arrives.
 *
 * @param change - What changed.
 * @param alert - The alert as the server states it.
 */
function receive(change: "OPENED" | "ACKNOWLEDGED", alert: AlertRecord): void {
  const frame = WsServerMessageSchema.parse({
    type: "alert.changed",
    siteId: DEMO_SITE_ID,
    change,
    alert,
  });
  if (frame.type !== "alert.changed") {
    throw new Error("fixture is not an alert frame");
  }
  act(() => {
    applyAlertFrame(harness.queryClient, frame);
  });
}

/**
 * Reads the text of a live region.
 *
 * @param politeness - The `aria-live` value of the region.
 * @returns The text of the region.
 */
function announced(politeness: "polite" | "assertive"): string {
  return document.querySelector(`[aria-live="${politeness}"]`)?.textContent ?? "";
}

/**
 * Lists the patterns the sound was asked to play, in order.
 *
 * @returns The pattern names.
 */
function playedPatterns(): readonly Pattern[] {
  return play.mock.calls.map(([pattern]) => pattern);
}

/** A Major alert on a robot that is blocked. */
function blocked(alertId: string, robotId: string): AlertRecord {
  return alertOf({ alertId: alertId.repeat(32), kind: "BLOCKED", robotId });
}

/** A Critical alert on a robot in e-stop. */
function estop(): AlertRecord {
  return alertOf({
    alertId: "1".repeat(32),
    kind: "ESTOP",
    severity: "CRITICAL",
    robotId: "sim-01",
  });
}

describe("AlertNotifier: Major alerts", () => {
  it("sounds a Major alert once and announces it politely", () => {
    mountNotifier();
    receive("OPENED", blocked("1", "sim-03"));
    expect(playedPatterns()).toEqual(["major"]);
    expect(announced("polite")).toBe("Major alert: sim-03 blocked");
  });

  it("announces but does not sound while the user has muted the alert", () => {
    useSoundPreference.setState({ muted: true });
    mountNotifier();
    receive("OPENED", blocked("1", "sim-03"));
    expect(play).not.toHaveBeenCalled();
    expect(announced("polite")).toBe("Major alert: sim-03 blocked");
  });

  it("makes one sound for several Major alerts opened in the same burst", () => {
    mountNotifier();
    receive("OPENED", blocked("1", "sim-03"));
    receive("OPENED", blocked("2", "sim-04"));
    expect(playedPatterns()).toEqual(["major"]);
  });
});

describe("AlertNotifier: Critical alerts", () => {
  it("announces a Critical alert assertively", () => {
    mountNotifier();
    receive("OPENED", estop());
    expect(announced("assertive")).toBe("Critical alert: sim-01 in e-stop");
  });

  it("repeats the critical sound until the alert is acknowledged", async () => {
    vi.useFakeTimers();
    mountNotifier([estop()]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(playedPatterns()).toEqual(["critical"]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(soundTokens.repeatMs);
    });
    expect(playedPatterns()).toEqual(["critical", "critical"]);

    receive("ACKNOWLEDGED", {
      ...estop(),
      status: "ACKNOWLEDGED",
      acknowledgedBy: "sub-0f9e-1a2b",
      acknowledgedAt: "2026-11-03T10:00:05.000Z",
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(soundTokens.repeatMs * 3);
    });
    expect(playedPatterns()).toEqual(["critical", "critical"]);
  });

  it("does not repeat a critical sound while muted", async () => {
    useSoundPreference.setState({ muted: true });
    mountNotifier([estop()]);
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    expect(playedPatterns()).not.toContain("critical");
  });
});
