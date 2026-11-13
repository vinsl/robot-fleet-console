/**
 * Ports of the audit read: the reader of one page of the trail, and the cursor refusal it raises.
 *
 * The reader states the outcome the domain needs rather than the SDK call behind it. The domain therefore never
 * imports an SDK, and the DynamoDB adapter is tested against the same contract as the in-memory fake.
 */
import type { AuditCursor, AuditRecord, AuditResult, RobotId, SiteId } from "@mfc/protocol";

/** One page request of the audit trail, validated by the query schema. */
export interface AuditPageRequest {
  /** Site whose trail is read. The partition of the query is built from it, never from the cursor. */
  readonly siteId: SiteId;
  /** Largest number of records to return. */
  readonly limit: number;
  /** Position to resume from, as issued by a previous page of the same site. */
  readonly cursor?: AuditCursor | undefined;
  /** Only the records of this robot, when set. */
  readonly robotId?: RobotId | undefined;
  /** Only the records with this outcome, when set. */
  readonly result?: AuditResult | undefined;
}

/** One page of the audit trail, newest first. */
export interface AuditPage {
  /** The records of the page, in the order of the store. */
  readonly items: AuditRecord[];
  /** Position of the next page, absent on the last page. */
  readonly nextCursor?: AuditCursor | undefined;
  /** Stored items read for the page that do not match the record schema, and were left out. */
  readonly invalidItems: number;
}

/**
 * Thrown by the reader when a cursor is refused: it is not a position of this site, or it is malformed. The message
 * is for logs only and is never sent to a client.
 */
export class AuditCursorError extends Error {
  /** Creates the error. */
  constructor() {
    super("audit cursor refused");
    this.name = "AuditCursorError";
  }
}

/** Reader of the audit trail. */
export interface AuditReaderPort {
  /**
   * Reads one page of the trail of a site, newest first.
   *
   * @param request - The site, the page size and the cursor of the page.
   * @returns The page.
   * @throws {AuditCursorError} When the cursor is refused.
   */
  page(request: AuditPageRequest): Promise<AuditPage>;
}
