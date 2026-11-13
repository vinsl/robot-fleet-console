/**
 * @vitest-environment jsdom
 *
 * The alert sound toggle: the three states, the mute preference, and the click that unlocks a blocked sound.
 */
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18n";
import { alertSound } from "../../src/live/alert-sound";
import { ALERT_SOUND_STORAGE_KEY, useSoundPreference } from "../../src/live/sound-preference";
import { soundStateOf } from "../../src/layout/SoundToggle";
import { renderStatusLine } from "../support/status-line-harness";
import { resetConsole } from "../support/console-harness";

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
  window.localStorage.removeItem(ALERT_SOUND_STORAGE_KEY);
  useSoundPreference.setState({ muted: false, blocked: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("soundStateOf", () => {
  it.each<[boolean, boolean, string]>([
    [false, false, "on"],
    [false, true, "blocked"],
    [true, false, "muted"],
    [true, true, "muted"],
  ])("muted=%s blocked=%s gives %s", (muted, blocked, expected) => {
    expect(soundStateOf(muted, blocked)).toBe(expected);
  });
});

describe("SoundToggle", () => {
  it("shows the sound on, not pressed, by default", () => {
    renderStatusLine({});
    const toggle = screen.getByRole("button", { name: "Alert sound on" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
  });

  it("mutes on click and remembers the choice", async () => {
    const user = userEvent.setup();
    renderStatusLine({});
    await user.click(screen.getByRole("button", { name: "Alert sound on" }));
    const toggle = screen.getByRole("button", { name: "Alert sound muted" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(window.localStorage.getItem(ALERT_SOUND_STORAGE_KEY)).toBe("off");
  });

  it("asks for a click when the browser blocked the sound, and unlocks on that click", async () => {
    const user = userEvent.setup();
    const unlock = vi.spyOn(alertSound, "unlock").mockResolvedValue(true);
    useSoundPreference.setState({ blocked: true });
    renderStatusLine({});
    await user.click(screen.getByRole("button", { name: "Click to enable alert sound" }));
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("button", { name: "Alert sound on" })).toBeTruthy();
    expect(useSoundPreference.getState().muted).toBe(false);
  });

  it("keeps the blocked text when the unlock is refused", async () => {
    const user = userEvent.setup();
    vi.spyOn(alertSound, "unlock").mockResolvedValue(false);
    useSoundPreference.setState({ blocked: true });
    renderStatusLine({});
    await user.click(screen.getByRole("button", { name: "Click to enable alert sound" }));
    expect(await screen.findByRole("button", { name: "Click to enable alert sound" })).toBeTruthy();
  });

  it("shows the open-alert count on the status line, as text", () => {
    renderStatusLine({ openAlerts: 2 });
    expect(screen.getByText("2 open")).toBeTruthy();
  });

  it("shows no count when no alert is open", () => {
    renderStatusLine({ openAlerts: 0 });
    expect(screen.queryByText(/open$/)).toBeNull();
  });
});
