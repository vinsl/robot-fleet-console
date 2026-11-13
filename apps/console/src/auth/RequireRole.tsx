/**
 * Route guard for pages that only some roles may open. UI only: the API enforces the same rule on its own.
 */
import type * as React from "react";
import type { Role } from "@mfc/protocol";
import { Forbidden } from "../pages/Forbidden";
import { useAuthStore } from "./auth-store";
import { isRoleAllowed } from "./roles";

/** Props of {@link RequireRole}. */
export interface RequireRoleProps {
  /** Roles that may open the page. */
  readonly allowed: readonly Role[];
  /** The page to render when the role is allowed. */
  readonly children: React.ReactNode;
}

/**
 * Renders the page when the user's role is allowed, and the Forbidden page otherwise.
 *
 * Hiding a link is not access control: this guard only keeps the page out of the UI. Server-side
 * enforcement of each protected action is the responsibility of the API route behind it.
 *
 * @param props - Allowed roles and the page.
 * @returns The page, or the Forbidden page.
 */
export function RequireRole({ allowed, children }: RequireRoleProps): React.JSX.Element {
  const role = useAuthStore((state) => state.role);
  if (!isRoleAllowed(role, allowed)) {
    return <Forbidden />;
  }
  return <>{children}</>;
}
