/**
 * Query of one downloaded site map: asks the API for a presigned URL, then downloads and validates the body.
 *
 * The body is cached per version reference. A version number names an object that never changes, so its
 * body is safe to keep; `active` can change on activation, which is why the write hooks invalidate the body
 * cache (see `SITE_MAP_BODY_KEY` in `api/site.ts`).
 */
import { useQuery } from "@tanstack/react-query";
import { DEMO_SITE_ID, type MapVersionNumber, type SiteMap } from "@mfc/protocol";
import { fetchMapUrl, SITE_MAP_BODY_KEY } from "../api/site";
import { useServices } from "../app/services";
import { fetchSiteMapText, SiteFetchError, type SiteFetchErrorKind } from "./fetch-map";

/** Time a downloaded body stays fresh, in milliseconds. Below the five-minute presigned URL lifetime. */
const SITE_MAP_STALE_MS = 4 * 60_000;

/**
 * Number of retries of a failed download. One is enough for a dropped connection or an expired presigned URL,
 * which a fresh request answers; more would only delay the operator's answer.
 */
const SITE_MAP_RETRIES = 1;

/**
 * Failures worth one more attempt. A network drop, a timeout and a refused URL (typically expired) are transient
 * or cured by asking the API again. A body that is invalid or too large is not: the same object fails the same way.
 */
const RETRYABLE_KINDS: readonly SiteFetchErrorKind[] = ["network", "timeout", "rejected"];

/**
 * Decides whether a failed download is retried. Used as the query's `retry` option.
 *
 * @param failureCount - Number of failed attempts so far, counting the one that just failed.
 * @param error - The error of the last attempt.
 * @returns `true` for one more attempt of a transient failure.
 */
export function shouldRetrySiteMap(failureCount: number, error: unknown): boolean {
  return (
    failureCount <= SITE_MAP_RETRIES &&
    error instanceof SiteFetchError &&
    RETRYABLE_KINDS.includes(error.kind)
  );
}

/**
 * Reads one site map: the presigned URL, then the validated body.
 *
 * @param version - Version number, or `active`.
 * @param enabled - Whether to download. A disabled query sends nothing.
 * @returns The query result; its data is the validated site map.
 */
export function useSiteMap(version: MapVersionNumber | "active", enabled: boolean) {
  const { api } = useServices();
  return useQuery({
    queryKey: [SITE_MAP_BODY_KEY, DEMO_SITE_ID, version],
    // Each attempt asks the API for a fresh URL, so a retry after an expired presigned URL gets a valid one.
    queryFn: async (): Promise<SiteMap> => {
      const { url } = await fetchMapUrl(api, version);
      return fetchSiteMapText(url);
    },
    enabled,
    retry: shouldRetrySiteMap,
    staleTime: SITE_MAP_STALE_MS,
  });
}
