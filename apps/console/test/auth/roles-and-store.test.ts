/**
 * Role derivation from Cognito groups, and the authentication store the UI reads.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useAuthStore } from "../../src/auth/auth-store";
import { isRoleAllowed, roleFromGroups } from "../../src/auth/roles";

describe("roleFromGroups", () => {
  it("returns the highest role of several groups", () => {
    expect(roleFromGroups(["Viewer", "Admin"])).toBe("Admin");
    expect(roleFromGroups(["Operator", "Viewer"])).toBe("Operator");
  });

  it("ignores groups that are not console roles", () => {
    expect(roleFromGroups(["Intruder", "Viewer"])).toBe("Viewer");
  });

  it("returns null when no group is a console role", () => {
    expect(roleFromGroups(["Intruder"])).toBeNull();
    expect(roleFromGroups([])).toBeNull();
  });
});

describe("isRoleAllowed", () => {
  it("allows only the listed roles, and nobody when signed out", () => {
    expect(isRoleAllowed("Admin", ["Admin"])).toBe(true);
    expect(isRoleAllowed("Operator", ["Admin"])).toBe(false);
    expect(isRoleAllowed("Viewer", ["Admin", "Operator"])).toBe(false);
    expect(isRoleAllowed(null, ["Admin"])).toBe(false);
  });
});

describe("useAuthStore", () => {
  beforeEach(() => {
    useAuthStore.setState({ status: "anonymous", role: null, step: null, signOutReason: null });
  });

  it("is authenticated with the derived role when a session is applied", () => {
    useAuthStore
      .getState()
      .applySession({ userId: "sub-1", groups: ["Operator"], expiresAtMs: 0 }, null);
    expect(useAuthStore.getState()).toMatchObject({
      status: "authenticated",
      role: "Operator",
      step: null,
    });
  });

  it("is anonymous with the expiry reason when the session ended by expiry", () => {
    useAuthStore
      .getState()
      .applySession({ userId: "sub-1", groups: ["Admin"], expiresAtMs: 0 }, null);
    useAuthStore.getState().applySession(null, "expired");
    expect(useAuthStore.getState()).toMatchObject({
      status: "anonymous",
      role: null,
      signOutReason: "expired",
    });
  });

  it("tracks the sign-in step and the authenticating status", () => {
    useAuthStore.getState().beginSignIn();
    expect(useAuthStore.getState().status).toBe("authenticating");
    useAuthStore.getState().setStep({ kind: "totp-required" });
    expect(useAuthStore.getState().step).toEqual({ kind: "totp-required" });
  });
});
