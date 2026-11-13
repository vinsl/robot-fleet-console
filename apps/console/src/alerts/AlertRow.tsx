/**
 * One alert in a list: its chip, sentence, cause, age, who acknowledged or resolved it, and the action buttons.
 *
 * Acknowledge and Resolve are shown to Operators and Admins only, and only for the status they apply to. The
 * API refuses the same actions for other roles; the console just does not offer them. A failed action shows its
 * message under the row, and a pending action disables its button.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { LoaderCircle } from "lucide-react";
import type { AlertRecord } from "@mfc/protocol";
import { useAlertAction } from "../api/alerts";
import { useAuthStore } from "../auth/auth-store";
import { formatDuration } from "../lib/duration";
import { useSelectionStore } from "../live/selection-store";
import { AlertChip } from "./AlertChip";
import { actionErrorKey, actorLabel, alertMessage, canActOnAlerts } from "./alert-text";
import styles from "./AlertRow.module.css";

/** Props of {@link AlertRow}. */
export interface AlertRowProps {
  /** The alert to show. */
  readonly alert: AlertRecord;
  /** Current time in epoch milliseconds, so that every age in a list refreshes together. */
  readonly now: number;
}

/**
 * Renders one alert as a list item.
 *
 * @param props - The alert and the current time.
 * @returns The list item.
 */
export function AlertRow({ alert, now }: AlertRowProps): React.JSX.Element {
  const { t } = useTranslation("alerts");
  const { t: tCommon } = useTranslation("common");
  const role = useAuthStore((state) => state.role);
  const mySub = useAuthStore((state) => state.userId);
  const acknowledge = useAlertAction("acknowledge");
  const resolve = useAlertAction("resolve");

  const canAct = canActOnAlerts(role);
  const message = alertMessage(alert, t);
  const failure = acknowledge.isError ? acknowledge.error : resolve.isError ? resolve.error : null;

  return (
    <li className={styles.row}>
      <div className={styles.head}>
        <AlertChip severity={alert.severity} status={alert.status} />
        <Link
          to={`/robots/${alert.robotId}`}
          className={styles.message}
          onClick={() => {
            useSelectionStore.getState().requestFocus(alert.robotId);
          }}
        >
          {message}
        </Link>
      </div>
      {alert.cause === undefined ? null : (
        <p className={styles.cause}>{t("cause", { cause: alert.cause })}</p>
      )}
      <p className={styles.meta}>
        <time dateTime={alert.openedAt}>
          {t("openedAgo", {
            age: formatDuration(now - Date.parse(alert.openedAt), tCommon),
          })}
        </time>
      </p>
      {alert.acknowledgedBy !== undefined && alert.acknowledgedAt !== undefined ? (
        <p className={styles.meta}>
          {t("acknowledgedBy", {
            who: actorLabel(alert.acknowledgedBy, mySub, t),
            age: formatDuration(now - Date.parse(alert.acknowledgedAt), tCommon),
          })}
        </p>
      ) : null}
      {alert.resolvedBy !== undefined && alert.resolvedAt !== undefined ? (
        <p className={styles.meta}>
          {t("resolvedAfter", {
            who: actorLabel(alert.resolvedBy, mySub, t),
            duration: formatDuration(
              Date.parse(alert.resolvedAt) - Date.parse(alert.openedAt),
              tCommon,
            ),
          })}
        </p>
      ) : null}
      {canAct && alert.status === "OPEN" ? (
        <ActionButton
          label={t("acknowledge")}
          pending={acknowledge.isPending}
          onClick={() => {
            resolve.reset();
            acknowledge.mutate(alert);
          }}
        />
      ) : null}
      {canAct && alert.status === "ACKNOWLEDGED" ? (
        <ActionButton
          label={t("resolve")}
          pending={resolve.isPending}
          onClick={() => {
            acknowledge.reset();
            resolve.mutate(alert);
          }}
        />
      ) : null}
      {failure === null ? null : (
        <p role="alert" className={styles.error}>
          {t(actionErrorKey(failure))}
        </p>
      )}
    </li>
  );
}

/** Props of {@link ActionButton}. */
interface ActionButtonProps {
  /** Text of the button. */
  readonly label: string;
  /** Whether the action is running. The button is disabled meanwhile and shows a spinner. */
  readonly pending: boolean;
  /** Runs the action. */
  readonly onClick: () => void;
}

/**
 * A row action. While pending it is disabled, and the spinner icon says so next to the text.
 *
 * @param props - Label, pending flag and handler.
 * @returns The button.
 */
function ActionButton({ label, pending, onClick }: ActionButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={styles.action}
      disabled={pending}
      aria-busy={pending}
      onClick={onClick}
    >
      {pending ? (
        <LoaderCircle aria-hidden="true" focusable="false" className={styles.icon} />
      ) : null}
      <span>{label}</span>
    </button>
  );
}
