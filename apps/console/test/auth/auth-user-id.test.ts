/**
 * The authentication store exposes the subject of the signed-in user, for "acknowledged by you", and clears it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { useAuthStore } from "../../src/auth/auth-store";

beforeEach(() => {
  useAuthStore.getState().applySession(null, null);
});

describe("auth store userId", () => {
  it("takes the subject from the session and clears it on sign-out", () => {
    useAuthStore
      .getState()
      .applySession({ userId: "sub-42", groups: ["Operator"], expiresAtMs: 0 }, null);
    expect(useAuthStore.getState().userId).toBe("sub-42");

    useAuthStore.getState().applySession(null, "expired");
    expect(useAuthStore.getState().userId).toBeNull();
  });
});
