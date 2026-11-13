/**
 * Temporary AWS credentials for the video viewer, exchanged from the console's ID token through the identity pool.
 *
 * The identity pool's authenticated role carries the viewer actions only, and only on the robot channels (SEC-ID-3,
 * ADR 0067). The ID token is used for the exchange and then dropped: it is never stored here, never sent to the video
 * endpoints and never logged. The credentials live in the closure of one provider, so they vanish with the panel that
 * owns it, and they are refreshed two minutes before they expire.
 */
import {
  CognitoIdentityClient,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import type { RuntimeConfig } from "@mfc/protocol";
import type { AuthClient } from "../auth/cognito-client";

/** The only part of the authentication client the exchange needs. */
export type IdTokenSource = Pick<AuthClient, "getIdToken">;

/**
 * Refresh margin: a credential is replaced when less than this remains, so that a viewer never starts a
 * signalling session with credentials that expire during the handshake.
 */
const REFRESH_MARGIN_MS = 120_000;

/** Upper bound of one identity pool call. */
const IDENTITY_CALL_TIMEOUT_MS = 5_000;

/**
 * Bounds a call that has no abort signal of its own (the ID token refresh) with the same timeout as the identity
 * pool calls. The timer is cleared as soon as the call settles, so no timer outlives the exchange.
 *
 * @param work - The call to bound.
 * @returns The result of the call.
 * @throws {Error} When the call does not settle within the timeout.
 */
async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("credential exchange timed out"));
    }, IDENTITY_CALL_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Credentials of the viewer. The shape matches the SDK's `AwsCredentialIdentity`, so the Kinesis Video clients take
 * it without a direct dependency on `@aws-sdk/types`.
 */
export interface ViewerCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
  readonly expiration: Date;
}

/**
 * Builds the provider of the viewer's credentials. Each call returns the cached credentials while they are valid
 * for more than the refresh margin, and runs one exchange otherwise. Concurrent calls share the same exchange.
 *
 * @param config - The validated runtime configuration: region, user pool and identity pool.
 * @param auth - The console's authentication client, which supplies the ID token. Only `getIdToken` is used.
 * @returns A function that resolves to valid credentials.
 * @throws Errors of the ID token refresh or of the identity pool calls. Their messages are not shown to the user.
 */
export function createCredentialProvider(
  config: RuntimeConfig,
  auth: IdTokenSource,
): () => Promise<ViewerCredentials> {
  const identity = new CognitoIdentityClient({ region: config.region });
  const loginProvider = `cognito-idp.${config.region}.amazonaws.com/${config.userPoolId}`;
  let cached: ViewerCredentials | null = null;
  let exchange: Promise<ViewerCredentials> | null = null;

  /**
   * Runs the identity pool exchange with a fresh ID token: `GetId`, then `GetCredentialsForIdentity`.
   *
   * @returns The new credentials.
   * @throws When the pool does not answer with an identity or with credentials that have an expiry.
   */
  const runExchange = async (): Promise<ViewerCredentials> => {
    // A stalled token refresh must not hold the pane in connecting: it fails into the unavailable state.
    const idToken = await withTimeout(auth.getIdToken());
    const logins = { [loginProvider]: idToken };
    const timeout = { abortSignal: AbortSignal.timeout(IDENTITY_CALL_TIMEOUT_MS) };
    const { IdentityId: identityId } = await identity.send(
      new GetIdCommand({ IdentityPoolId: config.identityPoolId, Logins: logins }),
      timeout,
    );
    if (identityId === undefined) {
      throw new Error("identity pool returned no identity");
    }
    const { Credentials: credentials } = await identity.send(
      new GetCredentialsForIdentityCommand({ IdentityId: identityId, Logins: logins }),
      timeout,
    );
    const { AccessKeyId, SecretKey, SessionToken, Expiration } = credentials ?? {};
    if (
      AccessKeyId === undefined ||
      SecretKey === undefined ||
      SessionToken === undefined ||
      Expiration === undefined
    ) {
      throw new Error("identity pool returned incomplete credentials");
    }
    return {
      accessKeyId: AccessKeyId,
      secretAccessKey: SecretKey,
      sessionToken: SessionToken,
      expiration: Expiration,
    };
  };

  return () => {
    if (cached !== null && cached.expiration.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return Promise.resolve(cached);
    }
    exchange ??= runExchange()
      .then((next) => {
        cached = next;
        return next;
      })
      .finally(() => {
        exchange = null;
      });
    return exchange;
  };
}
