/**
 * Tests of the connection lifetime: the session end, the two-hour cap, and the connection record shape.
 */
import { describe, expect, it } from "vitest";
import {
  ConnectionRecordSchema,
  connectionExpiresAtSeconds,
  sessionEnded,
} from "../../../src/domain/ws/session";

const CONNECTED_MS = Date.parse("2026-11-02T10:00:00.000Z");

describe("sessionEnded", () => {
  it("treats a session that ends at the current instant as ended", () => {
    expect(sessionEnded(1000, 1000)).toBe(true);
    expect(sessionEnded(1000, 999)).toBe(false);
  });
});

describe("connectionExpiresAtSeconds", () => {
  it("uses the session end when it comes before the two-hour cap", () => {
    const sessionEnd = CONNECTED_MS + 55 * 60 * 1000;
    expect(
      connectionExpiresAtSeconds({ connectedAtMs: CONNECTED_MS, sessionExpiresAtMs: sessionEnd }),
    ).toBe(sessionEnd / 1000 + 60);
  });

  it("caps the record at two hours after the connection, whatever the session end", () => {
    const sessionEnd = CONNECTED_MS + 5 * 60 * 60 * 1000;
    expect(
      connectionExpiresAtSeconds({ connectedAtMs: CONNECTED_MS, sessionExpiresAtMs: sessionEnd }),
    ).toBe((CONNECTED_MS + 2 * 60 * 60 * 1000) / 1000 + 60);
  });
});

describe("ConnectionRecordSchema", () => {
  const valid = {
    connectionId: "abcdef12",
    sub: "00000000-0000-4000-8000-000000000001",
    role: "Viewer",
    siteId: "paris-01",
    connectedAtMs: CONNECTED_MS,
    sessionExpiresAtMs: CONNECTED_MS + 1000,
    subscribed: false,
  };

  it("accepts a well-formed record", () => {
    expect(ConnectionRecordSchema.safeParse(valid).success).toBe(true);
  });

  it.each([
    ["a connection identifier with a slash", { connectionId: "abc/def" }],
    ["a short connection identifier", { connectionId: "abc" }],
    ["an unknown role", { role: "Superuser" }],
    ["a site with capitals", { siteId: "Paris-01" }],
    ["a negative connection time", { connectedAtMs: -1 }],
    ["a non-boolean subscription", { subscribed: "yes" }],
    ["an extra key", { sitePk: "SITE#paris-01" }],
  ])("refuses %s", (_label, change) => {
    expect(ConnectionRecordSchema.safeParse({ ...valid, ...change }).success).toBe(false);
  });
});
