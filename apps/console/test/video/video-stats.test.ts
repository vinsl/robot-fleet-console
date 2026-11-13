import { describe, expect, it } from "vitest";
import { roundTripMsFromReport } from "../../src/video/video-stats";

/** A candidate pair entry as the browser reports it, with an address field that must never be read. */
function pair(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "candidate-pair",
    id: "pair-1",
    state: "succeeded",
    nominated: true,
    selected: false,
    currentRoundTripTime: 0.212,
    localCandidateId: "local-1",
    remoteCandidateId: "remote-1",
    address: "203.0.113.7",
    port: 51000,
    ...overrides,
  };
}

describe("roundTripMsFromReport", () => {
  it("reads the round trip of the pair the transport selects, in milliseconds", () => {
    const report: unknown[] = [
      { type: "transport", id: "T01", selectedCandidatePairId: "pair-1" },
      pair({ id: "pair-2", currentRoundTripTime: 0.9 }),
      pair({}),
    ];

    expect(roundTripMsFromReport(report)).toBeCloseTo(212, 6);
  });

  it("falls back to a pair flagged as selected when there is no transport entry", () => {
    const report: unknown[] = [
      pair({ selected: true, nominated: false, currentRoundTripTime: 0.05 }),
    ];

    expect(roundTripMsFromReport(report)).toBeCloseTo(50, 6);
  });

  it("falls back to a nominated pair that succeeded", () => {
    const report: unknown[] = [pair({ state: "in-progress", nominated: false }), pair({})];

    expect(roundTripMsFromReport(report)).toBeCloseTo(212, 6);
  });

  it("returns null when the selected pair has no measured round trip yet", () => {
    const report: unknown[] = [pair({ currentRoundTripTime: undefined })];

    expect(roundTripMsFromReport(report)).toBeNull();
  });

  it("returns null for a negative or non-finite round trip", () => {
    expect(roundTripMsFromReport([pair({ currentRoundTripTime: -1 })])).toBeNull();
    expect(roundTripMsFromReport([pair({ currentRoundTripTime: Number.NaN })])).toBeNull();
  });

  it("returns null when no pair matches any rule", () => {
    expect(roundTripMsFromReport([pair({ state: "failed", nominated: false })])).toBeNull();
    expect(roundTripMsFromReport([])).toBeNull();
  });

  it("skips entries that do not match their schema instead of failing the report", () => {
    const report: unknown[] = [
      null,
      "text",
      { type: "codec" },
      { type: "candidate-pair" },
      pair({}),
    ];

    expect(roundTripMsFromReport(report)).toBeCloseTo(212, 6);
  });
});
