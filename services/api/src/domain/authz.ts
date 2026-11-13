/**
 * Authorisation rules of the HTTP API: which principal a verified access token stands for, and which
 * roles a route accepts.
 *
 * The functions are pure. The claims are read from the JWT authorizer of API Gateway, which has already
 * checked the signature, the issuer, the audience and the expiry. This module adds the checks the authorizer
 * does not make: the token must be an access token of the console's app client, so an ID token cannot be
 * replayed as a bearer credential, and the role comes from the group claim only.
 */
import {
  DEMO_SITE_ID,
  RoleSchema,
  UserSubSchema,
  highestRole,
  type Role,
  type SiteId,
  type UserSub,
} from "@mfc/protocol";
import { z } from "zod";

/** Value of the `token_use` claim of an access token. An ID token carries `id` and is refused here. */
const ACCESS_TOKEN_USE = "access";

/** Grammar of a Cognito app client identifier: alphanumeric, bounded. Read only to check that it is present. */
const ClientIdSchema = z.string().regex(/^[A-Za-z0-9]{1,128}$/);

/** Identity of the caller once the access token has been verified. */
export interface Principal {
  /** Cognito subject of the user. */
  readonly userId: UserSub;
  /** Highest role the user holds. */
  readonly role: Role;
  /** Site the console works on. */
  readonly siteId: SiteId;
}

/**
 * Reads the group names from the claim. Cognito sends a list claim as an array in a direct call and as a
 * bracketed string such as `[Admin Operator]` through the API Gateway JWT authorizer, so both shapes are read.
 *
 * The bracketed form is split on whitespace and commas, so `[Admin,Viewer]` and `[Admin Viewer]` read the same.
 * Group membership is set by administrators of the user pool (users cannot edit their own groups), so the
 * parser trusts the group names only as role names: anything that is not exactly a console role is dropped.
 * A group whose name contains a space is therefore never a role in the array form, and two roles in the
 * bracketed form. Both outcomes are tested and both are safe because no free-text name can grant a role.
 *
 * @param value - The raw claim value.
 * @returns The group names, empty when the claim has an unexpected shape.
 */
function groupsOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((group): group is string => typeof group === "string");
  }
  if (typeof value !== "string") {
    return [];
  }
  const trimmed = value.trim();
  const inner = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return inner.split(/[\s,]+/).filter((group) => group.length > 0);
}

/**
 * Builds the principal from the verified claims of an access token.
 *
 * Refused, with `null`: a token whose `token_use` is not `access` (an ID token), a token without a client
 * identifier, a token without a valid subject, and a token without any console role. Groups that are not console
 * roles are ignored, so a user in an unknown group gets no role from them.
 *
 * @param claims - The claims of the verified token.
 * @returns The principal, or `null` when the token does not grant a console role.
 */
export function principalFromClaims(claims: Record<string, unknown>): Principal | null {
  if (
    claims.token_use !== ACCESS_TOKEN_USE ||
    !ClientIdSchema.safeParse(claims.client_id).success
  ) {
    return null;
  }
  const subject = UserSubSchema.safeParse(claims.sub);
  if (!subject.success) {
    return null;
  }
  const roles = groupsOf(claims["cognito:groups"]).flatMap((group) => {
    const parsed = RoleSchema.safeParse(group);
    return parsed.success ? [parsed.data] : [];
  });
  const role = highestRole(roles);
  if (role === null) {
    return null;
  }
  return { userId: subject.data, role, siteId: DEMO_SITE_ID };
}

/**
 * Tells whether the principal holds one of the roles a route accepts.
 *
 * @param principal - The caller.
 * @param allowed - The roles the route accepts.
 * @returns `true` when the principal's role is in `allowed`.
 */
export function requireRole(principal: Principal, allowed: readonly Role[]): boolean {
  return allowed.includes(principal.role);
}

/** Largest `exp` the helper accepts, in seconds: a 10-digit epoch keeps the millisecond value a safe integer. */
const MAX_EXPIRY_SECONDS = 9_999_999_999;

/**
 * Reads the expiry of the access token as the instant the WebSocket session ends.
 *
 * Cognito sends `exp` as a number of seconds; the API Gateway authorizer may send it as a string, so both are
 * read. The session ends with the access token (FR-AUTH-4).
 *
 * @param claims - The claims of the verified access token.
 * @returns The expiry as an ISO 8601 instant with milliseconds, or `null` when `exp` is missing or malformed.
 */
export function sessionExpiresAtOf(claims: Record<string, unknown>): string | null {
  const parsed = z
    .union([
      z.number().int().positive().max(MAX_EXPIRY_SECONDS),
      z
        .string()
        .regex(/^\d{1,10}$/)
        .transform(Number),
    ])
    .safeParse(claims.exp);
  return parsed.success ? new Date(parsed.data * 1000).toISOString() : null;
}
