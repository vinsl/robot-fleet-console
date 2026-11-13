/**
 * Presentation rules of the alerts: the order the operator reads, the pill choice, the sentence and the actor.
 */
import i18n from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import "../../src/i18n";
import {
  actionErrorKey,
  actorLabel,
  alertMessage,
  canActOnAlerts,
  groupBySeverity,
  hasOpenCritical,
  newestPillAlert,
  newestResolvedFirst,
  severityVisual,
} from "../../src/alerts/alert-text";
import { ApiError } from "../../src/api/http-client";
import { alertOf } from "../live/support";

/** Translation function of the `alerts` namespace in English. */
const t = i18n.getFixedT("en", "alerts");

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("severityVisual", () => {
  it.each([
    ["CRITICAL", "alert.critical"],
    ["MAJOR", "alert.major"],
    ["MINOR", "alert.minor"],
    ["INFO", "alert.info"],
  ] as const)("maps %s to its label key %s", (severity, labelKey) => {
    expect(severityVisual(severity).labelKey).toBe(labelKey);
  });
});

describe("alertMessage", () => {
  it("names the robot in the sentence of the kind", () => {
    expect(alertMessage(alertOf({ kind: "BLOCKED", robotId: "sim-03" }), t)).toBe("sim-03 blocked");
  });
});

describe("actorLabel", () => {
  it("says you for the signed-in user", () => {
    expect(actorLabel("sub-abc-1a2b", "sub-abc-1a2b", t)).toBe("you");
  });

  it("identifies another operator by the last four characters of the subject", () => {
    expect(actorLabel("sub-0f9e-1a2b", "someone-else", t)).toBe("operator 1a2b");
  });

  it("does not say you when signed out", () => {
    expect(actorLabel("sub-1a2b", null, t)).toBe("operator 1a2b");
  });
});

describe("newestPillAlert", () => {
  it("ignores acknowledged, minor and info alerts", () => {
    const result = newestPillAlert([
      alertOf({
        alertId: "a".repeat(32),
        status: "ACKNOWLEDGED",
        acknowledgedBy: "x",
        acknowledgedAt: "2026-11-03T10:00:05.000Z",
      }),
      alertOf({ alertId: "b".repeat(32), severity: "MINOR", kind: "LOW_BATTERY" }),
    ]);
    expect(result).toEqual({ alert: null, count: 0 });
  });

  it("shows the most urgent alert first, then the newest", () => {
    const major = alertOf({
      alertId: "1".repeat(32),
      severity: "MAJOR",
      openedAt: "2026-11-03T10:05:00.000Z",
    });
    const oldCritical = alertOf({
      alertId: "2".repeat(32),
      severity: "CRITICAL",
      kind: "ESTOP",
      robotId: "sim-01",
      openedAt: "2026-11-03T10:00:00.000Z",
    });
    const newCritical = alertOf({
      alertId: "3".repeat(32),
      severity: "CRITICAL",
      kind: "ESTOP",
      robotId: "sim-02",
      openedAt: "2026-11-03T10:06:00.000Z",
    });
    const result = newestPillAlert([major, oldCritical, newCritical]);
    expect(result.count).toBe(3);
    expect(result.alert?.alertId).toBe(newCritical.alertId);
  });
});

describe("hasOpenCritical", () => {
  it("is true only for an open Critical alert", () => {
    expect(hasOpenCritical([alertOf({ severity: "CRITICAL", kind: "ESTOP" })])).toBe(true);
    expect(hasOpenCritical([alertOf({ severity: "MAJOR" })])).toBe(false);
  });
});

describe("groupBySeverity", () => {
  it("orders groups from Critical to Info and leaves out empty groups", () => {
    const groups = groupBySeverity([
      alertOf({ alertId: "1".repeat(32), severity: "MINOR", kind: "LOW_BATTERY" }),
      alertOf({ alertId: "2".repeat(32), severity: "MAJOR" }),
      alertOf({ alertId: "3".repeat(32), severity: "CRITICAL", kind: "ESTOP" }),
    ]);
    expect(groups.map((group) => group.severity)).toEqual(["CRITICAL", "MAJOR", "MINOR"]);
  });
});

describe("newestResolvedFirst", () => {
  it("puts the most recent resolution first", () => {
    const earlier = alertOf({
      alertId: "1".repeat(32),
      status: "RESOLVED",
      acknowledgedBy: "x",
      acknowledgedAt: "2026-11-03T10:00:05.000Z",
      resolvedBy: "x",
      resolvedAt: "2026-11-03T10:01:00.000Z",
    });
    const later = alertOf({
      alertId: "2".repeat(32),
      status: "RESOLVED",
      acknowledgedBy: "x",
      acknowledgedAt: "2026-11-03T10:00:05.000Z",
      resolvedBy: "x",
      resolvedAt: "2026-11-03T10:09:00.000Z",
    });
    expect(newestResolvedFirst([earlier, later]).map((alert) => alert.alertId)).toEqual([
      later.alertId,
      earlier.alertId,
    ]);
  });
});

describe("canActOnAlerts", () => {
  it.each([
    ["Operator", true],
    ["Admin", true],
    ["Viewer", false],
    [null, false],
  ] as const)("%s may act: %s", (role, expected) => {
    expect(canActOnAlerts(role)).toBe(expected);
  });
});

describe("actionErrorKey", () => {
  it("maps a conflict and a missing alert to their messages", () => {
    expect(actionErrorKey(new ApiError("request", 409, null))).toBe("error.conflict");
    expect(actionErrorKey(new ApiError("request", 404, null))).toBe("error.notFound");
  });

  it("gives the generic message for any other failure", () => {
    expect(actionErrorKey(new ApiError("server", 500, null))).toBe("error.action");
    expect(actionErrorKey(new Error("boom"))).toBe("error.action");
  });
});
