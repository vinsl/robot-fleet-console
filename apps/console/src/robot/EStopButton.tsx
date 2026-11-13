/**
 * The e-stop of the robot panel. It is the last element of the panel and it is never behind the lock: an operator
 * must be able to stop a robot whatever the lock state, and the robot stops on the first valid command (FR-CMD-4).
 *
 * Pressing sends at once. A confirmation would delay a safety stop, and an accidental stop is safe and recoverable.
 * Releasing is different: it moves the robot, so it asks for a confirmation inside the panel, then takes control,
 * waits for the robot to acknowledge the take, and only then sends `ESTOP_RELEASE` (ADR 0066).
 */
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RobotState } from "@mfc/protocol";
import type { CommandStatus } from "../control/command-store";
import type { ControlLock } from "../control/use-control-lock";
import type { SendCommand } from "../control/use-command";
import { STATE_VISUALS } from "../theme/robot-state-visuals";
import { classNames } from "../lib/class-names";
import controls from "./controls.module.css";
import styles from "./EStopButton.module.css";

/**
 * How long the release waits for the robot to acknowledge the take of control. The take itself waits up to the
 * acknowledgement timeout; this shorter wait keeps the confirmation from hanging on a robot that is not answering.
 */
export const RELEASE_TAKE_WAIT_MS = 3_000;

/** Props of {@link EStopButton}. */
export interface EStopButtonProps {
  /** The state the panel shows, or `undefined` before the first frame. `ESTOP` swaps the button for the release. */
  readonly displayState: RobotState | undefined;
  /** Whether the realtime socket is open. The e-stop stays enabled without it; the release does not. */
  readonly socketOpen: boolean;
  /** The lock and the take action the release needs. */
  readonly lock: ControlLock;
  /** Sends a command. Each call mints its own identifier. */
  readonly send: SendCommand["send"];
}

/**
 * Resolves with `fallback` when the work does not settle within `ms`. The work keeps running; only the wait ends.
 *
 * @param work - The promise to wait for.
 * @param ms - How long to wait, in milliseconds.
 * @param fallback - The value when the time is up.
 * @returns The value of the work, or the fallback.
 */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      resolve(fallback);
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Renders the e-stop, or its release when the robot is stopped.
 *
 * @param props - The state, the socket, the lock and the send operation.
 * @returns The button and, while confirming, the release dialog.
 */
export function EStopButton({
  displayState,
  socketOpen,
  lock,
  send,
}: EStopButtonProps): React.JSX.Element {
  const { t } = useTranslation("robot");
  const [confirming, setConfirming] = useState(false);
  const releaseRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const stopped = displayState === "ESTOP";

  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    }
  }, [confirming]);

  /** Closes the dialog and gives the focus back to the button that opened it. */
  const close = (): void => {
    setConfirming(false);
    releaseRef.current?.focus();
  };

  /**
   * Takes control, waits for the acknowledgement of the take, then releases the e-stop. A failed take stops here:
   * the failed command is in the log, and the button stays so that the operator can try again.
   */
  const confirm = async (): Promise<void> => {
    close();
    // A second take while the lock is already mine would only be refused, so it is skipped.
    const status: CommandStatus =
      lock.state === "mine"
        ? "ack"
        : await withDeadline(lock.acquire(), RELEASE_TAKE_WAIT_MS, "no-answer");
    if (status !== "ack") {
      return;
    }
    await send({ type: "ESTOP_RELEASE" });
  };

  if (!stopped) {
    const StopIcon = STATE_VISUALS.ESTOP.icon;
    return (
      <button
        type="button"
        className={classNames(controls.button, styles.estop)}
        onClick={() => {
          void send({ type: "ESTOP" });
        }}
      >
        <StopIcon aria-hidden="true" focusable="false" className={controls.icon} />
        <span>{t("command.estop")}</span>
      </button>
    );
  }

  return (
    <div className={styles.wrapper}>
      <button
        ref={releaseRef}
        type="button"
        className={classNames(controls.button, styles.estop)}
        disabled={!socketOpen || lock.busy}
        aria-haspopup="dialog"
        aria-expanded={confirming}
        onClick={() => {
          setConfirming(true);
        }}
      >
        <span>{t("command.estop_release")}</span>
      </button>
      {confirming ? (
        <div
          role="alertdialog"
          aria-labelledby={titleId}
          aria-describedby={bodyId}
          className={styles.dialog}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // The side panel also listens for Escape to close itself; this key closes the dialog only.
              event.stopPropagation();
              close();
            }
          }}
        >
          <h4 id={titleId} className={styles.dialogTitle}>
            {t("release.title")}
          </h4>
          <p id={bodyId} className={controls.hint}>
            {t("release.body")}
          </p>
          <div className={styles.actions}>
            <button
              ref={confirmRef}
              type="button"
              className={classNames(controls.button, styles.estop)}
              onClick={() => {
                void confirm();
              }}
            >
              {t("release.confirm")}
            </button>
            <button type="button" className={controls.button} onClick={close}>
              {t("release.cancel")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
