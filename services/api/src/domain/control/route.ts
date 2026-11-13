/**
 * Routing and role matrix of the control API: which route a request names, the parameters it carries, and the roles
 * that may call it.
 *
 * The route key is compared as an exact string, so an unexpected key is a refusal rather than a guess. The path
 * parameters are parsed with the protocol's own schemas, so every storage key built from them is built from validated
 * identifiers. Both functions are pure and tested alone.
 */
import { RobotIdSchema, SiteIdSchema, type Role, type RobotId, type SiteId } from "@mfc/protocol";

/** A route of the control API, with the parameters it carries once they have been validated. */
export type ControlRoute =
  | { readonly name: "listRobots"; readonly siteId: SiteId }
  | { readonly name: "getLock"; readonly siteId: SiteId; readonly robotId: RobotId }
  | { readonly name: "acquireLock"; readonly siteId: SiteId; readonly robotId: RobotId }
  | { readonly name: "releaseLock"; readonly siteId: SiteId; readonly robotId: RobotId }
  | { readonly name: "sendCommand"; readonly siteId: SiteId; readonly robotId: RobotId }
  | { readonly name: "getDemo"; readonly siteId: SiteId }
  | { readonly name: "setDemo"; readonly siteId: SiteId };

/** Name of a control route. */
export type ControlRouteName = ControlRoute["name"];

/**
 * Outcome of routing a request: the route, or the reason it cannot be routed. `unknown-route` is a `404`;
 * `invalid-path` is a `400`.
 */
export type ControlRouteResult =
  | { readonly ok: true; readonly route: ControlRoute }
  | { readonly ok: false; readonly reason: "unknown-route" | "invalid-path" };

/** Route keys of the API, exactly as API Gateway sends them. */
const ROUTE_NAMES: ReadonlyMap<string, ControlRouteName> = new Map<string, ControlRouteName>([
  ["GET /sites/{siteId}/robots", "listRobots"],
  ["GET /sites/{siteId}/robots/{robotId}/lock", "getLock"],
  ["POST /sites/{siteId}/robots/{robotId}/lock", "acquireLock"],
  ["POST /sites/{siteId}/robots/{robotId}/lock/release", "releaseLock"],
  ["POST /sites/{siteId}/robots/{robotId}/commands", "sendCommand"],
  ["GET /sites/{siteId}/demo", "getDemo"],
  ["PUT /sites/{siteId}/demo", "setDemo"],
]);

/** Roles that may read the fleet state of a site: every console role, the Viewer included. */
const EVERY_ROLE: readonly Role[] = ["Admin", "Operator", "Viewer"];

/** Roles that may take, release or command a robot: the roles that act on the fleet, never a Viewer. */
const OPERATORS: readonly Role[] = ["Admin", "Operator"];

/** Roles that may change the demo mode. */
const ADMIN: readonly Role[] = ["Admin"];

/**
 * Roles that may call a control route.
 *
 * The command route admits the operators; the command policy narrows a fault injection to the Admin again.
 *
 * @param name - The route.
 * @returns The roles the route accepts.
 */
export function rolesOf(name: ControlRouteName): readonly Role[] {
  switch (name) {
    case "listRobots":
    case "getLock":
    case "getDemo":
      return EVERY_ROLE;
    case "acquireLock":
    case "releaseLock":
    case "sendCommand":
      return OPERATORS;
    case "setDemo":
      return ADMIN;
  }
}

/**
 * Routes a request: resolves the route key, then validates the path parameters against the protocol schemas.
 *
 * @param routeKey - The route key of the request, for example `POST /sites/{siteId}/robots/{robotId}/commands`.
 * @param pathParameters - The path parameters of the request, if any.
 * @returns The route with its validated parameters, or the reason it cannot be routed.
 */
export function parseControlRoute(
  routeKey: string,
  pathParameters: Readonly<Record<string, string | undefined>> | undefined,
): ControlRouteResult {
  const name = ROUTE_NAMES.get(routeKey);
  if (name === undefined) {
    return { ok: false, reason: "unknown-route" };
  }
  const siteId = SiteIdSchema.safeParse(pathParameters?.siteId);
  if (!siteId.success) {
    return { ok: false, reason: "invalid-path" };
  }
  if (name === "listRobots" || name === "getDemo" || name === "setDemo") {
    return { ok: true, route: { name, siteId: siteId.data } };
  }
  const robotId = RobotIdSchema.safeParse(pathParameters?.robotId);
  if (!robotId.success) {
    return { ok: false, reason: "invalid-path" };
  }
  return { ok: true, route: { name, siteId: siteId.data, robotId: robotId.data } };
}
