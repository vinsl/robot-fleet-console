/**
 * In-memory fake of the audit reader, and the dependencies the audit tests share.
 *
 * The fake records every request, so a refused request can be shown to have reached no read, and it can be told to
 * refuse a cursor or fail, which is how the store's outcomes are simulated.
 */
import { AuditRecordSchema, type AuditRecord } from "@mfc/protocol";
import type { AuditPage, AuditPageRequest, AuditReaderPort } from "../../src/domain/audit/ports";
import { AuditCursorError } from "../../src/domain/audit/ports";
import { RecordingLogger } from "./recording";

/** Reader fake: a scripted page, with recorded requests and scripted failures. */
export class FakeAuditReader implements AuditReaderPort {
  /** Every request received, in order, whatever its outcome. */
  readonly requests: AuditPageRequest[] = [];
  /** Page returned by `page` when no failure is scripted. */
  scriptedPage: AuditPage = { items: [], invalidItems: 0 };
  /** Error thrown by `page` when set. */
  error: Error | undefined = undefined;

  /**
   * Makes the next reads refuse the cursor, as the store does for a cursor of another site.
   */
  refuseCursor(): void {
    this.error = new AuditCursorError();
  }

  /**
   * Returns the scripted page, or rejects with the scripted failure.
   *
   * @param request - The request.
   * @returns The page.
   */
  page(request: AuditPageRequest): Promise<AuditPage> {
    this.requests.push(request);
    return this.error === undefined
      ? Promise.resolve(this.scriptedPage)
      : Promise.reject(this.error);
  }
}

/** The records and the logger of one audit test. */
export interface AuditWorld {
  /** The reader fake. */
  readonly reader: FakeAuditReader;
  /** The logger that records every entry. */
  readonly logger: RecordingLogger;
}

/**
 * A fresh world for one test: an empty reader and a recording logger.
 *
 * @returns The world.
 */
export function auditWorld(): AuditWorld {
  return { reader: new FakeAuditReader(), logger: new RecordingLogger() };
}

/**
 * Builds a valid audit record, for the pages a fake returns.
 *
 * @param overrides - Fields to set over the defaults.
 * @returns The record, validated by the protocol schema.
 */
export function auditRecordOf(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return AuditRecordSchema.parse({
    auditId: "0190a0a0-0000-7000-8000-000000000001",
    ts: "2026-11-02T10:00:00.000Z",
    siteId: "paris-01",
    actor: "user-sub-operator",
    actorSource: "mfc.jwt",
    action: "site.map.activate",
    result: "SUCCEEDED",
    mapVersion: 3,
    correlationId: "corr-00000001",
    ...overrides,
  });
}
