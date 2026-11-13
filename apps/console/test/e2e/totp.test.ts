import { describe, expect, it, vi } from "vitest";
import { base32Decode, nextFreshCode, stepOf, totp } from "../../e2e/support/totp";

/** The public RFC 6238 test secret (ASCII "12345678901234567890") in base32; not a credential. */
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // gitleaks:allow

describe("totp", () => {
  it.each([
    ["the RFC 6238 vector at 59 s", 59_000, "287082"],
    ["the RFC 6238 vector at 1111111109 s", 1_111_111_109_000, "081804"],
    ["the RFC 6238 vector at 1234567890 s", 1_234_567_890_000, "005924"],
    ["the RFC 6238 vector at 2000000000 s", 2_000_000_000_000, "279037"],
  ])("gives the expected code for %s", (_label, atMs, expected) => {
    expect(totp(RFC_SECRET, atMs)).toBe(expected);
  });

  it("keeps the same code for every instant of one 30 s step", () => {
    expect(totp(RFC_SECRET, 60_000)).toBe(totp(RFC_SECRET, 89_999));
  });

  it("pads the code with leading zeros to the requested length", () => {
    expect(totp(RFC_SECRET, 1_234_567_890_000, 8)).toBe("89005924");
    expect(totp(RFC_SECRET, 1_111_111_109_000, 8)).toBe("07081804");
  });
});

describe("base32Decode", () => {
  it("decodes the canonical secret", () => {
    expect(Buffer.from(base32Decode(RFC_SECRET)).toString("latin1")).toBe("12345678901234567890");
  });

  it("ignores case, spaces and padding", () => {
    const grouped = "gezd gnbv gy3t qojq gezd gnbv gy3t qojq====";
    expect(base32Decode(grouped)).toEqual(base32Decode(RFC_SECRET));
  });

  it("refuses a character outside the alphabet", () => {
    expect(() => base32Decode("GEZDGNB1")).toThrow(/outside the alphabet/);
  });

  it("refuses an empty secret", () => {
    expect(() => base32Decode("  ==  ")).toThrow(/empty/);
  });
});

describe("stepOf", () => {
  it("maps every instant of a 30 s window to one step", () => {
    expect(stepOf(59_999)).toBe(1);
    expect(stepOf(60_000)).toBe(2);
  });
});

describe("nextFreshCode", () => {
  it("waits for the next step and returns the code of that step", async () => {
    const start = 1_000_000;
    let clock = start;
    const usedStep = stepOf(start);
    const firstCode = totp(RFC_SECRET, start);
    const code = await nextFreshCode(
      RFC_SECRET,
      usedStep,
      () => clock,
      (ms) => {
        clock += ms;
        return Promise.resolve();
      },
    );
    expect(stepOf(clock)).toBeGreaterThan(usedStep);
    expect(code).toBe(totp(RFC_SECRET, clock));
    expect(code).not.toBe(firstCode);
  });

  it("returns at once when the step has already changed", async () => {
    const code = await nextFreshCode(
      RFC_SECRET,
      stepOf(1_000_000) - 1,
      () => 1_000_000,
      () => Promise.reject(new Error("no sleep expected")),
    );
    expect(code).toBe(totp(RFC_SECRET, 1_000_000));
  });

  it("rejects after 35 s of waiting when the clock never advances", async () => {
    let sleeps = 0;
    await expect(
      nextFreshCode(
        RFC_SECRET,
        stepOf(1_000_000),
        () => 1_000_000,
        () => {
          sleeps += 1;
          return Promise.resolve();
        },
      ),
    ).rejects.toThrow(/35 seconds/);
    expect(sleeps).toBe(35);
  });

  it("waits on the real timers by default", async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    try {
      const pending = nextFreshCode(RFC_SECRET, stepOf(1_000_000));
      await vi.advanceTimersByTimeAsync(25_000);
      expect(await pending).toBe(totp(RFC_SECRET, 1_025_000));
    } finally {
      vi.useRealTimers();
    }
  });
});
