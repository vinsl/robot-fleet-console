/**
 * Alert sound made with Web Audio tones: no audio file, no CSP change (ADR 0060).
 *
 * Browsers keep an audio context suspended until a user gesture, so the context is created lazily and the
 * first `pointerdown` or `keydown` tries to resume it. A sound that is still blocked when it is due marks the
 * preference as blocked, which the status line shows as "click to enable".
 */
import { alertSound as sound } from "../theme/tokens";
import { useSoundPreference } from "./sound-preference";

/** Which tone pattern to play: two tones for a critical alert, one for a major alert. */
export type SoundPattern = "critical" | "major";

/** The part of an audio parameter the sound uses. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, when: number): void;
  linearRampToValueAtTime(value: number, when: number): void;
}

/** The part of an oscillator node the sound uses. */
export interface OscillatorLike {
  type: string;
  readonly frequency: AudioParamLike;
  connect(destination: unknown): void;
  start(when: number): void;
  stop(when: number): void;
}

/** The part of a gain node the sound uses. */
export interface GainLike {
  readonly gain: AudioParamLike;
  connect(destination: unknown): void;
}

/** The part of an audio context the sound uses. Injected so that tests run without Web Audio. */
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
}

/** The alert sound. One shared instance serves the console. */
export interface AlertSound {
  /**
   * Resumes audio after a user gesture.
   *
   * @returns `true` when audio is running afterwards.
   */
  unlock(): Promise<boolean>;
  /**
   * Plays one pattern now.
   *
   * @param pattern - The pattern to play.
   * @returns `false` when no audio is available or the browser keeps it blocked.
   */
  play(pattern: SoundPattern): Promise<boolean>;
}

/** Events that count as a user gesture for the audio unlock. */
const UNLOCK_EVENTS = ["pointerdown", "keydown"] as const;

/** Milliseconds per second, to convert the token durations. */
const MS_PER_S = 1_000;

/**
 * Creates the browser audio context, or `null` when the browser has none.
 *
 * @returns A new audio context, or `null`.
 */
function browserContext(): AudioContextLike | null {
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") {
    return null;
  }
  try {
    return new window.AudioContext();
  } catch {
    return null;
  }
}

/**
 * Creates the alert sound.
 *
 * @param createContext - Creates the audio context. Called once, on the first unlock or play.
 * @returns The sound.
 */
export function createAlertSound(
  createContext: () => AudioContextLike | null = browserContext,
): AlertSound {
  let context: AudioContextLike | null | undefined;

  /**
   * Returns the context, creating it on first use.
   *
   * @returns The context, or `null` when there is none.
   */
  function resolveContext(): AudioContextLike | null {
    if (context === undefined) {
      context = createContext();
    }
    return context;
  }

  /**
   * Asks a suspended context to run. A refusal is not an error here: the caller checks the state.
   *
   * @param audio - The context to resume.
   */
  async function tryResume(audio: AudioContextLike): Promise<void> {
    try {
      await audio.resume();
    } catch {
      // Still suspended: the caller reads the state and reports it as blocked.
    }
  }

  /**
   * Schedules the tones of a pattern on a running context.
   *
   * @param audio - The running context.
   * @param pattern - The pattern to schedule.
   */
  function schedule(audio: AudioContextLike, pattern: SoundPattern): void {
    const frequencies =
      pattern === "critical" ? [sound.criticalHz, sound.criticalHz] : [sound.majorHz];
    const toneS = sound.toneMs / MS_PER_S;
    const rampS = sound.rampMs / MS_PER_S;
    const stepS = (sound.toneMs + sound.gapMs) / MS_PER_S;
    frequencies.forEach((hz, index) => {
      const start = audio.currentTime + index * stepS;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = hz;
      oscillator.connect(gain);
      gain.connect(audio.destination);
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(sound.gain, start + rampS);
      gain.gain.linearRampToValueAtTime(0, start + toneS);
      oscillator.start(start);
      oscillator.stop(start + toneS);
    });
  }

  return {
    async unlock() {
      const audio = resolveContext();
      if (audio === null) {
        return false;
      }
      if (audio.state !== "running") {
        await tryResume(audio);
      }
      return audio.state === "running";
    },

    async play(pattern) {
      const audio = resolveContext();
      if (audio === null) {
        return false;
      }
      if (audio.state !== "running") {
        await tryResume(audio);
      }
      if (audio.state !== "running") {
        useSoundPreference.getState().setBlocked(true);
        return false;
      }
      schedule(audio, pattern);
      return true;
    },
  };
}

/**
 * Wires the first user gesture of the page to the audio unlock. The listeners are removed by the returned
 * function, so a page can stop listening.
 *
 * @param alert - The sound to unlock.
 * @param target - The document-like target that receives the gestures. Defaults to `document`.
 * @returns A function that removes the listeners.
 */
export function installAudioUnlock(
  alert: AlertSound,
  target: Pick<Document, "addEventListener" | "removeEventListener"> = document,
): () => void {
  const options: AddEventListenerOptions = { once: true, capture: true };
  const handler = (): void => {
    void alert.unlock().then((unlocked) => {
      if (unlocked) {
        useSoundPreference.getState().setBlocked(false);
      }
    });
  };
  for (const type of UNLOCK_EVENTS) {
    target.addEventListener(type, handler, options);
  }
  return () => {
    for (const type of UNLOCK_EVENTS) {
      target.removeEventListener(type, handler, options);
    }
  };
}

/** The shared alert sound. The audio context is created on the first gesture, never at import. */
export const alertSound: AlertSound = createAlertSound();
