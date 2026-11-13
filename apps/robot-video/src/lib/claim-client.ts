/**
 * The three requests of the video page to the agent, and the checks on every answer.
 *
 * The page talks only to its own origin (the loopback address of the agent). Each answer is parsed
 * with the protocol schema of its route, and an error answer is read through the protocol's problem
 * schema, so the page never acts on a body it could not validate. The fetch options keep the page's
 * credentials out of the browser's cache, cookies and referrer.
 */
import {
  ProblemSchema,
  VideoClaimResponseSchema,
  VideoSessionSchema,
  VideoStatusSchema,
  type VideoClaimResponse,
  type VideoSession,
  type VideoStatus,
} from "@mfc/protocol";
import type { z } from "zod";

/** Fragment prefix that carries the one-time claim token (ADR 0036). */
const CLAIM_FRAGMENT = "#claim=";

/** A claim token is 32 random bytes in unpadded base64url: exactly 43 characters. */
const CLAIM_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** Upper bound of one request. The agent answers in milliseconds; this only guards a stalled socket. */
const REQUEST_TIMEOUT_MS = 5_000;

/** Why a request failed, without any value from the request or the answer. */
export type ApiError =
  | { readonly kind: "problem"; readonly status: number; readonly type: string }
  | { readonly kind: "network" }
  | { readonly kind: "invalid-response" };

/** Outcome of one request: the validated value, or the reason it failed. */
export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ApiError };

/** The agent routes the page calls. Nothing else is ever requested. */
export interface AgentApi {
  /** Exchanges the one-time token for the session key (`POST /api/claim`). */
  claim(token: string): Promise<Result<VideoClaimResponse>>;
  /** Fetches the channel and fresh credentials (`GET /api/session`). */
  session(sessionKey: string): Promise<Result<VideoSession>>;
  /** Fetches the robot status shown in the banner (`GET /api/status`). */
  status(sessionKey: string): Promise<Result<VideoStatus>>;
}

/**
 * Reads the claim token from the URL fragment.
 *
 * The fragment is never sent to the server and never reaches a log of the agent. The caller removes
 * it from the address bar right after reading it.
 *
 * @param hash - The `location.hash` of the page, starting with `#`.
 * @returns The token when the fragment carries a well-formed one, else null.
 */
export function readClaimFromHash(hash: string): string | null {
  if (!hash.startsWith(CLAIM_FRAGMENT)) {
    return null;
  }
  const token = hash.slice(CLAIM_FRAGMENT.length);
  return CLAIM_TOKEN.test(token) ? token : null;
}

/**
 * Reads the body of a failed request as a protocol problem.
 *
 * @param response - The failed response.
 * @param body - The parsed body, or undefined when it was not JSON.
 * @returns The problem type and status, or an invalid-response error when the body is not a problem.
 */
function problemError(response: Response, body: unknown): ApiError {
  const problem = ProblemSchema.safeParse(body);
  if (!problem.success) {
    return { kind: "invalid-response" };
  }
  return { kind: "problem", status: response.status, type: problem.data.type };
}

/**
 * Sends one request and validates the answer.
 *
 * @param fetchFn - The fetch implementation (the browser's, or a fake in tests).
 * @param url - The absolute URL of the route.
 * @param init - The method, headers and body of the request.
 * @param schema - The protocol schema of a successful answer.
 * @returns The validated value, or the reason the request failed.
 */
async function request<T>(
  fetchFn: typeof fetch,
  url: string,
  init: {
    readonly method: "GET" | "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  },
  schema: z.ZodType<T>,
): Promise<Result<T>> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: { kind: "network" } };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    return { ok: false, error: problemError(response, body) };
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: { kind: "invalid-response" } };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Creates the client of the agent's three routes.
 *
 * @param fetchFn - The fetch implementation to use.
 * @param origin - The page origin, `http://127.0.0.1:<port>`. Every request goes to this origin.
 * @returns The three calls of the page.
 */
export function createAgentApi(fetchFn: typeof fetch, origin: string): AgentApi {
  return {
    claim(token: string): Promise<Result<VideoClaimResponse>> {
      return request(
        fetchFn,
        `${origin}/api/claim`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ claim: token }),
        },
        VideoClaimResponseSchema,
      );
    },
    session(sessionKey: string): Promise<Result<VideoSession>> {
      return request(
        fetchFn,
        `${origin}/api/session`,
        { method: "GET", headers: { Authorization: `Bearer ${sessionKey}` } },
        VideoSessionSchema,
      );
    },
    status(sessionKey: string): Promise<Result<VideoStatus>> {
      return request(
        fetchFn,
        `${origin}/api/status`,
        { method: "GET", headers: { Authorization: `Bearer ${sessionKey}` } },
        VideoStatusSchema,
      );
    },
  };
}
