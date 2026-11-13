/**
 * The `audit` handler: the outcomes of the allowed reads, the refusals of a malformed request, and the failures that
 * must not leak. The denied-access rows of the route live in `test/denied-access-admin.test.ts`.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";
import { AuditCursorSchema, AuditListResponseSchema, DEMO_SITE_ID } from "@mfc/protocol";
import { DynamoDbAuditReader, auditItem } from "../../src/adapters/dynamodb-audit";
import { createAuditHandler } from "../../src/handlers/audit";
import { auditRecordOf, auditWorld, type AuditWorld } from "../fakes/audit";
import { RecordingHandlerLogger } from "../fakes/recording";
import { documentClientStub, sendStub, type SendMock } from "../fakes/sdk-stub";

// The module builds its production handler at import, so its environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("EVENTS_TABLE_NAME", "mfc-demo-events");
});

const SUB = "00000000-0000-4000-8000-000000000001";
const ROUTE_KEY = "GET /sites/{siteId}/audit";
/** A cursor of the right grammar: the base64url of a JSON object that names the demo site. */
const VALID_CURSOR = AuditCursorSchema.parse("eyJzaXRlSWQiOiJwYXJpcy0wMSJ9");

/** Options of a request: the query string, the console group of the token, and whether the token has no group. */
interface RequestOptions {
  readonly query?: Record<string, string>;
  readonly groups?: string;
  readonly noGroups?: boolean;
  /** The site of the path, the demo site unless another is given. */
  readonly siteId?: string;
}

/** The handler under test, with the world and the logger it reaches. */
interface Harness {
  readonly handler: ReturnType<typeof createAuditHandler>;
  readonly world: AuditWorld;
  readonly logger: RecordingHandlerLogger;
}

/**
 * Builds the handler over a fresh world, with the logger kept for assertions.
 *
 * @returns The harness.
 */
function harness(): Harness {
  const world = auditWorld();
  const logger = new RecordingHandlerLogger();
  const handler = createAuditHandler({ logger, reader: world.reader });
  return { handler, world, logger };
}

/**
 * Builds a proxy event for the audit route, with the claims of an access token of the demo site.
 *
 * @param options - The request options; the token is an Operator's unless another group is given.
 * @returns The event.
 */
function eventFor(options: RequestOptions = {}): APIGatewayProxyEventV2WithJWTAuthorizer {
  const claims: Record<string, unknown> = {
    sub: SUB,
    token_use: "access",
    client_id: "clientapp01",
    "cognito:groups": options.noGroups === true ? undefined : (options.groups ?? "[Operator]"),
  };
  return {
    routeKey: ROUTE_KEY,
    pathParameters: { siteId: options.siteId ?? DEMO_SITE_ID },
    queryStringParameters: options.query,
    requestContext: {
      requestId: "req-0011-abcdef",
      authorizer: { jwt: { claims } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

describe("audit handler: allowed reads", () => {
  it("lists the trail of the site for a Viewer, with the records and the next cursor", async () => {
    const { handler, world } = harness();
    const record = auditRecordOf();
    world.reader.scriptedPage = { items: [record], invalidItems: 0, nextCursor: VALID_CURSOR };

    const response = await handler(eventFor({ groups: "[Viewer]", query: {} }));

    expect(response.statusCode).toBe(200);
    const body = AuditListResponseSchema.parse(JSON.parse(response.body ?? "{}"));
    expect(body).toEqual({ items: [record], nextCursor: VALID_CURSOR });
  });

  it("reads the default page of 50 when no limit is given", async () => {
    const { handler, world } = harness();

    await handler(eventFor({ query: {} }));

    expect(world.reader.requests).toEqual([{ siteId: DEMO_SITE_ID, limit: 50, cursor: undefined }]);
  });

  it("omits nextCursor on the last page", async () => {
    const { handler } = harness();

    const response = await handler(eventFor({ query: { limit: "10" } }));

    expect(JSON.parse(response.body ?? "{}")).toEqual({ items: [] });
  });

  it("sends no storage key name in the response", async () => {
    const { handler, world } = harness();
    world.reader.scriptedPage = { items: [auditRecordOf()], invalidItems: 0 };

    const response = await handler(eventFor({ query: {} }));

    expect(response.body).not.toMatch(/openAlert|"pk"|"sk"|expiresAt|byRobot|SITE#/);
  });
});

describe("audit handler: filters", () => {
  it("passes the robot and the outcome to the reader, for a Viewer", async () => {
    const { handler, world } = harness();

    const response = await handler(
      eventFor({ groups: "[Viewer]", query: { robotId: "sim-03", result: "REFUSED" } }),
    );

    expect(response.statusCode).toBe(200);
    expect(world.reader.requests).toEqual([
      { siteId: DEMO_SITE_ID, limit: 50, cursor: undefined, robotId: "sim-03", result: "REFUSED" },
    ]);
  });

  it.each([
    ["an unknown outcome", { result: "OOPS" }],
    ["a lower-case outcome", { result: "refused" }],
    ["a robot identifier with a space", { robotId: "SIM 01" }],
    ["an empty robot identifier", { robotId: "" }],
  ])("refuses %s with 400, and reads nothing", async (_label, query) => {
    const { handler, world } = harness();

    const response = await handler(eventFor({ query }));

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("urn:mfc:problem:invalid-request");
    expect(world.reader.requests).toEqual([]);
  });

  it("refuses a caller with no console role and filters set, with 403, and reads nothing", async () => {
    const { handler, world } = harness();

    const response = await handler(
      eventFor({ noGroups: true, query: { robotId: "sim-01", result: "REFUSED" } }),
    );

    expect(response.statusCode).toBe(403);
    expect(world.reader.requests).toEqual([]);
  });

  it("refuses a token of another site with filters set, with 403, before the query is read", async () => {
    const { handler, world } = harness();

    const response = await handler(
      eventFor({ siteId: "other-site", query: { robotId: "sim-01", result: "OOPS" } }),
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
    expect(world.reader.requests).toEqual([]);
  });
});

describe("audit handler: refusals of the request", () => {
  it("refuses a limit below 1 or above 100 with 400, and reads nothing", async () => {
    for (const limit of ["0", "101", "1.5", "many"]) {
      const { handler, world } = harness();
      const response = await handler(eventFor({ query: { limit } }));
      expect(response.statusCode).toBe(400);
      expect(world.reader.requests).toEqual([]);
    }
  });

  it("accepts the bounds 1 and 100", async () => {
    for (const limit of ["1", "100"]) {
      const { handler, world } = harness();
      const response = await handler(eventFor({ query: { limit } }));
      expect(response.statusCode).toBe(200);
      expect(world.reader.requests[0]?.limit).toBe(Number(limit));
    }
  });

  it("refuses a filter the API does not offer, with 400, because the query is strict", async () => {
    const { handler, world } = harness();

    const response = await handler(eventFor({ query: { actor: "x" } }));

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("urn:mfc:problem:invalid-request");
    expect(world.reader.requests).toEqual([]);
  });

  it("bad cursor 400: a cursor outside the cursor grammar is answered 400 before any read", async () => {
    const { handler, world } = harness();

    const response = await handler(eventFor({ query: { cursor: "not a cursor!" } }));

    expect(response.statusCode).toBe(400);
    expect(world.reader.requests).toEqual([]);
  });

  it("a cursor the reader refuses is answered 400 with no echo of the cursor", async () => {
    const { handler, world, logger } = harness();
    world.reader.refuseCursor();

    const response = await handler(eventFor({ query: { cursor: VALID_CURSOR } }));

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("urn:mfc:problem:invalid-request");
    expect(response.body).not.toContain(VALID_CURSOR);
    expect(logger.text()).not.toContain(VALID_CURSOR);
  });

  it("cursor of another site 400: the reader is asked for this site, and its refusal is a 400", async () => {
    const { handler, world } = harness();
    world.reader.refuseCursor();

    const response = await handler(eventFor({ query: { cursor: VALID_CURSOR } }));

    expect(response.statusCode).toBe(400);
    expect(world.reader.requests).toEqual([
      { siteId: DEMO_SITE_ID, limit: 50, cursor: VALID_CURSOR },
    ]);
  });
});

describe("audit handler: cursors through the real reader", () => {
  const KEY_NAME_PATTERN = /openAlertPk|openAlertSk|"pk"|"sk"|"kind"|expiresAt|byRobot|SITE#/;

  /**
   * Builds the handler over the DynamoDB reader and a stubbed client, so that a refused cursor is shown to end as a
   * 400 with no query sent, and that the cursors of a page carry no storage key name.
   *
   * @returns The handler and the stubbed client's send mock.
   */
  function realReaderHarness(): { handler: ReturnType<typeof createAuditHandler>; send: SendMock } {
    const send = sendStub();
    const reader = new DynamoDbAuditReader(documentClientStub(send), "mfc-demo-events");
    const logger = new RecordingHandlerLogger();
    return { handler: createAuditHandler({ logger, reader }), send };
  }

  /**
   * Encodes a cursor payload as the client would send it, bypassing the adapter's own encoder.
   *
   * @param payload - The JSON payload.
   * @returns The cursor, of the protocol grammar.
   */
  function cursorOf(payload: Record<string, unknown>): string {
    return AuditCursorSchema.parse(
      Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    );
  }

  it("answers 400 and sends no query for a tampered cursor, a foreign site or an extra storage key", async () => {
    const tampered = cursorOf({
      siteId: DEMO_SITE_ID,
      ts: "yesterday",
      auditId: "0190a0a0-0000-7000-8000-000000000001",
    });
    const extraKey = cursorOf({
      siteId: DEMO_SITE_ID,
      ts: "2026-11-02T10:00:00.000Z",
      auditId: "0190a0a0-0000-7000-8000-000000000001",
      pk: `SITE#${DEMO_SITE_ID}`,
    });
    const foreign = cursorOf({
      siteId: "other-site",
      ts: "2026-11-02T10:00:00.000Z",
      auditId: "0190a0a0-0000-7000-8000-000000000001",
    });

    for (const cursor of [tampered, extraKey, foreign]) {
      const { handler, send } = realReaderHarness();

      const response = await handler(eventFor({ query: { cursor } }));

      expect(response.statusCode).toBe(400);
      expect(response.body).toContain("urn:mfc:problem:invalid-request");
      expect(response.body).not.toContain(cursor);
      expect(send).not.toHaveBeenCalled();
    }
  });

  it("answers 400 and sends no query for a tampered cursor sent with a filter", async () => {
    const { handler, send } = realReaderHarness();
    const cursor = cursorOf({
      siteId: DEMO_SITE_ID,
      ts: "2026-11-02T10:00:00.000Z",
      auditId: "0190a0a0-0000-7000-8000-000000000001",
      pk: `SITE#${DEMO_SITE_ID}`,
    });

    const response = await handler(eventFor({ query: { cursor, robotId: "sim-01" } }));

    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain(cursor);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends no DynamoDB key name in the page or in its next cursor", async () => {
    const { handler, send } = realReaderHarness();
    const item = auditItem(auditRecordOf());
    const lastKey = {
      pk: item.pk,
      sk: item.sk,
      openAlertPk: item.openAlertPk,
      openAlertSk: item.openAlertSk,
    };
    send.mockResolvedValueOnce({ Items: [item], LastEvaluatedKey: lastKey });

    const response = await handler(eventFor({ query: { limit: "1" } }));

    expect(response.statusCode).toBe(200);
    const body = AuditListResponseSchema.parse(JSON.parse(response.body ?? "{}"));
    expect(response.body).not.toMatch(KEY_NAME_PATTERN);
    const nextCursor = body.nextCursor ?? "";
    expect(
      Object.keys(
        JSON.parse(Buffer.from(nextCursor, "base64url").toString("utf8")) as object,
      ).sort(),
    ).toEqual(["auditId", "siteId", "ts"]);
    expect(Buffer.from(nextCursor, "base64url").toString("utf8")).not.toMatch(KEY_NAME_PATTERN);
  });
});

describe("audit handler: failures", () => {
  it("answers 500 with no internal text when the reader fails", async () => {
    const { handler, world, logger } = harness();
    world.reader.error = new Error("arn:aws:dynamodb:eu-west-3:123456789012:table/mfc-demo-events");

    const response = await handler(eventFor({ query: {} }));

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("urn:mfc:problem:internal");
    expect(response.body).not.toContain("123456789012");
    expect(logger.text()).not.toContain("123456789012");
  });

  it("never logs the subject of a refused token", async () => {
    const { handler, logger } = harness();

    await handler(eventFor({ noGroups: true, query: {} }));

    expect(logger.text()).not.toContain(SUB);
  });
});
