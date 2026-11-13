/**
 * Fault injector of a simulated robot, for the demo. Only an Admin with demo mode on sees it (see
 * `robotVisibility`); the API and the robot refuse the same command in the other cases too (ADR 0065).
 *
 * The injected fault is audited by the API like any command. The injector never says a fault happened on a real
 * robot: it is only offered for simulated ones.
 */
import type * as React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FaultCodeSchema, type FaultCode } from "@mfc/protocol";
import type { SendCommand } from "../control/use-command";
import controls from "./controls.module.css";
import styles from "./FaultInjector.module.css";

/** Props of {@link FaultInjector}. */
export interface FaultInjectorProps {
  /** Whether the realtime socket is closed. The injector waits for it like the other commands. */
  readonly disabled: boolean;
  /** Sends a command. Each call mints its own identifier. */
  readonly send: SendCommand["send"];
}

/**
 * Renders the fault selector and its button.
 *
 * @param props - The socket state and the send operation.
 * @returns The injector.
 */
export function FaultInjector({ disabled, send }: FaultInjectorProps): React.JSX.Element {
  const { t } = useTranslation("robot");
  const selectId = useId();
  const [fault, setFault] = useState<FaultCode>("OBSTACLE");

  return (
    <div className={styles.row}>
      <label htmlFor={selectId} className={styles.label}>
        {t("fault.select")}
      </label>
      <select
        id={selectId}
        className={styles.select}
        value={fault}
        onChange={(event) => {
          // The select only offers protocol codes, but the value still crosses a boundary: check it.
          const parsed = FaultCodeSchema.safeParse(event.target.value);
          if (parsed.success) {
            setFault(parsed.data);
          }
        }}
      >
        {FaultCodeSchema.options.map((code) => (
          <option key={code} value={code}>
            {t(`fault.${code}`)}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={controls.button}
        disabled={disabled}
        onClick={() => {
          void send({ type: "SIMULATE_FAULT", params: { fault } });
        }}
      >
        {t("command.simulate_fault")}
      </button>
    </div>
  );
}
