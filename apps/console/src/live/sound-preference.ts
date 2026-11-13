/**
 * Local preference of the alert sound: muted or not, and whether the browser blocked the last attempt.
 *
 * The mute is kept in `localStorage` under {@link ALERT_SOUND_STORAGE_KEY}. It is a display preference, not a
 * credential. Storage may be disabled (private mode, policy), in which case the preference lasts for the page.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";

/** Key of the mute preference in `localStorage`. */
export const ALERT_SOUND_STORAGE_KEY = "mfc.alertSound";

/** Stored value of a muted sound. Any other stored value, or none, means sound on. */
const MUTED_VALUE = "off";
const ON_VALUE = "on";

/** The sound preference and its setters. */
export interface SoundPreferenceState {
  /** Whether the user muted the alert sound. */
  readonly muted: boolean;
  /** Whether the browser refused the last sound because no user gesture unlocked audio. */
  readonly blocked: boolean;
  /**
   * @param muted - The new mute preference. It is written to storage.
   */
  setMuted(muted: boolean): void;
  /**
   * @param blocked - Whether audio is blocked.
   */
  setBlocked(blocked: boolean): void;
}

/**
 * Reads the stored mute preference.
 *
 * @returns `true` when the stored value is muted; `false` when sound is on or storage is unavailable.
 */
function readMuted(): boolean {
  try {
    return window.localStorage.getItem(ALERT_SOUND_STORAGE_KEY) === MUTED_VALUE;
  } catch {
    return false;
  }
}

/**
 * Stores the mute preference. A failure is ignored: the choice then lasts for the page.
 *
 * @param muted - The preference to store.
 */
function writeMuted(muted: boolean): void {
  try {
    window.localStorage.setItem(ALERT_SOUND_STORAGE_KEY, muted ? MUTED_VALUE : ON_VALUE);
  } catch {
    // Storage unavailable: the preference still applies for this page.
  }
}

/** Preference store of the alert sound. Reads storage once, when the module loads. */
export const useSoundPreference: UseBoundStore<StoreApi<SoundPreferenceState>> =
  create<SoundPreferenceState>()((set) => ({
    muted: readMuted(),
    blocked: false,
    setMuted: (muted) => {
      writeMuted(muted);
      set({ muted });
    },
    setBlocked: (blocked) => {
      set({ blocked });
    },
  }));
