import { describe, expect, it } from "vitest";
import { RobotIdSchema, SiteIdSchema } from "../src/index";

describe.each([
  ["RobotIdSchema", RobotIdSchema],
  ["SiteIdSchema", SiteIdSchema],
])("%s", (_name, schema) => {
  it.each(["amr-01", "abc", "a".repeat(32)])("accepts %j", (value) => {
    expect(schema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["too short", "ab"],
    ["too long", "a".repeat(33)],
    ["uppercase", "AMR-01"],
    ["underscore", "amr_01"],
    ["empty", ""],
    ["leading space", " amr-01"],
    ["not a string", 42],
  ])("rejects %s", (_label, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });
});
