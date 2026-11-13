/**
 * HTTP helpers of the API Lambda functions: responses, RFC 7807 problems, correlation identifiers and
 * request bodies.
 *
 * The helpers only shape the API Gateway proxy result and validate the request. Errors leave this module
 * as fixed problems: the title comes from a table keyed by problem type, and the detail is written here, never
 * copied from an exception, so no stack trace or internal identifier reaches the caller.
 */
import {
  CorrelationIdSchema,
  ProblemSchema,
  uuidv7,
  type CorrelationId,
  type PROBLEM_TYPES,
} from "@mfc/protocol";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { z } from "zod";

/** Type of an RFC 7807 problem, one of the problem types the protocol publishes. */
export type ProblemType = (typeof PROBLEM_TYPES)[number];

/** The authorizer context of a JWT-protected route, as API Gateway sends it. Parsed, never trusted as is. */
export const JwtAuthorizerSchema = z.object({
  jwt: z.object({ claims: z.record(z.string(), z.unknown()) }),
});

/** One schema issue as the handlers log it: the path of the field and the zod code, never the value. */
export interface LoggedIssue {
  /** Path of the offending field, dot-separated. */
  readonly path: string;
  /** Zod issue code. */
  readonly code: string;
}

/**
 * Lists the paths and codes of validation issues. Values are never included: an issue can echo the input, and
 * the input can carry personal data.
 *
 * @param issues - The issues of a failed schema check, as zod or a use case reports them.
 * @returns One `{ path, code }` pair per issue.
 */
export function issuesOf(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly code: string }[],
): LoggedIssue[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    code: issue.code,
  }));
}

/** Largest request body the API accepts, in bytes. API Gateway allows 10 MB; the API allows far less. */
export const DEFAULT_MAX_BODY_BYTES = 16_384;

/** Media type of an RFC 7807 problem. */
const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Media type of a JSON success body. */
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

/**
 * Fixed title of a problem type. Titles never come from input or from an exception.
 *
 * A switch over the union rather than a lookup table: the compiler rejects a problem type that has no
 * title, so a type added to the protocol cannot ship without one.
 *
 * @param type - The problem type.
 * @returns The fixed title of that type.
 */
function problemTitle(type: ProblemType): string {
  switch (type) {
    case "invalid-request":
      return "Invalid request";
    case "robot-exists":
      return "Robot already exists";
    case "robot-not-found":
      return "Robot not found";
    case "robot-state-conflict":
      return "Robot state conflict";
    case "provisioning-failed":
      return "Provisioning failed";
    case "retirement-failed":
      return "Retirement failed";
    case "unauthorized":
      return "Unauthorized";
    case "forbidden":
      return "Forbidden";
    case "not-found":
      return "Not found";
    case "payload-too-large":
      return "Payload too large";
    case "rate-limited":
      return "Too many requests";
    case "map-not-found":
      return "Map not found";
    case "map-invalid":
      return "Map invalid";
    case "version-limit":
      return "Map version limit reached";
    case "alert-not-found":
      return "Alert not found";
    case "alert-state-conflict":
      return "Alert state conflict";
    case "lock-held":
      return "Robot control is held by another operator";
    case "lock-not-held":
      return "Robot control is not held";
    case "command-conflict":
      return "Command identifier already used";
    case "demo-mode-off":
      return "Demo mode is off";
    case "not-simulated":
      return "Robot is not simulated";
    case "upstream-failed":
      return "Upstream service failed";
    case "internal":
      return "Internal error";
  }
}

/** Shape of a proxy result this module returns. */
export type HttpResult = APIGatewayProxyStructuredResultV2;

/**
 * Outcome of reading a request body: the parsed value, or the problem response to return as is.
 */
export type ParseBodyResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly response: HttpResult };

/**
 * Builds an RFC 7807 problem response.
 *
 * The body is validated against {@link ProblemSchema} before it is serialised, so a status or a correlation
 * identifier outside the contract fails here, in the Lambda, and not in the console.
 *
 * @param type - The problem type. Its title is fixed by the table of this module.
 * @param status - The HTTP status, from 400 to 599.
 * @param correlationId - The correlation identifier of the request, echoed to the caller.
 * @param detail - Optional fixed sentence written by the API. Never an internal message.
 * @returns The proxy result, with `application/problem+json` and `cache-control: no-store`.
 */
export function problemResponse(
  type: ProblemType,
  status: number,
  correlationId: CorrelationId,
  detail?: string,
): HttpResult {
  const problem = ProblemSchema.parse({
    type: `urn:mfc:problem:${type}`,
    title: problemTitle(type),
    status,
    ...(detail === undefined ? {} : { detail }),
    correlationId,
  });
  return {
    statusCode: problem.status,
    headers: {
      "content-type": PROBLEM_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify(problem),
  };
}

/**
 * Builds a JSON success response.
 *
 * @param status - The HTTP status of the response.
 * @param body - The value to serialise. The caller validates it against its schema before this call.
 * @param correlationId - The correlation identifier of the request, echoed in a header.
 * @returns The proxy result, with `application/json`, `cache-control: no-store` and the correlation header.
 */
export function jsonResponse(
  status: number,
  body: unknown,
  correlationId: CorrelationId,
): HttpResult {
  return {
    statusCode: status,
    headers: {
      "content-type": JSON_CONTENT_TYPE,
      "cache-control": "no-store",
      "x-correlation-id": correlationId,
    },
    body: JSON.stringify(body),
  };
}

/**
 * Reads the correlation identifier of a request from the API Gateway request id.
 *
 * API Gateway request ids follow the identifier grammar, so the request id is used as is. A value outside the
 * grammar, which API Gateway does not send, is replaced by a fresh identifier so that the problem response
 * still validates.
 *
 * @param event - The proxy event.
 * @returns A correlation identifier that satisfies {@link CorrelationIdSchema}.
 */
export function getCorrelationId(event: APIGatewayProxyEventV2): CorrelationId {
  const parsed = CorrelationIdSchema.safeParse(event.requestContext.requestId);
  return parsed.success ? parsed.data : uuidv7();
}

/**
 * Decodes the body of a proxy event into bytes, honouring the base64 flag API Gateway sets for binary payloads.
 *
 * @param event - The proxy event.
 * @returns The raw body bytes; empty when the request has no body.
 */
function bodyBytes(event: APIGatewayProxyEventV2): Buffer {
  if (event.body === undefined) {
    return Buffer.alloc(0);
  }
  return Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8");
}

/**
 * Reads and validates the JSON body of a request.
 *
 * The size is checked on the decoded bytes before the body is parsed, so a large body is refused without
 * being decoded as JSON. The refusal names no value: a zod issue can echo the input, and the input may be
 * personal data.
 *
 * @param event - The proxy event.
 * @param schema - The schema the body must satisfy.
 * @param maxBytes - The largest accepted body, in bytes.
 * @returns The parsed body, or the problem response to return as is: `413` above the limit, `400` otherwise.
 */
export function parseBody<S extends z.ZodType>(
  event: APIGatewayProxyEventV2,
  schema: S,
  maxBytes: number = DEFAULT_MAX_BODY_BYTES,
): ParseBodyResult<z.output<S>> {
  const correlationId = getCorrelationId(event);
  const bytes = bodyBytes(event);
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      response: problemResponse(
        "payload-too-large",
        413,
        correlationId,
        "The request body is larger than the limit.",
      ),
    };
  }
  const invalid = (): ParseBodyResult<z.output<S>> => ({
    ok: false,
    response: problemResponse(
      "invalid-request",
      400,
      correlationId,
      "The request does not match the schema.",
    ),
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes.toString("utf8"));
  } catch {
    return invalid();
  }
  const parsed = schema.safeParse(decoded);
  return parsed.success ? { ok: true, data: parsed.data } : invalid();
}
