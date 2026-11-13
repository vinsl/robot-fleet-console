/**
 * Main navigation of the console, at the bottom centre of the screen. It lists the entries the role may see.
 */
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { NavLink } from "react-router";
import type { Role } from "@mfc/protocol";
import { classNames } from "../lib/class-names";
import { dockItemsFor } from "./dock-items";
import { useOpenAlertCount } from "./open-alerts";
import styles from "./Dock.module.css";

/** Props of {@link Dock}. */
export interface DockProps {
  /** The user's role, which decides the entries shown. */
  readonly role: Role | null;
}

/**
 * Renders the navigation. The active entry is marked by `aria-current` (set by the router) and by the accent
 * fill, so the state is not carried by colour alone. The Alerts entry shows the number of open alerts as text.
 * On a compact screen (ADR 0075) the labels are hidden visually and stay in the accessible name.
 *
 * @param props - The role.
 * @returns The navigation landmark.
 */
export function Dock({ role }: DockProps): React.JSX.Element {
  const { t } = useTranslation(["shell", "alerts"]);
  const items = dockItemsFor(role);
  const openAlerts = useOpenAlertCount();
  return (
    <nav aria-label={t("dock.label")} className={classNames("glass", styles.dock)}>
      <ul className={styles.list}>
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.id}>
              <NavLink
                to={item.path}
                end={item.path === "/"}
                className={({ isActive }) => (isActive ? styles.active : styles.link)}
              >
                <Icon aria-hidden="true" focusable="false" className={styles.icon} />
                <span className={styles.label}>{t(item.labelKey)}</span>
                {item.id === "alerts" && openAlerts !== null && openAlerts > 0 ? (
                  <>
                    {/* A flex container drops whitespace-only text, so the space only shapes the name. */}{" "}
                    <span
                      role="img"
                      className={styles.count}
                      aria-label={t("dockCount", { ns: "alerts", count: openAlerts })}
                    >
                      {openAlerts}
                    </span>
                  </>
                ) : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
