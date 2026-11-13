/**
 * Map download: the URL refusals, the transport failures, the byte budget and the schema check. The sample map
 * is the protocol fixture, so the console and the planner read the same file.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SITE_MAP_MAX_BYTES } from "@mfc/protocol";
import { fetchSiteMapText, SiteFetchError } from "../../src/site/fetch-map";

/** Presigned GET of a map on the regional S3 host, as the API returns it. */
const URL_OK =
  "https://fleet-demo-site-maps-abc123.s3.eu-west-3.amazonaws.com/sites/paris-01/maps/000002.geojson";

/** The protocol fixture: a valid site map. */
// Read from the package directory, where the test runner starts, as the theme contract test does.
const SAMPLE = readFileSync(
  "../../packages/protocol/test/fixtures/site-map/sample-warehouse.geojson",
  "utf8",
);

/**
 * Builds a fetch double that answers once and records its calls.
 *
 * @param answer - The response to return, or the error to reject with.
 * @returns The double and its spy.
 */
function fetchDouble(answer: Response | Error) {
  const impl: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response> = () =>
    answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  const spy = vi.fn(impl);
  return { fetchFn: spy as unknown as typeof fetch, spy };
}

/**
 * Reads the failure of a download, failing the test when it succeeds.
 *
 * @param promise - The download.
 * @returns The thrown value.
 */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the download to fail");
}

describe("fetchSiteMapText", () => {
  it("downloads and validates a map without credentials and without redirects", async () => {
    const { fetchFn, spy } = fetchDouble(new Response(SAMPLE, { status: 200 }));
    const map = await fetchSiteMapText(URL_OK, fetchFn);

    expect(map.type).toBe("FeatureCollection");
    expect(spy).toHaveBeenCalledTimes(1);
    const init = spy.mock.calls[0]?.[1];
    expect(init?.method).toBe("GET");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
  });

  it("refuses a URL that is not an S3 HTTPS URL before any request", async () => {
    for (const url of [
      "http://fleet-demo-site-maps.s3.eu-west-3.amazonaws.com/map.geojson",
      "https://user:pw@fleet-demo-site-maps.s3.eu-west-3.amazonaws.com/map.geojson",
      "https://evil.example/map.geojson",
      "not a url",
    ]) {
      const { fetchFn, spy } = fetchDouble(new Response(SAMPLE, { status: 200 }));
      const failure = await failureOf(fetchSiteMapText(url, fetchFn));
      expect(failure, url).toBeInstanceOf(SiteFetchError);
      expect((failure as SiteFetchError).kind, url).toBe("invalid");
      expect(spy, url).not.toHaveBeenCalled();
    }
  });

  it("reports a refused redirect or a network failure as a network error", async () => {
    const { fetchFn } = fetchDouble(new TypeError("redirect mode is set to error"));
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as SiteFetchError).kind).toBe("network");
  });

  it("reports a timed-out request as a timeout", async () => {
    const timeout = new DOMException("the operation timed out", "TimeoutError");
    const { fetchFn } = fetchDouble(timeout);
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as SiteFetchError).kind).toBe("timeout");
  });

  it("reports a non-2xx answer, such as an expired URL, as rejected", async () => {
    const { fetchFn } = fetchDouble(new Response("<Error>AccessDenied</Error>", { status: 403 }));
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as SiteFetchError).kind).toBe("rejected");
  });

  it("refuses a declared size above the budget without reading the body", async () => {
    const response = new Response(SAMPLE, {
      status: 200,
      headers: { "content-length": String(SITE_MAP_MAX_BYTES + 1) },
    });
    const { fetchFn } = fetchDouble(response);
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as SiteFetchError).kind).toBe("too-large");
  });

  it("enforces the budget while reading when no size is declared", async () => {
    const chunk = new Uint8Array(1_000_000).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 3) {
          controller.close();
          return;
        }
        sent += 1;
        controller.enqueue(chunk);
      },
    });
    const { fetchFn } = fetchDouble(new Response(stream, { status: 200 }));
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as SiteFetchError).kind).toBe("too-large");
  });

  it("refuses bytes that are not UTF-8", async () => {
    const bytes = new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]);
    const { fetchFn } = fetchDouble(new Response(bytes, { status: 200 }));
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as SiteFetchError).kind).toBe("invalid");
  });

  it("refuses a body that is not a valid site map", async () => {
    const invalid = JSON.stringify({ type: "FeatureCollection", features: [] });
    const { fetchFn } = fetchDouble(new Response(invalid, { status: 200 }));
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as SiteFetchError).kind).toBe("invalid");
  });

  it("does not put the URL or the body in the error message", async () => {
    const { fetchFn } = fetchDouble(new Response("secret-body", { status: 500 }));
    const failure = await failureOf(fetchSiteMapText(URL_OK, fetchFn));
    expect((failure as Error).message).not.toContain("secret-body");
    expect((failure as Error).message).not.toContain("fleet-demo-site-maps");
  });
});
