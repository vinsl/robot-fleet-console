/**
 * Alert shown when a save failed. The message is chosen from the step and the reason, never from the server's
 * text, so no internal detail or presigned field reaches the screen.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { SITE_MAP_MAX_BYTES } from "@mfc/protocol";
import type { SaveFailure } from "./save-map";
import styles from "./Editor.module.css";

/** Props of {@link SaveAlert}. */
export interface SaveAlertProps {
  /** The failure to explain. */
  readonly failure: SaveFailure;
  /** Whether a validation retry is running. */
  readonly busy: boolean;
  /** Validates the uploaded version again. Offered only when the upload succeeded. */
  readonly onRetryValidation: () => void;
}

/** Bytes per megabyte, for the size limit in the message. */
const BYTES_PER_MB = 1_000_000;

/**
 * Explains a failed save and offers the retry that the failure allows.
 *
 * @param props - The failure, the busy flag and the retry handler.
 * @returns The alert.
 */
export function SaveAlert({ failure, busy, onRetryValidation }: SaveAlertProps): React.JSX.Element {
  const { t } = useTranslation("site");
  const message = messageOf(failure);
  const canRetry = failure.stage === "validate" && failure.version !== null;
  return (
    <div className={styles.issues}>
      <p role="alert" className={styles.error}>
        {t(message.key, message.options ?? {})}
      </p>
      {canRetry ? (
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          aria-busy={busy}
          onClick={onRetryValidation}
        >
          {t("edit.retryValidation")}
        </button>
      ) : null}
    </div>
  );
}

/** A message key and the values it interpolates. */
interface MessageRef {
  readonly key: string;
  readonly options?: { readonly limitMb: number };
}

/**
 * The message key for a failure. Kept apart from the translation call, so the mapping is plain data.
 *
 * @param failure - The failure.
 * @returns The key of the sentence and its values.
 */
function messageOf(failure: SaveFailure): MessageRef {
  if (failure.reason === "unexpected") {
    return { key: "errors.generic" };
  }
  if (failure.stage === "upload") {
    switch (failure.reason) {
      case "too-large":
        return {
          key: "errors.upload.too-large",
          options: { limitMb: SITE_MAP_MAX_BYTES / BYTES_PER_MB },
        };
      case "rejected":
        return { key: "errors.upload.rejected" };
      case "network":
        return { key: "errors.upload.network" };
      case "timeout":
        return { key: "errors.upload.timeout" };
      default:
        return { key: "errors.generic" };
    }
  }
  if (failure.reason === "build") {
    return { key: "errors.save.build" };
  }
  if (failure.stage === "slot") {
    return { key: "errors.save.slot" };
  }
  if (failure.stage === "validate") {
    return { key: "errors.save.validate" };
  }
  return { key: "errors.generic" };
}
