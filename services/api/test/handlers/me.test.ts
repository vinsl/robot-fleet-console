/**
 * The `me` handler over an in-memory logger: the identity it returns, the refusals, and log hygiene.
 *
 * The subject is personal data in the sense of the logs policy, so no log entry may contain it.
 */
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { describe, expect, it } from "vitest";
import { createMeHandler, type MeHandlerDeps } from "../../src/handlers/me";
import { RecordingHandlerLogger } from "../fakes/recording";

const SUB = "00000000-0000-4000-8000-000000000001";
const CORRELATION = "req-0001-abcdef";

/**
 * Builds a proxy event carrying the given authorizer context.
 *
 * @param authorizer - The authorizer context, or `undefined` for a request without one.
 * @returns The event, with only the fields the handler reads.
 */
function eventWith(authorizer: unknown): APIGatewayProxyEventV2WithJWTAuthorizer {
  return {
    requestContext: { requestId: CORRELATION, authorizer },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

/**
 * Builds the handler over a fresh recording logger.
 *
 * @param logger - The logger to use.
 * @returns The handler.
 */
function handlerWith(logger: RecordingHandlerLogger) {
  const deps: MeHandlerDeps = { logger };
  return createMeHandler(deps);
}

describe("GET /me handler", () => {
  it("returns the identity of an Operator", () => {
    const logger = new RecordingHandlerLogger();
    const response = handlerWith(logger)(
      eventWith({
        jwt: {
          claims: {
            sub: SUB,
            token_use: "access",
            client_id: "clientapp01",
            "cognito:groups": "[Operator]",
          },
        },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body ?? "")).toEqual({
      userId: SUB,
      role: "Operator",
      siteId: "paris-01",
    });
  });

  it("refuses a request with no authorizer context with 403 forbidden", () => {
    const response = handlerWith(new RecordingHandlerLogger())(eventWith(undefined));
    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("urn:mfc:problem:forbidden");
  });

  it("refuses a token whose only group is unknown with 403 and no claim in the body", () => {
    const response = handlerWith(new RecordingHandlerLogger())(
      eventWith({
        jwt: {
          claims: {
            sub: SUB,
            token_use: "access",
            client_id: "clientapp01",
            "cognito:groups": "[Intruder]",
          },
        },
      }),
    );
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain(SUB);
  });

  it("logs the refusal without the subject", () => {
    const logger = new RecordingHandlerLogger();
    handlerWith(logger)(
      eventWith({
        jwt: {
          claims: {
            sub: SUB,
            token_use: "access",
            client_id: "clientapp01",
            "cognito:groups": "[Intruder]",
          },
        },
      }),
    );
    expect(logger.entries.map((entry) => entry.message)).toContain("identity refused");
    expect(JSON.stringify(logger.entries)).not.toContain(SUB);
  });

  it("answers 500 with no internal text when the logger fails", () => {
    const logger = new RecordingHandlerLogger();
    logger.warn = () => {
      throw new Error("logger unavailable at 10.0.0.1");
    };
    const response = handlerWith(logger)(eventWith({ jwt: { claims: {} } }));
    expect(response.statusCode).toBe(500);
    expect(response.body).toContain("urn:mfc:problem:internal");
    expect(response.body).not.toContain("10.0.0.1");
  });

  it("removes the correlation identifier from the logger when it ends", () => {
    const logger = new RecordingHandlerLogger();
    handlerWith(logger)(
      eventWith({
        jwt: {
          claims: {
            sub: SUB,
            token_use: "access",
            client_id: "clientapp01",
            "cognito:groups": "[Admin]",
          },
        },
      }),
    );
    expect(logger.keys.has("correlationId")).toBe(false);
  });
});
