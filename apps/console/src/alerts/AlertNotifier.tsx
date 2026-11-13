/**
 * Announces and sounds the alerts that need an operator: a Major alert when it opens, and a Critical alert
 * until it is acknowledged. Two visually hidden live regions carry the text to assistive technology, so the
 * notice never depends on sound alone (ADR 0060). The alert pill is the visual notice, shown from the same moment.
 *
 * Sound rules (ADR 0060):
 * - A Major alert sounds once, when a live frame opens it. A page load never replays it.
 * - A Critical alert sounds at once while one is open, then every `alertSound.repeatMs`, until it is acknowledged.
 *   This covers a page load too: a Critical alert still open is repeated, as the design asks.
 * - Nothing sounds while the user has muted the alert. The announcement is still made.
 * - A pattern plays at most once per burst window (see {@link createBurstGate}).
 * - The tab being hidden does not mute the sound: an operator in another tab must hear a Critical alert.
 *
 * The audio context is unlocked by the first user gesture, in the shell (`installAudioUnlock`). If the browser
 * still refuses a sound, the play call marks the preference as blocked, and the status line asks for a click.
 */
import type * as React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useActiveAlerts } from "../api/alerts";
import { alertSound, type SoundPattern } from "../live/alert-sound";
import { subscribeAlertOpened } from "../live/alerts-feed";
import { useSoundPreference } from "../live/sound-preference";
import { alertSound as soundTokens } from "../theme/tokens";
import { alertMessage, hasOpenCritical } from "./alert-text";
import { createBurstGate, type BurstGate } from "./sound-burst";

/**
 * Minimum time between two plays of one pattern. A pattern lasts `toneMs + gapMs`; a second request inside that
 * window would only stack on the first.
 */
const BURST_WINDOW_MS = soundTokens.toneMs + soundTokens.gapMs;

/**
 * Renders the live regions of the notifier and runs the sound rules. Mounted once, by the shell.
 *
 * @returns The two visually hidden live regions.
 */
export function AlertNotifier(): React.JSX.Element {
  const { t } = useTranslation("alerts");
  const query = useActiveAlerts();
  const critical = hasOpenCritical(query.data ?? []);
  const muted = useSoundPreference((state) => state.muted);
  const [gate] = useState<BurstGate>(() => createBurstGate(BURST_WINDOW_MS));
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  // Kept in a ref so that a language change does not drop the subscription and miss an alert opened meanwhile.
  const tRef = useRef(t);
  tRef.current = t;

  /**
   * Plays a pattern unless the user muted the alert or the burst window is still open. The mute is read at call
   * time, because the subscription outlives the renders that set it.
   */
  const ring = useCallback(
    (pattern: SoundPattern): void => {
      if (useSoundPreference.getState().muted || !gate.allow(pattern)) {
        return;
      }
      void alertSound.play(pattern);
    },
    [gate],
  );

  useEffect(() => {
    return subscribeAlertOpened((alert) => {
      const t = tRef.current;
      if (alert.severity === "CRITICAL") {
        setAssertive(t("announce.CRITICAL", { message: alertMessage(alert, t) }));
      } else if (alert.severity === "MAJOR") {
        setPolite(t("announce.MAJOR", { message: alertMessage(alert, t) }));
        ring("major");
      }
    });
  }, [ring]);

  useEffect(() => {
    if (!critical || muted) {
      return;
    }
    const repeat = (): void => {
      ring("critical");
    };
    repeat();
    const timer = setInterval(repeat, soundTokens.repeatMs);
    return () => {
      clearInterval(timer);
    };
  }, [critical, muted, ring]);

  return (
    <>
      <div className="visually-hidden" aria-live="polite" aria-atomic="true">
        {polite}
      </div>
      <div className="visually-hidden" aria-live="assertive" aria-atomic="true">
        {assertive}
      </div>
    </>
  );
}
