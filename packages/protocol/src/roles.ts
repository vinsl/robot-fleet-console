/**
 * Role ordering of the console. A user can hold several Cognito groups; the highest role applies, and every
 * caller that needs the effective role uses this one function so that the order is defined once.
 */
import type { Role } from "./ws";

/**
 * Rank of a role in the console hierarchy: a higher rank grants everything a lower one does.
 *
 * The switch is exhaustive over {@link Role}, so a new role without a rank does not compile.
 *
 * @param role - A console role.
 * @returns The rank, from 1 (Viewer) to 3 (Admin).
 */
function rankOf(role: Role): number {
  switch (role) {
    case "Viewer":
      return 1;
    case "Operator":
      return 2;
    case "Admin":
      return 3;
  }
}

/**
 * Returns the highest role of a list, so that a user in `Admin` and `Viewer` acts as an `Admin`.
 *
 * @param roles - The roles the user holds. May be empty.
 * @returns The highest role, or `null` when the list is empty.
 */
export function highestRole(roles: readonly Role[]): Role | null {
  let best: Role | null = null;
  for (const role of roles) {
    if (best === null || rankOf(role) > rankOf(best)) {
      best = role;
    }
  }
  return best;
}
