/**
 * The Admin switch of the demo mode, shown in the account menu.
 *
 * Turning the mode on or off is a global change, so it is confirmed in the page: a press opens a confirmation
 * group, and nothing changes until the Admin confirms. No browser dialog is used. The state is shown as text and
 * the knob position, never by colour alone. The API refuses the change for anyone but an Admin; this component is
 * only mounted for an Admin so that the others never see a control they cannot use.
 */
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDemoState, useSetDemo } from "../api/control";
import { classNames } from "../lib/class-names";
import styles from "./DemoSwitch.module.css";

/**
 * Renders the demo switch and its in-page confirmation.
 *
 * @returns The switch.
 */
export function DemoSwitch(): React.JSX.Element {
  const { t } = useTranslation("demo");
  const state = useDemoState();
  const setDemo = useSetDemo();
  const [confirming, setConfirming] = useState(false);
  const labelId = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const enabled = state.data?.enabled === true;
  const pending = setDemo.isPending;

  // Focus moves to the confirmation when it opens, so that a keyboard user confirms without searching for it.
  useEffect(() => {
    if (confirming) {
      confirmRef.current?.focus();
    }
  }, [confirming]);

  /** Opens the confirmation, after clearing any error of an earlier attempt. */
  const openConfirm = (): void => {
    setDemo.reset();
    setConfirming(true);
  };

  /** Closes the confirmation and gives the focus back to the switch that opened it. */
  const closeConfirm = (): void => {
    setConfirming(false);
    switchRef.current?.focus();
  };

  return (
    <div className={styles.root}>
      <div className={styles.row}>
        <span id={labelId}>{t("toggle")}</span>
        <button
          ref={switchRef}
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={labelId}
          className={classNames(styles.switch, enabled ? styles.on : undefined)}
          disabled={state.data === undefined || pending}
          onClick={openConfirm}
        >
          <span className={styles.knob} aria-hidden="true" />
          <span>{enabled ? t("on") : t("off")}</span>
        </button>
      </div>
      {confirming ? (
        <div role="group" aria-label={t("toggle")} className={styles.confirm}>
          <p>{enabled ? t("confirm.disable") : t("confirm.enable")}</p>
          <div className={styles.actions}>
            <button
              ref={confirmRef}
              type="button"
              className={styles.button}
              disabled={pending}
              onClick={() => {
                setDemo.mutate(!enabled, {
                  onSuccess: () => {
                    closeConfirm();
                  },
                });
              }}
            >
              {t("confirm.ok")}
            </button>
            <button type="button" className={styles.button} onClick={closeConfirm}>
              {t("confirm.cancel")}
            </button>
          </div>
        </div>
      ) : null}
      {setDemo.isError ? (
        <p role="alert" className={styles.error}>
          {t("error.update")}
        </p>
      ) : null}
    </div>
  );
}
