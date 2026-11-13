/**
 * Denied-access rows of the HTTP API (SEC-DAST-1): every refusal the API must return for an unauthorised,
 * malformed or oversized request, checked on the handlers and on the body parser.
 *
 * A refused request never reaches the session store: the rows that call `/ws-token` assert that the store saw
 * no operation. The Operator-only check is a row on the role helper, because the first route that needs it (the
 * users function) arrives in M9; the console-side check is in the console tests.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

// The HTTP ws-token module builds its production handler at import, so its environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("CONNECTIONS_TABLE_NAME", "mfc-demo-connections");
  vi.stubEnv("WS_URL", "wss://abc123.execute-api.eu-west-3.amazonaws.com/live");
  vi.stubEnv("FLEET_TABLE_NAME", "mfc-demo-fleet");
  vi.stubEnv("EVENTS_TABLE_NAME", "mfc-demo-events");
  vi.stubEnv("CONNECTIONS_TABLE_NAME", "mfc-demo-connections");
  vi.stubEnv(
    "WS_MANAGEMENT_ENDPOINT",
    "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
  );
  vi.stubEnv("IOT_DATA_ENDPOINT", "abc123-ats.iot.eu-west-3.amazonaws.com");
});
import { DEFAULT_MAX_BODY_BYTES, parseBody } from "../src/adapters/http";
import { requireRole, principalFromClaims } from "../src/domain/authz";
import { createAlertsHandler } from "../src/handlers/alerts";
import { createControlHandler, CONTROL_BODY_MAX_BYTES } from "../src/handlers/control";
import { createHttpWsTokenHandler } from "../src/handlers/http-ws-token";
import { createMeHandler } from "../src/handlers/me";
import { ALERT_ID, alertOf, alertsWorld, OPENED_AT, SITE_ID } from "./fakes/alerts";
import { FixedClock } from "./fakes/fixed";
import { RecordingHandlerLogger } from "./fakes/recording";
import { FakeWsSession } from "./fakes/ws-session";
import {
  CONTROL_ROBOT,
  CONTROL_SITE,
  commandIdOf,
  controlWorld,
  liveLockOf,
  OPERATOR_SUB,
  type ControlWorld,
} from "./fakes/control";

const SUB = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-11-02T10:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const ACCESS = {
  sub: SUB,
  token_use: "access",
  client_id: "clientapp01",
  "cognito:groups": "[Operator]",
};
const GOOD_BODY = '{"siteId":"paris-01"}';

/**
 * Builds a proxy event carrying the given authorizer context.
 *
 * @param authorizer - The authorizer context, or `undefined` when the request carries none.
 * @param body - The raw body text, when the request has one.
 * @returns The event, with only the fields the handlers read.
 */
function eventWith(authorizer: unknown, body?: string): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: { requestId: "req-0002-abcdef", authorizer },
    body,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/**
 * Builds the `/ws-token` handler over a fresh store, so each row can tell whether the store was reached.
 *
 * @returns The handler and the store.
 */
function wsTokenHarness() {
  const store = new FakeWsSession();
  const handler = createHttpWsTokenHandler({
    store,
    clock: new FixedClock(NOW),
    random: (size) => Buffer.alloc(size, 7),
    url: "wss://abc123.execute-api.eu-west-3.amazonaws.com/live",
    logger: new RecordingHandlerLogger(),
  });
  return { handler, store };
}

/**
 * Claims with an expiry, as the authorizer passes them for an access token.
 *
 * @param overrides - Claims to replace.
 * @returns The claims.
 */
function claims(overrides: Record<string, unknown> = {}): {
  jwt: { claims: Record<string, unknown> };
} {
  return { jwt: { claims: { ...ACCESS, exp: NOW_SECONDS + 1800, ...overrides } } };
}

describe("denied access: GET /me", () => {
  const me = createMeHandler({ logger: new RecordingHandlerLogger() });

  it("without claims is 403 forbidden", () => {
    const response = me(eventWith(undefined));
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
  });

  it("with the unknown group Intruder is 403", () => {
    expect(me(eventWith(claims({ "cognito:groups": "[Intruder]" }))).statusCode).toBe(403);
  });

  it("with an ID token is 403, even when the ID token carries a console group", () => {
    expect(me(eventWith(claims({ token_use: "id" }))).statusCode).toBe(403);
  });
});

describe("denied access: POST /ws-token", () => {
  it("with an ID token is 403 and the store is not reached", async () => {
    const { handler, store } = wsTokenHarness();
    const response = await handler(eventWith(claims({ token_use: "id" }), GOOD_BODY));
    expect(response.statusCode).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it("with a token that has no subject is 403 and the store is not reached", async () => {
    const { handler, store } = wsTokenHarness();
    const response = await handler(eventWith(claims({ sub: undefined }), GOOD_BODY));
    expect(response.statusCode).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it("for a site other than the caller's is 403 and nothing is stored", async () => {
    const { handler, store } = wsTokenHarness();
    const response = await handler(eventWith(claims(), '{"siteId":"other-site"}'));
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
    expect(store.calls).toEqual([]);
  });

  it("with a body that does not match the schema is 400 and nothing is stored", async () => {
    const { handler, store } = wsTokenHarness();
    const response = await handler(eventWith(claims(), '{"siteId":"paris-01","role":"Admin"}'));
    expect(response.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("with a body above 16 KiB is 413 and nothing is stored", async () => {
    const { handler, store } = wsTokenHarness();
    const response = await handler(eventWith(claims(), "x".repeat(DEFAULT_MAX_BODY_BYTES + 1)));
    expect(response.statusCode).toBe(413);
    expect(store.calls).toEqual([]);
  });

  it("whose session already ended is 400 and nothing is stored", async () => {
    const { handler, store } = wsTokenHarness();
    const response = await handler(eventWith(claims({ exp: NOW_SECONDS - 1 }), GOOD_BODY));
    expect(response.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });
});

describe("denied access: role checks", () => {
  it("a Viewer is refused on a route that accepts Operator and Admin only", () => {
    const viewer = principalFromClaims(claims({ "cognito:groups": "[Viewer]" }).jwt.claims);
    if (viewer === null) {
      throw new Error("a Viewer token must yield a principal");
    }
    expect(requireRole(viewer, ["Operator", "Admin"])).toBe(false);
  });

  it("a principal from an ID token never reaches a role check", () => {
    expect(principalFromClaims(claims({ token_use: "id" }).jwt.claims)).toBeNull();
  });
});

describe("denied access: body parser", () => {
  it("a body above 16 KiB is 413 problem before any parsing", () => {
    const oversized = "{".repeat(DEFAULT_MAX_BODY_BYTES + 1);
    const event = {
      requestContext: { requestId: "req-0004-abcdef" },
      body: oversized,
    } as unknown as APIGatewayProxyEventV2;
    const result = parseBody(event, z.object({}));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.statusCode).toBe(413);
    }
  });
});

describe("denied access: alerts routes", () => {
  /** The three routes of the alerts API, with their path parameters for the demo site. */
  const ROUTES = [
    { routeKey: "GET /sites/{siteId}/alerts", pathParameters: { siteId: SITE_ID } },
    {
      routeKey: "POST /sites/{siteId}/alerts/{alertId}/acknowledge",
      pathParameters: { siteId: SITE_ID, alertId: ALERT_ID },
    },
    {
      routeKey: "POST /sites/{siteId}/alerts/{alertId}/resolve",
      pathParameters: { siteId: SITE_ID, alertId: ALERT_ID },
    },
  ] as const;
  const ACTIONS = ROUTES.slice(1);
  const BODY = JSON.stringify({ openedAt: OPENED_AT });

  /**
   * Builds the alerts handler over a fresh world with one OPEN alert, so each row can tell whether the store was
   * reached.
   *
   * @returns The handler and the world.
   */
  function alertsHarness() {
    const world = alertsWorld();
    world.store.put(alertOf({ status: "OPEN" }));
    const handler = createAlertsHandler({
      logger: new RecordingHandlerLogger(),
      metrics: {
        count: (name) => {
          world.metrics.count(name);
        },
        publishStoredMetrics: vi.fn(),
      },
      tracer: { putAnnotation: vi.fn() },
      ports: {
        store: world.store,
        audit: world.audit,
        relay: world.relay,
        clock: world.clock,
        ids: world.deps.ids,
      },
    });
    return { handler, world };
  }

  /**
   * Asserts that a refused request reached neither the store, nor the audit, nor the relay.
   *
   * @param world - The world of the harness.
   */
  function expectNothingReached(world: ReturnType<typeof alertsWorld>): void {
    expect(world.store.getCalls).toBe(0);
    expect(world.store.listRequests).toEqual([]);
    expect(world.store.transactions).toEqual([]);
    expect(world.audit.records).toEqual([]);
    expect(world.relay.changes).toEqual([]);
  }

  /**
   * Builds a proxy event for an alerts route. The claims are those of an Operator access token, with the overrides
   * applied; an override set to `undefined` removes the claim.
   *
   * @param route - The route key and path parameters.
   * @param overrides - Claims to set over the Operator access token.
   * @returns The event.
   */
  function alertEvent(
    route: { readonly routeKey: string; readonly pathParameters: Readonly<Record<string, string>> },
    overrides: Record<string, unknown> = {},
  ): APIGatewayProxyEventV2WithJWTAuthorizer {
    return {
      routeKey: route.routeKey,
      pathParameters: route.pathParameters,
      body: BODY,
      requestContext: {
        requestId: "req-0009-abcdef",
        authorizer: { jwt: { claims: { ...ACCESS, ...overrides } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  }

  it("a Viewer is 403 on acknowledge and on resolve, and nothing is reached", async () => {
    for (const route of ACTIONS) {
      const { handler, world } = alertsHarness();
      const response = await handler(alertEvent(route, { "cognito:groups": "[Viewer]" }));
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("urn:mfc:problem:forbidden");
      expectNothingReached(world);
    }
  });

  it("a Viewer may list the alerts (200), the denied rows do not apply to the read", async () => {
    const { handler } = alertsHarness();
    const response = await handler(alertEvent(ROUTES[0], { "cognito:groups": "[Viewer]" }));
    expect(response.statusCode).toBe(200);
  });

  it("an Operator is 403 on every route of another site, before any store call", async () => {
    for (const route of ROUTES) {
      const { handler, world } = alertsHarness();
      const otherSite = {
        ...route,
        pathParameters: { ...route.pathParameters, siteId: "other-site" },
      };
      const response = await handler(alertEvent(otherSite));
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("urn:mfc:problem:forbidden");
      expectNothingReached(world);
    }
  });

  it("an ID token is 403 on every alerts route, even with a console group", async () => {
    for (const route of ROUTES) {
      const { handler, world } = alertsHarness();
      const response = await handler(alertEvent(route, { token_use: "id" }));
      expect(response.statusCode).toBe(403);
      expectNothingReached(world);
    }
  });

  it("a token with no console group is 403 on every alerts route", async () => {
    for (const route of ROUTES) {
      const { handler, world } = alertsHarness();
      const response = await handler(alertEvent(route, { "cognito:groups": undefined }));
      expect(response.statusCode).toBe(403);
      expectNothingReached(world);
    }
  });
});

describe("denied access: control routes", () => {
  /** Every control route with its path parameters for the demo site and the fixture robot. */
  const ROUTES = [
    { routeKey: "GET /sites/{siteId}/robots", pathParameters: { siteId: CONTROL_SITE } },
    {
      routeKey: "GET /sites/{siteId}/robots/{robotId}/lock",
      pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
    },
    {
      routeKey: "POST /sites/{siteId}/robots/{robotId}/lock",
      pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
    },
    {
      routeKey: "POST /sites/{siteId}/robots/{robotId}/lock/release",
      pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
    },
    {
      routeKey: "POST /sites/{siteId}/robots/{robotId}/commands",
      pathParameters: { siteId: CONTROL_SITE, robotId: CONTROL_ROBOT },
    },
    { routeKey: "GET /sites/{siteId}/demo", pathParameters: { siteId: CONTROL_SITE } },
    { routeKey: "PUT /sites/{siteId}/demo", pathParameters: { siteId: CONTROL_SITE } },
  ] as const;
  const COMMAND = ROUTES[4];
  const ACQUIRE = ROUTES[2];
  const RELEASE = ROUTES[3];
  const DEMO_PUT = ROUTES[6];
  const COMMAND_BODY = JSON.stringify({ commandId: commandIdOf(1), type: "PAUSE" });

  /**
   * Builds the control handler over a fresh world, so each row can tell whether a port was reached.
   *
   * @returns The handler and the world.
   */
  function controlHarness(): {
    handler: ReturnType<typeof createControlHandler>;
    world: ControlWorld;
  } {
    const world = controlWorld();
    const handler = createControlHandler({
      logger: new RecordingHandlerLogger(),
      metrics: {
        count: (name) => {
          world.metrics.count(name);
        },
        publishStoredMetrics: vi.fn(),
      },
      tracer: { putAnnotation: vi.fn() },
      ports: {
        locks: world.deps.locks,
        claims: world.deps.claims,
        demo: world.deps.demo,
        robots: world.deps.robots,
        publisher: world.deps.publisher,
        relay: world.deps.relay,
        audit: world.deps.audit,
        clock: world.deps.clock,
        ids: world.deps.ids,
        randomBytes: world.deps.randomBytes,
      },
    });
    return { handler, world };
  }

  /**
   * Builds a proxy event for a control route. The claims are those of an Operator access token with the overrides applied;
   * an override set to `undefined` removes the claim.
   *
   * @param route - The route key and path parameters.
   * @param body - The raw body.
   * @param overrides - Claims to set over the Operator access token.
   * @returns The event.
   */
  function controlEvent(
    route: { readonly routeKey: string; readonly pathParameters: Readonly<Record<string, string>> },
    body: string | undefined,
    overrides: Record<string, unknown> = {},
  ): APIGatewayProxyEventV2WithJWTAuthorizer {
    return {
      routeKey: route.routeKey,
      pathParameters: route.pathParameters,
      body,
      requestContext: {
        requestId: "req-0010-abcdef",
        authorizer: {
          jwt: {
            claims: {
              sub: OPERATOR_SUB,
              token_use: "access",
              client_id: "clientapp01",
              "cognito:groups": "[Operator]",
              ...overrides,
            },
          },
        },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  }

  it("viewer-command-403: a Viewer is refused on the command route, and only the refusal is audited", async () => {
    const { handler, world } = controlHarness();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const response = await handler(
      controlEvent(COMMAND, COMMAND_BODY, { "cognito:groups": "[Viewer]" }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
    expect(world.calls).toEqual(["audit.write"]);
    expect(world.publisher.published).toEqual([]);
    expect(world.audit.records).toEqual([
      expect.objectContaining({
        action: "command.pause",
        result: "REFUSED",
        problemType: "forbidden",
        commandId: commandIdOf(1),
        actor: OPERATOR_SUB,
      }),
    ]);
  });

  it("viewer-lock-403: a Viewer is refused on both lock writes, and only the refusal is audited", async () => {
    for (const route of [ACQUIRE, RELEASE]) {
      const { handler, world } = controlHarness();
      const response = await handler(
        controlEvent(route, JSON.stringify({ commandId: commandIdOf(2) }), {
          "cognito:groups": "[Viewer]",
        }),
      );
      expect(response.statusCode).toBe(403);
      expect(world.calls).toEqual(["audit.write"]);
      expect(world.audit.records).toEqual([
        expect.objectContaining({
          action: route === ACQUIRE ? "lock.acquire" : "lock.release",
          result: "REFUSED",
          problemType: "forbidden",
          robotId: route.pathParameters.robotId,
        }),
      ]);
    }
  });

  it("viewer-demo-put-403: a Viewer cannot switch the demo mode", async () => {
    const { handler, world } = controlHarness();
    const response = await handler(
      controlEvent(DEMO_PUT, JSON.stringify({ enabled: true }), { "cognito:groups": "[Viewer]" }),
    );

    expect(response.statusCode).toBe(403);
    expect(world.demo.state.enabled).toBe(false);
    expect(world.calls).toEqual([]);
  });

  it("operator-demo-put-403: an Operator cannot switch the demo mode", async () => {
    const { handler, world } = controlHarness();
    const response = await handler(controlEvent(DEMO_PUT, JSON.stringify({ enabled: true })));

    expect(response.statusCode).toBe(403);
    expect(world.demo.state.enabled).toBe(false);
    expect(world.calls).toEqual([]);
  });

  it("operator-fault-403: an Operator cannot inject a fault, even with the demo mode on", async () => {
    const { handler, world } = controlHarness();
    world.demo.state = { enabled: true };
    world.locks.put(liveLockOf(OPERATOR_SUB));
    const body = JSON.stringify({
      commandId: commandIdOf(3),
      type: "SIMULATE_FAULT",
      params: { fault: "SENSOR_FAULT" },
    });
    const response = await handler(controlEvent(COMMAND, body));

    expect(response.statusCode).toBe(403);
    expect(world.calls).toEqual(["audit.write"]);
    expect(world.publisher.published).toEqual([]);
    expect(world.audit.records).toEqual([
      expect.objectContaining({
        action: "command.simulate_fault",
        result: "REFUSED",
        problemType: "forbidden",
        commandId: commandIdOf(3),
      }),
    ]);
  });

  it("id-token-403: an ID token is refused on every control route, even with a console group", async () => {
    for (const route of ROUTES) {
      const { handler, world } = controlHarness();
      const response = await handler(controlEvent(route, undefined, { token_use: "id" }));
      expect(response.statusCode).toBe(403);
      expect(world.calls).toEqual([]);
    }
  });

  it("no-role-403: a token with no console group is refused on every control route", async () => {
    for (const route of ROUTES) {
      const { handler, world } = controlHarness();
      const response = await handler(
        controlEvent(route, undefined, { "cognito:groups": "[Intruder]" }),
      );
      expect(response.statusCode).toBe(403);
      expect(world.calls).toEqual([]);
    }
  });

  // The design names this row `no-claims-401`. The handler answers 403 for a request whose authorizer context is missing
  // or malformed: API Gateway answers 401 before the handler for a missing token, and a 403 here is the safer answer
  // for a context that reached the handler without the console role. The status is kept; only the title follows the
  // design.
  it("no-claims-401: a request without any authorizer context is refused with 403 before any port", async () => {
    const { handler, world } = controlHarness();
    const event = {
      routeKey: COMMAND.routeKey,
      pathParameters: COMMAND.pathParameters,
      body: COMMAND_BODY,
      requestContext: { requestId: "req-0011-abcdef" },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    const response = await handler(event);

    expect(response.statusCode).toBe(403);
    expect(world.calls).toEqual([]);
  });

  it("other-site-403: a site the token does not grant is refused on every control route", async () => {
    for (const route of ROUTES) {
      const { handler, world } = controlHarness();
      const otherSite = {
        ...route,
        pathParameters: { ...route.pathParameters, siteId: "other-site" },
      };
      const response = await handler(controlEvent(otherSite, '{"enabled":true}'));
      expect(response.statusCode).toBe(403);
      expect(response.body).toContain("urn:mfc:problem:forbidden");
      expect(world.calls).toEqual([]);
    }
  });

  it("unknown-route-404: a route key the API does not serve is 404, and nothing is reached", async () => {
    const { handler, world } = controlHarness();
    const response = await handler(
      controlEvent(
        {
          routeKey: "DELETE /sites/{siteId}/robots/{robotId}/lock",
          pathParameters: COMMAND.pathParameters,
        },
        undefined,
      ),
    );

    expect(response.statusCode).toBe(404);
    expect(world.calls).toEqual([]);
  });

  it("oversize-body-413: a body above the control limit is refused before parsing", async () => {
    // The demo route is Admin-only: the Admin claims let the request reach the body check.
    const cases: [(typeof ROUTES)[number], Record<string, unknown>][] = [
      [COMMAND, {}],
      [ACQUIRE, {}],
      [DEMO_PUT, { "cognito:groups": "[Admin]" }],
    ];
    for (const [route, claims] of cases) {
      const { handler, world } = controlHarness();
      const response = await handler(
        controlEvent(route, "x".repeat(CONTROL_BODY_MAX_BYTES + 1), claims),
      );
      expect(response.statusCode).toBe(413);
      expect(world.calls).toEqual([]);
    }
  });

  it("bad-body-400: a body that does not match the route schema is refused, and nothing is reached", async () => {
    const { handler, world } = controlHarness();
    const response = await handler(
      controlEvent(COMMAND, '{"commandId":"not-a-uuid","type":"PAUSE"}'),
    );

    expect(response.statusCode).toBe(400);
    expect(world.calls).toEqual([]);
  });

  it("command-without-lock-409: a command without the lock is refused with the lock-not-held problem", async () => {
    const { handler, world } = controlHarness();
    const response = await handler(controlEvent(COMMAND, COMMAND_BODY));

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("urn:mfc:problem:lock-not-held");
    expect(world.publisher.published).toEqual([]);
  });

  it("replayed-command-deduplicated: the same command identifier publishes once", async () => {
    const { handler, world } = controlHarness();
    world.locks.put(liveLockOf(OPERATOR_SUB));
    await handler(controlEvent(COMMAND, COMMAND_BODY));
    const replay = await handler(controlEvent(COMMAND, COMMAND_BODY));

    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.body ?? "null")).toMatchObject({ deduplicated: true });
    expect(world.publisher.published).toHaveLength(1);
  });

  it("replayed-estop-publishes-nothing: the e-stop replay is answered from its claim, without the lock", async () => {
    const { handler, world } = controlHarness();
    const body = JSON.stringify({ commandId: commandIdOf(4), type: "ESTOP" });
    await handler(controlEvent(COMMAND, body));
    const replay = await handler(controlEvent(COMMAND, body));

    expect(JSON.parse(replay.body ?? "null")).toMatchObject({ deduplicated: true });
    expect(world.publisher.published).toHaveLength(1);
  });

  it("replayed-lock-take-changes-nothing: a replayed take after a release does not take the lock again", async () => {
    const { handler, world } = controlHarness();
    const take = JSON.stringify({ commandId: commandIdOf(5) });
    await handler(controlEvent(ACQUIRE, take));
    await handler(controlEvent(RELEASE, JSON.stringify({ commandId: commandIdOf(6) })));
    const replay = await handler(controlEvent(ACQUIRE, take));

    expect(JSON.parse(replay.body ?? "null")).toMatchObject({
      changed: false,
      lock: { held: false },
    });
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(false);
  });

  it("replayed-lock-release-changes-nothing: a replayed release after a re-take does not release it", async () => {
    const { handler, world } = controlHarness();
    const release = JSON.stringify({ commandId: commandIdOf(7) });
    await handler(controlEvent(ACQUIRE, JSON.stringify({ commandId: commandIdOf(8) })));
    await handler(controlEvent(RELEASE, release));
    await handler(controlEvent(ACQUIRE, JSON.stringify({ commandId: commandIdOf(9) })));
    const replay = await handler(controlEvent(RELEASE, release));

    expect(JSON.parse(replay.body ?? "null")).toMatchObject({
      changed: false,
      lock: { held: true, mine: true },
    });
    expect(world.locks.items.has(CONTROL_ROBOT)).toBe(true);
  });
});
