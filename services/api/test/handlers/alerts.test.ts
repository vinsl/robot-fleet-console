/**
 * The `alerts` handler: the outcomes of the allowed requests, the refusals and the failures that must not leak. The
 * denied-access rows of every route live in `test/denied-access.test.ts`; this file covers the paths of each route.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import {
  AlertActionResponseSchema,
  AlertListResponseSchema,
  DEMO_SITE_ID,
  type AlertId,
  type AuditRecord,
} from "@mfc/protocol";
import { DEFAULT_MAX_BODY_BYTES } from "../../src/adapters/http";
import { AlertCursorError } from "../../src/domain/alerts/ports";
import { createAlertsHandler, type AlertsHandlerDeps } from "../../src/handlers/alerts";
import { RecordingHandlerLogger } from "../fakes/recording";
import {
  ALERT_ID,
  alertOf,
  alertsWorld,
  OPENED_AT,
  SITE_ID,
  type AlertsWorld,
} from "../fakes/alerts";

// The module builds its production handler at import, so its environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("FLEET_TABLE_NAME", "mfc-demo-fleet");
  vi.stubEnv("EVENTS_TABLE_NAME", "mfc-demo-events");
  vi.stubEnv("CONNECTIONS_TABLE_NAME", "mfc-demo-connections");
  vi.stubEnv(
    "WS_MANAGEMENT_ENDPOINT",
    "https://abc123xyz.execute-api.eu-west-3.amazonaws.com/live",
  );
});

const SUB = "00000000-0000-4000-8000-000000000001";
const OTHER_SITE = "other-site";
/** An identifier of the right shape that no stored alert has. */
const OTHER_ALERT_ID: AlertId = "fedcba9876543210fedcba9876543210";

/** The route keys of the alerts API, with their path parameters for the demo site and the fixture alert. */
const LIST = {
  routeKey: "GET /sites/{siteId}/alerts",
  pathParameters: { siteId: SITE_ID },
};
const ACKNOWLEDGE = {
  routeKey: "POST /sites/{siteId}/alerts/{alertId}/acknowledge",
  pathParameters: { siteId: SITE_ID, alertId: ALERT_ID },
};
const RESOLVE = {
  routeKey: "POST /sites/{siteId}/alerts/{alertId}/resolve",
  pathParameters: { siteId: SITE_ID, alertId: ALERT_ID },
};

/** A route as a request names it. */
interface RouteDef {
  readonly routeKey: string;
  readonly pathParameters: Record<string, string>;
}

/** Options of a request: body, query string, token type, and a site that replaces the path site. */
interface RequestOptions {
  readonly body?: string;
  readonly query?: Record<string, string>;
  readonly tokenUse?: string;
  readonly siteOverride?: string;
}

/** Test harness: the handler over an in-memory world, with the fakes kept for assertions. */
interface Harness {
  readonly handler: ReturnType<typeof createAlertsHandler>;
  readonly world: AlertsWorld;
  readonly logger: RecordingHandlerLogger;
  readonly publishStoredMetrics: ReturnType<typeof vi.fn>;
}

/**
 * Builds the handler over a fresh world, with one OPEN alert stored.
 *
 * @returns The handler and what it reaches.
 */
function harness(): Harness {
  const world = alertsWorld();
  world.store.put(alertOf({ status: "OPEN" }));
  const logger = new RecordingHandlerLogger();
  const publishStoredMetrics = vi.fn();
  const metrics: AlertsHandlerDeps["metrics"] = {
    count: (name) => {
      world.metrics.count(name);
    },
    publishStoredMetrics,
  };
  const handler = createAlertsHandler({
    logger,
    metrics,
    tracer: { putAnnotation: vi.fn() },
    ports: {
      store: world.store,
      audit: world.audit,
      relay: world.relay,
      clock: world.clock,
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
 * @param options - The optional body, query, token type and site override.
 * @returns The event.
 */
function eventFor(
  route: RouteDef,
  groups: string | undefined,
  options: RequestOptions = {},
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
    queryStringParameters: options.query,
    requestContext: {
      requestId: "req-0008-abcdef",
      authorizer: { jwt: { claims } },
    },
    body: options.body,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/**
 * The audit records committed with the alert transactions. A transition writes its audit record in the same
 * transaction, so the fake keeps it with the transition rather than in the audit port.
 *
 * @param world - The world of the harness.
 * @returns The audit records of the applied transitions, in order.
 */
function committedAudits(world: AlertsWorld): AuditRecord[] {
  return world.store.transactions.map((entry) => entry.transition.audit);
}

/** A body that acknowledges or resolves the fixture alert. */
const ACTION_BODY = JSON.stringify({ openedAt: OPENED_AT });

/**
 * Parses the body of a response as JSON, without trusting its shape.
 *
 * @param body - The raw body text.
 * @returns The decoded value, typed unknown.
 */
function jsonOf(body: string | undefined): unknown {
  return JSON.parse(body ?? "null") as unknown;
}

describe("GET /sites/{siteId}/alerts", () => {
  it("lists the active alerts for a Viewer and answers with the protocol shape", async () => {
    const { handler, world } = harness();
    world.store.page = { alerts: [alertOf({ status: "OPEN" })], invalidItems: 0 };

    const response = await handler(eventFor(LIST, "[Viewer]"), {
      getRemainingTimeInMillis: () => 5000,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers?.["x-correlation-id"]).toBe("req-0008-abcdef");
    expect(AlertListResponseSchema.safeParse(jsonOf(response.body)).success).toBe(true);
    expect(world.store.listRequests).toEqual([
      expect.objectContaining({ siteId: DEMO_SITE_ID, status: "active", limit: 50 }),
    ]);
  });

  it("passes the resolved filters and the cursor to the store", async () => {
    const { handler, world } = harness();

    const response = await handler(
      eventFor(LIST, "[Operator]", {
        query: {
          status: "resolved",
          severity: "MAJOR",
          robotId: "sim-03",
          since: OPENED_AT,
          limit: "10",
        },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(world.store.listRequests).toEqual([
      expect.objectContaining({
        status: "resolved",
        severity: "MAJOR",
        robotId: "sim-03",
        since: OPENED_AT,
        limit: 10,
      }),
    ]);
  });

  it("answers 400 without a store call when the limit is above the maximum", async () => {
    const { handler, world } = harness();
    const response = await handler(eventFor(LIST, "[Viewer]", { query: { limit: "500" } }));
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("urn:mfc:problem:invalid-request");
    expect(world.store.listRequests).toEqual([]);
  });

  it("answers 400 without a store call when since is given for active alerts", async () => {
    const { handler, world } = harness();
    const response = await handler(eventFor(LIST, "[Viewer]", { query: { since: OPENED_AT } }));
    expect(response.statusCode).toBe(400);
    expect(world.store.listRequests).toEqual([]);
  });

  it("answers 400 without a store call on a parameter the schema does not know", async () => {
    const { handler, world } = harness();
    const response = await handler(eventFor(LIST, "[Viewer]", { query: { sort: "severity" } }));
    expect(response.statusCode).toBe(400);
    expect(world.store.listRequests).toEqual([]);
  });

  it("answers 400 when the cursor does not belong to this site and status", async () => {
    const { handler, world } = harness();
    world.store.listError = new AlertCursorError();

    const response = await handler(eventFor(LIST, "[Viewer]", { query: { cursor: "AAAA" } }));

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("urn:mfc:problem:invalid-request");
  });
});

describe("POST acknowledge and resolve", () => {
  it("acknowledges an OPEN alert for an Operator, relays the change and audits it", async () => {
    const { handler, world } = harness();

    const response = await handler(eventFor(ACKNOWLEDGE, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(200);
    expect(response.headers?.["x-correlation-id"]).toBe("req-0008-abcdef");
    const body = AlertActionResponseSchema.parse(jsonOf(response.body));
    expect(body).toMatchObject({
      changed: true,
      alert: { status: "ACKNOWLEDGED", acknowledgedBy: SUB },
    });
    expect(world.relay.changes.map((change) => change.change)).toEqual(["ACKNOWLEDGED"]);
    expect(committedAudits(world)).toEqual([
      expect.objectContaining({ action: "alert.acknowledge", actor: SUB, result: "SUCCEEDED" }),
    ]);
    expect(world.metrics.value("AlertAcknowledged")).toBe(1);
  });

  it("resolves an acknowledged alert for an Admin", async () => {
    const { handler, world } = harness();
    world.store.put(
      alertOf({ status: "ACKNOWLEDGED", acknowledgedBy: SUB, acknowledgedAt: OPENED_AT }),
    );

    const response = await handler(eventFor(RESOLVE, "[Admin]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(200);
    expect(AlertActionResponseSchema.parse(jsonOf(response.body)).alert.status).toBe("RESOLVED");
    expect(world.relay.changes.map((change) => change.change)).toEqual(["RESOLVED"]);
    expect(committedAudits(world).map((record) => record.action)).toEqual(["alert.resolve"]);
  });

  it("answers 200 with changed false when the alert is already acknowledged, without audit or relay", async () => {
    const { handler, world } = harness();
    world.store.put(
      alertOf({ status: "ACKNOWLEDGED", acknowledgedBy: SUB, acknowledgedAt: OPENED_AT }),
    );

    const response = await handler(eventFor(ACKNOWLEDGE, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(200);
    expect(AlertActionResponseSchema.parse(jsonOf(response.body)).changed).toBe(false);
    expect(world.audit.records).toEqual([]);
    expect(world.relay.changes).toEqual([]);
  });

  it("answers 409 alert-state-conflict when resolving an OPEN alert", async () => {
    const { handler, world } = harness();

    const response = await handler(eventFor(RESOLVE, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("urn:mfc:problem:alert-state-conflict");
    expect(world.store.transactions).toEqual([]);
  });

  it("answers 409 when the alert is already resolved", async () => {
    const { handler, world } = harness();
    world.store.put(
      alertOf({
        status: "RESOLVED",
        acknowledgedBy: SUB,
        acknowledgedAt: OPENED_AT,
        resolvedBy: SUB,
        resolvedAt: OPENED_AT,
      }),
    );

    const response = await handler(eventFor(ACKNOWLEDGE, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("urn:mfc:problem:alert-state-conflict");
  });

  it("answers 409 when the alert changes twice under the action", async () => {
    const { handler, world } = harness();
    world.store.conflictNext();
    world.store.conflictNext();

    const response = await handler(eventFor(ACKNOWLEDGE, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("urn:mfc:problem:alert-state-conflict");
    expect(world.relay.changes).toEqual([]);
  });

  it("answers 404 alert-not-found and writes no audit record when no alert matches", async () => {
    const { handler, world } = harness();
    const missing = {
      ...ACKNOWLEDGE,
      pathParameters: { siteId: SITE_ID, alertId: OTHER_ALERT_ID },
    };

    const response = await handler(eventFor(missing, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain("urn:mfc:problem:alert-not-found");
    expect(world.audit.records).toEqual([]);
    expect(world.metrics.value("AlertNotFound")).toBe(1);
  });

  it("answers 400 without a store call when the body carries a status (mass assignment)", async () => {
    const { handler, world } = harness();
    const body = JSON.stringify({ openedAt: OPENED_AT, status: "RESOLVED" });

    const response = await handler(eventFor(ACKNOWLEDGE, "[Operator]", { body }));

    expect(response.statusCode).toBe(400);
    expect(world.store.getCalls).toBe(0);
    expect(world.store.transactions).toEqual([]);
  });

  it("answers 400 without a store call when the body is not JSON", async () => {
    const { handler, world } = harness();
    const response = await handler(eventFor(RESOLVE, "[Operator]", { body: "not json" }));
    expect(response.statusCode).toBe(400);
    expect(world.store.getCalls).toBe(0);
  });

  it("answers 413 without a store call when the body is above the limit", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor(RESOLVE, "[Operator]", { body: "x".repeat(DEFAULT_MAX_BODY_BYTES + 1) }),
    );
    expect(response.statusCode).toBe(413);
    expect(world.store.getCalls).toBe(0);
  });

  it("answers 400 for a malformed alert identifier in the path, without a store call", async () => {
    const { handler, world } = harness();
    const malformed = {
      ...ACKNOWLEDGE,
      pathParameters: { siteId: SITE_ID, alertId: "NOT-AN-ALERT-ID" },
    };

    const response = await handler(eventFor(malformed, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(400);
    expect(world.store.getCalls).toBe(0);
  });

  it("answers 404 for a route key the API does not serve", async () => {
    const { handler } = harness();
    const response = await handler(
      eventFor(
        { routeKey: "DELETE /sites/{siteId}/alerts", pathParameters: { siteId: SITE_ID } },
        "[Admin]",
      ),
    );
    expect(response.statusCode).toBe(404);
  });

  it("answers 403 for an action on another site before any store call", async () => {
    const { handler, world } = harness();
    const response = await handler(
      eventFor(ACKNOWLEDGE, "[Operator]", { body: ACTION_BODY, siteOverride: OTHER_SITE }),
    );
    expect(response.statusCode).toBe(403);
    expect(world.store.getCalls).toBe(0);
  });

  it("skips the relay when less than 1.5 s remain, and still answers 200", async () => {
    const { handler, world } = harness();

    const response = await handler(eventFor(ACKNOWLEDGE, "[Operator]", { body: ACTION_BODY }), {
      getRemainingTimeInMillis: () => 1000,
    });

    expect(response.statusCode).toBe(200);
    expect(world.relay.changes).toEqual([]);
    expect(world.metrics.value("AlertRelaySkipped")).toBe(1);
  });

  it("answers 500 with no internal text when the store fails, and clears the log keys", async () => {
    const { handler, world, logger, publishStoredMetrics } = harness();
    world.store.getError = new Error(
      "ProvisionedThroughputExceeded arn:aws:dynamodb:eu-west-3:123456789012:table/x",
    );

    const response = await handler(eventFor(ACKNOWLEDGE, "[Operator]", { body: ACTION_BODY }));

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("urn:mfc:problem:internal");
    expect(response.body).not.toContain("ProvisionedThroughput");
    expect(response.body).not.toContain("123456789012");
    expect(logger.keys.size).toBe(0);
    expect(publishStoredMetrics).toHaveBeenCalledTimes(1);
  });
});
