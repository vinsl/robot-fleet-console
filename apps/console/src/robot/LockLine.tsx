/**
 * The lock line of the robot panel: who controls the robot, and the button that takes control when nobody does.
 *
 * Each state has an icon and a sentence, never a colour alone (WCAG 1.4.1). The line of the holder shows a warning
 * when the heartbeat link is lost, because then the robot is about to pause. It shows no countdown: the heartbeats
 * keep the lock alive, so a countdown would only alarm the operator (ADR 0066).
 */
import type * as React from "react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import { BADGE_VISUALS, CONNECTION_VISUALS } from "../theme/robot-state-visuals";
import type { ControlLock } from "../control/use-control-lock";
import { classNames } from "../lib/class-names";
import controls from "./controls.module.css";
import styles from "./LockLine.module.css";

/** Props of {@link LockLine}. */
export interface LockLineProps {
  /** The lock of the robot and the actions on it. */
  readonly lock: ControlLock;
  /** Whether this user may take the lock. Viewers see the state only. */
  readonly canTake: boolean;
  /** Whether the realtime socket is open; taking control needs its acknowledgement. */
  readonly socketOpen: boolean;
  /** Whether the last heartbeat was sent. Only meaningful while the lock is held by this user. */
  readonly linkOk: boolean;
}

/**
 * One line of status: an icon and a sentence.
 *
 * @param props - The icon, its colour and the text.
 * @returns The line.
 */
function StatusLine({
  icon: Icon,
  color,
  children,
}: {
  readonly icon?: LucideIcon | undefined;
  readonly color: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <p className={styles.status} style={{ color }}>
      {Icon === undefined ? null : (
        <Icon aria-hidden="true" focusable="false" className={controls.icon} />
      )}
      <span>{children}</span>
    </p>
  );
}

/**
 * Renders the lock line.
 *
 * @param props - The lock, the permissions and the link state.
 * @returns The line.
 */
export function LockLine({ lock, canTake, socketOpen, linkOk }: LockLineProps): React.JSX.Element {
  const { t } = useTranslation("robot");
  const hintId = useId();
  const takeDisabled = lock.busy || !socketOpen;

  return (
    <div className={styles.line}>
      {lock.state === "mine" ? (
        <StatusLine icon={BADGE_VISUALS.lockMine.icon} color={BADGE_VISUALS.lockMine.color}>
          {t("lock.mine")}
        </StatusLine>
      ) : null}
      {lock.state === "other" ? (
        <StatusLine icon={BADGE_VISUALS.lockOther.icon} color={BADGE_VISUALS.lockOther.color}>
          {t("lock.other", { label: lock.holderLabel ?? "" })}
        </StatusLine>
      ) : null}
      {lock.state === "free" ? (
        <StatusLine color={BADGE_VISUALS.lockOther.color}>{t("lock.free")}</StatusLine>
      ) : null}
      {lock.state === "unknown" ? (
        <StatusLine color={BADGE_VISUALS.lockOther.color}>{t("lock.unknown")}</StatusLine>
      ) : null}
      {lock.state === "mine" && !linkOk ? (
        <StatusLine
          icon={CONNECTION_VISUALS.reconnecting.icon}
          color={CONNECTION_VISUALS.reconnecting.color}
        >
          {t("lock.linkLost")}
        </StatusLine>
      ) : null}
      {lock.state === "free" && canTake ? (
        <>
          <button
            type="button"
            className={classNames(controls.button, styles.take)}
            disabled={takeDisabled}
            aria-describedby={!socketOpen ? hintId : undefined}
            onClick={() => {
              void lock.acquire();
            }}
          >
            {t("command.take_control")}
          </button>
          {!socketOpen ? (
            <p id={hintId} className={controls.hint}>
              {t("panel.socketDown")}
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
