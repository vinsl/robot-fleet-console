/**
 * HTTP client of the console for the REST API. Every response is validated before it reaches the UI.
 *
 * A request carries the bearer token of the signed-in user. A 401 forces one token refresh and one retry;
 * a second 401 signs the user out. Errors never carry the token, and the API body is only read for its
 * correlation identifier.
 */
import { ProblemSchema, type Problem, type RuntimeConfig } from "@mfc/protocol";
import { AuthError } from "../auth/cognito-client";
import { isTimeout } from "../lib/is-timeout";

/** Timeout of one request, so that a stalled API cannot freeze the console. */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * Anything that validates a response body: a zod schema from `@mfc/protocol` in practice. Only `safeParse` is
 * used, so the console does not depend on the schema library directly.
 */
interface BodySchema<T> {
  safeParse(
    data: unknown,
  ): { readonly success: true; readonly data: T } | { readonly success: false };
}

/** The REST routes the console calls. Typed so that a route cannot be misspelt. */
export const API_PATHS = {
  health: "/health",
  me: "/me",
  wsToken: "/ws-token",
} as const;

/** Route of one site, built by `sitePaths` in `api/site.ts` from validated identifiers and versions only. */
export type SitePath = `/sites/${string}`;

/** One of the REST routes in {@link API_PATHS}, or a site route. */
type ApiPath = (typeof API_PATHS)[keyof typeof API_PATHS] | SitePath;

/** HTTP methods the console sends. */
type ApiMethod = "GET" | "POST" | "PUT";

/** Category of a failed API call. */
type ApiErrorKind =
  | "unauthorized"
  | "forbidden"
  | "rate-limited"
  | "server"
  | "timeout"
  | "network"
  | "invalid-response"
  | "request";

/**
 * A failed API call. The message is fixed; the category, status and correlation identifier are what the
 * UI may show.
 */
export class ApiError extends Error {
  /** Category of the failure. */
  readonly kind: ApiErrorKind;
  /** HTTP status, or `null` when no response arrived. */
  readonly status: number | null;
  /** Correlation identifier from the problem body, when the API sent one. */
  readonly correlationId: string | null;

  /**
   * @param kind - Failure category.
   * @param status - HTTP status, or `null`.
   * @param correlationId - Correlation identifier, or `null`.
   */
  constructor(kind: ApiErrorKind, status: number | null, correlationId: string | null) {
    super(`API request failed: ${kind}`);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.correlationId = correlationId;
  }
}

/** The part of the authentication client the HTTP client needs. */
export interface ApiTokenSource {
  /**
   * @param options - `force` refreshes the token even when it is still valid.
   * @returns The access token.
   */
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
  /** Ends the session. */
  signOut(): Promise<void>;
}

/** Options of {@link createApiClient}. Injected for tests. */
interface ApiClientOptions {
  /** Fetch implementation. Defaults to the global one. */
  readonly fetchFn?: typeof fetch;
}

/** Typed calls to the REST API. */
export interface ApiClient {
  /**
   * @param path - A route of {@link API_PATHS}.
   * @param schema - Schema of the expected response body.
   * @returns The validated body.
   * @throws {ApiError} On any failure.
   */
  get<T>(path: ApiPath, schema: BodySchema<T>): Promise<T>;
  /**
   * @param path - A route of {@link API_PATHS} or a site route.
   * @param body - Request body, serialised as JSON. `undefined` sends no body.
   * @param schema - Schema of the expected response body.
   * @returns The validated body.
   * @throws {ApiError} On any failure.
   */
  post<T>(path: ApiPath, body: unknown, schema: BodySchema<T>): Promise<T>;
  /**
   * @param path - A site route.
   * @param body - Request body, serialised as JSON.
   * @param schema - Schema of the expected response body.
   * @returns The validated body.
   * @throws {ApiError} On any failure.
   */
  put<T>(path: ApiPath, body: unknown, schema: BodySchema<T>): Promise<T>;
}

/**
 * Maps an HTTP status to a failure category.
 *
 * @param status - The response status.
 * @returns The category.
 */
function kindForStatus(status: number): ApiErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "server";
  return "request";
}

/**
 * Reads the problem body of an error response, when the API sent one. Gateway responses (for example the
 * authorizer's 401) are not problem documents and yield `null`.
 *
 * @param response - The failed response.
 * @returns The problem, or `null`.
 */
async function readProblem(response: Response): Promise<Problem | null> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/problem+json")) {
    return null;
  }
  try {
    const parsed = ProblemSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Serialises an optional request body. `undefined` means no body, which is how the slot and validation
 * routes are called.
 *
 * @param body - The value to send, or `undefined`.
 * @returns The JSON text, or `null` when there is no body.
 */
function serialise(body: unknown): string | null {
  return body === undefined ? null : JSON.stringify(body);
}

/**
 * Creates the API client.
 *
 * @param config - The runtime configuration; only the API origin is used.
 * @param auth - The token source of the signed-in user.
 * @param options - Injected dependencies.
 * @returns The client.
 */
export function createApiClient(
  config: Pick<RuntimeConfig, "apiUrl">,
  auth: ApiTokenSource,
  options: ApiClientOptions = {},
): ApiClient {
  const fetchFn = options.fetchFn ?? fetch;

  /**
   * Sends one attempt with a fresh token.
   *
   * @param method - HTTP method.
   * @param path - API route.
   * @param body - Serialised body, if any.
   * @param forceRefresh - Whether to refresh the token first.
   * @returns The raw response.
   * @throws {ApiError} `unauthorized` when no token can be obtained, `timeout` or `network` when no response
   *   arrives.
   */
  async function attempt(
    method: ApiMethod,
    path: ApiPath,
    body: string | null,
    forceRefresh: boolean,
  ): Promise<Response> {
    let token: string;
    try {
      token = await auth.getAccessToken(forceRefresh ? { force: true } : undefined);
    } catch (error) {
      if (error instanceof AuthError) {
        throw new ApiError("unauthorized", null, null);
      }
      throw error;
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (body !== null) {
      headers["Content-Type"] = "application/json";
    }
    try {
      return await fetchFn(new URL(path, config.apiUrl), {
        method,
        headers,
        body,
        cache: "no-store",
        credentials: "omit",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ApiError(isTimeout(error) ? "timeout" : "network", null, null);
    }
  }

  /**
   * Turns a response into the validated body, or throws the matching {@link ApiError}.
   *
   * @param response - The response of a non-retried attempt.
   * @param schema - Schema of the expected body.
   * @returns The validated body.
   * @throws {ApiError} On a non-2xx status or a body that does not match the schema.
   */
  async function parse<T>(response: Response, schema: BodySchema<T>): Promise<T> {
    if (!response.ok) {
      const problem = await readProblem(response);
      throw new ApiError(
        kindForStatus(response.status),
        response.status,
        problem?.correlationId ?? null,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError("invalid-response", response.status, null);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError("invalid-response", response.status, null);
    }
    return parsed.data;
  }

  /**
   * Runs a request with one retry after a forced refresh on 401.
   *
   * @param method - HTTP method.
   * @param path - API route.
   * @param body - Serialised body, if any.
   * @param schema - Schema of the expected body.
   * @returns The validated body.
   * @throws {ApiError} On any failure; a second 401 also signs the user out.
   */
  async function request<T>(
    method: ApiMethod,
    path: ApiPath,
    body: string | null,
    schema: BodySchema<T>,
  ): Promise<T> {
    const first = await attempt(method, path, body, false);
    if (first.status !== 401) {
      return parse(first, schema);
    }

    const second = await attempt(method, path, body, true);
    if (second.status === 401) {
      await auth.signOut();
      throw new ApiError("unauthorized", 401, null);
    }
    return parse(second, schema);
  }

  return {
    get: (path, schema) => request("GET", path, null, schema),
    post: (path, body, schema) => request("POST", path, serialise(body), schema),
    put: (path, body, schema) => request("PUT", path, serialise(body), schema),
  };
}
