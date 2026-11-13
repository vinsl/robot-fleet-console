/**
 * Entries of the dock, the main navigation of the console, and the rule that decides which entries a role sees.
 *
 * The filter only shapes the UI. Hiding a link is not access control: the route guard and the API enforce
 * the same roles again.
 */
import {
  Bell,
  Bot,
  Building2,
  ChartColumn,
  Map as MapIcon,
  ScrollText,
  type LucideIcon,
} from "lucide-react";
import type { Role } from "@mfc/protocol";
import { isRoleAllowed } from "../auth/roles";

/** One entry of the dock. */
export interface DockItem {
  /** Stable identifier, used as React key. */
  readonly id: "fleet" | "alerts" | "kpi" | "audit" | "robots" | "site";
  /** Route the entry opens. */
  readonly path: string;
  /** i18n key of the label, namespace `shell`. */
  readonly labelKey: string;
  /** Icon shown next to the label. */
  readonly icon: LucideIcon;
  /** Roles that see the entry. */
  readonly roles: readonly Role[];
}

/**
 * Every dock entry, in display order (DESIGN 2.1: Fleet, Alerts, KPI, Audit, Robots). Site is an
 * administration page (Admin only).
 */
export const DOCK_ITEMS: readonly DockItem[] = [
  {
    id: "fleet",
    path: "/",
    labelKey: "pages.fleet",
    icon: MapIcon,
    roles: ["Admin", "Operator", "Viewer"],
  },
  {
    id: "alerts",
    path: "/alerts",
    labelKey: "pages.alerts",
    icon: Bell,
    roles: ["Admin", "Operator", "Viewer"],
  },
  {
    id: "kpi",
    path: "/kpi",
    labelKey: "pages.kpi",
    icon: ChartColumn,
    roles: ["Admin", "Operator", "Viewer"],
  },
  {
    id: "audit",
    path: "/audit",
    labelKey: "pages.audit",
    icon: ScrollText,
    roles: ["Admin", "Operator", "Viewer"],
  },
  {
    id: "robots",
    path: "/robots",
    labelKey: "pages.robots",
    icon: Bot,
    roles: ["Admin", "Operator", "Viewer"],
  },
  { id: "site", path: "/site", labelKey: "pages.site", icon: Building2, roles: ["Admin"] },
];

/**
 * Returns the dock entries a role may see.
 *
 * @param role - The user's effective role, or `null` when the user has no known group.
 * @returns The entries, in display order; empty when there is no role.
 */
export function dockItemsFor(role: Role | null): readonly DockItem[] {
  return DOCK_ITEMS.filter((item) => isRoleAllowed(role, item.roles));
}
