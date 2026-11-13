/**
 * Glass panel on the right edge, used for the selected robot. Unlike a sheet it does not dim the map: the
 * map stays live behind it.
 */
import type * as React from "react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronsLeft, ChevronsRight, X } from "lucide-react";
import { classNames } from "../lib/class-names";
import styles from "./SidePanel.module.css";

/** Props of {@link SidePanel}. */
export interface SidePanelProps {
  /** Translated title, used as the accessible name of the panel. */
  readonly title: string;
  /** Called on Escape or from the close button. */
  readonly onClose: () => void;
  /** Whether the panel offers a button that widens it to most of the screen. */
  readonly expandable?: boolean;
  /** Content of the panel. */
  readonly children: React.ReactNode;
}

/**
 * Renders the panel and closes it on Escape. An expandable panel carries a button on its left edge that widens it
 * to most of the screen, so a camera feed can be watched at a useful size.
 *
 * @param props - Title, close handler, optional expansion and content.
 * @returns The panel.
 */
export function SidePanel({
  title,
  onClose,
  expandable = false,
  children,
}: SidePanelProps): React.JSX.Element {
  const { t } = useTranslation("shell");
  const titleId = useId();
  const [expanded, setExpanded] = useState(false);
  const ToggleIcon = expanded ? ChevronsRight : ChevronsLeft;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <aside
      aria-labelledby={titleId}
      className={classNames("glass", styles.panel, expanded && styles.expanded)}
    >
      {expandable ? (
        <button
          type="button"
          className={styles.expand}
          aria-expanded={expanded}
          aria-label={expanded ? t("panel.narrow") : t("panel.widen")}
          onClick={() => {
            setExpanded((current) => !current);
          }}
        >
          <ToggleIcon aria-hidden="true" focusable="false" className={styles.icon} />
        </button>
      ) : null}
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
    </aside>
  );
}
