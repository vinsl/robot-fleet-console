/**
 * Routing of the audit API: the route key of the one read it offers, and the validation of its path parameter.
 *
 * Every verified console role may read the trail (FR-AUTH-1, ADR 0064): the Viewer included, since the trail holds
 * no secret and the subjects it names are already visible in the console. The role is therefore not checked here,
 * and the handler only checks that the token belongs to the site of the path. The route key is compared as an exact
 * string, so an unexpected key is a refusal rather than a guess.
 */
import { SiteIdSchema, type SiteId } from "@mfc/protocol";

/** Route key of the audit read, exactly as API Gateway sends it. */
export const AUDIT_ROUTE_KEY = "GET /sites/{siteId}/audit";

/**
 * Outcome of routing a request: the site of the path, or the reason it cannot be routed. `unknown-route` is a `404`;
 * `invalid-path` is a `400`.
 */
export type AuditRouteResult =
  | { readonly ok: true; readonly siteId: SiteId }
  | { readonly ok: false; readonly reason: "unknown-route" | "invalid-path" };

/**
 * Routes a request: checks the route key, then validates the site of the path against the protocol schema, so every
 * partition built from it is built from a validated identifier.
 *
 * @param routeKey - The route key of the request.
 * @param pathParameters - The path parameters of the request, if any.
 * @returns The site, or the reason the request cannot be routed.
 */
export function parseAuditRoute(
  routeKey: string,
  pathParameters: Readonly<Record<string, string | undefined>> | undefined,
): AuditRouteResult {
  if (routeKey !== AUDIT_ROUTE_KEY) {
    return { ok: false, reason: "unknown-route" };
  }
  const siteId = SiteIdSchema.safeParse(pathParameters?.siteId);
  if (!siteId.success) {
    return { ok: false, reason: "invalid-path" };
  }
  return { ok: true, siteId: siteId.data };
}
