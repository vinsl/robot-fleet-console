/**
 * Console role derivation from the Cognito groups of the signed-in user.
 *
 * These functions only shape the UI. Authorization is enforced by the API from the verified token, so a
 * wrong role here can hide a page but never grant access to data.
 */
import { RoleSchema, highestRole, type Role } from "@mfc/protocol";

/**
 * Derives the effective console role from the `cognito:groups` claim.
 *
 * Groups that are not console roles are ignored. A user in several role groups acts with the highest one.
 *
 * @param groups - Group names from the access token. May be empty.
 * @returns The highest known role, or `null` when no group is a console role.
 */
export function roleFromGroups(groups: readonly string[]): Role | null {
  const roles = groups.flatMap((group) => {
    const parsed = RoleSchema.safeParse(group);
    return parsed.success ? [parsed.data] : [];
  });
  return highestRole(roles);
}

/**
 * Tells whether a role may see a page.
 *
 * @param role - The user's effective role, or `null` when signed out or without a known group.
 * @param allowed - Roles the page is open to.
 * @returns `true` only when `role` is one of `allowed`.
 */
export function isRoleAllowed(role: Role | null, allowed: readonly Role[]): boolean {
  return role !== null && allowed.includes(role);
}
