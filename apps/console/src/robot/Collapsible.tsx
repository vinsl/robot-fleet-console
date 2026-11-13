/**
 * A titled section the operator can fold. The heading is a button with `aria-expanded`, so the keyboard and the
 * screen reader both learn the state. The content stays in the DOM when folded (hidden), so a live region inside it
 * keeps its place.
 */
import type * as React from "react";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { classNames } from "../lib/class-names";
import styles from "./Collapsible.module.css";

/** Props of {@link Collapsible}. */
export interface CollapsibleProps {
  /** Translated title of the section. */
  readonly title: string;
  /** Whether the section starts open. Defaults to open, so the content is visible until the operator folds it. */
  readonly defaultOpen?: boolean;
  /** The content of the section. */
  readonly children: React.ReactNode;
}

/**
 * Renders the section.
 *
 * @param props - Title, initial state and content.
 * @returns The section.
 */
export function Collapsible({
  title,
  defaultOpen = true,
  children,
}: CollapsibleProps): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <section className={styles.section}>
      <h4 className={styles.heading}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => {
            setOpen((value) => !value);
          }}
        >
          <span>{title}</span>
          <ChevronDown
            aria-hidden="true"
            focusable="false"
            className={classNames(styles.chevron, open && styles.open)}
          />
        </button>
      </h4>
      <div id={contentId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
