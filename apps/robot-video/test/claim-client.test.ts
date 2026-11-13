import { describe, expect, it } from "vitest";
import { createAgentApi, readClaimFromHash } from "../src/lib/claim-client";
import { CLAIM_TOKEN, IDLE_STATUS, SESSION_KEY, sessionWithExpiry } from "./fixtures";

const ORIGIN = "http://127.0.0.1:8123";

/** One recorded call of the fake fetch. */
interface Recorded {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Builds a fake fetch that answers with one fixed response and records every call.
 *
 * @param answer - A function returning the response for a call, or throwing for a network failure.
 * @returns The fetch and the list of recorded calls.
 */
function fakeFetch(answer: () => Response): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init: init ?? {} });
    return Promise.resolve(answer());
  };
  return { fetch: fetchFn, calls };
}

/**
 * Returns a JSON response.
 *
 * @param status - The HTTP status.
 * @param body - The body, serialised as JSON.
 * @returns The response.
 */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

/** A valid problem body of the agent. */
function problem(type: string): unknown {
  return {
    type: `urn:mfc:problem:${type}`,
    title: "Refused",
    status: 401,
    correlationId: "0190f2b0-0000-7000-8000-000000000000",
  };
}

describe("readClaimFromHash", () => {
  it("returns the token of a well-formed fragment", () => {
    expect(readClaimFromHash(`#claim=${CLAIM_TOKEN}`)).toBe(CLAIM_TOKEN);
  });

  it.each([
    ["a short token", "#claim=short"],
    ["a token of 44 characters", `#claim=${"A".repeat(44)}`],
    ["another fragment", "#other=AAAA"],
    ["an empty fragment", ""],
    ["a bare hash", "#"],
    ["a token with a character outside base64url", `#claim=${"A".repeat(42)}+`],
    ["a token with padding", `#claim=${"A".repeat(42)}==`],
  ])("returns null for %s", (_label, hash) => {
    expect(readClaimFromHash(hash)).toBeNull();
  });
});

describe("createAgentApi", () => {
  it("sends the claim as a JSON body to the claim route, never in the URL", async () => {
    const fake = fakeFetch(() => json(200, { sessionKey: SESSION_KEY }));
    const result = await createAgentApi(fake.fetch, ORIGIN).claim(CLAIM_TOKEN);

    expect(result).toEqual({ ok: true, value: { sessionKey: SESSION_KEY } });
    const [call] = fake.calls;
    expect(call?.url).toBe(`${ORIGIN}/api/claim`);
    expect(call?.url).not.toContain(CLAIM_TOKEN);
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({ "Content-Type": "application/json" });
    expect(call?.init.body).toBe(JSON.stringify({ claim: CLAIM_TOKEN }));
  });

  it("sends every request without credentials, cache or referrer, with a timeout", async () => {
    const fake = fakeFetch(() => json(200, { sessionKey: SESSION_KEY }));
    await createAgentApi(fake.fetch, ORIGIN).claim(CLAIM_TOKEN);

    const [call] = fake.calls;
    expect(call?.init.credentials).toBe("omit");
    expect(call?.init.cache).toBe("no-store");
    expect(call?.init.referrerPolicy).toBe("no-referrer");
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends the session key as a bearer token on the session route", async () => {
    const fake = fakeFetch(() => json(200, sessionWithExpiry("2030-01-01T00:00:00Z")));
    const result = await createAgentApi(fake.fetch, ORIGIN).session(SESSION_KEY);

    expect(result.ok).toBe(true);
    const [call] = fake.calls;
    expect(call?.url).toBe(`${ORIGIN}/api/session`);
    expect(call?.init.method).toBe("GET");
    expect(call?.init.headers).toEqual({ Authorization: `Bearer ${SESSION_KEY}` });
  });

  it("sends the session key as a bearer token on the status route", async () => {
    const fake = fakeFetch(() => json(200, IDLE_STATUS));
    const result = await createAgentApi(fake.fetch, ORIGIN).status(SESSION_KEY);

    expect(result).toEqual({ ok: true, value: IDLE_STATUS });
    expect(fake.calls[0]?.url).toBe(`${ORIGIN}/api/status`);
    expect(fake.calls[0]?.init.headers).toEqual({ Authorization: `Bearer ${SESSION_KEY}` });
  });

  it("refuses a successful answer with an extra key", async () => {
    const fake = fakeFetch(() => json(200, { sessionKey: SESSION_KEY, extra: true }));
    const result = await createAgentApi(fake.fetch, ORIGIN).claim(CLAIM_TOKEN);

    expect(result).toEqual({ ok: false, error: { kind: "invalid-response" } });
  });

  it("refuses a session whose key id is a long-lived AKIA key", async () => {
    const session = sessionWithExpiry("2030-01-01T00:00:00Z");
    const body = {
      ...session,
      credentials: { ...session.credentials, accessKeyId: "AKIAIOSFODNN7EXAMPLE" },
    };
    const fake = fakeFetch(() => json(200, body));
    const result = await createAgentApi(fake.fetch, ORIGIN).session(SESSION_KEY);

    expect(result).toEqual({ ok: false, error: { kind: "invalid-response" } });
  });

  it("reads a refusal through the problem schema and keeps its type only", async () => {
    const fake = fakeFetch(() => json(401, problem("claim-wrong")));
    const result = await createAgentApi(fake.fetch, ORIGIN).claim(CLAIM_TOKEN);

    expect(result).toEqual({
      ok: false,
      error: { kind: "problem", status: 401, type: "urn:mfc:problem:claim-wrong" },
    });
  });

  it("reports a refusal whose body is not a problem as an invalid response", async () => {
    const fake = fakeFetch(() => new Response("<html>", { status: 502 }));
    const result = await createAgentApi(fake.fetch, ORIGIN).status(SESSION_KEY);

    expect(result).toEqual({ ok: false, error: { kind: "invalid-response" } });
  });

  it("reports a rejected fetch as a network error", async () => {
    const failing = (): Promise<Response> => Promise.reject(new TypeError("Failed to fetch"));
    const result = await createAgentApi(failing, ORIGIN).status(SESSION_KEY);

    expect(result).toEqual({ ok: false, error: { kind: "network" } });
  });
});
