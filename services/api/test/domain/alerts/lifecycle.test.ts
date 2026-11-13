import { describe, expect, it } from "vitest";
import type { AlertAction, AlertStatus } from "@mfc/protocol";
import { ZodError } from "zod";
import {
  acknowledged,
  actionInstant,
  planOf,
  resolved,
} from "../../../src/domain/alerts/lifecycle";
import { ALERT_PROBLEMS } from "../../../src/domain/alerts/problems";
import { alertOf, OPENED_AT } from "../../fakes/alerts";

const LATER = "2026-11-02T10:05:00.000Z";

describe("planOf", () => {
  const table: [AlertAction, AlertStatus, ReturnType<typeof planOf>][] = [
    ["acknowledge", "OPEN", "apply"],
    ["acknowledge", "ACKNOWLEDGED", "replay"],
    ["acknowledge", "RESOLVED", { refuse: ALERT_PROBLEMS.alreadyResolved }],
    ["resolve", "OPEN", { refuse: ALERT_PROBLEMS.acknowledgeFirst }],
    ["resolve", "ACKNOWLEDGED", "apply"],
    ["resolve", "RESOLVED", "replay"],
  ];

  it.each(table)("plans %s on %s", (action, status, expected) => {
    expect(planOf(action, status)).toEqual(expected);
  });
});

describe("acknowledged", () => {
  it("moves an OPEN alert to ACKNOWLEDGED with the operator and the instant", () => {
    const next = acknowledged(alertOf(), "user-sub-1", LATER);
    expect(next.status).toBe("ACKNOWLEDGED");
    expect(next.acknowledgedBy).toBe("user-sub-1");
    expect(next.acknowledgedAt).toBe(LATER);
    expect(next.resolvedAt).toBeUndefined();
  });

  it("refuses a caller that did not check the status first", () => {
    const acked = acknowledged(alertOf(), "user-sub-1", LATER);
    expect(() => acknowledged(acked, "user-sub-2", LATER)).toThrow(ZodError);
  });
});

describe("resolved", () => {
  it("moves an ACKNOWLEDGED alert to RESOLVED and keeps the acknowledgement", () => {
    const acked = acknowledged(alertOf(), "user-sub-1", LATER);
    const next = resolved(acked, "user-sub-2", "2026-11-02T10:10:00.000Z");
    expect(next.status).toBe("RESOLVED");
    expect(next.resolvedBy).toBe("user-sub-2");
    expect(next.resolvedAt).toBe("2026-11-02T10:10:00.000Z");
    expect(next.acknowledgedBy).toBe("user-sub-1");
    expect(next.acknowledgedAt).toBe(LATER);
  });

  it("refuses an OPEN alert, which must be acknowledged first", () => {
    expect(() => resolved(alertOf(), "user-sub-1", LATER)).toThrow(ZodError);
  });
});

describe("actionInstant", () => {
  it("returns the server clock when it is after the opening", () => {
    expect(actionInstant(new Date(LATER), OPENED_AT)).toBe(LATER);
  });

  it("never returns an instant before the opening, when the clock is earlier", () => {
    expect(actionInstant(new Date("2026-11-02T09:59:00.000Z"), OPENED_AT)).toBe(OPENED_AT);
  });
});
