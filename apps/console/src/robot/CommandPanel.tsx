/**
 * The command grid of the robot panel: Pause, Resume, Return to base and Release control.
 *
 * Every button needs the lock, and the answer needs the socket, so each one is disabled unless the user holds the
 * lock and the socket is open. A disabled grid says why in a sentence that the button points to, so the reason is
 * not only a dimmed colour. Viewers never get this component (ADR 0066).
 */
import type * as React from "react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import type { SendCommand } from "../control/use-command";
import type { ControlLock } from "../control/use-control-lock";
import { classNames } from "../lib/class-names";
import controls from "./controls.module.css";
import styles from "./CommandPanel.module.css";

/** Props of {@link CommandPanel}. */
export interface CommandPanelProps {
  /** The lock and the release action. */
  readonly lock: ControlLock;
  /** Whether the realtime socket is open. */
  readonly socketOpen: boolean;
  /** Sends a command. Each call mints its own identifier. */
  readonly send: SendCommand["send"];
}

/**
 * Renders the 2 by 2 command grid.
 *
 * @param props - The lock, the socket and the send operation.
 * @returns The grid and its hint.
 */
export function CommandPanel({ lock, socketOpen, send }: CommandPanelProps): React.JSX.Element {
  const { t } = useTranslation("robot");
  const hintId = useId();
  const mine = lock.state === "mine";
  const disabled = !mine || !socketOpen;
  let hint: string | undefined;
  if (!mine) {
    hint = t("lock.takeHint");
  } else if (!socketOpen) {
    hint = t("panel.socketDown");
  }
  const describedBy = hint === undefined ? undefined : hintId;

  return (
    <div className={styles.wrapper}>
      <div className={styles.grid} role="group" aria-label={t("panel.commands")}>
        <button
          type="button"
          className={classNames(controls.button, styles.cell)}
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={() => {
            void send({ type: "PAUSE" });
          }}
        >
          {t("command.pause")}
        </button>
        <button
          type="button"
          className={classNames(controls.button, styles.cell)}
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={() => {
            void send({ type: "RESUME" });
          }}
        >
          {t("command.resume")}
        </button>
        <button
          type="button"
          className={classNames(controls.button, styles.cell)}
          disabled={disabled}
          aria-describedby={describedBy}
          onClick={() => {
            void send({ type: "RETURN_TO_BASE" });
          }}
        >
          {t("command.return_to_base")}
        </button>
        <button
          type="button"
          className={classNames(controls.button, styles.cell)}
          disabled={disabled || lock.busy}
          aria-describedby={describedBy}
          onClick={() => {
            void lock.release();
          }}
        >
          {t("command.release_control")}
        </button>
      </div>
      {hint === undefined ? null : (
        <p id={hintId} className={controls.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}
