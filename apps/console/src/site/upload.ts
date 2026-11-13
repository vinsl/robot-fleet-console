/**
 * Browser side of a map upload: posts the file to the presigned POST the API issued.
 *
 * The URL comes back through the API, so it is checked before any request is sent: it must be HTTPS, carry
 * no credentials or port, and point at an S3 host. A tampered response cannot redirect the file elsewhere.
 * The S3 response body is never shown, because it can echo the request.
 */
import type { CreateMapResponse } from "@mfc/protocol";
import { isTimeout } from "../lib/is-timeout";

/** Longest the browser waits for the upload. A 2 MB map on a slow link fits well within it. */
const UPLOAD_TIMEOUT_MS = 30_000;

/** Name of the file part. S3 requires it to be the last form field. */
const FILE_FIELD = "file";

/** File name sent with the body. The key on S3 is server-chosen, so this name is cosmetic. */
const FILE_NAME = "site-map.geojson";

/** One DNS label of a host name: letters, digits and hyphens, bounded. */
const DNS_LABEL_PATTERN = /^[a-z0-9-]{1,63}$/;

/** Category of a failed upload. */
export type SiteUploadErrorKind = "too-large" | "rejected" | "network" | "timeout";

/** A failed upload. The message is fixed; the category is what the UI may show. */
export class SiteUploadError extends Error {
  /** Category of the failure. */
  readonly kind: SiteUploadErrorKind;

  /**
   * @param kind - Failure category.
   */
  constructor(kind: SiteUploadErrorKind) {
    super(`site map upload failed: ${kind}`);
    this.name = "SiteUploadError";
    this.kind = kind;
  }
}

/**
 * Tells whether a host name is an S3 host: virtual-hosted (`<bucket>.s3.<region>.amazonaws.com`) or path
 * style (`s3.<region>.amazonaws.com`). Checked label by label, so no pattern can backtrack on the input.
 *
 * @param hostname - The host name of the URL.
 * @returns `true` for an S3 host.
 */
function isS3Host(hostname: string): boolean {
  const labels = hostname.split(".");
  const count = labels.length;
  return (
    count >= 4 &&
    labels[count - 1] === "com" &&
    labels[count - 2] === "amazonaws" &&
    labels[count - 4] === "s3" &&
    labels.every((label) => DNS_LABEL_PATTERN.test(label))
  );
}

/**
 * Checks that a presigned POST target is an HTTPS URL on an S3 host, before any byte leaves the browser.
 *
 * @param url - The URL from the API response.
 * @throws {SiteUploadError} `rejected` when the URL is not an S3 HTTPS URL without credentials or port.
 */
export function assertUploadTarget(url: string): void {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new SiteUploadError("rejected");
  }
  const plain =
    target.protocol === "https:" &&
    target.username === "" &&
    target.password === "" &&
    target.port === "";
  if (!plain || !isS3Host(target.hostname)) {
    throw new SiteUploadError("rejected");
  }
}

/**
 * Tells whether an S3 error response says the file is too large. The body is read only to find the error
 * code; it is not kept.
 *
 * @param response - The failed response.
 * @returns `true` for an oversized file.
 */
async function isTooLarge(response: Response): Promise<boolean> {
  if (response.status === 413) {
    return true;
  }
  if (response.status !== 400) {
    return false;
  }
  try {
    return (await response.text()).includes("EntityTooLarge");
  } catch {
    return false;
  }
}

/**
 * Uploads the map file to its presigned POST. Fields are sent in the order the API returned them, then the
 * file, as S3 requires. Success is S3's `204 No Content`.
 *
 * @param upload - The presigned POST from the upload slot.
 * @param body - The GeoJSON document as a blob.
 * @param fetchFn - Fetch implementation, injected for tests.
 * @throws {SiteUploadError} On any refusal, network failure or timeout.
 */
export async function uploadToPresignedPost(
  upload: CreateMapResponse["upload"],
  body: Blob,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  assertUploadTarget(upload.url);

  const form = new FormData();
  for (const [name, value] of Object.entries(upload.fields)) {
    form.append(name, value);
  }
  form.append(FILE_FIELD, body, FILE_NAME);

  let response: Response;
  try {
    response = await fetchFn(upload.url, {
      method: "POST",
      body: form,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    throw new SiteUploadError(isTimeout(error) ? "timeout" : "network");
  }

  if (response.status === 204) {
    return;
  }
  throw new SiteUploadError((await isTooLarge(response)) ? "too-large" : "rejected");
}
