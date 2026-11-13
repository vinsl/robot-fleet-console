/**
 * Account menu of the status line. It holds sign-out. Sign-out clears the session in memory; the route guard
 * then sends the user to the sign-in page.
 */
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, LogOut, User } from "lucide-react";
import { useServices } from "../app/services";
import { useAuthStore } from "../auth/auth-store";
import { isRoleAllowed } from "../auth/roles";
import { DemoSwitch } from "../demo/DemoSwitch";
import { classNames } from "../lib/class-names";
import styles from "./UserMenu.module.css";

/**
 * Renders the account toggle and its menu. Escape closes the menu and returns focus to the toggle; the event
 * does not reach the document, so an open sheet does not close with it.
 *
 * @returns The account menu.
 */
export function UserMenu(): React.JSX.Element {
  const { t } = useTranslation("shell");
  const { auth } = useServices();
  const role = useAuthStore((state) => state.role);
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const signOutRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      signOutRef.current?.focus();
    }
  }, [open]);

  // A press anywhere outside the menu closes it, as a native menu does.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent): void => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && !root.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={styles.root}
      onBlur={(event) => {
        // Focus that leaves the account control (Tab past the last item, or a click elsewhere) closes the menu.
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
          setOpen(false);
        }
      }}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
          toggleRef.current?.focus();
        }
      }}
    >
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        className={styles.toggle}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <User aria-hidden="true" focusable="false" className={styles.icon} />
        <span>{t("userMenu.label")}</span>
        <ChevronDown aria-hidden="true" focusable="false" className={styles.icon} />
      </button>
      <div id={menuId} hidden={!open} className={classNames("glass", styles.menu)}>
        {/* Mounted only while the menu is open, so that a half-finished confirmation never survives a close. */}
        {open && isRoleAllowed(role, ["Admin"]) ? <DemoSwitch /> : null}
        <button
          ref={signOutRef}
          type="button"
          className={styles.item}
          onClick={() => {
            void auth.signOut();
          }}
        >
          <LogOut aria-hidden="true" focusable="false" className={styles.icon} />
          <span>{t("userMenu.signOut")}</span>
        </button>
      </div>
    </div>
  );
}
