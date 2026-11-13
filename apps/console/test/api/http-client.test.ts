/**
 * HTTP client: authorization header, one refresh-and-retry on 401, problem parsing and response validation.
 */
import { describe, expect, it } from "vitest";
import { MeSchema } from "@mfc/protocol";
import {
  ApiError,
  API_PATHS,
  createApiClient,
  type ApiTokenSource,
} from "../../src/api/http-client";
import { AuthError } from "../../src/auth/cognito-client";

const CONFIG = { apiUrl: "https://abc123defg.execute-api.eu-west-3.amazonaws.com" };
const SUB = "11111111-2222-3333-4444-555555555555";
const ME_BODY = { userId: SUB, role: "Admin", siteId: "paris-01" };

/** A request as the client sent it. */
interface Recorded {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/**
 * Builds a token source that issues numbered tokens and records each request for a token.
 *
 * @returns The token source with read-only accessors for its calls.
 */
function tokenSource() {
  const forced: boolean[] = [];
  let signedOut = 0;
  const auth: ApiTokenSource = {
    getAccessToken: (options) => {
      forced.push(options?.force === true);
      return Promise.resolve(`token-${String(forced.length)}`);
    },
    signOut: () => {
      signedOut += 1;
      return Promise.resolve();
    },
  };
  return {
    auth,
    forced: () => forced,
    signedOut: () => signedOut,
  };
}

/**
 * Builds a fetch double that answers the scripted responses in order and records every request.
 *
 * @param responses - The responses to return, one per request.
 * @returns The fetch double and the recorded requests.
 */
function scriptedFetch(responses: Response[]) {
  const recorded: Recorded[] = [];
  const queue = [...responses];
  const fetchFn = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    recorded.push({ url, init });
    const next = queue.shift();
    return next === undefined
      ? Promise.reject(new Error("no scripted response"))
      : Promise.resolve(next);
  };
  return { fetchFn, recorded };
}

/**
 * Builds a JSON response.
 *
 * @param status - HTTP status.
 * @param body - Body, serialised as JSON.
 * @param contentType - Content type of the response.
 * @returns The response.
 */
function json(status: number, body: unknown, contentType = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": contentType } });
}

/** A problem document as the API writes it. */
const FORBIDDEN_PROBLEM = {
  type: "urn:mfc:problem:forbidden",
  title: "Forbidden",
  status: 403,
  correlationId: "abcdef12-3456-7890",
};

/**
 * Returns the thrown value of a rejected promise, or fails the test when it resolved.
 *
 * @param promise - The call expected to fail.
 * @returns The thrown value.
 */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to fail");
}

describe("createApiClient", () => {
  it("sends the bearer token and returns the validated body", async () => {
    const source = tokenSource();
    const { fetchFn, recorded } = scriptedFetch([json(200, ME_BODY)]);
    const api = createApiClient(CONFIG, source.auth, { fetchFn });

    const me = await api.get(API_PATHS.me, MeSchema);

    expect(me).toEqual(ME_BODY);
    expect(recorded[0]?.url).toBe(`${CONFIG.apiUrl}/me`);
    expect(recorded[0]?.init).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
    });
    expect(new Headers(recorded[0]?.init?.headers).get("authorization")).toBe("Bearer token-1");
  });

  it("retries once with a forced refresh after a 401, then succeeds", async () => {
    const source = tokenSource();
    const { fetchFn } = scriptedFetch([new Response(null, { status: 401 }), json(200, ME_BODY)]);
    const api = createApiClient(CONFIG, source.auth, { fetchFn });

    expect(await api.get(API_PATHS.me, MeSchema)).toEqual(ME_BODY);
    expect(source.forced()).toEqual([false, true]);
    expect(source.signedOut()).toBe(0);
  });

  it("signs out and fails after a second 401", async () => {
    const source = tokenSource();
    const { fetchFn, recorded } = scriptedFetch([
      new Response(null, { status: 401 }),
      new Response(null, { status: 401 }),
    ]);
    const api = createApiClient(CONFIG, source.auth, { fetchFn });

    const failure = await failureOf(api.get(API_PATHS.me, MeSchema));

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ kind: "unauthorized", status: 401 });
    expect(recorded).toHaveLength(2);
    expect(source.signedOut()).toBe(1);
  });

  it("reads the correlation identifier from a problem document", async () => {
    const { fetchFn } = scriptedFetch([
      json(403, FORBIDDEN_PROBLEM, "application/problem+json; charset=utf-8"),
    ]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    const failure = await failureOf(api.get(API_PATHS.me, MeSchema));

    expect(failure).toMatchObject({
      kind: "forbidden",
      status: 403,
      correlationId: "abcdef12-3456-7890",
    });
  });

  it("maps a non-problem 429 from the gateway by status, without a correlation identifier", async () => {
    const { fetchFn } = scriptedFetch([new Response("Too Many Requests", { status: 429 })]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    const failure = await failureOf(api.get(API_PATHS.me, MeSchema));

    expect(failure).toMatchObject({ kind: "rate-limited", status: 429, correlationId: null });
  });

  it("rejects a body that does not match the schema", async () => {
    const { fetchFn } = scriptedFetch([json(200, { ...ME_BODY, role: "Root" })]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    await expect(api.get(API_PATHS.me, MeSchema)).rejects.toMatchObject({
      kind: "invalid-response",
    });
  });

  it("maps a stalled request and a refused connection to timeout and network", async () => {
    const timedOut = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const timeoutApi = createApiClient(CONFIG, tokenSource().auth, {
      fetchFn: () => Promise.reject(timedOut),
    });
    const networkApi = createApiClient(CONFIG, tokenSource().auth, {
      fetchFn: () => Promise.reject(new TypeError("fetch failed")),
    });

    await expect(timeoutApi.get(API_PATHS.me, MeSchema)).rejects.toMatchObject({ kind: "timeout" });
    await expect(networkApi.get(API_PATHS.me, MeSchema)).rejects.toMatchObject({ kind: "network" });
  });

  it("never calls the API when no token can be obtained", async () => {
    const auth: ApiTokenSource = {
      getAccessToken: () => Promise.reject(new AuthError("expired")),
      signOut: () => Promise.resolve(),
    };
    const { fetchFn, recorded } = scriptedFetch([]);
    const api = createApiClient(CONFIG, auth, { fetchFn });

    await expect(api.get(API_PATHS.me, MeSchema)).rejects.toMatchObject({ kind: "unauthorized" });
    expect(recorded).toHaveLength(0);
  });

  it("serialises a POST body as JSON", async () => {
    const { fetchFn, recorded } = scriptedFetch([json(200, ME_BODY)]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    await api.post(API_PATHS.wsToken, { siteId: "paris-01" }, MeSchema);

    expect(recorded[0]?.init?.method).toBe("POST");
    expect(recorded[0]?.init?.body).toBe('{"siteId":"paris-01"}');
    expect(new Headers(recorded[0]?.init?.headers).get("content-type")).toBe("application/json");
  });
});

describe("createApiClient put", () => {
  const SITE_ROUTE = "/sites/paris-01" as const;

  it("sends the JSON body with its content type and returns the validated body", async () => {
    const { fetchFn, recorded } = scriptedFetch([json(200, ME_BODY)]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    const result = await api.put(SITE_ROUTE, { name: "Plant 1" }, MeSchema);

    expect(result).toEqual(ME_BODY);
    expect(recorded[0]?.url).toBe(`${CONFIG.apiUrl}/sites/paris-01`);
    expect(recorded[0]?.init).toMatchObject({ method: "PUT", body: '{"name":"Plant 1"}' });
    const headers = new Headers(recorded[0]?.init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer token-1");
  });

  it("maps a 4xx problem document to a request error with its correlation identifier", async () => {
    const conflict = {
      type: "urn:mfc:problem:conflict",
      title: "Conflict",
      status: 409,
      correlationId: "fedcba98-7654-3210",
    };
    const { fetchFn } = scriptedFetch([
      json(409, conflict, "application/problem+json; charset=utf-8"),
    ]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    const failure = await failureOf(api.put(SITE_ROUTE, { name: "Plant 1" }, MeSchema));

    expect(failure).toMatchObject({
      kind: "request",
      status: 409,
      correlationId: "fedcba98-7654-3210",
    });
  });

  it("sends no body and no content type when the body is undefined", async () => {
    const { fetchFn, recorded } = scriptedFetch([json(200, ME_BODY)]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    await api.put(SITE_ROUTE, undefined, MeSchema);

    expect(recorded[0]?.init).toMatchObject({ method: "PUT", body: null });
    expect(new Headers(recorded[0]?.init?.headers).has("content-type")).toBe(false);
  });

  it("rejects an empty success body as an invalid response", async () => {
    const { fetchFn } = scriptedFetch([new Response(null, { status: 200 })]);
    const api = createApiClient(CONFIG, tokenSource().auth, { fetchFn });

    await expect(api.put(SITE_ROUTE, undefined, MeSchema)).rejects.toMatchObject({
      kind: "invalid-response",
      status: 200,
    });
  });
});
