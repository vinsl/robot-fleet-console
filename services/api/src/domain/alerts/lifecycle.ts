/**
 * Lifecycle of an alert: the transitions an operator action may take, and the records they produce.
 *
 * The lifecycle is strict (ADR 0061): an alert is acknowledged once, then resolved. The planning function is
 * pure, so the table of allowed actions is tested alone; the transition builders validate their result with the
 * protocol schema, which also enforces that the acknowledgement precedes the resolution.
 */
import {
  AlertRecordSchema,
  AlertStatusSchema,
  IsoMsSchema,
  type AlertAction,
  type AlertRecord,
  type AlertStatus,
  type IsoMs,
  type UserSub,
} from "@mfc/protocol";
import { ALERT_PROBLEMS } from "./problems";
import type { UseCaseProblem } from "../result";

/**
 * Instant of an operator action: the server clock, but never before the opening of the alert. A robot clock may
 * run ahead, and the stored record must not show a resolution before the alert it closes.
 *
 * @param now - The current instant of the server.
 * @param openedAt - The opening instant of the alert.
 * @returns The later of the two, in the fixed ISO format of the protocol.
 */
export function actionInstant(now: Date, openedAt: IsoMs): IsoMs {
  const current = IsoMsSchema.parse(now.toISOString());
  return current < openedAt ? openedAt : current;
}

/**
 * Moves an OPEN alert to ACKNOWLEDGED.
 *
 * The caller checks the status first with {@link planOf}. Calling this on another status is a programming error,
 * reported as a ZodError rather than silently producing an inconsistent record.
 *
 * @param current - The alert as read.
 * @param by - Subject of the operator who acknowledges it.
 * @param at - Instant of the acknowledgement.
 * @returns The acknowledged alert, validated by the alert schema.
 * @throws {ZodError} When `current` is not OPEN or the result breaks the record rules.
 */
export function acknowledged(current: AlertRecord, by: UserSub, at: IsoMs): AlertRecord {
  AlertStatusSchema.extract(["OPEN"]).parse(current.status);
  return AlertRecordSchema.parse({
    ...current,
    status: "ACKNOWLEDGED",
    acknowledgedBy: by,
    acknowledgedAt: at,
  });
}

/**
 * Moves an ACKNOWLEDGED alert to RESOLVED. The acknowledgement is kept, so the history shows who took the
 * alert in hand.
 *
 * @param current - The alert as read.
 * @param by - Subject of the operator who resolves it.
 * @param at - Instant of the resolution.
 * @returns The resolved alert, validated by the alert schema.
 * @throws {ZodError} When `current` is not ACKNOWLEDGED or the result breaks the record rules.
 */
export function resolved(current: AlertRecord, by: UserSub, at: IsoMs): AlertRecord {
  AlertStatusSchema.extract(["ACKNOWLEDGED"]).parse(current.status);
  return AlertRecordSchema.parse({
    ...current,
    status: "RESOLVED",
    resolvedBy: by,
    resolvedAt: at,
  });
}

/**
 * What an action does on an alert in a given status: change it, answer with it unchanged (an idempotent
 * repeat), or refuse with a problem.
 */
export type ActionPlan = "apply" | "replay" | { readonly refuse: UseCaseProblem };

/**
 * Plans an action on an alert in a status.
 *
 * @param action - The operator action.
 * @param status - The status of the alert as read.
 * @returns The plan. Acknowledging an acknowledged alert and resolving a resolved one are replays, so a double
 * click or a retry is harmless.
 */
export function planOf(action: AlertAction, status: AlertStatus): ActionPlan {
  if (action === "acknowledge") {
    switch (status) {
      case "OPEN":
        return "apply";
      case "ACKNOWLEDGED":
        return "replay";
      case "RESOLVED":
        return { refuse: ALERT_PROBLEMS.alreadyResolved };
    }
  }
  switch (status) {
    case "OPEN":
      return { refuse: ALERT_PROBLEMS.acknowledgeFirst };
    case "ACKNOWLEDGED":
      return "apply";
    case "RESOLVED":
      return "replay";
  }
}
