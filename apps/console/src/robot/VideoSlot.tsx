/**
 * The video area at the top of the robot panel. A real robot shows its live camera; a simulated robot has no camera,
 * so the slot says so. While the registry loads, the slot shows the unavailable sentence, as it did before the
 * camera was wired.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { VideoOff } from "lucide-react";
import type { RobotId } from "@mfc/protocol";
import { VideoPane, type VideoOverlay } from "../video/VideoPane";
import styles from "./VideoSlot.module.css";

/** Props of {@link VideoSlot}. */
export interface VideoSlotProps {
  /** The robot whose camera the slot shows. */
  readonly robotId: RobotId;
  /** Whether the robot is simulated, or `undefined` while the registry loads. */
  readonly simulated: boolean | undefined;
  /** The overlay fields of the live pane. */
  readonly overlay: VideoOverlay;
}

/**
 * Renders the live pane for a real robot, or the placeholder tile otherwise. The viewer is created only for a real
 * robot, so a simulated robot never opens a channel.
 *
 * @param props - The robot, whether it is simulated, and the overlay fields.
 * @returns The video area.
 */
export function VideoSlot({ robotId, simulated, overlay }: VideoSlotProps): React.JSX.Element {
  const { t } = useTranslation("robot");
  if (simulated === false) {
    return <VideoPane robotId={robotId} overlay={overlay} />;
  }
  return (
    <div className={styles.slot}>
      <VideoOff aria-hidden="true" focusable="false" className={styles.icon} />
      <span className={styles.text}>
        {simulated === true ? t("video.noCamera") : t("video.unavailable")}
      </span>
    </div>
  );
}
