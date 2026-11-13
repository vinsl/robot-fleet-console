/**
 * Text of the audit sheet: translation keys of the actions, the "who" label of an actor, and the time of a record.
 *
 * The functions are pure so that the table can be checked without rendering it. The actor is named by its
 * {@link holderLabel}, never by its full subject, as the lock holders are.
 */
import { UserSubSchema, type AuditAction, type AuditResult, type AuditRecord } from "@mfc/protocol";
import type { TFunction } from "i18next";
import { holderLabel } from "../control/lock-store";
import { AUDIT_RESULT_VISUALS } from "../theme/robot-state-visuals";

/**
 * Translation key of an audited action, in the `audit` namespace. The keys mirror the protocol names, so a
 * new action without a translation is caught by the i18n test.
 *
 * @param action - The audited action.
 * @returns The key, for example `action.command.return_to_base`.
 */
export function auditActionKey(action: AuditAction): string {
  return `action.${action}`;
}

/** The visual of one outcome. */
export type AuditResultVisual = (typeof AUDIT_RESULT_VISUALS)[AuditResult];

/**
 * Picks the visual of an outcome. A switch, not an index lookup, so that a new outcome fails to compile until it
 * has a visual.
 *
 * @param result - The outcome of the record.
 * @returns The icon, colour and label key of the outcome.
 */
export function auditResultVisual(result: AuditResult): AuditResultVisual {
  switch (result) {
    case "SUCCEEDED":
      return AUDIT_RESULT_VISUALS.SUCCEEDED;
    case "REFUSED":
      return AUDIT_RESULT_VISUALS.REFUSED;
    case "FAILED":
      return AUDIT_RESULT_VISUALS.FAILED;
  }
}

/**
 * Names the actor of a record. The source decides, not the shape of the name: a CLI actor can be a plain word that
 * also parses as a user subject. A verified human (`mfc.jwt`) is shown as the lock holder label (`Operator 3f9a`).
 * An administration call (`mfc.admin`) is shown as the tool that made it, never as a person, and no raw name is
 * printed from it.
 *
 * @param record - The record whose actor is named.
 * @param t - Translation function of the `audit` namespace.
 * @returns The localised label.
 */
export function whoLabel(record: Pick<AuditRecord, "actor" | "actorSource">, t: TFunction): string {
  if (record.actorSource === "mfc.admin") {
    return t("actorLabel.admin");
  }
  const subject = UserSubSchema.safeParse(record.actor);
  return subject.success ? holderLabel(subject.data, t) : t("actorLabel.admin");
}

/**
 * Formats the time of a record in the language of the console, with the date and the seconds.
 *
 * @param ts - The record time, as an ISO 8601 string.
 * @param language - The language tag to format with.
 * @returns The formatted time.
 */
export function formatAuditTime(ts: string, language: string): string {
  return new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" }).format(
    new Date(ts),
  );
}
