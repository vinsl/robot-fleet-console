/**
 * The end-to-end authentication client answers an ID token only inside a session, like the real client.
 */
import { describe, expect, it } from "vitest";
import { createFakeAuthClient, FIXTURE_MARKER } from "../../src/auth/fake-auth-client";

describe("fake authentication client", () => {
  it("refuses an ID token without a session, and serves a fixture one once signed in", async () => {
    const auth = createFakeAuthClient();
    await expect(auth.getIdToken()).rejects.toMatchObject({ kind: "expired" });

    await auth.signIn("e2e-operator@example.test", "e2e-password");
    await auth.submitTotp("123456");

    expect(await auth.getIdToken()).toContain(FIXTURE_MARKER);
  });
});
