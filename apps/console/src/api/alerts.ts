/**
 * Alerts API: route builders, query hooks and the cache updates shared with the live feed.
 *
 * The active and resolved lists are server state, so they live in the TanStack Query cache (ADR 0057). The
 * WebSocket patches that cache through {@link upsertAlert}; the periodic refetch heals any frame that was
 * lost. Every route is site-scoped and built from validated identifiers only.
 */
import {
  useMutation,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  ALERT_LIST_DEFAULT_LIMIT,
  AlertActionResponseSchema,
  AlertIdSchema,
  AlertListResponseSchema,
  DEMO_SITE_ID,
  compareAlerts,
  type AlertAction,
  type AlertActionResponse,
  type AlertId,
  type AlertListQuery,
  type AlertListResponse,
  type AlertRecord,
  type SiteId,
} from "@mfc/protocol";
import { useServices } from "../app/services";
import { live } from "../theme/tokens";
import { ApiError, type ApiClient, type SitePath } from "./http-client";
import { sitePaths } from "./site";

/** Query key prefix of every alert list. Invalidating it refetches the active and resolved lists. */
export const ALERTS_KEY = "alerts";

/** Most pages of active alerts fetched in one refresh. Bounds the work of one refetch. */
const MAX_ACTIVE_PAGES = 3;

/** Query parameters the console may send. Every value is a string, as in a URL. */
type AlertQueryParams = Partial<Record<keyof AlertListQuery, string>>;

/**
 * Builds the list route of the alerts of a site, with its query string.
 *
 * @param siteId - Site identifier, checked by {@link sitePaths}.
 * @param query - Query parameters; undefined entries are left out.
 * @returns `/sites/{siteId}/alerts?...`.
 */
export function alertsPath(siteId: SiteId, query: AlertQueryParams): SitePath {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    params.set(key, value);
  }
  const search = params.toString();
  return search === ""
    ? `${sitePaths.site(siteId)}/alerts`
    : `${sitePaths.site(siteId)}/alerts?${search}`;
}

/**
 * Builds the route of one operator action on an alert.
 *
 * @param siteId - Site identifier.
 * @param alertId - Alert identifier, checked against the protocol grammar before it becomes a segment.
 * @param action - The action: `acknowledge` or `resolve`.
 * @returns `/sites/{siteId}/alerts/{alertId}/{action}`.
 * @throws TypeError When the alert identifier is malformed.
 */
export function alertActionPath(siteId: SiteId, alertId: AlertId, action: AlertAction): SitePath {
  if (!AlertIdSchema.safeParse(alertId).success) {
    throw new TypeError("invalid alert id");
  }
  return `${sitePaths.site(siteId)}/alerts/${alertId}/${action}`;
}

/**
 * Query key of the active alerts of a site.
 *
 * @param siteId - Site identifier.
 * @returns The key `[alerts, siteId, "active"]`.
 */
export const activeAlertsKey = (siteId: SiteId): readonly unknown[] => [
  ALERTS_KEY,
  siteId,
  "active",
];

/**
 * Query key of the resolved alerts of a site.
 *
 * @param siteId - Site identifier.
 * @returns The key `[alerts, siteId, "resolved"]`.
 */
export const resolvedAlertsKey = (siteId: SiteId): readonly unknown[] => [
  ALERTS_KEY,
  siteId,
  "resolved",
];

/**
 * Fetches the active alerts, following the cursor for up to {@link MAX_ACTIVE_PAGES} pages.
 *
 * @param api - The API client.
 * @returns The alerts, in {@link compareAlerts} order.
 */
async function fetchActiveAlerts(api: ApiClient): Promise<readonly AlertRecord[]> {
  const alerts: AlertRecord[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_ACTIVE_PAGES; page += 1) {
    const params: AlertQueryParams =
      cursor === undefined ? { status: "active" } : { status: "active", cursor };
    const response = await api.get(alertsPath(DEMO_SITE_ID, params), AlertListResponseSchema);
    alerts.push(...response.alerts);
    if (response.nextCursor === undefined) {
      break;
    }
    cursor = response.nextCursor;
  }
  return [...alerts].sort(compareAlerts);
}

/**
 * Builds the query of one page of resolved alerts. The window is computed when the query runs, so a
 * refetch slides it forward.
 *
 * @param cursor - The cursor of the page, or `undefined` for the first page.
 * @returns The query parameters.
 */
function resolvedPageQuery(cursor: string | undefined): AlertQueryParams {
  const since = new Date(Date.now() - live.historyWindowMs).toISOString();
  const base: AlertQueryParams = {
    status: "resolved",
    since,
    limit: String(ALERT_LIST_DEFAULT_LIMIT),
  };
  return cursor === undefined ? base : { ...base, cursor };
}

/**
 * Lists the active alerts of the demo site, refetched every `live.alertsRefetchMs`.
 *
 * @returns The query; `data` is the list in display order.
 */
export function useActiveAlerts(): UseQueryResult<readonly AlertRecord[]> {
  const { api } = useServices();
  return useQuery({
    queryKey: activeAlertsKey(DEMO_SITE_ID),
    queryFn: () => fetchActiveAlerts(api),
    refetchInterval: live.alertsRefetchMs,
  });
}

/**
 * Lists the alerts resolved in the last `live.historyWindowMs`, one page at a time.
 *
 * @returns The infinite query; `data.pages` holds the pages in the order they were fetched.
 */
export function useResolvedAlerts(): UseInfiniteQueryResult<InfiniteData<AlertListResponse>> {
  const { api } = useServices();
  return useInfiniteQuery({
    queryKey: resolvedAlertsKey(DEMO_SITE_ID),
    queryFn: ({ pageParam }) =>
      api.get(alertsPath(DEMO_SITE_ID, resolvedPageQuery(pageParam)), AlertListResponseSchema),
    // The first page has no cursor. Widened so that the page parameter is `string | undefined` for every page.
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: live.historyRefetchMs,
  });
}

/**
 * Patches the active and resolved caches with one alert.
 *
 * An open or acknowledged alert replaces the entry with the same id, or joins the list in
 * {@link compareAlerts} order. A resolved alert leaves the active list and is put first on page 0 of the
 * resolved history. A cache that is not loaded yet is left alone: the next fetch brings the alert.
 *
 * @param queryClient - The query cache of the console.
 * @param alert - The alert as the server now states it.
 */
export function upsertAlert(queryClient: QueryClient, alert: AlertRecord): void {
  queryClient.setQueryData<readonly AlertRecord[]>(activeAlertsKey(DEMO_SITE_ID), (current) => {
    if (current === undefined) {
      return undefined;
    }
    const others = current.filter((entry) => entry.alertId !== alert.alertId);
    if (alert.status === "RESOLVED") {
      return others;
    }
    return [...others, alert].sort(compareAlerts);
  });

  if (alert.status !== "RESOLVED") {
    return;
  }
  queryClient.setQueryData<InfiniteData<AlertListResponse>>(
    resolvedAlertsKey(DEMO_SITE_ID),
    (current) => {
      const [first, ...rest] = current?.pages ?? [];
      if (current === undefined || first === undefined) {
        return undefined;
      }
      const pages = [first, ...rest].map((page) => ({
        ...page,
        alerts: page.alerts.filter((entry) => entry.alertId !== alert.alertId),
      }));
      const head = pages[0];
      if (head === undefined) {
        return undefined;
      }
      pages[0] = { ...head, alerts: [alert, ...head.alerts] };
      return { pages, pageParams: current.pageParams };
    },
  );
}

/**
 * Runs one operator action on an alert. The cache is patched from the response; a 404 or a 409 means the
 * console's view is stale, so the alert queries are refetched instead.
 *
 * The status is read rather than the error kind: a 409 is the conflict of the lifecycle, and the kinds of
 * {@link ApiError} are shared with every route.
 *
 * @param action - The action this mutation performs.
 * @returns The mutation; its variables are the alert the action applies to.
 */
export function useAlertAction(
  action: AlertAction,
): UseMutationResult<AlertActionResponse, Error, AlertRecord> {
  const { api } = useServices();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (alert: AlertRecord) =>
      api.post(
        alertActionPath(DEMO_SITE_ID, alert.alertId, action),
        { openedAt: alert.openedAt },
        AlertActionResponseSchema,
      ),
    onSuccess: (response) => {
      upsertAlert(queryClient, response.alert);
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) {
        void queryClient.invalidateQueries({ queryKey: [ALERTS_KEY] });
      }
    },
  });
}
