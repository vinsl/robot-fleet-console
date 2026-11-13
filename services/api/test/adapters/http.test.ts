/**
 * HTTP helpers: the shape of responses, the problem contract, the correlation identifier and the body limits.
 *
 * The problem body must hold the fixed title and the correlation identifier only. Each refusal of the body
 * parser is checked for the status it returns and for the absence of the rejected value.
 */
import { PROBLEM_TYPES, ProblemSchema } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  DEFAULT_MAX_BODY_BYTES,
  getCorrelationId,
  issuesOf,
  JwtAuthorizerSchema,
  jsonResponse,
  parseBody,
  problemResponse,
} from "../../src/adapters/http";

const CORRELATION = "req-0001-abcdef";

/**
 * Builds a proxy event that carries only the fields the helpers read.
 *
 * @param overrides - The request id, body and base64 flag.
 * @returns The event.
 */
function eventWith(overrides: {
  requestId?: string;
  body?: string;
  isBase64Encoded?: boolean;
}): APIGatewayProxyEventV2 {
  return {
    requestContext: { requestId: overrides.requestId ?? CORRELATION },
    body: overrides.body,
    isBase64Encoded: overrides.isBase64Encoded ?? false,
  } as unknown as APIGatewayProxyEventV2;
}

const BodySchema = z.strictObject({ siteId: z.string().min(1) });

describe("problemResponse titles", () => {
  it.each(PROBLEM_TYPES)(
    "gives %s a fixed title and a body that satisfies the problem schema",
    (type) => {
      const response = problemResponse(type, 400, CORRELATION);
      const problem = ProblemSchema.parse(JSON.parse(response.body ?? ""));
      expect(problem.type).toBe(`urn:mfc:problem:${type}`);
      expect(problem.title).not.toBe(type);
      expect(problem.title.length).toBeGreaterThan(0);
    },
  );
});

describe("problemResponse", () => {
  it("answers with the problem media type and no caching", () => {
    const response = problemResponse("forbidden", 403, CORRELATION);
    expect(response.statusCode).toBe(403);
    expect(response.headers).toMatchObject({
      "content-type": "application/problem+json",
      "cache-control": "no-store",
    });
  });

  it("carries exactly the RFC 7807 fields with a fixed title", () => {
    const body: unknown = JSON.parse(problemResponse("forbidden", 403, CORRELATION).body ?? "");
    expect(body).toEqual({
      type: "urn:mfc:problem:forbidden",
      title: "Forbidden",
      status: 403,
      correlationId: CORRELATION,
    });
  });

  it("includes the detail only when one is given", () => {
    const body: unknown = JSON.parse(
      problemResponse("invalid-request", 400, CORRELATION, "Fixed sentence.").body ?? "",
    );
    expect(body).toMatchObject({ detail: "Fixed sentence." });
  });

  it("never carries a stack trace, a message from an exception, or a second correlation identifier", () => {
    const text = problemResponse("internal", 500, CORRELATION).body ?? "";
    expect(text).not.toMatch(/stack|at .*\(|Error|Exception/);
    expect(text.match(/correlationId/g)).toHaveLength(1);
  });

  it("refuses a status outside the error range", () => {
    expect(() => problemResponse("internal", 200, CORRELATION)).toThrow();
  });
});

describe("jsonResponse", () => {
  it("serialises the body with the JSON media type and the correlation header", () => {
    const response = jsonResponse(200, { ok: true }, CORRELATION);
    expect(response).toEqual({
      statusCode: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-correlation-id": CORRELATION,
      },
      body: '{"ok":true}',
    });
  });
});

describe("getCorrelationId", () => {
  it("uses the API Gateway request id when it follows the identifier grammar", () => {
    expect(getCorrelationId(eventWith({ requestId: "c6af9ac6-7b61-11e6-9a41" }))).toBe(
      "c6af9ac6-7b61-11e6-9a41",
    );
  });

  it("replaces a request id outside the grammar with a fresh identifier", () => {
    const id = getCorrelationId(eventWith({ requestId: "bad id!" }));
    expect(id).toMatch(/^[A-Za-z0-9-]{8,64}$/);
    expect(id).not.toBe("bad id!");
  });
});

describe("parseBody", () => {
  it("returns the parsed body when it matches the schema", () => {
    const result = parseBody(eventWith({ body: '{"siteId":"paris-01"}' }), BodySchema);
    expect(result).toEqual({ ok: true, data: { siteId: "paris-01" } });
  });

  it("decodes a base64 body", () => {
    const encoded = Buffer.from('{"siteId":"paris-01"}', "utf8").toString("base64");
    const result = parseBody(eventWith({ body: encoded, isBase64Encoded: true }), BodySchema);
    expect(result.ok).toBe(true);
  });

  it("refuses a missing body with 400 invalid-request", () => {
    const result = parseBody(eventWith({}), BodySchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.statusCode).toBe(400);
    }
  });

  it("refuses malformed JSON with 400 and does not echo it", () => {
    const result = parseBody(eventWith({ body: "{not json secret-value" }), BodySchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.statusCode).toBe(400);
      expect(result.response.body).not.toContain("secret-value");
    }
  });

  it("refuses a body that does not match the schema without echoing the value", () => {
    const result = parseBody(
      eventWith({ body: '{"siteId":"","extra":"leaked-value"}' }),
      BodySchema,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.statusCode).toBe(400);
      expect(result.response.body).not.toContain("leaked-value");
    }
  });

  it("refuses an oversized body with 413 before it parses the JSON", () => {
    const oversized = "x".repeat(DEFAULT_MAX_BODY_BYTES + 1);
    const result = parseBody(eventWith({ body: oversized }), BodySchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.statusCode).toBe(413);
      expect(result.response.body).toContain("urn:mfc:problem:payload-too-large");
    }
  });

  it("accepts a body of exactly the limit", () => {
    const padding = "a".repeat(DEFAULT_MAX_BODY_BYTES - '{"siteId":"paris-01","p":""}'.length);
    const body = `{"siteId":"paris-01","p":"${padding}"}`;
    expect(Buffer.byteLength(body)).toBe(DEFAULT_MAX_BODY_BYTES);
    const result = parseBody(eventWith({ body }), z.looseObject({ siteId: z.string() }));
    expect(result.ok).toBe(true);
  });

  it("measures the decoded size of a base64 body against the limit", () => {
    const encoded = Buffer.alloc(DEFAULT_MAX_BODY_BYTES + 1, "x").toString("base64");
    const result = parseBody(eventWith({ body: encoded, isBase64Encoded: true }), BodySchema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.statusCode).toBe(413);
    }
  });
});

describe("issuesOf", () => {
  it("joins each path with dots and keeps the code, never the value", () => {
    const issues = z
      .object({ fleet: z.object({ version: z.number() }) })
      .safeParse({ fleet: { version: "secret-value" } });

    expect(issues.success).toBe(false);
    if (issues.success) {
      return;
    }
    expect(issuesOf(issues.error.issues)).toEqual([
      { path: "fleet.version", code: "invalid_type" },
    ]);
  });

  it("formats an empty path as an empty string", () => {
    expect(issuesOf([{ path: [], code: "custom" }])).toEqual([{ path: "", code: "custom" }]);
  });
});

describe("JwtAuthorizerSchema", () => {
  it("accepts the verified claims and refuses a context without them", () => {
    expect(JwtAuthorizerSchema.safeParse({ jwt: { claims: { sub: "u" } } }).success).toBe(true);
    expect(JwtAuthorizerSchema.safeParse({}).success).toBe(false);
  });
});
