/**
 * HTTP contract of the audit read: the list query and one page of records.
 *
 * The list is read-only, newest records first, one page per request. It can be narrowed to one robot and to one
 * outcome; no other filter is offered. The cursor is opaque to the caller and is checked again by the API against
 * the site it was issued for.
 */
import { z } from "zod";
import { AlertCursorSchema } from "./alerts-api";
import { AuditRecordSchema, AuditResultSchema } from "./audit";
import { RobotIdSchema } from "./ids";

/** Largest page the audit endpoint returns. Bounds the response size and the read units of one request. */
export const AUDIT_LIST_MAX_LIMIT = 100;

/** Page size when the client does not ask for one. */
export const AUDIT_LIST_DEFAULT_LIMIT = 50;

/**
 * Opaque pagination cursor of the audit list. It has the grammar of the alert cursor, which both pagers
 * share, so one bound covers every list of the API.
 */
export const AuditCursorSchema = AlertCursorSchema;

/** A validated audit cursor. */
export type AuditCursor = z.infer<typeof AuditCursorSchema>;

/**
 * Query string of `GET /sites/{siteId}/audit`. Strict: a filter the API does not offer is refused rather than
 * silently ignored. The two filters are optional and combine with AND. A filter that matches nothing yields
 * pages without records, so the caller keeps paging until the trail ends.
 */
export const AuditListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(AUDIT_LIST_MAX_LIMIT).default(AUDIT_LIST_DEFAULT_LIMIT),
  cursor: AuditCursorSchema.optional(),
  robotId: RobotIdSchema.optional(),
  result: AuditResultSchema.optional(),
});

/** A validated and defaulted audit query. */
export type AuditListQuery = z.infer<typeof AuditListQuerySchema>;

/** One page of audit records. `nextCursor` is present when more records may follow. */
export const AuditListResponseSchema = z.strictObject({
  items: z.array(AuditRecordSchema).max(AUDIT_LIST_MAX_LIMIT),
  nextCursor: AuditCursorSchema.optional(),
});

/** A validated page of audit records. */
export type AuditListResponse = z.infer<typeof AuditListResponseSchema>;
