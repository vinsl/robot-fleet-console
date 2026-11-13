/**
 * Text of the audit sheet: every audited action has a translation in both languages, and the result visuals are
 * chosen by a switch that covers every outcome.
 */
import { describe, expect, it } from "vitest";
import i18n from "i18next";
import { AuditActionSchema, AuditResultSchema } from "@mfc/protocol";
import "../../src/i18n";
import { auditActionKey, auditResultVisual } from "../../src/audit/audit-text";

describe("audit text", () => {
  it.each(AuditActionSchema.options)("translates the action %s in en and fr", (action) => {
    const key = `audit:${auditActionKey(action)}`;
    expect(i18n.getFixedT("en")(key)).not.toBe(key);
    expect(i18n.getFixedT("fr")(key)).not.toBe(key);
  });

  it.each(AuditResultSchema.options)("gives the result %s an icon and a label key", (result) => {
    const visual = auditResultVisual(result);
    expect(typeof visual.icon).toBe("object");
    expect(visual.labelKey).toBe(`audit:result.${result}`);
  });
});
