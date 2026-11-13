/**
 * RFC 7807 problem details, the only error body the API returns (`application/problem+json`).
 *
 * The body carries a correlation identifier and nothing else that could identify the system: no stack
 * trace, no account id, no resource name beyond what the caller sent. Operators find the cause in the
 * logs with the correlation identifier.
 */
import { z } from "zod";
import { CorrelationIdSchema } from "./ids";

/** Problem types the API uses. Each is published as `urn:mfc:problem:<name>`. */
export const PROBLEM_TYPES = [
  "invalid-request",
  "robot-exists",
  "robot-not-found",
  "robot-state-conflict",
  "provisioning-failed",
  "retirement-failed",
  "unauthorized",
  "forbidden",
  "not-found",
  "payload-too-large",
  "rate-limited",
  "map-not-found",
  "map-invalid",
  "version-limit",
  "alert-not-found",
  "alert-state-conflict",
  "lock-held",
  "lock-not-held",
  "command-conflict",
  "demo-mode-off",
  "not-simulated",
  "upstream-failed",
  "internal",
] as const;

/** Length bound of the human-readable title. Titles are fixed per type, so a short bound is enough. */
const MAX_TITLE_LENGTH = 120;

/** Length bound of the detail. The detail is written by the API, never copied from an internal error. */
const MAX_DETAIL_LENGTH = 500;

/** RFC 7807 problem object as returned by the API. Strict, so no internal field can be added silently. */
export const ProblemSchema = z.strictObject({
  type: z.string().regex(/^urn:mfc:problem:[a-z-]+$/),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  status: z.int().min(400).max(599),
  detail: z.string().max(MAX_DETAIL_LENGTH).optional(),
  correlationId: CorrelationIdSchema,
});

/** A validated problem object. */
export type Problem = z.infer<typeof ProblemSchema>;
