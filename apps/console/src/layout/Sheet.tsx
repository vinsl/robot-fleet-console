/**
 * A large glass dialog over the dimmed map. Every page other than the fleet view opens in one.
 *
 * It follows the dialog pattern: `role="dialog"` with `aria-modal`, a name from its title, focus moved inside
 * when it opens and back to the opener when it closes, a focus trap for Tab, and Escape to close. The map keeps
 * updating behind the scrim.
 */
import type * as React from "react";
import { useEffect, useId, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { classNames } from "../lib/class-names";
import { focusableWithin } from "./focus";
import styles from "./Sheet.module.css";

/** Props of {@link Sheet}. */
export interface SheetProps {
  /** Translated title, used as the accessible name of the dialog. */
  readonly title: string;
  /** Called when the user closes the sheet (Escape, close button, scrim). The owner decides how to close. */
  readonly onClose: () => void;
  /** Content of the sheet. */
  readonly children: React.ReactNode;
}

/**
 * Renders a modal sheet and manages its focus.
 *
 * @param props - Title, close handler and content.
 * @returns The scrim and the dialog.
 */
export function Sheet({ title, onClose, children }: SheetProps): React.JSX.Element {
  const { t } = useTranslation("shell");
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus moves in once when the sheet opens and returns to the element that opened it when it closes.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (focusableWithin(dialog)[0] ?? dialog).focus();
    return () => {
      if (opener?.isConnected === true) {
        opener.focus();
      }
    };
  }, []);

  // Listens on the document, not on the dialog: a click on the scrim leaves focus on the page body, and
  // Escape must still close the sheet then.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      const dialog = dialogRef.current;
      if (event.key !== "Tab" || dialog === null) {
        return;
      }
      const stops = focusableWithin(dialog);
      const first = stops[0];
      const last = stops.at(-1);
      if (first === undefined || last === undefined) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const active = document.activeElement;
      const outside = !dialog.contains(active);
      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <>
      <div className={styles.scrim} aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={classNames("glass", styles.sheet)}
      >
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label={t("dialog.close")}
            onClick={onClose}
          >
            <X aria-hidden="true" focusable="false" className={styles.icon} />
          </button>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </>
  );
}
