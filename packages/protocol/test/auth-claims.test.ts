/**
 * Access token claims the console reads: the subject is required, the groups are optional, other claims pass.
 */
import { describe, expect, it } from "vitest";
import { CognitoAccessClaimsSchema } from "../src/index";

const SUB = "11111111-2222-3333-4444-555555555555";

describe("CognitoAccessClaimsSchema", () => {
  it("reads the subject and the groups and ignores the other claims", () => {
    const parsed = CognitoAccessClaimsSchema.parse({
      sub: SUB,
      "cognito:groups": ["Admin"],
      token_use: "access",
      scope: "aws.cognito.signin.user.admin",
    });
    expect(parsed).toEqual({ sub: SUB, "cognito:groups": ["Admin"] });
  });

  it("accepts a token without groups", () => {
    expect(CognitoAccessClaimsSchema.parse({ sub: SUB })["cognito:groups"]).toBeUndefined();
  });

  it.each([
    ["a missing subject", { "cognito:groups": ["Admin"] }],
    ["a subject with a space", { sub: "has space" }],
    ["groups that are not a list", { sub: SUB, "cognito:groups": "Admin" }],
  ])("rejects %s", (_label, claims) => {
    expect(CognitoAccessClaimsSchema.safeParse(claims).success).toBe(false);
  });
});
