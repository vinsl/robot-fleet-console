// @vitest-environment jsdom
/**
 * Alert sound preference: the mute is stored under its key, read on load, and a storage failure is ignored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_SOUND_STORAGE_KEY, useSoundPreference } from "../../src/live/sound-preference";

beforeEach(() => {
  window.localStorage.clear();
  useSoundPreference.setState({ muted: false, blocked: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSoundPreference", () => {
  it("stores the mute under the documented key", () => {
    useSoundPreference.getState().setMuted(true);
    expect(window.localStorage.getItem(ALERT_SOUND_STORAGE_KEY)).toBe("off");
    expect(useSoundPreference.getState().muted).toBe(true);

    useSoundPreference.getState().setMuted(false);
    expect(window.localStorage.getItem(ALERT_SOUND_STORAGE_KEY)).toBe("on");
  });

  it("reads a stored mute when the module loads", async () => {
    window.localStorage.setItem(ALERT_SOUND_STORAGE_KEY, "off");
    vi.resetModules();
    const fresh = await import("../../src/live/sound-preference");
    expect(fresh.useSoundPreference.getState().muted).toBe(true);
  });

  it("keeps the choice for the page when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => {
      useSoundPreference.getState().setMuted(true);
    }).not.toThrow();
    expect(useSoundPreference.getState().muted).toBe(true);
  });

  it("records whether the browser blocked the sound", () => {
    useSoundPreference.getState().setBlocked(true);
    expect(useSoundPreference.getState().blocked).toBe(true);
    useSoundPreference.getState().setBlocked(false);
    expect(useSoundPreference.getState().blocked).toBe(false);
  });
});
