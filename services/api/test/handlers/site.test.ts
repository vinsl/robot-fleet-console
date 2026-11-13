/**
 * The `site` handler: the denied-access rows of every route (role, site, token, active-map rule), the outcomes of the
 * allowed requests, and the failures that must not leak. Each refusal is checked to happen before the store or the
 * object store is reached.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MAX_BODY_BYTES } from "../../src/adapters/http";
import { createSiteHandler, type SiteHandlerDeps } from "../../src/handlers/site";
import { RecordingHandlerLogger } from "../fakes/recording";
import { createSiteWorld, TEST_ACTOR, type SiteWorld } from "../site/fakes";
import { mapRecordOf } from "../site/fixtures";

// The module builds its production handler at import, so its environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("FLEET_TABLE_NAME", "mfc-demo-fleet");
  vi.stubEnv("EVENTS_TABLE_NAME", "mfc-demo-events");
  vi.stubEnv("SITE_MAPS_BUCKET_NAME", "mfc-demo-site-maps");
});

const SITE = "paris-01";
const OTHER_SITE = "other-site";
const SUB = TEST_ACTOR;

/** A route as a request names it: the route key and the path parameters. */
interface RouteDef {
  readonly routeKey: string;
  readonly pathParameters: Record<string, string>;
}

/** Name of a route of the site API. */
type RouteName =
  "getSite" | "updateSite" | "listMaps" | "createMap" | "getMapUrl" | "validateMap" | "activateMap";

/** Routes of the site API, with their path parameters for the demo site. */
const ROUTES: ReadonlyMap<RouteName, RouteDef> = new Map<RouteName, RouteDef>([
  ["getSite", { routeKey: "GET /sites/{siteId}", pathParameters: { siteId: SITE } }],
  ["updateSite", { routeKey: "PUT /sites/{siteId}", pathParameters: { siteId: SITE } }],
  ["listMaps", { routeKey: "GET /sites/{siteId}/maps", pathParameters: { siteId: SITE } }],
  ["createMap", { routeKey: "POST /sites/{siteId}/maps", pathParameters: { siteId: SITE } }],
  [
    "getMapUrl",
    {
      routeKey: "GET /sites/{siteId}/maps/{version}",
      pathParameters: { siteId: SITE, version: "3" },
    },
  ],
  [
    "validateMap",
    {
      routeKey: "POST /sites/{siteId}/maps/{version}/validate",
      pathParameters: { siteId: SITE, version: "3" },
    },
  ],
  [
    "activateMap",
    {
      routeKey: "POST /sites/{siteId}/maps/{version}/activate",
      pathParameters: { siteId: SITE, version: "3" },
    },
  ],
]);

/**
 * The definition of a route of the table.
 *
 * @param name - The route.
 * @returns Its route key and path parameters.
 * @throws When the table lacks the route: a test bug, never a request outcome.
 */
function routeOf(name: RouteName): RouteDef {
  const route = ROUTES.get(name);
  if (route === undefined) {
    throw new Error(`no route ${name}`);
  }
  return route;
}

/** Test harness: the handler over an in-memory world, with the fakes kept for assertions. */
interface Harness {
  readonly handler: ReturnType<typeof createSiteHandler>;
  readonly world: SiteWorld;
  readonly logger: RecordingHandlerLogger;
  readonly publishStoredMetrics: ReturnType<typeof vi.fn>;
}

/**
 * Builds the handler over a fresh world.
 *
 * @returns The handler and what it reaches.
 */
function harness(): Harness {
  const world = createSiteWorld();
  const logger = new RecordingHandlerLogger();
  const publishStoredMetrics = vi.fn();
  const metrics: SiteHandlerDeps["metrics"] = {
    count: (name) => {
      world.metrics.count(name);
    },
    publishStoredMetrics,
  };
  const handler = createSiteHandler({
    logger,
    metrics,
    tracer: { putAnnotation: vi.fn() },
    ports: {
      store: world.store,
      objects: world.objects,
      audit: world.audit,
      clock: world.deps.clock,
      ids: world.deps.ids,
    },
  });
  return { handler, world, logger, publishStoredMetrics };
}

/**
 * Builds a proxy event with the verified claims of one group, as the JWT authorizer passes them.
 *
 * @param route - The route key and the path parameters.
 * @param groups - The Cognito group claim, or `undefined` for a token with no console group.
 * @param options - The optional body and token type.
 * @returns The event.
 */
function eventFor(
  route: { routeKey: string; pathParameters: Record<string, string> },
  groups: string | undefined,
  options: { body?: string; tokenUse?: string; siteOverride?: string } = {},
): APIGatewayProxyEventV2WithJWTAuthorizer {
  const pathParameters =
    options.siteOverride === undefined
      ? route.pathParameters
      : { ...route.pathParameters, siteId: options.siteOverride };
  const claims: Record<string, unknown> = {
    sub: SUB,
    token_use: options.tokenUse ?? "access",
    client_id: "clientapp01",
  };
  if (groups !== undefined) {
    claims["cognito:groups"] = groups;
  }
  return {
    routeKey: route.routeKey,
    pathParameters,
    requestContext: {
      requestId: "req-0007-abcdef",
      authorizer: { jwt: { claims } },
    },
    body: options.body,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/**
 * Asserts that a request reached neither the store nor the object store.
 *
 * @param world - The world of the harness.
 */
function expectNothingReached(world: SiteWorld): void {
  expect(world.store.calls).toEqual([]);
  expect(world.objects.uploads).toEqual([]);
  expect(world.objects.downloads).toEqual([]);
  expect(world.audit.records).toEqual([]);
}

/** Routes the Admin is allowed on, with a body where the route takes one. */
const ADMIN_BODY = '{"name":"Warehouse A"}';

describe("denied access: wrong role", () => {
  it.each<[RouteName]>([
    ["createMap"],
    ["validateMap"],
    ["activateMap"],
    ["updateSite"],
    ["listMaps"],
  ])("%s is 403 for a Viewer and for an Operator, and nothing is reached", async (name) => {
    for (const groups of ["[Viewer]", "[Operator]"]) {
      const { handler, world } = harness();
      const response = await handler(eventFor(routeOf(name), groups, { body: ADMIN_BODY }));
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("urn:mfc:problem:forbidden");
      expectNothingReached(world);
    }
  });

  it("a body of a refused update is not even parsed", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor(routeOf("updateSite"), "[Operator]", { body: "not json at all" }),
    );
    expect(response.statusCode).toBe(403);
    expectNothingReached(world);
  });

  it("a token with no console group is 403 on every route", async () => {
    for (const route of [...ROUTES.values()]) {
      const { handler, world } = harness();
      const response = await handler(eventFor(route, "[Intruder]", { body: ADMIN_BODY }));
      expect(response.statusCode).toBe(403);
      expectNothingReached(world);
    }
  });
});

describe("denied access: foreign site", () => {
  it.each([...ROUTES.keys()])(
    "%s for another site is 403 for an Admin, and nothing is reached",
    async (name) => {
      const { handler, world } = harness();
      const response = await handler(
        eventFor(routeOf(name), "[Admin]", { body: ADMIN_BODY, siteOverride: OTHER_SITE }),
      );
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("urn:mfc:problem:forbidden");
      expectNothingReached(world);
    },
  );

  it.each(["getSite", "getMapUrl"] as RouteName[])(
    "%s for another site is 403 for a Viewer too",
    async (name) => {
      const { handler, world } = harness();
      const response = await handler(
        eventFor(routeOf(name), "[Viewer]", { siteOverride: OTHER_SITE }),
      );
      expect(response.statusCode).toBe(403);
      expectNothingReached(world);
    },
  );
});

describe("denied access: missing or wrong token", () => {
  it.each([...ROUTES.keys()])(
    "%s without verified claims is 403, and nothing is reached",
    async (name) => {
      const { handler, world } = harness();
      const event = {
        routeKey: routeOf(name).routeKey,
        pathParameters: routeOf(name).pathParameters,
        requestContext: { requestId: "req-0007-abcdef", authorizer: undefined },
        body: ADMIN_BODY,
      } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
      const response = await handler(event);
      expect(response.statusCode).toBe(403);
      expectNothingReached(world);
    },
  );

  it("an ID token that carries an Admin group is 403 on every route", async () => {
    for (const route of [...ROUTES.values()]) {
      const { handler, world } = harness();
      const response = await handler(
        eventFor(route, "[Admin]", { body: ADMIN_BODY, tokenUse: "id" }),
      );
      expect(response.statusCode).toBe(403);
      expectNothingReached(world);
    }
  });
});

describe("getMapUrl: the active-map rule", () => {
  /**
   * Arranges a site whose active map is version 3, with version 3 validated and version 2 kept.
   *
   * @param world - The world to arrange.
   */
  function seedActive(world: SiteWorld): void {
    world.store.seedSite(SITE, { name: null, activeVersion: 3, nextVersion: 3, updatedAt: null });
    world.store.seedMap(SITE, mapRecordOf(3, "VALID"));
    world.store.seedMap(SITE, mapRecordOf(2, "VALID"));
  }

  it.each(["[Viewer]", "[Operator]"])("%s may read the active map", async (groups) => {
    const { handler, world } = harness();
    seedActive(world);
    const response = await handler(
      eventFor(
        { ...routeOf("getMapUrl"), pathParameters: { siteId: SITE, version: "active" } },
        groups,
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "")).toMatchObject({ version: 3, sizeBytes: 1234 });
  });

  it.each(["[Viewer]", "[Operator]"])(
    "%s is 403 for a numbered version, even one that is valid, and nothing is reached",
    async (groups) => {
      const { handler, world } = harness();
      seedActive(world);
      const response = await handler(eventFor(routeOf("getMapUrl"), groups));
      expect(response.statusCode).toBe(403);
      expect(world.store.calls).not.toContain("getMap");
      expect(world.objects.downloads).toEqual([]);
    },
  );

  it("an Admin may read any valid version by number", async () => {
    const { handler, world } = harness();
    seedActive(world);
    const response = await handler(
      eventFor(
        { ...routeOf("getMapUrl"), pathParameters: { siteId: SITE, version: "2" } },
        "[Admin]",
      ),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "")).toMatchObject({ version: 2 });
    expect(world.objects.downloads).toHaveLength(1);
  });

  it("an Admin may read the active map", async () => {
    const { handler, world } = harness();
    seedActive(world);
    const response = await handler(
      eventFor(
        { ...routeOf("getMapUrl"), pathParameters: { siteId: SITE, version: "active" } },
        "[Admin]",
      ),
    );
    expect(response.statusCode).toBe(200);
  });

  it("the active map of a site with none is 404 map-not-found", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor(
        { ...routeOf("getMapUrl"), pathParameters: { siteId: SITE, version: "active" } },
        "[Viewer]",
      ),
    );
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("urn:mfc:problem:map-not-found");
    expect(world.objects.downloads).toEqual([]);
  });
});

describe("allowed requests", () => {
  it("returns the default profile of a site with no item to a Viewer", async () => {
    const { handler } = harness();
    const response = await handler(eventFor(routeOf("getSite"), "[Viewer]"));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "")).toEqual({
      siteId: SITE,
      name: SITE,
      activeVersion: null,
      updatedAt: null,
    });
  });

  it("stores the name and audits it with the actor of the verified token, not of the body", async () => {
    const { handler, world, publishStoredMetrics } = harness();
    const response = await handler(
      eventFor(routeOf("updateSite"), "[Admin]", {
        body: '{"name":"Warehouse A"}',
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "")).toMatchObject({ name: "Warehouse A" });
    expect(world.audit.records).toHaveLength(1);
    expect(world.audit.records[0]).toMatchObject({
      actor: SUB,
      action: "site.update",
      correlationId: "req-0007-abcdef",
    });
    expect(publishStoredMetrics).toHaveBeenCalledTimes(1);
  });

  it("refuses an update with a field outside the schema as 400, before any write", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor(routeOf("updateSite"), "[Admin]", { body: '{"name":"A","actor":"someone-else"}' }),
    );
    expect(response.statusCode).toBe(400);
    expect(world.store.calls).toEqual([]);
  });

  it("refuses an update above the body limit as 413", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor(routeOf("updateSite"), "[Admin]", { body: "x".repeat(DEFAULT_MAX_BODY_BYTES + 1) }),
    );
    expect(response.statusCode).toBe(413);
    expect(world.store.calls).toEqual([]);
  });

  it("creates a map slot for an Admin and presigns its upload", async () => {
    const { handler, world } = harness();
    const response = await handler(eventFor(routeOf("createMap"), "[Admin]"));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "")).toMatchObject({ version: 1, maxBytes: 2_000_000 });
    expect(world.objects.uploads).toEqual([`sites/${SITE}/maps/000001.geojson`]);
  });

  it("answers a version the store does not know with 404 map-not-found", async () => {
    const { handler } = harness();
    const response = await handler(eventFor(routeOf("validateMap"), "[Admin]"));
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("urn:mfc:problem:map-not-found");
  });

  it("answers an activation of a version that is not validated with 422", async () => {
    const { handler, world } = harness();
    world.store.seedMap(SITE, mapRecordOf(3, "PENDING"));
    const response = await handler(eventFor(routeOf("activateMap"), "[Admin]"));
    expect(response.statusCode).toBe(422);
    expect(response.body).toContain("urn:mfc:problem:map-invalid");
  });

  it("lists the versions to an Admin", async () => {
    const { handler, world } = harness();
    world.store.seedMap(SITE, mapRecordOf(1, "VALID"));
    const response = await handler(eventFor(routeOf("listMaps"), "[Admin]"));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "")).toMatchObject({
      versions: [{ version: 1, status: "VALID", active: false }],
    });
  });
});

describe("routing and failures", () => {
  it("answers an unknown route with 404 not-found, before any role check", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor({ routeKey: "DELETE /sites/{siteId}", pathParameters: { siteId: SITE } }, "[Admin]"),
    );
    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("urn:mfc:problem:not-found");
    expectNothingReached(world);
  });

  it("answers a malformed site identifier with 400, and nothing is reached", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor(
        { routeKey: "GET /sites/{siteId}", pathParameters: { siteId: "Bad_Id" } },
        "[Admin]",
      ),
    );
    expect(response.statusCode).toBe(400);
    expectNothingReached(world);
  });

  it("answers an unexpected store failure with 500 and no internal text", async () => {
    const { handler, world, logger } = harness();
    vi.spyOn(world.store, "getSite").mockRejectedValueOnce(
      new Error("ResourceNotFound arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-fleet"),
    );
    const response = await handler(eventFor(routeOf("getSite"), "[Viewer]"));
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("urn:mfc:problem:internal");
    expect(response.body).not.toContain("arn:");
    expect(response.body).not.toContain("123456789012");
    expect(logger.text()).not.toContain("123456789012");
  });

  it("removes its log keys when the invocation ends", async () => {
    const { handler, logger } = harness();
    await handler(eventFor(routeOf("getSite"), "[Viewer]"));
    expect(logger.keys.has("correlationId")).toBe(false);
    expect(logger.keys.has("route")).toBe(false);
  });
});

describe("refusals are logged without tokens or bodies", () => {
  it("never logs the subject or the body of a refused request", async () => {
    const { handler, logger } = harness();
    await handler(eventFor(routeOf("updateSite"), "[Viewer]", { body: '{"name":"Secret Name"}' }));
    expect(logger.text()).not.toContain(SUB);
    expect(logger.text()).not.toContain("Secret Name");
  });
});
