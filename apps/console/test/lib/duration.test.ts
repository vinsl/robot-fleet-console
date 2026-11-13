/**
 * Duration formatting: seconds, minutes, hours with padded minutes, and refusal of non-finite input.
 */
import i18next, { type TFunction } from "i18next";
import { beforeAll, describe, expect, it } from "vitest";
import { formatDuration } from "../../src/lib/duration";

let t: TFunction;

beforeAll(async () => {
  const instance = i18next.createInstance();
  await instance.init({
    lng: "en",
    resources: {
      en: {
        common: {
          duration: {
            seconds: "{{count}} s",
            minutes: "{{count}} min",
            hoursMinutes: "{{hours}} h {{minutes}} min",
          },
        },
      },
    },
    interpolation: { escapeValue: false },
  });
  t = instance.getFixedT("en", "common");
});

describe("formatDuration", () => {
  it("shows whole seconds below one minute", () => {
    expect(formatDuration(12_900, t)).toBe("12 s");
    expect(formatDuration(0, t)).toBe("0 s");
  });

  it("shows whole minutes below one hour", () => {
    expect(formatDuration(180_000, t)).toBe("3 min");
    expect(formatDuration(3_599_999, t)).toBe("59 min");
  });

  it("shows hours and zero-padded minutes from one hour", () => {
    expect(formatDuration(7_500_000, t)).toBe("2 h 05 min");
    expect(formatDuration(3_600_000, t)).toBe("1 h 00 min");
  });

  it("clamps a negative duration to zero", () => {
    expect(formatDuration(-5_000, t)).toBe("0 s");
  });

  it("refuses a value that is not finite", () => {
    expect(() => formatDuration(Number.NaN, t)).toThrow(RangeError);
    expect(() => formatDuration(Number.POSITIVE_INFINITY, t)).toThrow(RangeError);
  });
});
