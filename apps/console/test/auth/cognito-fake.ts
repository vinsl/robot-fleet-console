/* eslint-disable @typescript-eslint/no-extraneous-class -- test doubles mirror the library classes, which have constructors only */
/**
 * Scripted stand-in for `amazon-cognito-identity-js`, loaded by the authentication tests through `vi.mock`.
 *
 * Each test sets the behaviour it needs in {@link lib}.script and reads the recorded calls afterwards. Only the
 * classes and methods the authentication client uses exist here.
 */

/** Callbacks the client passes to the library's sign-in calls. Only the ones the tests use are typed. */
export interface SignInCallbacks {
  onSuccess: (session: unknown) => void;
  onFailure: (error: unknown) => void;
  newPasswordRequired?: () => void;
  totpRequired?: () => void;
  mfaSetup?: () => void;
}

/** Callbacks of the TOTP enrolment and of the sign-in TOTP answer. */
export interface ResultCallbacks {
  onSuccess: (session: unknown) => void;
  onFailure: (error: unknown) => void;
}

/** Behaviour of the fake library for one test. Each test sets the calls it expects. */
export interface FakeScript {
  authenticate?: (callbacks: SignInCallbacks) => void;
  complete?: (callbacks: SignInCallbacks) => void;
  associate?: (callbacks: {
    associateSecretCode: (code: string) => void;
    onFailure: (e: unknown) => void;
  }) => void;
  verify?: (code: string, callbacks: ResultCallbacks) => void;
  mfa?: (code: string, callbacks: ResultCallbacks, type: string) => void;
  refresh?: (callback: (error: unknown, session?: unknown) => void) => void;
}

/** Shared state of the fake library. Reset before each test. */
export const lib = {
  script: {} as FakeScript,
  pools: [] as unknown[],
  storages: [] as unknown[],
  refreshCalls: 0,
  localSignOuts: 0,
  revocations: 0,
};

/** Records the pool configuration the client creates. */
export class CognitoUserPool {
  constructor(config: unknown) {
    lib.pools.push(config);
  }
}

/** Carries the credentials to the library call. */
export class AuthenticationDetails {
  readonly data: unknown;
  constructor(data: unknown) {
    this.data = data;
  }
}

/** A user of the fake library; every call is answered by the shared script. */
export class CognitoUser {
  constructor(data: { Storage: unknown }) {
    lib.storages.push(data.Storage);
  }

  authenticateUser(_details: unknown, callbacks: SignInCallbacks): void {
    lib.script.authenticate?.(callbacks);
  }

  completeNewPasswordChallenge(
    _password: string,
    _attributes: unknown,
    callbacks: SignInCallbacks,
  ): void {
    lib.script.complete?.(callbacks);
  }

  associateSoftwareToken(callbacks: {
    associateSecretCode: (code: string) => void;
    onFailure: (e: unknown) => void;
  }): void {
    lib.script.associate?.(callbacks);
  }

  verifySoftwareToken(code: string, _device: string, callbacks: ResultCallbacks): void {
    lib.script.verify?.(code, callbacks);
  }

  sendMFACode(code: string, callbacks: ResultCallbacks, type: string): void {
    lib.script.mfa?.(code, callbacks, type);
  }

  refreshSession(_token: unknown, callback: (error: unknown, session?: unknown) => void): void {
    lib.refreshCalls += 1;
    lib.script.refresh?.(callback);
  }

  globalSignOut(callbacks: {
    onSuccess: (message: string) => void;
    onFailure: (e: unknown) => void;
  }): void {
    lib.revocations += 1;
    callbacks.onSuccess("revoked");
  }

  signOut(): void {
    lib.localSignOuts += 1;
  }
}
