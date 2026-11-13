/**
 * In-memory stand-in for the authentication client, used only by the end-to-end build (`VITE_E2E=true`).
 *
 * The production build never contains this module: `vite.config.ts` replaces the flag with a constant, so the
 * dynamic import in `main.tsx` is dead code and is removed (checked on the built bundle). The accounts and the
 * TOTP code below are fixed test fixtures; they open nothing outside the console and carry no real credential.
 *
 * Sign-in is the later-login path only: the password, then a TOTP code. The first-login steps are covered by
 * the unit tests of the real client.
 */
import type { AuthClient, AuthStep, Session, SignOutReason } from "./cognito-client";
import { AuthError } from "./cognito-client";

/**
 * Marker of the fixture build. `scripts/check-console-fixtures.mjs` fails a production build that contains it.
 * It is used at runtime (as the fixture token), so the bundler keeps it when the fake is included.
 */
export const FIXTURE_MARKER = "mfc-e2e-fixture-v1";

/** Password of every fixture account. */
const FIXTURE_PASSWORD = "e2e-password";

/** TOTP code the fixture accepts. */
const FIXTURE_TOTP_CODE = "123456";

/** Lifetime of the fixture session, in milliseconds. */
const FIXTURE_SESSION_MS = 3_600_000;

/** Fixture accounts: email to Cognito group. */
const FIXTURE_GROUPS: ReadonlyMap<string, string> = new Map([
  ["e2e-admin@example.test", "Admin"],
  ["e2e-operator@example.test", "Operator"],
  ["e2e-viewer@example.test", "Viewer"],
]);

/** Listener of session changes, as in the real client. */
type Listener = (session: Session | null, reason: SignOutReason | null) => void;

/**
 * Creates the fake client. Its state lives in the page only, so a reload signs the user out, as in production.
 *
 * @returns An authentication client that answers from fixtures.
 */
export function createFakeAuthClient(): AuthClient {
  const listeners = new Set<Listener>();
  let session: Session | null = null;
  let pendingUser: Session | null = null;

  /**
   * Stores the session and tells the listeners.
   *
   * @param next - The new session, or `null`.
   */
  function publish(next: Session | null): void {
    session = next;
    for (const listener of listeners) {
      listener(next, null);
    }
  }

  return {
    signIn(email: string, password: string): Promise<AuthStep> {
      const group = FIXTURE_GROUPS.get(email);
      if (group === undefined || password !== FIXTURE_PASSWORD) {
        return Promise.reject(new AuthError("invalid"));
      }
      pendingUser = {
        userId: email,
        groups: [group],
        expiresAtMs: Date.now() + FIXTURE_SESSION_MS,
      };
      return Promise.resolve({ kind: "totp-required" });
    },

    completeNewPassword() {
      return Promise.reject(new AuthError("generic"));
    },

    verifyTotpSetup() {
      return Promise.reject(new AuthError("generic"));
    },

    submitTotp(code: string): Promise<AuthStep> {
      if (pendingUser === null) {
        return Promise.reject(new AuthError("generic"));
      }
      if (code !== FIXTURE_TOTP_CODE) {
        return Promise.reject(new AuthError("code"));
      }
      publish(pendingUser);
      pendingUser = null;
      return Promise.resolve({ kind: "signed-in" });
    },

    signOut() {
      pendingUser = null;
      publish(null);
      return Promise.resolve();
    },

    getAccessToken() {
      if (session === null) {
        return Promise.reject(new AuthError("expired"));
      }
      // The fixture token is not a JWT: the end-to-end build never calls the real API.
      return Promise.resolve(`${FIXTURE_MARKER}-access-token`);
    },

    getIdToken() {
      if (session === null) {
        return Promise.reject(new AuthError("expired"));
      }
      return Promise.resolve(`${FIXTURE_MARKER}-id-token`);
    },

    getSession() {
      return session;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
