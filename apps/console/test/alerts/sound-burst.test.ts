/**
 * Burst gate: one sound pattern plays at most once per window, each pattern has its own window, and a clock that
 * goes backwards does not silence the alerts.
 */
import { describe, expect, it } from "vitest";
import { createBurstGate } from "../../src/alerts/sound-burst";

const WINDOW_MS = 300;

describe("createBurstGate", () => {
  it("lets the first request through", () => {
    const gate = createBurstGate(WINDOW_MS, () => 1_000);
    expect(gate.allow("major")).toBe(true);
  });

  it("merges a second request of the same pattern inside the window", () => {
    let now = 1_000;
    const gate = createBurstGate(WINDOW_MS, () => now);
    expect(gate.allow("major")).toBe(true);
    now += WINDOW_MS - 1;
    expect(gate.allow("major")).toBe(false);
  });

  it("lets the pattern through again once the window has passed", () => {
    let now = 1_000;
    const gate = createBurstGate(WINDOW_MS, () => now);
    expect(gate.allow("critical")).toBe(true);
    now += WINDOW_MS;
    expect(gate.allow("critical")).toBe(true);
  });

  it("keeps a separate window for each pattern", () => {
    const gate = createBurstGate(WINDOW_MS, () => 1_000);
    expect(gate.allow("critical")).toBe(true);
    expect(gate.allow("major")).toBe(true);
    expect(gate.allow("critical")).toBe(false);
  });

  it("restarts the window when the clock goes backwards", () => {
    let now = 5_000;
    const gate = createBurstGate(WINDOW_MS, () => now);
    expect(gate.allow("major")).toBe(true);
    now = 1_000;
    expect(gate.allow("major")).toBe(true);
  });

  it("does not extend the window by merged requests", () => {
    let now = 1_000;
    const gate = createBurstGate(WINDOW_MS, () => now);
    expect(gate.allow("major")).toBe(true);
    now += 200;
    expect(gate.allow("major")).toBe(false);
    now += 100;
    expect(gate.allow("major")).toBe(true);
  });
});
