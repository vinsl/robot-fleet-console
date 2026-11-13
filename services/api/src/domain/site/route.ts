/**
 * Routing and role matrix of the site API: which route a request names, the parameters it carries, and the
 * roles that may call it.
 *
 * The route key is compared as an exact string, so an unexpected key is a refusal rather than a guess. The
 * path parameters are parsed with the protocol's own schemas, so the storage key is only ever built from a
 * validated site identifier and a validated version number. Both functions are pure and tested alone.
 */
import {
  MapRefParamSchema,
  MapVersionParamSchema,
  SiteIdSchema,
  type MapRef,
  type MapVersionNumber,
  type Role,
  type SiteId,
} from "@mfc/protocol";

/** A route of the site API, with the parameters it carries once they have been validated. */
export type SiteRoute =
  | { readonly name: "getSite"; readonly siteId: SiteId }
  | { readonly name: "updateSite"; readonly siteId: SiteId }
  | { readonly name: "listMaps"; readonly siteId: SiteId }
  | { readonly name: "createMap"; readonly siteId: SiteId }
  | { readonly name: "getMapUrl"; readonly siteId: SiteId; readonly ref: MapRef }
  | { readonly name: "validateMap"; readonly siteId: SiteId; readonly version: MapVersionNumber }
  | { readonly name: "activateMap"; readonly siteId: SiteId; readonly version: MapVersionNumber };

/** Name of a site route. */
export type SiteRouteName = SiteRoute["name"];

/**
 * Outcome of routing a request: the route, or the reason it cannot be routed. `unknown-route` is a `404`;
 * `invalid-path` is a `400`.
 */
export type SiteRouteResult =
  | { readonly ok: true; readonly route: SiteRoute }
  | { readonly ok: false; readonly reason: "unknown-route" | "invalid-path" };

/** Route keys of the API, exactly as API Gateway sends them. */
const ROUTE_NAMES: ReadonlyMap<string, SiteRouteName> = new Map<string, SiteRouteName>([
  ["GET /sites/{siteId}", "getSite"],
  ["PUT /sites/{siteId}", "updateSite"],
  ["GET /sites/{siteId}/maps", "listMaps"],
  ["POST /sites/{siteId}/maps", "createMap"],
  ["GET /sites/{siteId}/maps/{version}", "getMapUrl"],
  ["POST /sites/{siteId}/maps/{version}/validate", "validateMap"],
  ["POST /sites/{siteId}/maps/{version}/activate", "activateMap"],
]);

/** Roles that may read the site profile and the active map: every console role. */
const EVERY_ROLE: readonly Role[] = ["Admin", "Operator", "Viewer"];

/** Roles that may change the site or read its version list: administrators only. */
const ADMIN_ONLY: readonly Role[] = ["Admin"];

/**
 * Roles that may call a route. Reads of the profile and of the active map are open to every console role,
 * because the fleet view needs the active map; the version list and every write are administrator actions.
 *
 * @param name - The route.
 * @returns The roles the route accepts.
 */
export function rolesOf(name: SiteRouteName): readonly Role[] {
  switch (name) {
    case "getSite":
    case "getMapUrl":
      return EVERY_ROLE;
    case "updateSite":
    case "listMaps":
    case "createMap":
    case "validateMap":
    case "activateMap":
      return ADMIN_ONLY;
  }
}

/**
 * Routes a request: resolves the route key, then validates the path parameters against the protocol schemas.
 *
 * The site identifier is always required. The version is a number for the write routes and a number or
 * `active` for the read of a map file.
 *
 * @param routeKey - The route key of the request, for example `GET /sites/{siteId}`.
 * @param pathParameters - The path parameters of the request, if any.
 * @returns The route with its validated parameters, or the reason it cannot be routed.
 */
export function parseSiteRoute(
  routeKey: string,
  pathParameters: Readonly<Record<string, string | undefined>> | undefined,
): SiteRouteResult {
  const name = ROUTE_NAMES.get(routeKey);
  if (name === undefined) {
    return { ok: false, reason: "unknown-route" };
  }
  const siteId = SiteIdSchema.safeParse(pathParameters?.siteId);
  if (!siteId.success) {
    return { ok: false, reason: "invalid-path" };
  }
  const rawVersion = pathParameters?.version;

  switch (name) {
    case "getSite":
    case "updateSite":
    case "listMaps":
    case "createMap":
      return { ok: true, route: { name, siteId: siteId.data } };
    case "getMapUrl": {
      const ref = MapRefParamSchema.safeParse(rawVersion);
      return ref.success
        ? { ok: true, route: { name, siteId: siteId.data, ref: ref.data } }
        : { ok: false, reason: "invalid-path" };
    }
    case "validateMap":
    case "activateMap": {
      const version = MapVersionParamSchema.safeParse(rawVersion);
      return version.success
        ? { ok: true, route: { name, siteId: siteId.data, version: version.data } }
        : { ok: false, reason: "invalid-path" };
    }
  }
}
