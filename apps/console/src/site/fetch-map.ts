/**
 * Browser side of a map download: reads the presigned GET the API issued and validates the GeoJSON it returns.
 *
 * The URL comes back through the API, so it is checked before any request: HTTPS, an S3 host, no credentials
 * or port. The body is read through a byte budget rather than trusted to be small, because a presigned
 * object can be larger than the console expects. The body is validated with the same schema the server
 * applies, so the console never renders a map the planner would refuse.
 */
import { parseSiteMap, SITE_MAP_MAX_BYTES, type SiteMap } from "@mfc/protocol";
import { isTimeout } from "../lib/is-timeout";
import { assertUploadTarget } from "./upload";

/** Longest the browser waits for a map body. A full 2 MB map on a slow link fits well within it. */
const FETCH_TIMEOUT_MS = 15_000;

/**
 * Category of a failed download. `rejected` is a non-2xx answer, typically an expired presigned URL, which
 * the caller may answer by asking the API for a fresh URL once.
 */
export type SiteFetchErrorKind = "network" | "timeout" | "invalid" | "too-large" | "rejected";

/** A failed download. The message is fixed; only the category may reach the UI. */
export class SiteFetchError extends Error {
  /** Category of the failure. */
  readonly kind: SiteFetchErrorKind;

  /**
   * @param kind - Failure category.
   */
  constructor(kind: SiteFetchErrorKind) {
    super(`site map fetch failed: ${kind}`);
    this.name = "SiteFetchError";
    this.kind = kind;
  }
}

/**
 * Reads a response body up to the site map size bound. The budget is enforced while reading, so an answer
 * without a `Content-Length` cannot grow past it.
 *
 * @param response - A successful response.
 * @returns The body decoded as UTF-8.
 * @throws {SiteFetchError} `too-large` past the budget, `invalid` for bytes that are not UTF-8, `timeout` or
 *   `network` when the body stream fails.
 */
async function readBounded(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      total += result.value.byteLength;
      if (total > SITE_MAP_MAX_BYTES) {
        await reader.cancel();
        throw new SiteFetchError("too-large");
      }
      chunks.push(result.value);
    }
  } catch (error) {
    if (error instanceof SiteFetchError) {
      throw error;
    }
    throw new SiteFetchError(isTimeout(error) ? "timeout" : "network");
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    // `fatal` makes invalid UTF-8 a refusal instead of a silent replacement character.
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SiteFetchError("invalid");
  }
}

/**
 * Downloads a presigned site map and validates it.
 *
 * Credentials are omitted and redirects refused, so the presigned URL is the only authority the request
 * carries. The URL is never logged or echoed in an error.
 *
 * @param url - The presigned GET URL from the API.
 * @param fetchFn - Fetch implementation, injected for tests.
 * @returns The validated site map.
 * @throws {SiteFetchError} On a refused URL, a network failure, a timeout, a non-2xx answer, an oversized or
 *   malformed body, or a body that does not satisfy the site map schema.
 */
export async function fetchSiteMapText(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<SiteMap> {
  try {
    assertUploadTarget(url);
  } catch {
    throw new SiteFetchError("invalid");
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SiteFetchError(isTimeout(error) ? "timeout" : "network");
  }

  if (!response.ok) {
    throw new SiteFetchError("rejected");
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > SITE_MAP_MAX_BYTES) {
    await response.body?.cancel();
    throw new SiteFetchError("too-large");
  }

  const text = await readBounded(response);
  try {
    return parseSiteMap(text);
  } catch {
    // The schema error can quote part of the file, so the refusal states the category only.
    throw new SiteFetchError("invalid");
  }
}
