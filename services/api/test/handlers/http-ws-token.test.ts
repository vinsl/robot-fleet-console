/**
 * The `http-ws-token` handler over in-memory ports: the token it issues, each refusal and its status, and the
 * rule that a token and a subject never reach a log entry or a response other than the token itself.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it, vi } from "vitest";

// The handler module builds its production handler at import, so the environment must exist first.
vi.hoisted(() => {
  vi.stubEnv("AWS_REGION", "eu-west-3");
  vi.stubEnv("CONNECTIONS_TABLE_NAME", "mfc-demo-connections");
  vi.stubEnv("WS_URL", "wss://abc123.execute-api.eu-west-3.amazonaws.com/live");
});
import { createHttpWsTokenHandler } from "../../src/handlers/http-ws-token";
import { FixedClock } from "../fakes/fixed";
import { RecordingHandlerLogger } from "../fakes/recording";
import { FakeWsSession } from "../fakes/ws-session";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const SUB = "00000000-0000-4000-8000-000000000001";
const URL = "wss://abc123.execute-api.eu-west-3.amazonaws.com/live";
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

/**
 * A proxy event with verified claims and a JSON body.
 *
 * @param claims - The verified claims, or `undefined` for a request without an authorizer.
 * @param body - The raw body text, or `undefined` for none.
 * @returns The event.
 */
function eventWith(
  claims: Record<string, unknown> | undefined,
  body?: string,
): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: {
      requestId: "req-wstoken-0001",
      authorizer: claims === undefined ? undefined : { jwt: { claims } },
    },
    body,
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

const GOOD_CLAIMS = {
  sub: SUB,
  token_use: "access",
  client_id: "clientapp01",
  "cognito:groups": "[Operator]",
  exp: NOW_SECONDS + 1800,
};
const GOOD_BODY = '{"siteId":"paris-01"}';

/**
 * Builds the handler over fresh fakes.
 *
 * @returns The handler, the store and the logger.
 */
function harness() {
  const store = new FakeWsSession();
  const logger = new RecordingHandlerLogger();
  const handler = createHttpWsTokenHandler({
    store,
    clock: new FixedClock(NOW),
    random: (size) => Buffer.alloc(size, 7),
    url: URL,
    logger,
  });
  return { handler, store, logger };
}

describe("POST /ws-token handler", () => {
  it("issues a token for the caller's site and stores only its hash", async () => {
    const { handler, store } = harness();
    const response = await handler(eventWith(GOOD_CLAIMS, GOOD_BODY));
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body ?? "") as {
      token: string;
      sessionExpiresAt: string;
      url: string;
    };
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.sessionExpiresAt).toBe(new Date((NOW_SECONDS + 1800) * 1000).toISOString());
    expect(body.url).toBe(URL);
    expect([...store.tokens.keys()]).not.toContain(body.token);
    expect([...store.tokens.values()][0]?.sub).toBe(SUB);
  });

  it("accepts a numeric exp sent as a string by the authorizer", async () => {
    const { handler } = harness();
    const response = await handler(
      eventWith({ ...GOOD_CLAIMS, exp: String(NOW_SECONDS + 1800) }, GOOD_BODY),
    );
    expect(response.statusCode).toBe(200);
  });

  it("refuses a request with no authorizer context with 403 and touches no store", async () => {
    const { handler, store } = harness();
    const response = await handler(eventWith(undefined, GOOD_BODY));
    expect(response.statusCode).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it("refuses a token without a subject with 403 and touches no store", async () => {
    const { handler, store } = harness();
    const response = await handler(eventWith({ ...GOOD_CLAIMS, sub: undefined }, GOOD_BODY));
    expect(response.statusCode).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it("refuses a token without an expiry with 403", async () => {
    const { handler, store } = harness();
    const response = await handler(
      eventWith(
        { sub: SUB, token_use: "access", client_id: "clientapp01", "cognito:groups": "[Operator]" },
        GOOD_BODY,
      ),
    );
    expect(response.statusCode).toBe(403);
    expect(store.calls).toEqual([]);
  });

  it("refuses a request for another site with 403 and stores nothing", async () => {
    const { handler, store } = harness();
    const response = await handler(eventWith(GOOD_CLAIMS, '{"siteId":"other-site"}'));
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
    expect(store.calls).toEqual([]);
  });

  it("refuses a body that does not match the schema with 400", async () => {
    const { handler, store } = harness();
    const response = await handler(eventWith(GOOD_CLAIMS, '{"siteId":"paris-01","extra":1}'));
    expect(response.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("refuses an oversized body with 413", async () => {
    const { handler } = harness();
    const response = await handler(eventWith(GOOD_CLAIMS, "x".repeat(16_385)));
    expect(response.statusCode).toBe(413);
  });

  it("refuses a session that already ended or lasts longer than an hour with 400", async () => {
    const { handler, store } = harness();
    const ended = await handler(eventWith({ ...GOOD_CLAIMS, exp: NOW_SECONDS - 1 }, GOOD_BODY));
    const tooLong = await handler(
      eventWith({ ...GOOD_CLAIMS, exp: NOW_SECONDS + 7200 }, GOOD_BODY),
    );
    expect(ended.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
    expect(store.calls).toEqual([]);
  });

  it("answers 500 with no internal text when the store fails, and logs no token", async () => {
    const { handler, store, logger } = harness();
    store.failure = new Error("table unavailable for abcdefghijklmnop");
    const response = await handler(eventWith(GOOD_CLAIMS, GOOD_BODY));
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("table unavailable");
    expect(JSON.stringify(logger.entries)).not.toContain(SUB);
  });

  it("never logs the issued token or the subject on success", async () => {
    const { handler, logger } = harness();
    const response = await handler(eventWith(GOOD_CLAIMS, GOOD_BODY));
    const { token } = JSON.parse(response.body ?? "") as { token: string };
    const logged = JSON.stringify(logger.entries);
    expect(logged).not.toContain(token);
    expect(logged).not.toContain(SUB);
  });
});
