/**
 * The open-alert count shown by the dock and the status line: only alerts still waiting for an operator count.
 */
import { describe, expect, it } from "vitest";
import { countOpenAlerts } from "../../src/layout/open-alerts";
import { alertOf } from "../live/support";

describe("countOpenAlerts", () => {
  it("counts nothing for an empty list", () => {
    expect(countOpenAlerts([])).toBe(0);
  });

  it("counts OPEN alerts and leaves out acknowledged ones", () => {
    const alerts = [
      alertOf({ alertId: "0123456789abcdef0123456789abcdef" }),
      alertOf({
        alertId: "11111111111111111111111111111111",
        robotId: "sim-04",
        kind: "ESTOP",
        severity: "CRITICAL",
      }),
      alertOf({
        alertId: "22222222222222222222222222222222",
        status: "ACKNOWLEDGED",
        acknowledgedBy: "00000000-0000-4000-8000-000000000001",
        acknowledgedAt: "2026-11-03T10:01:00.000Z",
      }),
    ];
    expect(countOpenAlerts(alerts)).toBe(2);
  });
});
