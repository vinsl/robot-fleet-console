import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@mfc/protocol";
import { createCredentialProvider } from "../../src/video/kvs-credentials";

const { send, CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } = vi.hoisted(
  () => {
    const sendFn = vi.fn<(command: unknown) => Promise<unknown>>();
    class FakeIdentityClient {
      readonly send = sendFn;
    }
    class FakeGetId {
      constructor(readonly input: unknown) {}
    }
    class FakeGetCredentials {
      constructor(readonly input: unknown) {}
    }
    return {
      send: sendFn,
      CognitoIdentityClient: FakeIdentityClient,
      GetIdCommand: FakeGetId,
      GetCredentialsForIdentityCommand: FakeGetCredentials,
    };
  },
);

vi.mock("@aws-sdk/client-cognito-identity", () => ({
  CognitoIdentityClient,
  GetIdCommand,
  GetCredentialsForIdentityCommand,
}));

const CONFIG: RuntimeConfig = {
  apiUrl: "https://abc123defg.execute-api.eu-west-3.amazonaws.com",
  wsUrl: "wss://xyz987wvut.execute-api.eu-west-3.amazonaws.com/ws",
  region: "eu-west-3",
  userPoolId: "eu-west-3_AbCdEf123",
  userPoolClientId: "abcdefghijklmnopqrstuvwxyz",
  identityPoolId: "eu-west-3:11111111-2222-3333-4444-555555555555",
};

/** Lifetime of the fake credentials, as the identity pool issues them. */
const LIFETIME_MS = 60 * 60 * 1000;

/**
 * Makes the identity pool answer with credentials that expire `LIFETIME_MS` after the current fake time.
 *
 * @param issuedAt - The fake time of the answer, in milliseconds.
 */
function answerWithCredentials(issuedAt: number): void {
  send.mockImplementation((command: unknown) => {
    if (command instanceof GetIdCommand) {
      return Promise.resolve({ IdentityId: "eu-west-3:identity-1" });
    }
    if (command instanceof GetCredentialsForIdentityCommand) {
      return Promise.resolve({
        Credentials: {
          AccessKeyId: "ASIAFAKEKEY",
          SecretKey: "fake-secret",
          SessionToken: "fake-session",
          Expiration: new Date(issuedAt + LIFETIME_MS),
        },
      });
    }
    return Promise.reject(new Error("unexpected command"));
  });
}

/**
 * The ID token source of the tests: by default it always answers the same token.
 *
 * @param getIdToken - Replaces the answer, for a stalled refresh.
 * @returns The token source.
 */
function fakeAuth(getIdToken: () => Promise<string> = () => Promise.resolve("fake-id-token")): {
  getIdToken: () => Promise<string>;
} {
  return { getIdToken };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-11-04T10:00:00Z") });
  send.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createCredentialProvider", () => {
  it("credentials-cached-until-2-min-before-expiry: reuses the credentials while they are valid for more than 2 min", async () => {
    const issuedAt = Date.now();
    answerWithCredentials(issuedAt);
    const provider = createCredentialProvider(CONFIG, fakeAuth());

    const first = await provider();
    const second = await provider();
    expect(second).toBe(first);
    expect(send).toHaveBeenCalledTimes(2);

    vi.setSystemTime(issuedAt + LIFETIME_MS - 2 * 60 * 1000 - 1000);
    await provider();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("credentials-cached-until-2-min-before-expiry: exchanges again once less than 2 min remain", async () => {
    const issuedAt = Date.now();
    answerWithCredentials(issuedAt);
    const provider = createCredentialProvider(CONFIG, fakeAuth());
    await provider();

    vi.setSystemTime(issuedAt + LIFETIME_MS - 2 * 60 * 1000 + 1000);
    await provider();

    expect(send).toHaveBeenCalledTimes(4);
  });

  it("shares one exchange between concurrent calls", async () => {
    answerWithCredentials(Date.now());
    const provider = createCredentialProvider(CONFIG, fakeAuth());

    await Promise.all([provider(), provider(), provider()]);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends the ID token only to the identity pool, under the user pool login provider", async () => {
    answerWithCredentials(Date.now());
    const provider = createCredentialProvider(CONFIG, fakeAuth());

    await provider();

    const getId = send.mock.calls[0]?.[0] as { input: unknown };
    expect(getId.input).toEqual({
      IdentityPoolId: CONFIG.identityPoolId,
      Logins: {
        "cognito-idp.eu-west-3.amazonaws.com/eu-west-3_AbCdEf123": "fake-id-token",
      },
    });
  });

  it("rejects an answer without complete credentials, and does not cache it", async () => {
    send.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof GetIdCommand
          ? { IdentityId: "eu-west-3:identity-1" }
          : { Credentials: { AccessKeyId: "ASIAFAKEKEY" } },
      ),
    );
    const provider = createCredentialProvider(CONFIG, fakeAuth());

    await expect(provider()).rejects.toThrow("incomplete credentials");
    answerWithCredentials(Date.now());
    await expect(provider()).resolves.toMatchObject({ accessKeyId: "ASIAFAKEKEY" });
  });

  it("fails the exchange when the ID token refresh stalls, and does not cache the failure", async () => {
    const provider = createCredentialProvider(
      CONFIG,
      fakeAuth(() => new Promise<string>(() => undefined)),
    );

    const pending = expect(provider()).rejects.toThrow("credential exchange timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(send).not.toHaveBeenCalled();
    answerWithCredentials(Date.now());
    const provider2 = createCredentialProvider(CONFIG, fakeAuth());
    await expect(provider2()).resolves.toMatchObject({ accessKeyId: "ASIAFAKEKEY" });
  });
});
