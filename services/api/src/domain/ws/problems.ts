/**
 * RFC 7807 problems of the WebSocket functions: the fixed text of each refusal, and its validated object.
 *
 * Titles and details are written here and never built from input or from an internal error, so a problem
 * cannot leak a stack trace, a token or a site the caller did not name.
 */
import { ProblemSchema, type CorrelationId, type Problem } from "@mfc/protocol";

/** One problem of the WebSocket functions: its type, HTTP status, title and fixed detail. */
export interface WsProblemEntry {
  readonly type: string;
  readonly status: 400 | 403 | 500;
  readonly title: string;
  readonly detail: string;
}

/** The problems the token endpoint returns. */
export const WS_PROBLEMS = {
  invalidRequest: {
    type: "invalid-request",
    status: 400,
    title: "Invalid request",
    detail: "The request does not match the schema.",
  },
  invalidSession: {
    type: "invalid-session",
    status: 400,
    title: "Invalid session",
    detail: "The session window of the principal is not valid.",
  },
  forbiddenSite: {
    type: "forbidden-site",
    status: 403,
    title: "Site not allowed",
    detail: "The principal has no access to this site.",
  },
  internal: {
    type: "internal",
    status: 500,
    title: "Internal error",
    detail: "Unexpected error; quote the correlation id.",
  },
} as const satisfies Record<string, WsProblemEntry>;

/**
 * Builds the RFC 7807 object of a problem, validated against the shared schema.
 *
 * @param entry - The problem.
 * @param correlationId - The correlation identifier of the invocation, echoed to the caller.
 * @returns The problem object.
 */
export function wsProblem(entry: WsProblemEntry, correlationId: CorrelationId): Problem {
  return ProblemSchema.parse({
    type: `urn:mfc:problem:${entry.type}`,
    title: entry.title,
    status: entry.status,
    detail: entry.detail,
    correlationId,
  });
}
