/**
 * The audit trail as a paged query: one page of {@link AUDIT_LIST_DEFAULT_LIMIT} records at a time, newest first.
 *
 * The trail is a snapshot taken when the sheet opens, so it is not polled; "Load more" fetches the next page.
 */
import {
  useInfiniteQuery,
  type InfiniteData,
  type UseInfiniteQueryResult,
} from "@tanstack/react-query";
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  DEMO_SITE_ID,
  type AuditListResponse,
  type AuditListQuery,
} from "@mfc/protocol";
import { auditQueryKey, fetchAuditPage, type AuditFilters } from "../api/audit";
import { useServices } from "../app/services";

/**
 * Builds the query of one page. The first page has no cursor; later pages carry the cursor of the previous one. The
 * filters are repeated on every page, because the cursor only moves the position inside the filtered trail.
 *
 * @param cursor - The cursor of the page, or `undefined` for the first page.
 * @param filters - The filters of the trail.
 * @returns The page query.
 */
function pageQuery(cursor: string | undefined, filters: AuditFilters): AuditListQuery {
  return {
    limit: AUDIT_LIST_DEFAULT_LIMIT,
    ...(cursor === undefined ? {} : { cursor }),
    ...(filters.robotId === undefined ? {} : { robotId: filters.robotId }),
    ...(filters.result === undefined ? {} : { result: filters.result }),
  };
}

/**
 * Lists the audit trail of the demo site, one page at a time, narrowed by the filters.
 *
 * @param filters - The filters of the trail; none by default. A change of filter starts a new trail from its first page.
 * @returns The infinite query; `data.pages` holds the pages in the order they were fetched.
 */
export function useAuditTrail(
  filters: AuditFilters = {},
): UseInfiniteQueryResult<InfiniteData<AuditListResponse>> {
  const { api } = useServices();
  return useInfiniteQuery({
    queryKey: auditQueryKey(DEMO_SITE_ID, filters),
    queryFn: ({ pageParam }) => fetchAuditPage(api, DEMO_SITE_ID, pageQuery(pageParam, filters)),
    // The first page has no cursor. Widened so that the page parameter is `string | undefined` for every page.
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
  });
}
