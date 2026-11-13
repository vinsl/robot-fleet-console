/**
 * The fixed refusals of the alerts use cases. Each one is a single sentence the operator can act on, and none
 * of them echoes the request.
 */
import type { UseCaseProblem } from "../result";

/** The refusals of the alerts use cases, keyed by the situation they name. */
export const ALERT_PROBLEMS = {
  notFound: {
    type: "alert-not-found",
    status: 404,
    detail: "No alert matches this request.",
  },
  alreadyResolved: {
    type: "alert-state-conflict",
    status: 409,
    detail: "The alert is already resolved.",
  },
  acknowledgeFirst: {
    type: "alert-state-conflict",
    status: 409,
    detail: "Acknowledge the alert first.",
  },
  changed: {
    type: "alert-state-conflict",
    status: 409,
    detail: "The alert changed meanwhile. Reload it.",
  },
  invalidCursor: {
    type: "invalid-request",
    status: 400,
    detail: "The cursor is not valid.",
  },
} as const satisfies Record<string, UseCaseProblem>;
