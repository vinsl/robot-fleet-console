/**
 * Loading of the runtime configuration: the happy path, and every way the file can be unusable.
 */
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  RUNTIME_CONFIG_PATH,
  loadRuntimeConfig,
} from "../../src/config/runtime-config";

const VALID = {
  apiUrl: "https://abc123defg.execute-api.eu-west-3.amazonaws.com",
  wsUrl: "wss://xyz987wvut.execute-api.eu-west-3.amazonaws.com/ws",
  region: "eu-west-3",
  userPoolId: "eu-west-3_EXAMPLE1",
  userPoolClientId: "examplecl1234567890example",
  identityPoolId: "eu-west-3:00000000-0000-0000-0000-000000000000",
};

/** A request as the loader sent it. */
interface Recorded {
  readonly path: string;
  readonly init: RequestInit | undefined;
}

/**
 * Returns a fetch double that answers with the given body and status, and records the request.
 *
 * @param body - The body: a string is sent as is, anything else as JSON.
 * @param status - HTTP status.
 * @returns The fetch double and the recorded requests.
 */
function fetchReturning(body: unknown, status = 200) {
  const recorded: Recorded[] = [];
  const fetchFn = (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const path =
      input instanceof URL ? input.pathname : typeof input === "string" ? input : input.url;
    recorded.push({ path, init });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return Promise.resolve(new Response(text, { status }));
  };
  return { fetchFn, recorded };
}

describe("loadRuntimeConfig", () => {
  it("returns the validated configuration and bypasses the cache without credentials", async () => {
    const { fetchFn, recorded } = fetchReturning(VALID);

    const config = await loadRuntimeConfig(fetchFn);

    expect(config).toEqual(VALID);
    expect(recorded[0]?.path).toBe(RUNTIME_CONFIG_PATH);
    expect(recorded[0]?.init).toMatchObject({ cache: "no-store", credentials: "omit" });
  });

  it("reports an unreachable file as unavailable", async () => {
    const fetchFn = () => Promise.reject(new TypeError("network down"));
    await expect(loadRuntimeConfig(fetchFn)).rejects.toMatchObject({
      name: "ConfigError",
      reason: "unavailable",
    });
  });

  it("reports a non-2xx answer as unavailable", async () => {
    const { fetchFn } = fetchReturning("missing", 404);
    const failure = await loadRuntimeConfig(fetchFn).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure).toMatchObject({ reason: "unavailable" });
  });

  it.each([
    ["a body that is not JSON", "{not json"],
    ["an extra key", { ...VALID, accountId: "123456789012" }],
    ["a plain HTTP API URL", { ...VALID, apiUrl: "http://abc.example.test" }],
    ["a non-WSS realtime URL", { ...VALID, wsUrl: "https://abc.example.test/ws" }],
    ["a malformed pool id", { ...VALID, userPoolId: "not a pool" }],
    ["a missing field", { ...VALID, region: undefined }],
  ])("rejects %s as invalid", async (_label, body) => {
    const { fetchFn } = fetchReturning(body);
    const failure = await loadRuntimeConfig(fetchFn).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure).toMatchObject({ reason: "invalid" });
  });
});
