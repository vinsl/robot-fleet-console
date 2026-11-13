/**
 * Use case: read one page of the audit trail of a site, newest first.
 *
 * A stored item that does not match the record schema is left out and counted, so one bad item never blanks the page.
 * A refused cursor is the client's malformed input: it is answered with a 400 that carries no internal text.
 */
import type { AuditListQuery, AuditListResponse, SiteId } from "@mfc/protocol";
import { refuse, succeed, type UseCaseProblem, type UseCaseResult } from "../result";
import type { DomainLogger } from "../ports";
import { AuditCursorError, type AuditPage, type AuditReaderPort } from "./ports";

/** The refusal of a cursor that is not a position of this site. The detail is fixed and never echoes the cursor. */
export const AUDIT_CURSOR_PROBLEM: UseCaseProblem = {
  type: "invalid-request",
  status: 400,
  detail: "The cursor is not valid.",
};

/** Dependencies of the audit read. */
export interface AuditListDeps {
  /** Reader of the trail. */
  readonly reader: AuditReaderPort;
  /** Structured logger. */
  readonly logger: DomainLogger;
}

/**
 * Reads one page of the audit trail of a site.
 *
 * @param deps - The reader and the logger.
 * @param siteId - The verified site of the caller, which is also the site of the path.
 * @param query - The validated query of the request: the page size and the cursor.
 * @returns The page, or the refusal of a cursor that does not belong to this site.
 */
export async function listAudit(
  deps: AuditListDeps,
  siteId: SiteId,
  query: AuditListQuery,
): Promise<UseCaseResult<AuditListResponse>> {
  const { reader, logger } = deps;
  let page: AuditPage;
  try {
    page = await reader.page({
      siteId,
      limit: query.limit,
      cursor: query.cursor,
      robotId: query.robotId,
      result: query.result,
    });
  } catch (error) {
    if (error instanceof AuditCursorError) {
      logger.warn("audit cursor refused", { reason: "cursor-mismatch" });
      return refuse(AUDIT_CURSOR_PROBLEM);
    }
    throw error;
  }

  if (page.invalidItems > 0) {
    logger.warn("stored audit items left out", { count: page.invalidItems });
  }

  return succeed({
    items: page.items,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  });
}
