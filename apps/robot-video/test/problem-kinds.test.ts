import { describe, expect, it } from "vitest";
import { messageKeyForProblem } from "../src/lib/problem-kinds";

describe("messageKeyForProblem", () => {
  it.each([
    ["claim-used", "claim.used"],
    ["claim-wrong", "claim.wrong"],
    ["claim-expired", "claim.expired"],
    ["claim-locked", "claim.locked"],
    ["credentials-unavailable", "status.credentialsUnavailable"],
    ["unauthorised", "error.unauthorised"],
    ["rate-limited", "error.rateLimited"],
  ] as const)("maps urn:mfc:problem:%s to %s", (suffix, key) => {
    expect(messageKeyForProblem(`urn:mfc:problem:${suffix}`)).toBe(key);
  });

  it("maps any other problem to the generic sentence", () => {
    expect(messageKeyForProblem("urn:mfc:problem:internal")).toBe("error.generic");
  });

  it("maps a type outside the agent's namespace to the generic sentence", () => {
    expect(messageKeyForProblem("https://example.com/other")).toBe("error.generic");
  });
});
