/**
 * The end of the wizard: the version is saved and validated, and the operator decides what comes next.
 *
 * Activation is offered here as well as in the versions list, so a fresh version can be used at once. A conflict
 * and a generic failure read differently, because only a conflict says the operator should look at the list again.
 */
import type * as React from "react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapVersion } from "@mfc/protocol";
import { useActivateMap } from "../../api/site";
import { activationFailureKey, type ActivationFailureKey } from "../activation";
import styles from "./Editor.module.css";

/** Props of {@link SavedPanel}. */
export interface SavedPanelProps {
  /** The validated version. */
  readonly version: MapVersion;
  /** Shows the versions list. */
  readonly onViewVersions: () => void;
  /** Starts a new drawing. */
  readonly onEditAnother: () => void;
}

/** Outcome of the activation offered by the panel. */
type Outcome = "activated" | ActivationFailureKey;

/**
 * Renders the saved version and the next actions.
 *
 * @param props - The version and the two navigation handlers.
 * @returns The panel.
 */
export function SavedPanel({
  version,
  onViewVersions,
  onEditAnother,
}: SavedPanelProps): React.JSX.Element {
  const { t } = useTranslation("site");
  const titleId = useId();
  const activate = useActivateMap();
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const onActivate = (): void => {
    setOutcome(null);
    activate.mutate(version.version, {
      onSuccess: () => {
        setOutcome("activated");
      },
      onError: (error: unknown) => {
        setOutcome(activationFailureKey(error));
      },
    });
  };

  const counts = version.summary?.counts;
  return (
    <section aria-labelledby={titleId} className={styles.step}>
      <h3 id={titleId} className={styles.stepTitle}>
        {t("saved.title", { version: version.version })}
      </h3>
      <p className={styles.hint}>{t("saved.hint")}</p>
      {counts === undefined ? null : (
        <p className={styles.hint}>
          {t("saved.counts", {
            walls: counts.wall,
            workstations: counts.workstation,
            nogo: counts.nogo,
          })}
        </p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={activate.isPending || outcome === "activated"}
          aria-busy={activate.isPending}
          onClick={onActivate}
        >
          {activate.isPending ? t("saved.activating") : t("saved.activate")}
        </button>
        <button type="button" className={styles.button} onClick={onViewVersions}>
          {t("saved.viewVersions")}
        </button>
        <button type="button" className={styles.button} onClick={onEditAnother}>
          {t("saved.editAnother")}
        </button>
      </div>

      {outcome === "activated" ? (
        <p role="status" className={styles.hint}>
          {t("saved.activated", { version: version.version })}
        </p>
      ) : null}
      {outcome === "conflict" ? (
        <p role="alert" className={styles.error}>
          {t("saved.activateConflict")}
        </p>
      ) : null}
      {outcome === "generic" ? (
        <p role="alert" className={styles.error}>
          {t("saved.activateFailed")}
        </p>
      ) : null}
    </section>
  );
}
