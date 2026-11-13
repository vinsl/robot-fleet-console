/**
 * Routing and role matrix of the alerts API: which route a request names, the parameters it carries, and the
 * roles that may call it.
 *
 * The route key is compared as an exact string, so an unexpected key is a refusal rather than a guess. The
 * path parameters are parsed with the protocol's own schemas, so every storage key built from them is built
 * from validated identifiers. Both functions are pure and tested alone.
 */
import { AlertIdSchema, SiteIdSchema, type AlertId, type Role, type SiteId } from "@mfc/protocol";

/** A route of the alerts API, with the parameters it carries once they have been validated. */
export type AlertRoute =
  | { readonly name: "listAlerts"; readonly siteId: SiteId }
  | { readonly name: "acknowledgeAlert"; readonly siteId: SiteId; readonly alertId: AlertId }
  | { readonly name: "resolveAlert"; readonly siteId: SiteId; readonly alertId: AlertId };

/** Name of an alerts route. */
export type AlertRouteName = AlertRoute["name"];

/**
 * Outcome of routing a request: the route, or the reason it cannot be routed. `unknown-route` is a `404`;
 * `invalid-path` is a `400`.
 */
export type AlertRouteResult =
  | { readonly ok: true; readonly route: AlertRoute }
  | { readonly ok: false; readonly reason: "unknown-route" | "invalid-path" };

/** Route keys of the API, exactly as API Gateway sends them. */
const ROUTE_NAMES: ReadonlyMap<string, AlertRouteName> = new Map<string, AlertRouteName>([
  ["GET /sites/{siteId}/alerts", "listAlerts"],
  ["POST /sites/{siteId}/alerts/{alertId}/acknowledge", "acknowledgeAlert"],
  ["POST /sites/{siteId}/alerts/{alertId}/resolve", "resolveAlert"],
]);

/** Roles that may read the alerts of a site: every console role, the Viewer included (FR-AUTH-1). */
const EVERY_ROLE: readonly Role[] = ["Admin", "Operator", "Viewer"];

/** Roles that may acknowledge or resolve an alert: the roles that act on the fleet, never a Viewer. */
const OPERATORS: readonly Role[] = ["Admin", "Operator"];

/**
 * Roles that may call an alerts route.
 *
 * @param name - The route.
 * @returns The roles the route accepts.
 */
export function rolesOf(name: AlertRouteName): readonly Role[] {
  switch (name) {
    case "listAlerts":
      return EVERY_ROLE;
    case "acknowledgeAlert":
    case "resolveAlert":
      return OPERATORS;
  }
}

/**
 * Routes a request: resolves the route key, then validates the path parameters against the protocol schemas.
 *
 * @param routeKey - The route key of the request, for example `POST /sites/{siteId}/alerts/{alertId}/resolve`.
 * @param pathParameters - The path parameters of the request, if any.
 * @returns The route with its validated parameters, or the reason it cannot be routed.
 */
export function parseAlertRoute(
  routeKey: string,
  pathParameters: Readonly<Record<string, string | undefined>> | undefined,
): AlertRouteResult {
  const name = ROUTE_NAMES.get(routeKey);
  if (name === undefined) {
    return { ok: false, reason: "unknown-route" };
  }
  const siteId = SiteIdSchema.safeParse(pathParameters?.siteId);
  if (!siteId.success) {
    return { ok: false, reason: "invalid-path" };
  }
  if (name === "listAlerts") {
    return { ok: true, route: { name, siteId: siteId.data } };
  }
  const alertId = AlertIdSchema.safeParse(pathParameters?.alertId);
  if (!alertId.success) {
    return { ok: false, reason: "invalid-path" };
  }
  return { ok: true, route: { name, siteId: siteId.data, alertId: alertId.data } };
}
