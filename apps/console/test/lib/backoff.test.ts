import { describe, expect, it } from "vitest";
import { computeBackoffMs, type BackoffOptions } from "../../src/lib/backoff";

const options: BackoffOptions = { baseMs: 100, capMs: 10_000 };

/** One invalid-input case: label, attempt, options and random source. */
type InvalidCase = readonly [string, number, BackoffOptions, () => number];

const invalidCases: readonly InvalidCase[] = [
  ["a negative attempt", -1, options, () => 0.5],
  ["a fractional attempt", 1.5, options, () => 0.5],
  ["a NaN attempt", Number.NaN, options, () => 0.5],
  ["an infinite attempt", Number.POSITIVE_INFINITY, options, () => 0.5],
  ["a zero base", 0, { baseMs: 0, capMs: 10 }, () => 0.5],
  ["a negative base", 0, { baseMs: -100, capMs: 10_000 }, () => 0.5],
  ["a NaN base", 0, { baseMs: Number.NaN, capMs: 10_000 }, () => 0.5],
  [
    "an infinite base",
    0,
    { baseMs: Number.POSITIVE_INFINITY, capMs: Number.POSITIVE_INFINITY },
    () => 0.5,
  ],
  ["a cap below the base", 0, { baseMs: 100, capMs: 50 }, () => 0.5],
  ["a draw of exactly one", 0, options, () => 1],
  ["a draw above one", 0, options, () => 1.5],
  ["a negative draw", 0, options, () => -0.1],
  ["a NaN draw", 0, options, () => Number.NaN],
];

/**
 * Linear congruential generator returning draws in `[0, 1)`.
 *
 * Used instead of `Math.random` so that sweeps are reproducible run after run. The
 * multiplier and increment are the Numerical Recipes constants; with a 32-bit state the
 * product stays below 2 ** 53, so every intermediate value is an exact double.
 *
 * @param seed - Initial state.
 * @returns A draw source.
 */
function lcgDraws(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

describe("computeBackoffMs", () => {
  it("scales the first attempt by the random draw", () => {
    expect(computeBackoffMs(0, options, () => 0.5)).toBe(50);
  });

  it("doubles the window with each attempt until the cap is reached", () => {
    expect(computeBackoffMs(1, options, () => 0.5)).toBe(100);
    expect(computeBackoffMs(2, options, () => 0.5)).toBe(200);
    // Window of attempt 6 is 6 400 ms, still under the cap.
    expect(computeBackoffMs(6, options, () => 0.5)).toBe(3_200);
    // Window of attempt 7 would be 12 800 ms, so the 10 000 ms cap applies.
    expect(computeBackoffMs(7, options, () => 0.5)).toBe(5_000);
  });

  it("stays strictly below the exponential ceiling for a draw close to one", () => {
    const delay = computeBackoffMs(3, options, () => 0.9999);
    expect(delay).toBeLessThan(800);
    expect(delay).toBe(799);
  });

  it("caps the delay for large attempt numbers", () => {
    expect(computeBackoffMs(10, options, () => 0.999_999)).toBeLessThanOrEqual(10_000);
    expect(computeBackoffMs(10, options, () => 0.999_999)).toBe(9_999);
  });

  it("stays finite for an absurdly large attempt number", () => {
    const delay = computeBackoffMs(10_000, options, () => 0.999_999);
    expect(Number.isFinite(delay)).toBe(true);
    expect(delay).toBeLessThanOrEqual(options.capMs);
  });

  it("returns zero when the draw is zero", () => {
    expect(computeBackoffMs(5, options, () => 0)).toBe(0);
  });

  it.each(invalidCases)("throws RangeError for %s", (_label, attempt, opts, random) => {
    expect(() => computeBackoffMs(attempt, opts, random)).toThrow(RangeError);
  });

  // Known production defect: NaN fails neither `capMs < baseMs` nor any other check, so a
  it("throws RangeError for a NaN cap, which fails every comparison", () => {
    expect(() => computeBackoffMs(0, { baseMs: 100, capMs: Number.NaN }, () => 0.5)).toThrow(
      RangeError,
    );
  });

  // An infinite cap would let `baseMs * 2 ** 64` overflow, so the delay could be NaN or Infinity.
  it("throws RangeError for an infinite cap", () => {
    expect(() =>
      computeBackoffMs(64, { baseMs: 1e308, capMs: Number.POSITIVE_INFINITY }, () => 0),
    ).toThrow(RangeError);
  });
});

describe("computeBackoffMs output bounds", () => {
  const sweepOptions: readonly BackoffOptions[] = [
    { baseMs: 100, capMs: 10_000 },
    { baseMs: 1, capMs: 1 },
    { baseMs: 0.5, capMs: 7.25 },
    { baseMs: 250, capMs: 250_000 },
  ];

  // The edges of the draw interval are included explicitly, followed by seeded random draws.
  const generator = lcgDraws(20_261_031);
  const draws = [0, 0.5, 1 - 2 ** -53, ...Array.from({ length: 200 }, () => generator())];

  it("keeps every delay a whole number within [0, capMs] over attempts and draws", () => {
    const violations: string[] = [];
    for (const opts of sweepOptions) {
      for (let attempt = 0; attempt <= 100; attempt += 1) {
        for (const draw of draws) {
          const delay = computeBackoffMs(attempt, opts, () => draw);
          const withinBounds = Number.isInteger(delay) && delay >= 0 && delay <= opts.capMs;
          if (!withinBounds) {
            violations.push(
              `attempt=${String(attempt)} base=${String(opts.baseMs)} cap=${String(opts.capMs)} ` +
                `draw=${String(draw)} delay=${String(delay)}`,
            );
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
