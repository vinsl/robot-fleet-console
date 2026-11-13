/**
 * Audit list HTTP contract: the query takes a limit and a cursor and nothing else, and a page is bounded.
 */
import { describe, expect, it } from "vitest";
import {
  AUDIT_LIST_DEFAULT_LIMIT,
  AUDIT_LIST_MAX_LIMIT,
  AuditListQuerySchema,
  AuditListResponseSchema,
} from "../src/index";

const RECORD = {
  auditId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
  ts: "2026-11-02T10:00:00.000Z",
  siteId: "paris-01",
  robotId: "sim-01",
  actor: "vincent",
  actorSource: "mfc.admin",
  action: "command.pause",
  commandId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9e",
  result: "SUCCEEDED",
  correlationId: "corr-0001-abcd",
};

describe("AuditListQuerySchema", () => {
  it("defaults the limit when the caller sends no parameter", () => {
    expect(AuditListQuerySchema.parse({}).limit).toBe(AUDIT_LIST_DEFAULT_LIMIT);
  });

  it("reads the limit from the query string, as a number", () => {
    expect(AuditListQuerySchema.parse({ limit: "25" }).limit).toBe(25);
  });

  it.each([
    ["zero", "0"],
    ["above the maximum", String(AUDIT_LIST_MAX_LIMIT + 1)],
    ["a fraction", "1.5"],
  ])("refuses a limit of %s", (_label, limit) => {
    expect(AuditListQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it("accepts an opaque cursor of the alert grammar", () => {
    expect(AuditListQuerySchema.safeParse({ cursor: "abc_DEF-123" }).success).toBe(true);
    expect(AuditListQuerySchema.safeParse({ cursor: "abc=" }).success).toBe(false);
  });

  it("accepts a robot and a result filter together", () => {
    expect(AuditListQuerySchema.parse({ robotId: "sim-03", result: "REFUSED" })).toMatchObject({
      robotId: "sim-03",
      result: "REFUSED",
    });
  });

  it.each([
    ["an unknown result", { result: "refused" }],
    ["a robot identifier with a space", { robotId: "SIM 01" }],
    ["an empty robot identifier", { robotId: "" }],
    ["an actor filter", { actor: "x" }],
    ["an action filter", { action: "command.pause" }],
  ])("refuses %s, which the list does not offer in that form", (_label, query) => {
    expect(AuditListQuerySchema.safeParse(query).success).toBe(false);
  });
});

describe("AuditListResponseSchema", () => {
  it("accepts a page with records and a next cursor, and an empty page", () => {
    expect(
      AuditListResponseSchema.safeParse({ items: [RECORD], nextCursor: "abc_DEF-123" }).success,
    ).toBe(true);
    expect(AuditListResponseSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it("refuses a page of more records than the maximum", () => {
    const items = Array.from({ length: AUDIT_LIST_MAX_LIMIT + 1 }, () => RECORD);
    expect(AuditListResponseSchema.safeParse({ items }).success).toBe(false);
  });

  it("refuses a record that does not satisfy the audit record schema", () => {
    const withoutCommand = Object.fromEntries(
      Object.entries(RECORD).filter(([name]) => name !== "commandId"),
    );
    expect(AuditListResponseSchema.safeParse({ items: [withoutCommand] }).success).toBe(false);
  });
});
