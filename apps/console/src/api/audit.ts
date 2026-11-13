/**
 * Audit API: the route builder and the request function of the audit trail of a site.
 *
 * The trail is read-only and paged newest first. The pages live in the TanStack Query cache, read by
 * `audit/use-audit.ts`; this module only addresses the route and fetches one validated page. The filters are sent
 * to the API, which applies them to the whole trail, so a match is never hidden by the page it is not on.
 */
import {
  AuditListResponseSchema,
  type AuditListQuery,
  type AuditListResponse,
  type AuditResult,
  type RobotId,
  type SiteId,
} from "@mfc/protocol";
import type { ApiClient, SitePath } from "./http-client";
import { sitePaths } from "./site";

/** Query key prefix of the audit trail. */
export const AUDIT_KEY = "audit";

/**
 * The filters of the audit trail. An absent field is not filtered on; the API refuses any other field.
 */
export interface AuditFilters {
  /** Only the records of this robot. */
  readonly robotId?: RobotId | undefined;
  /** Only the records with this outcome. */
  readonly result?: AuditResult | undefined;
}

/**
 * Query key of the audit trail of a site, with its filters. The filters are part of the key, so each filter has its
 * own cache of pages. The key keeps the `[audit, siteId]` prefix, so an invalidation of the site still reaches every
 * filter.
 *
 * @param siteId - Site identifier.
 * @param filters - The filters of the trail; none by default.
 * @returns The key `[audit, siteId, robotId | null, result | null]`.
 */
export const auditQueryKey = (siteId: SiteId, filters: AuditFilters = {}): readonly unknown[] => [
  AUDIT_KEY,
  siteId,
  filters.robotId ?? null,
  filters.result ?? null,
];

/**
 * Builds the route of one page of the audit trail of a site, with its query string.
 *
 * The limit is always sent, so the page size does not depend on the server default. The cursor is opaque and
 * is only forwarded, never parsed. A filter is sent only when it is set, so an unfiltered request is the same URL as
 * before the filters existed.
 *
 * @param siteId - Site identifier, checked by {@link sitePaths}.
 * @param query - The page size, the filters and, for every page after the first, the cursor of the previous page.
 * @returns `/sites/{siteId}/audit?limit=...`, with the cursor and the filters when they are given.
 */
export function auditPath(siteId: SiteId, query: AuditListQuery): SitePath {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor !== undefined) {
    params.set("cursor", query.cursor);
  }
  if (query.robotId !== undefined) {
    params.set("robotId", query.robotId);
  }
  if (query.result !== undefined) {
    params.set("result", query.result);
  }
  return `${sitePaths.site(siteId)}/audit?${params.toString()}`;
}

/**
 * Fetches one page of the audit trail and validates it against the protocol schema.
 *
 * @param api - The API client.
 * @param siteId - Site identifier.
 * @param query - The page to fetch.
 * @returns The validated page.
 * @throws {ApiError} On any failure.
 */
export function fetchAuditPage(
  api: ApiClient,
  siteId: SiteId,
  query: AuditListQuery,
): Promise<AuditListResponse> {
  return api.get(auditPath(siteId, query), AuditListResponseSchema);
}
