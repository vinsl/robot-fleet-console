/**
 * Alert sound toggle of the status line. It shows the sound state with an icon and a text, never with colour
 * alone, and it is a toggle button: `aria-pressed` is the muted state (ADR 0060).
 *
 * The browser keeps audio blocked until a user gesture. When the last sound was blocked, a click on the toggle
 * is that gesture: it unlocks audio instead of muting.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { alertSound } from "../live/alert-sound";
import { useSoundPreference } from "../live/sound-preference";
import { SOUND_VISUALS, type SoundState } from "../theme/robot-state-visuals";
import styles from "./SoundToggle.module.css";

/**
 * Chooses the state the toggle shows. A muted user has nothing to unlock, so muted wins over blocked.
 *
 * @param muted - Whether the user muted the alert sound.
 * @param blocked - Whether the browser refused the last sound.
 * @returns `muted`, `blocked` or `on`.
 */
export function soundStateOf(muted: boolean, blocked: boolean): SoundState {
  if (muted) {
    return "muted";
  }
  return blocked ? "blocked" : "on";
}

/**
 * Typed lookup of a sound visual. A switch keeps the lookup on a closed union, so no computed key reaches the
 * table.
 *
 * @param state - The sound state.
 * @returns The visual defined in `robot-state-visuals.ts`.
 */
function soundVisualOf(state: SoundState): (typeof SOUND_VISUALS)[SoundState] {
  switch (state) {
    case "on":
      return SOUND_VISUALS.on;
    case "muted":
      return SOUND_VISUALS.muted;
    case "blocked":
      return SOUND_VISUALS.blocked;
  }
}

/**
 * Renders the toggle. Its text is hidden on a compact screen (ADR 0075); the accessible name is then the same text, kept as
 * `aria-label`.
 *
 * @returns The button.
 */
export function SoundToggle(): React.JSX.Element {
  const { t } = useTranslation("alerts");
  const muted = useSoundPreference((preference) => preference.muted);
  const blocked = useSoundPreference((preference) => preference.blocked);

  const state = soundStateOf(muted, blocked);
  const visual = soundVisualOf(state);
  const Icon = visual.icon;
  const label = t(visual.labelKey);

  /**
   * Unlocks audio when it is blocked, otherwise flips the mute preference. The store is read at click time,
   * so the handler does not hold detached store methods.
   */
  const onClick = (): void => {
    const preference = useSoundPreference.getState();
    if (state === "blocked") {
      void alertSound.unlock().then((unlocked) => {
        if (unlocked) {
          useSoundPreference.getState().setBlocked(false);
        }
      });
      return;
    }
    preference.setMuted(!preference.muted);
  };

  return (
    <button
      type="button"
      className={styles.toggle}
      style={{ color: visual.color }}
      aria-pressed={muted}
      aria-label={label}
      onClick={onClick}
    >
      <Icon aria-hidden="true" focusable="false" className={styles.icon} />
      <span className={styles.label}>{label}</span>
    </button>
  );
}
