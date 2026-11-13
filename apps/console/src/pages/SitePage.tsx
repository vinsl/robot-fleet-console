/**
 * Site configuration sheet (Admin only): two sections, the editor and the map versions.
 *
 * The page is a sheet over the map, as every other page is. The route guard keeps it out of the tree for other
 * roles, and no query runs before the sections need one, so a refused role sends nothing to the API. The wizard
 * state lives here, so closing the sheet can ask before a draft that was not saved is lost.
 */
import type * as React from "react";
import { useCallback, useEffect, useId, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sheet } from "../layout/Sheet";
import { focusableWithin } from "../layout/focus";
import { useDismiss } from "../layout/use-dismiss";
import { classNames } from "../lib/class-names";
import { SiteProfile } from "../site/editor/SiteProfile";
import { SiteEditor } from "../site/editor/SiteEditor";
import {
  hasUnsavedDraft,
  INITIAL_WIZARD_STATE,
  wizardReducer,
} from "../site/editor/wizard-reducer";
import { VersionsTab } from "../site/versions/VersionsTab";
import styles from "./SitePage.module.css";

/** Sections of the page, in tab order. */
const TABS = ["editor", "versions"] as const;

/** A section of the page. */
type SiteTab = (typeof TABS)[number];

/**
 * Section that an arrow, Home or End key moves to. Wraps around at both ends, as the WAI-ARIA tabs pattern
 * prescribes.
 *
 * @param current - The focused section.
 * @param key - The key pressed.
 * @returns The target section, or `null` when the key is not a tab navigation key.
 */
function targetTab(current: SiteTab, key: string): SiteTab | null {
  const last = TABS.length - 1;
  const currentIndex = TABS.indexOf(current);
  let index: number;
  switch (key) {
    case "ArrowRight":
      index = currentIndex === last ? 0 : currentIndex + 1;
      break;
    case "ArrowLeft":
      index = currentIndex === 0 ? last : currentIndex - 1;
      break;
    case "Home":
      index = 0;
      break;
    case "End":
      index = last;
      break;
    default:
      return null;
  }
  return TABS.at(index) ?? null;
}

/** Props of {@link DiscardConfirm}. */
interface DiscardConfirmProps {
  /** Keeps the draft and returns to the sheet. */
  readonly onKeep: () => void;
  /** Closes the sheet and drops the draft. */
  readonly onDiscard: () => void;
}

/**
 * Asks before an unsaved draft is dropped. The keep button takes the focus, so Enter keeps the work; Escape
 * (handled by the sheet) also keeps it.
 *
 * The question holds the focus until it is answered: Tab cycles between its two buttons, and the focus returns to
 * the element that was focused before the question opened, so the keyboard user is back where they were.
 *
 * @param props - The two answers.
 * @returns The alert dialog.
 */
function DiscardConfirm({ onKeep, onDiscard }: DiscardConfirmProps): React.JSX.Element {
  const { t } = useTranslation("site");
  const titleId = useId();
  const messageId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keepRef.current?.focus();
    return () => {
      if (opener?.isConnected === true) {
        opener.focus();
      }
    };
  }, []);

  /**
   * Keeps Tab and Shift+Tab inside the question. The event stops here, so the sheet's own focus trap does not also
   * move the focus.
   *
   * @param event - The key event of the question.
   */
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const dialog = dialogRef.current;
    if (event.key !== "Tab" || dialog === null) {
      return;
    }
    event.stopPropagation();
    const stops = focusableWithin(dialog);
    const first = stops[0];
    const last = stops.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      ref={dialogRef}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      className={styles.confirm}
      onKeyDown={onKeyDown}
    >
      <p id={titleId} className={styles.confirmTitle}>
        {t("discard.title")}
      </p>
      <p id={messageId}>{t("discard.message")}</p>
      <div className={styles.confirmActions}>
        <button ref={keepRef} type="button" className={styles.tab} onClick={onKeep}>
          {t("discard.keep")}
        </button>
        <button type="button" className={styles.tab} onClick={onDiscard}>
          {t("discard.confirm")}
        </button>
      </div>
    </div>
  );
}

/**
 * Renders the site configuration sheet with its two sections.
 *
 * @returns The sheet.
 */
export function SitePage(): React.JSX.Element {
  const { t } = useTranslation("site");
  const dismiss = useDismiss();
  const idBase = useId();
  const [selected, setSelected] = useState<SiteTab>("editor");
  const [state, dispatch] = useReducer(wizardReducer, INITIAL_WIZARD_STATE);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const dirty = hasUnsavedDraft(state);
  // One map for the page's lifetime, created on first render. The buttons are the only holders of a reference.
  const [tabElements] = useState(() => new Map<SiteTab, HTMLButtonElement>());
  // One stable callback per tab, so React does not detach and re-attach the ref on every render.
  const [tabRefs] = useState(
    () =>
      new Map(
        TABS.map((tab): [SiteTab, (element: HTMLButtonElement | null) => void] => [
          tab,
          (element) => {
            if (element === null) {
              tabElements.delete(tab);
            } else {
              tabElements.set(tab, element);
            }
          },
        ]),
      ),
  );

  /**
   * Selects a section and moves focus to its tab, as automatic activation does.
   *
   * @param tab - The section to select.
   */
  const select = useCallback(
    (tab: SiteTab): void => {
      setSelected(tab);
      tabElements.get(tab)?.focus();
    },
    [tabElements],
  );

  /**
   * Handles the navigation keys of the tablist.
   *
   * @param event - The key event of a tab.
   * @param tab - The section of the tab that received the key.
   */
  const onTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, tab: SiteTab): void => {
    const target = targetTab(tab, event.key);
    if (target === null) {
      return;
    }
    event.preventDefault();
    select(target);
  };

  // While the discard question is open, closing the sheet only answers it (keep); otherwise a draft that was not
  // saved asks first, and a clean page closes at once.
  const requestClose = useCallback((): void => {
    if (confirmingClose) {
      setConfirmingClose(false);
    } else if (dirty) {
      setConfirmingClose(true);
    } else {
      dismiss();
    }
  }, [confirmingClose, dirty, dismiss]);

  return (
    <Sheet title={t("title")} onClose={requestClose}>
      {confirmingClose ? (
        <DiscardConfirm
          onKeep={() => {
            setConfirmingClose(false);
          }}
          onDiscard={dismiss}
        />
      ) : null}
      <div role="tablist" aria-label={t("tabs.label")} className={styles.tablist}>
        {TABS.map((tab) => {
          const isSelected = tab === selected;
          return (
            <button
              key={tab}
              ref={tabRefs.get(tab)}
              id={`${idBase}-tab-${tab}`}
              type="button"
              role="tab"
              aria-selected={isSelected}
              aria-controls={`${idBase}-panel-${tab}`}
              tabIndex={isSelected ? 0 : -1}
              className={classNames(styles.tab, isSelected && styles.tabSelected)}
              onClick={() => {
                setSelected(tab);
              }}
              onKeyDown={(event) => {
                onTabKeyDown(event, tab);
              }}
            >
              {t(`tabs.${tab}`)}
            </button>
          );
        })}
      </div>
      {/* Sections stay mounted when hidden, so the editor keeps its work across a change of tab. */}
      <div
        id={`${idBase}-panel-editor`}
        role="tabpanel"
        aria-labelledby={`${idBase}-tab-editor`}
        tabIndex={0}
        hidden={selected !== "editor"}
      >
        <SiteProfile />
        <SiteEditor
          state={state}
          dispatch={dispatch}
          onViewVersions={() => {
            setSelected("versions");
          }}
        />
      </div>
      <div
        id={`${idBase}-panel-versions`}
        role="tabpanel"
        aria-labelledby={`${idBase}-tab-versions`}
        tabIndex={0}
        hidden={selected !== "versions"}
      >
        {/* Mounted on first view only: the versions list is requested when the operator asks for it. */}
        {selected === "versions" ? <VersionsTab canEdit /> : null}
      </div>
    </Sheet>
  );
}
