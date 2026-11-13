/**
 * Denied-access rows of the admin API routes (SEC-DAST-1), starting with the audit read. Each refused request must
 * answer its problem and must reach no port: the fake reader records every read, and a refused request leaves that
 * record empty.
 *
 * A refusal without claims is `403`, not `401`: the JWT authorizer of API Gateway already refuses a request without a
 * valid token, and the handlers answer `403` for a token that grants no console role, as the other functions do.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { DEMO_SITE_ID } from "@mfc/protocol";
import { createAuditHandler } from "../src/handlers/audit";
import { auditWorld, type AuditWorld } from "./fakes/audit";
import { RecordingHandlerLogger } from "./fakes/recording";

// The audit module builds its production handler at import, so its environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("EVENTS_TABLE_NAME", "mfc-demo-events");
});

const SUB = "00000000-0000-4000-8000-000000000002";
const ROUTE = {
  routeKey: "GET /sites/{siteId}/audit",
  pathParameters: { siteId: DEMO_SITE_ID },
} as const;

/**
 * Builds the handler over a fresh world, so each row can tell whether the reader was reached.
 *
 * @returns The handler and the world.
 */
function auditHarness(): { handler: ReturnType<typeof createAuditHandler>; world: AuditWorld } {
  const world = auditWorld();
  const handler = createAuditHandler({
    logger: new RecordingHandlerLogger(),
    reader: world.reader,
  });
  return { handler, world };
}

/**
 * Builds a proxy event for the audit route. The claims are those of an Operator access token, with the overrides
 * applied; an override set to `undefined` removes the claim.
 *
 * @param overrides - Claims to set over the Operator access token.
 * @param route - The route key and path parameters.
 * @returns The event.
 */
function auditEvent(
  overrides: Record<string, unknown> = {},
  route: {
    readonly routeKey: string;
    readonly pathParameters: Readonly<Record<string, string>>;
  } = ROUTE,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    routeKey: route.routeKey,
    pathParameters: route.pathParameters,
    queryStringParameters: {},
    requestContext: {
      requestId: "req-0012-abcdef",
      authorizer: {
        jwt: {
          claims: {
            sub: SUB,
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

describe("denied access: GET /sites/{siteId}/audit", () => {
  it("without claims is 403 and the reader is not reached", async () => {
    const { handler, world } = auditHarness();
    const response = await handler({
      routeKey: ROUTE.routeKey,
      pathParameters: ROUTE.pathParameters,
      requestContext: { requestId: "req-0013-abcdef", authorizer: undefined },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
    expect(world.reader.requests).toEqual([]);
  });

  it("with an ID token is 403, even when the ID token carries a console group", async () => {
    const { handler, world } = auditHarness();

    const response = await handler(auditEvent({ token_use: "id" }));

    expect(response.statusCode).toBe(403);
    expect(world.reader.requests).toEqual([]);
  });

  it("with no console group is 403 and the reader is not reached", async () => {
    const { handler, world } = auditHarness();

    const response = await handler(auditEvent({ "cognito:groups": undefined }));

    expect(response.statusCode).toBe(403);
    expect(world.reader.requests).toEqual([]);
  });

  it("with an unknown group is 403 and the reader is not reached", async () => {
    const { handler, world } = auditHarness();

    const response = await handler(auditEvent({ "cognito:groups": "[Intruder]" }));

    expect(response.statusCode).toBe(403);
    expect(world.reader.requests).toEqual([]);
  });

  it("for another site is 403 and the reader is not reached", async () => {
    const { handler, world } = auditHarness();

    const response = await handler(
      auditEvent({}, { routeKey: ROUTE.routeKey, pathParameters: { siteId: "other-site" } }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
    expect(world.reader.requests).toEqual([]);
  });

  it("on an unknown route is 404 and the reader is not reached", async () => {
    const { handler, world } = auditHarness();

    const response = await handler(
      auditEvent(
        {},
        { routeKey: "DELETE /sites/{siteId}/audit", pathParameters: { siteId: DEMO_SITE_ID } },
      ),
    );

    expect(response.statusCode).toBe(404);
    expect(world.reader.requests).toEqual([]);
  });

  it("with a malformed site in the path is 400 and the reader is not reached", async () => {
    const { handler, world } = auditHarness();

    const response = await handler(
      auditEvent({}, { routeKey: ROUTE.routeKey, pathParameters: { siteId: "Paris 01" } }),
    );

    expect(response.statusCode).toBe(400);
    expect(world.reader.requests).toEqual([]);
  });
});
