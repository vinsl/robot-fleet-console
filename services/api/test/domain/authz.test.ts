/**
 * Authorisation rules: how the verified claims map to a principal, and how a route checks the role.
 *
 * Each rule has a row for the accepted shape and a row for the refused one, so that a loosened parser fails
 * here before it grants a role.
 */
import { DEMO_SITE_ID } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import { principalFromClaims, requireRole, sessionExpiresAtOf } from "../../src/domain/authz";

const SUB = "00000000-0000-4000-8000-000000000001";
const ACCESS = { sub: SUB, token_use: "access", client_id: "clientapp01" };

describe("principalFromClaims", () => {
  it("reads a list claim sent as an array", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": ["Operator"],
      }),
    ).toEqual({
      userId: SUB,
      role: "Operator",
      siteId: DEMO_SITE_ID,
    });
  });

  it("reads a list claim sent as a bracketed string, as the API Gateway authorizer does", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": "[Admin Operator]",
      })?.role,
    ).toBe("Admin");
  });

  it("reads a bare comma-separated string without brackets", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": "Viewer,Operator",
      })?.role,
    ).toBe("Operator");
  });

  it("gives the highest role when the user holds Admin and Viewer", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": ["Viewer", "Admin"],
      })?.role,
    ).toBe("Admin");
  });

  it("ignores an unknown group and keeps the console role", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": "[Intruder Viewer]",
      })?.role,
    ).toBe("Viewer");
  });

  it("refuses a token whose only group is unknown", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": ["Intruder"],
      }),
    ).toBeNull();
  });

  it("refuses an ID token, even when it carries a group, so it cannot be used as a bearer credential", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "id",
        client_id: "clientapp01",
        "cognito:groups": ["Admin"],
      }),
    ).toBeNull();
  });

  it("refuses an access token without a client identifier", () => {
    expect(
      principalFromClaims({ sub: SUB, token_use: "access", "cognito:groups": ["Admin"] }),
    ).toBeNull();
  });

  it("documents that a bracketed group list is split on spaces and commas, and only role names count", () => {
    expect(principalFromClaims({ ...ACCESS, "cognito:groups": "[Admin,Viewer]" })?.role).toBe(
      "Admin",
    );
    expect(principalFromClaims({ ...ACCESS, "cognito:groups": "[Viewer Intruder-x]" })?.role).toBe(
      "Viewer",
    );
    // The array form compares whole names: a name with a space is not a role there.
    expect(principalFromClaims({ ...ACCESS, "cognito:groups": ["Viewer Admin"] })).toBeNull();
  });

  it("refuses a token with no group claim", () => {
    expect(principalFromClaims({ sub: SUB })).toBeNull();
  });

  it("refuses a token with an empty group list", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": [],
      }),
    ).toBeNull();
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": "[]",
      }),
    ).toBeNull();
  });

  it("refuses a group claim of an unexpected type", () => {
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": 42,
      }),
    ).toBeNull();
    expect(
      principalFromClaims({
        sub: SUB,
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": [1, null],
      }),
    ).toBeNull();
  });

  it("refuses a token without a subject", () => {
    expect(
      principalFromClaims({
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": ["Admin"],
      }),
    ).toBeNull();
  });

  it("refuses a subject outside the identifier alphabet", () => {
    expect(
      principalFromClaims({
        sub: "user@example.com",
        token_use: "access",
        client_id: "clientapp01",
        "cognito:groups": ["Admin"],
      }),
    ).toBeNull();
  });
});

describe("requireRole", () => {
  const operator = { userId: SUB, role: "Operator", siteId: DEMO_SITE_ID } as const;

  it("accepts a principal whose role is listed", () => {
    expect(requireRole(operator, ["Admin", "Operator"])).toBe(true);
  });

  it("refuses a principal whose role is not listed", () => {
    expect(requireRole(operator, ["Admin"])).toBe(false);
  });

  it("refuses every principal when the route lists no role", () => {
    expect(requireRole(operator, [])).toBe(false);
  });
});

describe("sessionExpiresAtOf", () => {
  const EXP = 1_793_617_200;

  it("reads a numeric expiry in seconds as an ISO instant with milliseconds", () => {
    expect(sessionExpiresAtOf({ exp: EXP })).toBe("2026-11-02T11:00:00.000Z");
  });

  it("reads an expiry sent as a string", () => {
    expect(sessionExpiresAtOf({ exp: String(EXP) })).toBe("2026-11-02T11:00:00.000Z");
  });

  it("refuses a missing, fractional, non-numeric, zero, negative or oversized expiry", () => {
    for (const exp of [undefined, 12.5, "12.5", "soon", 0, -1, "", 10_000_000_000, "1e9"]) {
      expect(sessionExpiresAtOf({ exp })).toBeNull();
    }
  });
});
