import { describe, expect, it } from "vitest";
import { isChannelGone, VideoPageError } from "../src/lib/errors";
import {
  isExpired,
  needsRefresh,
  pickFresherSession,
  REFRESH_BEFORE_EXPIRY_MS,
  toRunSession,
} from "../src/lib/session";
import { sessionWithExpiry } from "./fixtures";

const NOW = new Date("2026-11-02T10:00:00.000Z");

/**
 * Returns a run session that expires `ms` after NOW.
 *
 * @param ms - Milliseconds of validity left.
 * @returns The session in the page's form.
 */
function expiringIn(ms: number): ReturnType<typeof toRunSession> {
  return toRunSession(sessionWithExpiry(new Date(NOW.getTime() + ms).toISOString()));
}

describe("toRunSession", () => {
  it("keeps the channel and turns the expiration into a Date", () => {
    const run = toRunSession(sessionWithExpiry("2026-11-02T11:00:00Z"));

    expect(run.robotId).toBe("kali-01");
    expect(run.channelName).toBe("mfc-demo-kali-01");
    expect(run.credentials.expiration).toEqual(new Date("2026-11-02T11:00:00Z"));
  });
});

describe("needsRefresh", () => {
  it("is false with more than 15 minutes left", () => {
    expect(needsRefresh(expiringIn(REFRESH_BEFORE_EXPIRY_MS + 1), NOW)).toBe(false);
  });

  it("is false at exactly 15 minutes left", () => {
    expect(needsRefresh(expiringIn(REFRESH_BEFORE_EXPIRY_MS), NOW)).toBe(false);
  });

  it("is true just under 15 minutes left", () => {
    expect(needsRefresh(expiringIn(REFRESH_BEFORE_EXPIRY_MS - 1), NOW)).toBe(true);
  });
});

describe("isExpired", () => {
  it("is false one millisecond before the expiry", () => {
    expect(isExpired(expiringIn(1), NOW)).toBe(false);
  });

  it("is true at the expiry instant", () => {
    expect(isExpired(expiringIn(0), NOW)).toBe(true);
  });

  it("is true after the expiry instant", () => {
    expect(isExpired(expiringIn(-1), NOW)).toBe(true);
  });
});

describe("pickFresherSession", () => {
  it("takes the session that expires later", () => {
    const current = expiringIn(60_000);
    const next = expiringIn(3_600_000);

    expect(pickFresherSession(current, next)).toBe(next);
  });

  it("ignores a session that expires earlier", () => {
    const current = expiringIn(3_600_000);
    const stale = expiringIn(60_000);

    expect(pickFresherSession(current, stale)).toBe(current);
  });

  it("keeps the current session when both expire at the same instant", () => {
    const current = expiringIn(60_000);
    const same = expiringIn(60_000);

    expect(pickFresherSession(current, same)).toBe(current);
  });
});

describe("isChannelGone", () => {
  it("recognises the AWS error of a page error carrying it as detail", () => {
    expect(isChannelGone(new VideoPageError("AWS_CALL_FAILED", "ResourceNotFoundException"))).toBe(
      true,
    );
  });

  it("recognises the SDK error itself", () => {
    const error = new Error("channel is gone");
    error.name = "ResourceNotFoundException";

    expect(isChannelGone(error)).toBe(true);
  });

  it.each([
    ["an access denial", new VideoPageError("AWS_CALL_FAILED", "AccessDeniedException")],
    ["a plain error", new Error("boom")],
    ["a value that is not an error", "ResourceNotFoundException"],
  ])("is false for %s", (_label, value: unknown) => {
    expect(isChannelGone(value)).toBe(false);
  });
});
