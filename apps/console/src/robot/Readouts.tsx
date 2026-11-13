/**
 * The readouts of the robot panel: speed, battery and the round trip of the last command, then the overlay fields
 * (name and position). Numbers use the current language's separators and the same precision everywhere.
 */
import type * as React from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatBattery } from "../lib/format-battery";
import type { LiveRobot } from "../live/fleet-reducer";
import styles from "./Readouts.module.css";

/** Props of {@link Readouts}. */
export interface ReadoutsProps {
  /** The live record of the robot, or `undefined` before the first frame. */
  readonly robot: LiveRobot | undefined;
  /** The robot's name from the registry, or `undefined` while it loads. */
  readonly name: string | undefined;
  /** Round trip of the last acknowledged command, in milliseconds. */
  readonly lastRoundTripMs: number | undefined;
}

/**
 * Renders the readouts. A value that is not known yet shows a dash, never a zero.
 *
 * @param props - The robot, its name and the last round trip.
 * @returns The readouts.
 */
export function Readouts({ robot, name, lastRoundTripMs }: ReadoutsProps): React.JSX.Element {
  const { t, i18n } = useTranslation("robot");
  const language = i18n.language;
  const decimal = useMemo(
    () => new Intl.NumberFormat(language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }),
    [language],
  );
  const integer = useMemo(
    () => new Intl.NumberFormat(language, { maximumFractionDigits: 0 }),
    [language],
  );
  const pose = robot?.pose ?? null;
  const empty = t("readouts.empty");

  return (
    <div className={styles.wrapper}>
      <dl className={styles.grid}>
        <div className={styles.cell}>
          <dt className={styles.label}>{t("readouts.speed")}</dt>
          <dd className={styles.value}>
            {pose === null
              ? empty
              : t("readouts.speedValue", { value: decimal.format(pose.speed) })}
          </dd>
        </div>
        <div className={styles.cell}>
          <dt className={styles.label}>{t("readouts.battery")}</dt>
          <dd className={styles.value}>
            {robot === undefined
              ? empty
              : t("readouts.batteryValue", { value: formatBattery(robot.battery, language) })}
          </dd>
        </div>
        <div className={styles.cell}>
          <dt className={styles.label}>{t("readouts.latency")}</dt>
          <dd className={styles.value}>
            {lastRoundTripMs === undefined
              ? empty
              : t("readouts.latencyValue", { ms: integer.format(lastRoundTripMs) })}
          </dd>
        </div>
      </dl>
      <dl className={styles.details}>
        <div className={styles.line}>
          <dt className={styles.label}>{t("readouts.name")}</dt>
          <dd className={styles.detail}>{name ?? empty}</dd>
        </div>
        <div className={styles.line}>
          <dt className={styles.label}>{t("readouts.position")}</dt>
          <dd className={styles.detail}>
            {pose === null
              ? empty
              : t("readouts.positionValue", {
                  x: decimal.format(pose.x),
                  y: decimal.format(pose.y),
                })}
          </dd>
        </div>
      </dl>
    </div>
  );
}
