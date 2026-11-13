/**
 * Use case: list the alerts of a site, one page per request.
 *
 * The page keeps the order of the store. The active list is ordered by the index key `SEVERITY#openedAt` as a plain
 * string, which is alphabetical (CRITICAL, INFO, MAJOR, MINOR) and not severity order; the console sorts the merged
 * pages it shows, never the page alone. A stored item that does not match the alert schema is left out and counted,
 * so one bad item never blanks the whole list.
 */
import type { AlertListQuery, AlertListResponse, SiteId } from "@mfc/protocol";
import { ALERT_PROBLEMS } from "./problems";
import { AlertCursorError, type AlertPage, type AlertsDeps } from "./ports";
import { refuse, succeed, type UseCaseResult } from "../result";

/**
 * Reads one page of the alerts of a site.
 *
 * @param deps - The store, logger and metrics of the alerts use cases.
 * @param siteId - The verified site of the caller.
 * @param query - The validated query of the request.
 * @returns The page, or the refusal of a cursor that does not belong to this site and status.
 */
export async function listAlerts(
  deps: AlertsDeps,
  siteId: SiteId,
  query: AlertListQuery,
): Promise<UseCaseResult<AlertListResponse>> {
  const { store, logger, metrics } = deps;
  let page: AlertPage;
  try {
    page = await store.list({
      siteId,
      status: query.status,
      severity: query.severity,
      robotId: query.robotId,
      since: query.since,
      limit: query.limit,
      cursor: query.cursor,
    });
  } catch (error) {
    if (error instanceof AlertCursorError) {
      logger.warn("alert cursor refused", { reason: "cursor-mismatch" });
      return refuse(ALERT_PROBLEMS.invalidCursor);
    }
    throw error;
  }

  if (page.invalidItems > 0) {
    for (let count = 0; count < page.invalidItems; count += 1) {
      metrics.count("AlertItemInvalid");
    }
    logger.warn("stored alert items left out", { count: page.invalidItems });
  }

  return succeed({
    alerts: page.alerts,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}
