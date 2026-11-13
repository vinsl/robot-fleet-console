/**
 * Map upload to the presigned POST: field order, refusals of the target, and the S3 error mapping.
 */
import { describe, expect, it, vi } from "vitest";
import type { CreateMapResponse } from "@mfc/protocol";
import { assertUploadTarget, SiteUploadError, uploadToPresignedPost } from "../../src/site/upload";

type Upload = CreateMapResponse["upload"];

const UPLOAD: Upload = {
  url: "https://fleet-demo-site-maps-abc123.s3.eu-west-3.amazonaws.com/",
  fields: {
    key: "sites/paris-01/maps/000001.geojson",
    "Content-Type": "application/geo+json",
    policy: "eyJleHBpcmF0aW9uIjoiMjAyNi0xMS0wM1QxMjowMDowMFoifQ==",
  },
  expiresAt: "2026-11-03T12:05:00.000Z",
};

const BODY = new Blob(['{"type":"FeatureCollection"}'], { type: "application/geo+json" });

/**
 * Builds a fetch double that returns one response and records the call.
 *
 * @param response - The response to return, or a rejection reason.
 * @returns The double and the recorded calls.
 */
function fetchDouble(response: Response | Error) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn = vi.fn((input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
    const url = input instanceof URL ? input.href : input instanceof Request ? input.url : input;
    calls.push({ url, init });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls, spy: fetchFn };
}

/**
 * Reads the failure of an upload, failing the test when it succeeds.
 *
 * @param promise - The upload.
 * @returns The thrown value.
 */
async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the upload to fail");
}

describe("assertUploadTarget", () => {
  it("accepts a virtual-hosted and a path-style S3 HTTPS URL", () => {
    expect(() => {
      assertUploadTarget(UPLOAD.url);
    }).not.toThrow();
    expect(() => {
      assertUploadTarget("https://s3.eu-west-3.amazonaws.com/bucket");
    }).not.toThrow();
  });

  it("refuses HTTP, credentials, a port, another host and a lookalike S3 host", () => {
    for (const url of [
      "http://fleet.s3.eu-west-3.amazonaws.com/",
      "https://user:pw@fleet.s3.eu-west-3.amazonaws.com/",
      "https://fleet.s3.eu-west-3.amazonaws.com:8443/",
      "https://evil.example/",
      "https://s3.eu-west-3.amazonaws.com.evil.example/",
      "https://evil.example/s3.eu-west-3.amazonaws.com",
      "not a url",
    ]) {
      expect(() => {
        assertUploadTarget(url);
      }, url).toThrow(SiteUploadError);
    }
  });
});

describe("uploadToPresignedPost", () => {
  it("posts the fields in order, then the file, without credentials or redirects", async () => {
    const { fetchFn, calls } = fetchDouble(new Response(null, { status: 204 }));

    await uploadToPresignedPost(UPLOAD, BODY, fetchFn);

    const init = calls[0]?.init;
    expect(calls[0]?.url).toBe(UPLOAD.url);
    expect(init).toMatchObject({ method: "POST", credentials: "omit", redirect: "error" });
    const form = init?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("expected a form");
    }
    expect([...form.keys()]).toEqual([...Object.keys(UPLOAD.fields), "file"]);
    expect(form.get("key")).toBe(UPLOAD.fields.key);
  });

  it("does not send the file when the target is refused", async () => {
    const { fetchFn, spy } = fetchDouble(new Response(null, { status: 204 }));

    const failure = await failureOf(
      uploadToPresignedPost({ ...UPLOAD, url: "https://evil.example/" }, BODY, fetchFn),
    );

    expect(failure).toMatchObject({ kind: "rejected" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("maps a 403 to rejected, without showing the body", async () => {
    const { fetchFn } = fetchDouble(
      new Response("<Error><Message>secret</Message></Error>", { status: 403 }),
    );

    const failure = await failureOf(uploadToPresignedPost(UPLOAD, BODY, fetchFn));

    expect(failure).toBeInstanceOf(SiteUploadError);
    expect(failure).toMatchObject({ kind: "rejected" });
    expect(String(failure)).not.toContain("secret");
  });

  it("maps a 413 and an S3 EntityTooLarge to too-large", async () => {
    const tooLarge = fetchDouble(new Response(null, { status: 413 }));
    const s3TooLarge = fetchDouble(
      new Response("<Error><Code>EntityTooLarge</Code></Error>", { status: 400 }),
    );

    await expect(
      failureOf(uploadToPresignedPost(UPLOAD, BODY, tooLarge.fetchFn)),
    ).resolves.toMatchObject({
      kind: "too-large",
    });
    await expect(
      failureOf(uploadToPresignedPost(UPLOAD, BODY, s3TooLarge.fetchFn)),
    ).resolves.toMatchObject({
      kind: "too-large",
    });
  });

  it("maps a 400 without EntityTooLarge to rejected", async () => {
    const { fetchFn } = fetchDouble(
      new Response("<Error><Code>InvalidArgument</Code></Error>", { status: 400 }),
    );

    await expect(failureOf(uploadToPresignedPost(UPLOAD, BODY, fetchFn))).resolves.toMatchObject({
      kind: "rejected",
    });
  });

  it("maps a timeout and a refused connection to timeout and network", async () => {
    const timedOut = Object.assign(new Error("aborted"), { name: "TimeoutError" });

    await expect(
      failureOf(uploadToPresignedPost(UPLOAD, BODY, fetchDouble(timedOut).fetchFn)),
    ).resolves.toMatchObject({ kind: "timeout" });
    await expect(
      failureOf(
        uploadToPresignedPost(UPLOAD, BODY, fetchDouble(new TypeError("fetch failed")).fetchFn),
      ),
    ).resolves.toMatchObject({ kind: "network" });
  });
});
