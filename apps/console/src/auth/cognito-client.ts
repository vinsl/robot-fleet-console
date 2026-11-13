/*
 * The library is in AWS maintenance mode (Amplify JavaScript v5). It is kept on purpose for this demo: it
 * provides SRP and TOTP challenges without a hosted UI, and the console needs nothing else (ADR 0045). The
 * deprecation is therefore suppressed for this file only, and the migration path is recorded in the ADR.
 */
/* eslint-disable @typescript-eslint/no-deprecated */
/**
 * Sign-in, MFA and token management of the console, on top of `amazon-cognito-identity-js`.
 *
 * Tokens live only in this module's closure and in the in-memory storage shim (ADR 0045). Nothing is written
 * to `localStorage` or `sessionStorage`, so a page reload signs the user out (SEC-WEB-2). The sign-in
 * sequence is driven by the challenges Cognito returns: a first login sets a new password and enrols a TOTP
 * device, later logins only answer the TOTP challenge (ADR 0044).
 */
import {
  AuthenticationDetails,
  CognitoUser,
  CognitoUserPool,
  type CognitoUserSession,
  type IAuthenticationCallback,
} from "amazon-cognito-identity-js";
import { CognitoAccessClaimsSchema, type RuntimeConfig } from "@mfc/protocol";
import { MemoryStorage } from "./memory-storage";

/** Refresh the access token when less than this remains, so that a request never leaves with an expired one. */
const REFRESH_MARGIN_MS = 60_000;

/** Name of the TOTP device enrolled at first login. Shown in the user's authenticator app. */
const TOTP_DEVICE_NAME = "robot-fleet-console";

/** Issuer shown in the authenticator app next to the account name. */
const TOTP_ISSUER = "Fleet Console";

/**
 * The next thing the user must do to sign in. The sign-in view renders one form per step.
 */
export type AuthStep =
  | { readonly kind: "signed-in" }
  | { readonly kind: "new-password" }
  | { readonly kind: "totp-setup"; readonly secretCode: string; readonly otpauthUri: string }
  | { readonly kind: "totp-required" };

/** What the console knows about the signed-in user. It holds no token. */
export interface Session {
  /** Cognito subject of the user. */
  readonly userId: string;
  /** Cognito groups of the user, from the access token. */
  readonly groups: readonly string[];
  /** Access token expiry, in milliseconds since the epoch. */
  readonly expiresAtMs: number;
}

/** Why a session ended without the user asking for it. */
export type SignOutReason = "expired";

/** Category of an authentication failure. The sign-in view maps each one to a fixed message. */
export type AuthErrorKind =
  "invalid" | "code" | "locked" | "network" | "generic" | "expired" | "password-policy";

/**
 * Failure of an authentication operation. The message is fixed and never carries a Cognito message, so
 * nothing about the account (existence, lock state, password policy) reaches the screen.
 */
export class AuthError extends Error {
  /** Category of the failure. */
  readonly kind: AuthErrorKind;

  /**
   * @param kind - The failure category.
   */
  constructor(kind: AuthErrorKind) {
    super(`authentication failed: ${kind}`);
    this.name = "AuthError";
    this.kind = kind;
  }
}

/** Operations of the console's authentication client. */
export interface AuthClient {
  /**
   * Starts a sign-in with the account password.
   *
   * @param email - Account email, the Cognito username.
   * @param password - Account password. Never stored by the client.
   * @returns The next step.
   * @throws {AuthError} When the credentials are refused or the service is unavailable.
   */
  signIn(email: string, password: string): Promise<AuthStep>;
  /**
   * Answers the new-password challenge of a first login.
   *
   * @param newPassword - The password the user chose.
   * @returns The next step, normally the TOTP enrolment.
   * @throws {AuthError} When no such challenge is pending or the password is refused.
   */
  completeNewPassword(newPassword: string): Promise<AuthStep>;
  /**
   * Confirms the TOTP device enrolled at first login.
   *
   * @param code - Six-digit code shown by the authenticator app.
   * @returns `signed-in` when the code is correct.
   * @throws {AuthError} When no enrolment is pending or the code is wrong.
   */
  verifyTotpSetup(code: string): Promise<AuthStep>;
  /**
   * Answers the TOTP challenge of a later login.
   *
   * @param code - Six-digit code shown by the authenticator app.
   * @returns `signed-in` when the code is correct.
   * @throws {AuthError} When no challenge is pending or the code is wrong.
   */
  submitTotp(code: string): Promise<AuthStep>;
  /**
   * Ends the session. Local state is cleared before the revocation request, so a slow or failed network call
   * never keeps tokens in memory. The promise settles once the revocation has been attempted.
   */
  signOut(): Promise<void>;
  /**
   * Returns a bearer token for the API, refreshing it first when it is close to expiry.
   *
   * @param options - `force` refreshes even when the token is still valid.
   * @returns The access token.
   * @throws {AuthError} `expired` when there is no session or the refresh fails.
   */
  getAccessToken(options?: { readonly force?: boolean }): Promise<string>;
  /**
   * Returns the ID token, which the video slice exchanges for identity pool credentials. It is refreshed with the
   * same margin as the access token, and it is only ever handed to the caller: it is never stored by the client.
   *
   * @returns The ID token.
   * @throws {AuthError} `expired` when there is no session or the refresh fails.
   */
  getIdToken(): Promise<string>;
  /**
   * The current session, without any token.
   *
   * @returns The session, or `null` when signed out.
   */
  getSession(): Session | null;
  /**
   * Subscribes to session changes.
   *
   * @param listener - Called with the new session (or `null`) and the reason when the session ended by expiry.
   * @returns A function that removes the listener.
   */
  onChange(listener: (session: Session | null, reason: SignOutReason | null) => void): () => void;
}

/** A challenge the user has to answer next, together with the user it belongs to. */
interface PendingChallenge {
  readonly kind: "new-password" | "totp-setup" | "totp-required";
  readonly user: CognitoUser;
  readonly username: string;
}

/** The signed-in user: the library session, the derived session and the user to refresh it with. */
interface ActiveSession {
  readonly user: CognitoUser;
  readonly cognito: CognitoUserSession;
  readonly session: Session;
}

/** Cognito error codes mapped to the failure categories. Anything else is `generic`. */
const ERROR_KINDS: Readonly<Record<string, AuthErrorKind>> = {
  NotAuthorizedException: "invalid",
  UserNotFoundException: "invalid",
  UserNotConfirmedException: "invalid",
  CodeMismatchException: "code",
  ExpiredCodeException: "code",
  EnableSoftwareTokenMFAException: "code",
  TooManyRequestsException: "locked",
  TooManyFailedAttemptsException: "locked",
  LimitExceededException: "locked",
  InvalidPasswordException: "password-policy",
};

/**
 * Builds the `otpauth` URI the authenticator app reads from the QR code.
 *
 * @param username - Account name shown in the app.
 * @param secretCode - Base32 secret returned by Cognito.
 * @returns The `otpauth://totp` URI.
 */
function buildOtpauthUri(username: string, secretCode: string): string {
  const label = `${encodeURIComponent(TOTP_ISSUER)}:${encodeURIComponent(username)}`;
  const params = new URLSearchParams({ secret: secretCode, issuer: TOTP_ISSUER });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Maps an error from the library to an {@link AuthError}. The Cognito message is dropped on purpose.
 *
 * @param error - Whatever the library passed to a failure callback.
 * @returns The categorised error.
 */
function toAuthError(error: unknown): AuthError {
  if (error instanceof AuthError) {
    return error;
  }
  if (error instanceof TypeError) {
    // The library reports transport failures as rejected fetches, which surface as TypeError.
    return new AuthError("network");
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const kind = ERROR_KINDS[error.code];
    if (kind !== undefined) {
      return new AuthError(kind);
    }
  }
  return new AuthError("generic");
}

/**
 * Reads the console claims of a library session.
 *
 * @param session - The session returned by the library.
 * @returns The derived session.
 * @throws {AuthError} `generic` when the access token lacks the expected claims.
 */
function describeSession(session: CognitoUserSession): Session {
  const token = session.getAccessToken();
  const claims = CognitoAccessClaimsSchema.safeParse(token.payload);
  if (!claims.success) {
    throw new AuthError("generic");
  }
  return {
    userId: claims.data.sub,
    groups: claims.data["cognito:groups"] ?? [],
    expiresAtMs: token.getExpiration() * 1000,
  };
}

/**
 * Creates the authentication client of the console.
 *
 * @param config - Pool and client identifiers from the runtime configuration.
 * @param storage - Storage given to the library. Defaults to an in-memory shim; tests may inject another.
 * @returns The client. One instance per page.
 */
export function createAuthClient(
  config: Pick<RuntimeConfig, "userPoolId" | "userPoolClientId">,
  storage: MemoryStorage = new MemoryStorage(),
): AuthClient {
  const pool = new CognitoUserPool({
    UserPoolId: config.userPoolId,
    ClientId: config.userPoolClientId,
    Storage: storage,
    // Advanced security is not enabled on the pool (cost, ADR 0044): no device data is collected.
    AdvancedSecurityDataCollectionFlag: false,
  });

  let pending: PendingChallenge | null = null;
  let active: ActiveSession | null = null;
  let inFlightRefresh: Promise<void> | null = null;
  const listeners = new Set<(session: Session | null, reason: SignOutReason | null) => void>();

  /**
   * Makes a library session the active one and tells the listeners.
   *
   * @param user - The user the session belongs to.
   * @param cognito - The session returned by the library.
   */
  function adopt(user: CognitoUser, cognito: CognitoUserSession): void {
    const session = describeSession(cognito);
    pending = null;
    active = { user, cognito, session };
    notify(session, null);
  }

  /**
   * Drops the active session and tells the listeners.
   *
   * @param reason - Why the session ended, or `null` when the user asked for it.
   */
  function clear(reason: SignOutReason | null): void {
    active = null;
    pending = null;
    notify(null, reason);
  }

  /**
   * Calls every listener with the new state. A listener cannot break the others.
   *
   * @param session - The new session, or `null`.
   * @param reason - Why the session ended by expiry, if it did.
   */
  function notify(session: Session | null, reason: SignOutReason | null): void {
    for (const listener of listeners) {
      try {
        listener(session, reason);
      } catch {
        // A failing UI listener must not stop the session from being updated for the others.
      }
    }
  }

  /**
   * Runs one library operation that answers with the next sign-in step.
   *
   * @param user - The user the challenge belongs to.
   * @param username - Account name, used for the TOTP URI.
   * @param run - Starts the library call with the given callbacks.
   * @returns The next step.
   */
  function drive(
    user: CognitoUser,
    username: string,
    run: (callbacks: IAuthenticationCallback) => void,
  ): Promise<AuthStep> {
    return new Promise<AuthStep>((resolve, reject) => {
      const fail = (error: unknown): void => {
        reject(toAuthError(error));
      };
      run({
        onSuccess: (cognito) => {
          adopt(user, cognito);
          resolve({ kind: "signed-in" });
        },
        onFailure: fail,
        newPasswordRequired: () => {
          pending = { kind: "new-password", user, username };
          resolve({ kind: "new-password" });
        },
        totpRequired: () => {
          pending = { kind: "totp-required", user, username };
          resolve({ kind: "totp-required" });
        },
        mfaRequired: () => {
          // SMS is not enabled on the pool, so a text-message challenge is never expected.
          fail(new AuthError("generic"));
        },
        mfaSetup: () => {
          user.associateSoftwareToken({
            associateSecretCode: (secretCode) => {
              pending = { kind: "totp-setup", user, username };
              resolve({
                kind: "totp-setup",
                secretCode,
                otpauthUri: buildOtpauthUri(username, secretCode),
              });
            },
            onFailure: fail,
          });
        },
      });
    });
  }

  /**
   * Returns the pending challenge when it has the expected kind.
   *
   * @param kind - The challenge the caller answers.
   * @returns The pending challenge.
   * @throws {AuthError} `generic` when no such challenge is pending.
   */
  function requirePending(kind: PendingChallenge["kind"]): PendingChallenge {
    if (pending === null || pending.kind !== kind) {
      throw new AuthError("generic");
    }
    return pending;
  }

  /**
   * Refreshes the access token with the refresh token. Concurrent callers share one request.
   *
   * @param current - The active session to refresh.
   * @returns A promise that settles when the new tokens are in place.
   */
  function refresh(current: ActiveSession): Promise<void> {
    inFlightRefresh ??= new Promise<void>((resolve, reject) => {
      current.user.refreshSession(
        current.cognito.getRefreshToken(),
        (error: unknown, fresh: CognitoUserSession | undefined) => {
          if ((error !== null && error !== undefined) || fresh === undefined) {
            // A refused refresh token ends the session: the user signs in again.
            current.user.signOut();
            clear("expired");
            reject(new AuthError("expired"));
            return;
          }
          adopt(current.user, fresh);
          resolve();
        },
      );
    }).finally(() => {
      inFlightRefresh = null;
    });
    return inFlightRefresh;
  }

  return {
    async signIn(email, password) {
      pending = null;
      const user = new CognitoUser({ Username: email, Pool: pool, Storage: storage });
      const details = new AuthenticationDetails({ Username: email, Password: password });
      const step = await drive(user, email, (callbacks) => {
        user.authenticateUser(details, callbacks);
      });
      return step;
    },

    async completeNewPassword(newPassword) {
      const challenge = requirePending("new-password");
      return drive(challenge.user, challenge.username, (callbacks) => {
        challenge.user.completeNewPasswordChallenge(newPassword, {}, callbacks);
      });
    },

    async verifyTotpSetup(code) {
      const challenge = requirePending("totp-setup");
      return new Promise<AuthStep>((resolve, reject) => {
        challenge.user.verifySoftwareToken(code, TOTP_DEVICE_NAME, {
          onSuccess: (cognito) => {
            adopt(challenge.user, cognito);
            resolve({ kind: "signed-in" });
          },
          onFailure: (error: unknown) => {
            reject(toAuthError(error));
          },
        });
      });
    },

    async submitTotp(code) {
      const challenge = requirePending("totp-required");
      return new Promise<AuthStep>((resolve, reject) => {
        challenge.user.sendMFACode(
          code,
          {
            onSuccess: (cognito) => {
              adopt(challenge.user, cognito);
              resolve({ kind: "signed-in" });
            },
            onFailure: (error: unknown) => {
              reject(toAuthError(error));
            },
          },
          "SOFTWARE_TOKEN_MFA",
        );
      });
    },

    async signOut() {
      const user = active?.user ?? pending?.user ?? null;
      clear(null);
      if (user === null) {
        return;
      }
      await new Promise<void>((resolve) => {
        // Revocation is best effort: whether it succeeds or not, the local session is gone.
        user.globalSignOut({
          onSuccess: () => {
            user.signOut();
            resolve();
          },
          onFailure: () => {
            user.signOut();
            resolve();
          },
        });
      });
    },

    async getAccessToken(options) {
      const current = active;
      if (current === null) {
        throw new AuthError("expired");
      }
      const remainingMs = current.session.expiresAtMs - Date.now();
      if (options?.force !== true && remainingMs > REFRESH_MARGIN_MS) {
        return current.cognito.getAccessToken().getJwtToken();
      }
      await refresh(current);
      const next = active;
      if (next === null) {
        throw new AuthError("expired");
      }
      return next.cognito.getAccessToken().getJwtToken();
    },

    async getIdToken() {
      const current = active;
      if (current === null) {
        throw new AuthError("expired");
      }
      const idToken = current.cognito.getIdToken();
      if (idToken.getExpiration() * 1000 - Date.now() > REFRESH_MARGIN_MS) {
        return idToken.getJwtToken();
      }
      await refresh(current);
      const next = active;
      if (next === null) {
        throw new AuthError("expired");
      }
      return next.cognito.getIdToken().getJwtToken();
    },

    getSession() {
      return active?.session ?? null;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
