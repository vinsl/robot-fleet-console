/**
 * Sign-in sequences and token handling of the authentication client, with the Cognito library replaced by a
 * scripted fake (see `cognito-fake.ts`). The tests prove the protocol the client drives, not the library.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthError,
  createAuthClient,
  type AuthStep,
  type Session,
} from "../../src/auth/cognito-client";
import { MemoryStorage } from "../../src/auth/memory-storage";
import { lib } from "./cognito-fake";

vi.mock("amazon-cognito-identity-js", () => import("./cognito-fake"));

const SUB = "11111111-2222-3333-4444-555555555555";
const CONFIG = { userPoolId: "eu-west-3_EXAMPLE1", userPoolClientId: "examplecl1234567890example" };

/**
 * Builds a library session whose access token carries the given groups and expires after `expiresIn` seconds.
 *
 * @param groups - Cognito groups of the user.
 * @param expiresIn - Seconds until the access token expires.
 * @param tag - Distinguishes the token value between refreshes.
 * @returns A session shaped like the library's.
 */
function cognitoSession(groups: string[], expiresIn = 3600, tag = "first") {
  return {
    getAccessToken: () => ({
      payload: { sub: SUB, "cognito:groups": groups },
      getJwtToken: () => `jwt-${tag}`,
      getExpiration: () => Math.floor(Date.now() / 1000) + expiresIn,
    }),
    getIdToken: () => ({
      getJwtToken: () => `id-${tag}`,
      getExpiration: () => Math.floor(Date.now() / 1000) + expiresIn,
    }),
    getRefreshToken: () => ({ getToken: () => "refresh-token" }),
  };
}

/**
 * Drives the complete first-login sequence: new password, TOTP enrolment, verification.
 *
 * @param groups - Groups of the user in the issued session.
 * @param expiresIn - Access token lifetime, in seconds.
 * @returns The client, signed in.
 */
async function signedInAfterFirstLogin(groups: string[] = ["Admin"], expiresIn = 3600) {
  lib.script = {
    authenticate: (cb) => {
      cb.newPasswordRequired?.();
    },
    complete: (cb) => {
      cb.mfaSetup?.();
    },
    associate: (cb) => {
      cb.associateSecretCode("SECRET123");
    },
    verify: (_code, cb) => {
      cb.onSuccess(cognitoSession(groups, expiresIn));
    },
  };
  const client = createAuthClient(CONFIG);
  await client.signIn("ana@example.test", "temporary-pass-1");
  await client.completeNewPassword("Correct-horse-battery-1");
  await client.verifyTotpSetup("123456");
  return client;
}

beforeEach(() => {
  lib.script = {};
  lib.pools.length = 0;
  lib.storages.length = 0;
  lib.refreshCalls = 0;
  lib.localSignOuts = 0;
  lib.revocations = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sign-in sequence", () => {
  it("walks a first login: new password, TOTP enrolment, then signed in", async () => {
    let verifiedCode = "";
    lib.script = {
      authenticate: (cb) => {
        cb.newPasswordRequired?.();
      },
      complete: (cb) => {
        cb.mfaSetup?.();
      },
      associate: (cb) => {
        cb.associateSecretCode("SECRET123");
      },
      verify: (code, cb) => {
        verifiedCode = code;
        cb.onSuccess(cognitoSession(["Operator"]));
      },
    };
    const client = createAuthClient(CONFIG);

    expect(await client.signIn("ana@example.test", "temporary-pass-1")).toEqual({
      kind: "new-password",
    });
    const enrol = await client.completeNewPassword("Correct-horse-battery-1");
    expect(enrol.kind).toBe("totp-setup");
    if (enrol.kind !== "totp-setup") throw new Error("expected the TOTP enrolment step");
    expect(enrol.secretCode).toBe("SECRET123");
    expect(enrol.otpauthUri.startsWith("otpauth://totp/")).toBe(true);
    expect(enrol.otpauthUri).toContain("secret=SECRET123");

    expect(await client.verifyTotpSetup("123456")).toEqual({ kind: "signed-in" });
    expect(verifiedCode).toBe("123456");
    const session: Session | null = client.getSession();
    expect(session?.userId).toBe(SUB);
    expect(session?.groups).toEqual(["Operator"]);
  });

  it("answers the TOTP challenge of a later login with the software-token type", async () => {
    let usedType = "";
    lib.script = {
      authenticate: (cb) => {
        cb.totpRequired?.();
      },
      mfa: (_code, cb, type) => {
        usedType = type;
        cb.onSuccess(cognitoSession(["Viewer"]));
      },
    };
    const client = createAuthClient(CONFIG);

    const step: AuthStep = await client.signIn("ana@example.test", "pass");
    expect(step).toEqual({ kind: "totp-required" });
    expect(await client.submitTotp("654321")).toEqual({ kind: "signed-in" });
    expect(usedType).toBe("SOFTWARE_TOKEN_MFA");
  });

  it("refuses a code when no matching challenge is pending", async () => {
    const client = createAuthClient(CONFIG);
    await expect(client.submitTotp("123456")).rejects.toMatchObject({ kind: "generic" });
    await expect(client.completeNewPassword("x")).rejects.toMatchObject({ kind: "generic" });
  });
});

describe("error mapping", () => {
  it("gives the same category to an unknown user and to a wrong password", async () => {
    const kinds: string[] = [];
    for (const code of ["NotAuthorizedException", "UserNotFoundException"]) {
      lib.script = {
        authenticate: (cb) => {
          cb.onFailure(Object.assign(new Error("hidden detail"), { code }));
        },
      };
      const client = createAuthClient(CONFIG);
      const failure = await client
        .signIn("ghost@example.test", "whatever")
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AuthError);
      if (failure instanceof AuthError) kinds.push(failure.kind);
    }
    expect(kinds).toEqual(["invalid", "invalid"]);
  });

  it.each([
    ["CodeMismatchException", "code"],
    ["TooManyRequestsException", "locked"],
    ["LimitExceededException", "locked"],
    ["InvalidPasswordException", "password-policy"],
    ["SomethingNew", "generic"],
  ] as const)("maps %s to %s without leaking the library message", async (code, kind) => {
    lib.script = {
      authenticate: (cb) => {
        cb.onFailure(Object.assign(new Error("internal text"), { code }));
      },
    };
    const client = createAuthClient(CONFIG);
    const failure = await client
      .signIn("ana@example.test", "pass")
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AuthError);
    expect(failure).toMatchObject({ kind, message: `authentication failed: ${kind}` });
  });

  it("reports a transport failure as a network error", async () => {
    lib.script = {
      authenticate: (cb) => {
        cb.onFailure(new TypeError("Failed to fetch"));
      },
    };
    const client = createAuthClient(CONFIG);
    await expect(client.signIn("ana@example.test", "pass")).rejects.toMatchObject({
      kind: "network",
    });
  });
});

describe("storage", () => {
  it("never touches localStorage and gives the library the in-memory shim", async () => {
    const touched: string[] = [];
    const spy = new Proxy(
      {},
      {
        get: (_target, property) => {
          touched.push(String(property));
          return () => null;
        },
      },
    );
    vi.stubGlobal("localStorage", spy);

    await signedInAfterFirstLogin();

    expect(touched).toEqual([]);
    expect(lib.storages[0]).toBeInstanceOf(MemoryStorage);
    expect(lib.pools[0]).toMatchObject({ AdvancedSecurityDataCollectionFlag: false });
  });
});

describe("token handling", () => {
  it("refreshes once when several callers ask near expiry", async () => {
    const client = await signedInAfterFirstLogin(["Admin"], 30);
    lib.script.refresh = (callback) => {
      callback(null, cognitoSession(["Admin"], 3600, "second"));
    };

    const tokens = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);

    expect(lib.refreshCalls).toBe(1);
    expect(tokens).toEqual(["jwt-second", "jwt-second", "jwt-second"]);
  });

  it("does not refresh a valid token unless forced", async () => {
    const client = await signedInAfterFirstLogin(["Admin"], 3600);
    lib.script.refresh = (callback) => {
      callback(null, cognitoSession(["Admin"], 3600, "forced"));
    };

    expect(await client.getAccessToken()).toBe("jwt-first");
    expect(lib.refreshCalls).toBe(0);
    expect(await client.getAccessToken({ force: true })).toBe("jwt-forced");
    expect(lib.refreshCalls).toBe(1);
  });

  it("ends the session with reason expired when the refresh is refused", async () => {
    const client = await signedInAfterFirstLogin(["Admin"], 30);
    const seen: Array<{ session: Session | null; reason: string | null }> = [];
    client.onChange((session, reason) => {
      seen.push({ session, reason });
    });
    lib.script.refresh = (callback) => {
      callback(new Error("refresh token revoked"), undefined);
    };

    await expect(client.getAccessToken()).rejects.toMatchObject({ kind: "expired" });
    expect(client.getSession()).toBeNull();
    expect(seen).toEqual([{ session: null, reason: "expired" }]);
    expect(lib.localSignOuts).toBe(1);
  });

  it("get-id-token-refreshes-when-near-expiry", async () => {
    const client = await signedInAfterFirstLogin(["Admin"], 30);
    lib.script.refresh = (callback) => {
      callback(null, cognitoSession(["Admin"], 3600, "second"));
    };

    expect(await client.getIdToken()).toBe("id-second");
    expect(lib.refreshCalls).toBe(1);
  });

  it("get-id-token-keeps-a-valid-token-without-refreshing", async () => {
    const client = await signedInAfterFirstLogin(["Admin"], 3600);

    expect(await client.getIdToken()).toBe("id-first");
    expect(lib.refreshCalls).toBe(0);
  });

  it("id-token-never-persisted: the client writes no storage and exposes no token in the session", async () => {
    const setItem = vi.spyOn(MemoryStorage.prototype, "setItem");
    const client = await signedInAfterFirstLogin(["Admin"], 3600);

    await client.getIdToken();

    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(client.getSession())).not.toContain("id-first");
  });

  it("refuses a token when nobody is signed in", async () => {
    const client = createAuthClient(CONFIG);
    await expect(client.getAccessToken()).rejects.toMatchObject({ kind: "expired" });
  });
});

describe("ID token", () => {
  it("refuses an ID token when nobody is signed in", async () => {
    const client = createAuthClient(CONFIG);
    await expect(client.getIdToken()).rejects.toMatchObject({ kind: "expired" });
  });
});

describe("sign-out", () => {
  it("clears the session, revokes the tokens and notifies listeners once", async () => {
    const client = await signedInAfterFirstLogin();
    const seen: Array<Session | null> = [];
    const unsubscribe = client.onChange((session) => {
      seen.push(session);
    });

    await client.signOut();
    unsubscribe();

    expect(client.getSession()).toBeNull();
    expect(lib.revocations).toBe(1);
    expect(lib.localSignOuts).toBe(1);
    expect(seen).toEqual([null]);
  });
});
