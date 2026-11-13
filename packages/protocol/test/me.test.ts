/**
 * Identity response of `GET /me` and the problem types added for the HTTP API.
 *
 * The valid sample must parse; each rule (strict keys, role grammar, site grammar, subject grammar)
 * has its own rejected variant so that a loosened field fails here first.
 */
import { describe, expect, it } from "vitest";
import { DEMO_SITE_ID, MeSchema, PROBLEM_TYPES, ProblemSchema } from "../src/index";

const valid = {
  userId: "00000000-0000-4000-8000-000000000001",
  role: "Operator",
  siteId: DEMO_SITE_ID,
};

describe("MeSchema", () => {
  it("accepts a well-formed identity", () => {
    expect(MeSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an unknown claim so that no email or name leaks", () => {
    expect(MeSchema.safeParse({ ...valid, email: "user@example.com" }).success).toBe(false);
  });

  it("rejects a role outside the three console roles", () => {
    expect(MeSchema.safeParse({ ...valid, role: "Root" }).success).toBe(false);
  });

  it("rejects a subject with characters outside the UUID alphabet", () => {
    expect(MeSchema.safeParse({ ...valid, userId: "user@example.com" }).success).toBe(false);
  });

  it("rejects a site identifier outside the identifier grammar", () => {
    expect(MeSchema.safeParse({ ...valid, siteId: "Demo Site" }).success).toBe(false);
  });
});

describe("problem types", () => {
  it("publishes the types the HTTP API returns", () => {
    expect(PROBLEM_TYPES).toEqual(
      expect.arrayContaining([
        "unauthorized",
        "forbidden",
        "not-found",
        "payload-too-large",
        "rate-limited",
      ]),
    );
  });

  it("builds a valid problem for each published type", () => {
    for (const type of PROBLEM_TYPES) {
      const parsed = ProblemSchema.safeParse({
        type: `urn:mfc:problem:${type}`,
        title: "Title",
        status: 400,
        correlationId: "abcdef12-0001",
      });
      expect(parsed.success).toBe(true);
    }
  });
});
