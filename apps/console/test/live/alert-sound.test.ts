// @vitest-environment jsdom
/**
 * Alert sound: tone scheduling, suspended and missing audio, the one-shot gesture unlock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  alertSound as sharedSound,
  createAlertSound,
  installAudioUnlock,
  type AudioContextLike,
  type AlertSound,
  type OscillatorLike,
} from "../../src/live/alert-sound";
import { useSoundPreference } from "../../src/live/sound-preference";
import { alertSound } from "../../src/theme/tokens";

/** A recording audio context. Its state and the resume outcome are set by each test. */
class FakeAudio implements AudioContextLike {
  state = "suspended";
  currentTime = 0;
  readonly destination = {};
  readonly oscillators: { frequency: number; start: number; stop: number }[] = [];
  readonly resume = vi.fn((): Promise<void> => {
    if (this.resumeWorks) {
      this.state = "running";
    }
    return Promise.resolve();
  });

  constructor(private readonly resumeWorks: boolean) {}

  createOscillator(): OscillatorLike {
    const record = { frequency: 0, start: -1, stop: -1 };
    this.oscillators.push(record);
    return {
      type: "",
      frequency: {
        get value(): number {
          return record.frequency;
        },
        set value(next: number) {
          record.frequency = next;
        },
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
      start: (when) => {
        record.start = when;
      },
      stop: (when) => {
        record.stop = when;
      },
    };
  }

  createGain() {
    return {
      gain: {
        value: 0,
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    };
  }
}

beforeEach(() => {
  useSoundPreference.setState({ muted: false, blocked: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createAlertSound", () => {
  it("plays a critical pattern as two tones and a major pattern as one", async () => {
    const audio = new FakeAudio(true);
    audio.state = "running";
    const sound = createAlertSound(() => audio);

    expect(await sound.play("critical")).toBe(true);
    expect(audio.oscillators.map((o) => o.frequency)).toEqual([
      alertSound.criticalHz,
      alertSound.criticalHz,
    ]);

    audio.oscillators.length = 0;
    expect(await sound.play("major")).toBe(true);
    expect(audio.oscillators.map((o) => o.frequency)).toEqual([alertSound.majorHz]);
  });

  it("resumes a suspended context on play", async () => {
    const audio = new FakeAudio(true);
    const sound = createAlertSound(() => audio);
    expect(await sound.play("major")).toBe(true);
    expect(audio.resume).toHaveBeenCalledTimes(1);
  });

  it("returns false and records the block when the context stays suspended", async () => {
    const audio = new FakeAudio(false);
    const sound = createAlertSound(() => audio);

    expect(await sound.play("critical")).toBe(false);
    expect(audio.oscillators).toHaveLength(0);
    expect(useSoundPreference.getState().blocked).toBe(true);
  });

  it("treats a refused resume as a block rather than an error", async () => {
    const audio = new FakeAudio(false);
    audio.resume.mockImplementationOnce(() => Promise.reject(new Error("refused")));
    const sound = createAlertSound(() => audio);
    await expect(sound.play("major")).resolves.toBe(false);
  });

  it("unlock reports whether audio runs afterwards, and clears nothing by itself", async () => {
    const sound = createAlertSound(() => new FakeAudio(true));
    expect(await sound.unlock()).toBe(true);
    expect(useSoundPreference.getState().blocked).toBe(false);

    const stuck = createAlertSound(() => new FakeAudio(false));
    expect(await stuck.unlock()).toBe(false);
  });

  it("creates the context once, on first use", async () => {
    const audio = new FakeAudio(true);
    const createContext = vi.fn(() => audio);
    const sound = createAlertSound(createContext);
    await sound.unlock();
    await sound.play("major");
    expect(createContext).toHaveBeenCalledTimes(1);
  });

  it("returns false without throwing when the browser has no audio", async () => {
    const sound = createAlertSound(() => null);
    expect(await sound.play("critical")).toBe(false);
    expect(await sound.unlock()).toBe(false);
  });

  it("has no audio in jsdom, so the shared sound degrades to false", async () => {
    await expect(sharedSound.play("major")).resolves.toBe(false);
  });
});

describe("installAudioUnlock", () => {
  it("listens once for the first pointer or key press, and unlocks on it", async () => {
    const audio = new FakeAudio(true);
    const sound: AlertSound = createAlertSound(() => audio);
    useSoundPreference.setState({ blocked: true });
    const addSpy = vi.spyOn(document, "addEventListener");

    const stop = installAudioUnlock(sound, document);
    expect(addSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), {
      once: true,
      capture: true,
    });
    expect(addSpy).toHaveBeenCalledWith("keydown", expect.any(Function), {
      once: true,
      capture: true,
    });

    document.dispatchEvent(new Event("pointerdown"));
    await vi.waitFor(() => {
      expect(useSoundPreference.getState().blocked).toBe(false);
    });
    stop();
  });

  it("removes its listeners when stopped", () => {
    const removeSpy = vi.spyOn(document, "removeEventListener");
    const stop = installAudioUnlock(
      createAlertSound(() => null),
      document,
    );
    stop();
    expect(removeSpy).toHaveBeenCalledWith("pointerdown", expect.any(Function), {
      once: true,
      capture: true,
    });
    expect(removeSpy).toHaveBeenCalledWith("keydown", expect.any(Function), {
      once: true,
      capture: true,
    });
  });
});
