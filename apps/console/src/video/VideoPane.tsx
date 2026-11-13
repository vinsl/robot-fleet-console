/**
 * The live camera of a real robot, with the overlay of FR-VID-4: the latency chip top left, and the name, state,
 * position and speed below. The pane renders in every state, so the overlay stays readable while the video connects
 * or after it fails. The state is shape, icon and text; colour never carries it alone (WCAG 1.4.1).
 */
import type * as React from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Loader, Video, VideoOff } from "lucide-react";
import type { RobotId, RobotPose, RobotState } from "@mfc/protocol";
import { StateChip } from "../components/StateChip";
import { useRobotVideo } from "./use-robot-video";
import styles from "./VideoPane.module.css";

/** The overlay fields the robot panel already knows. A field not known yet is `undefined` or `null`. */
export interface VideoOverlay {
  /** The robot's name from the registry, or `undefined` while it loads. */
  readonly name: string | undefined;
  /** The displayed state, or `undefined` before the first frame. */
  readonly state: RobotState | undefined;
  /** The newest pose, or `null` before the first one. */
  readonly pose: RobotPose | null;
}

/** Props of {@link VideoPane}. */
export interface VideoPaneProps {
  /** The robot whose camera is shown. Validated by the route. */
  readonly robotId: RobotId;
  /** The overlay fields. */
  readonly overlay: VideoOverlay;
}

/**
 * Renders the video pane and its overlay.
 *
 * @param props - The robot and the overlay fields.
 * @returns The pane.
 */
export function VideoPane({ robotId, overlay }: VideoPaneProps): React.JSX.Element {
  const { t, i18n } = useTranslation("robot");
  const { state, rttMs, videoRef } = useRobotVideo(robotId);
  const [infoHidden, setInfoHidden] = useState(false);
  const InfoIcon = infoHidden ? Eye : EyeOff;
  const integer = useMemo(
    () => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 0 }),
    [i18n.language],
  );
  const decimal = useMemo(
    () =>
      new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [i18n.language],
  );
  const pose = overlay.pose;
  const empty = t("readouts.empty");

  return (
    <div className={styles.pane} data-state={state}>
      {/* No controls: the operator watches, and the pane does not offer to pause or seek a live feed. */}
      <video
        ref={videoRef}
        className={styles.video}
        muted
        playsInline
        autoPlay
        aria-label={t("video.label")}
      />
      {state === "connecting" ? (
        <p role="status" className={styles.status}>
          <Loader aria-hidden="true" focusable="false" className={styles.icon} />
          <span>{t("video.loading")}</span>
        </p>
      ) : null}
      {state === "unavailable" ? (
        <p role="status" className={styles.status}>
          <VideoOff aria-hidden="true" focusable="false" className={styles.icon} />
          <span>{t("video.unavailable")}</span>
        </p>
      ) : null}
      <div className={styles.overlay}>
        {state === "live" ? (
          <p className={styles.latency}>
            <Video aria-hidden="true" focusable="false" className={styles.icon} />
            <span>
              {rttMs === null ? t("video.live") : t("video.latency", { ms: integer.format(rttMs) })}
            </span>
          </p>
        ) : null}
        {infoHidden ? null : (
          <div className={styles.fields}>
            {overlay.state === undefined ? null : <StateChip state={overlay.state} />}
            <dl className={styles.details}>
              <div className={styles.field}>
                <dt className={styles.label}>{t("readouts.name")}</dt>
                <dd className={styles.value}>{overlay.name ?? empty}</dd>
              </div>
              <div className={styles.field}>
                <dt className={styles.label}>{t("readouts.position")}</dt>
                <dd className={styles.value}>
                  {pose === null
                    ? empty
                    : t("readouts.positionValue", {
                        x: decimal.format(pose.x),
                        y: decimal.format(pose.y),
                      })}
                </dd>
              </div>
              <div className={styles.field}>
                <dt className={styles.label}>{t("readouts.speed")}</dt>
                <dd className={styles.value}>
                  {pose === null
                    ? empty
                    : t("readouts.speedValue", { value: decimal.format(pose.speed) })}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </div>
      <button
        type="button"
        className={styles.infoToggle}
        aria-pressed={infoHidden}
        aria-label={infoHidden ? t("video.showInfo") : t("video.hideInfo")}
        onClick={() => {
          setInfoHidden((current) => !current);
        }}
      >
        <InfoIcon aria-hidden="true" focusable="false" className={styles.toggleIcon} />
      </button>
    </div>
  );
}
