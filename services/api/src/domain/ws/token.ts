/**
 * Single-use WebSocket tokens: issue, hash, and redeem at `$connect`.
 *
 * A token is 32 random bytes, valid for 60 seconds and redeemable once. The store keeps only its SHA-256 hash,
 * so a dump of the table cannot be replayed. The token is never logged and never stored in clear.
 */
import { createHash } from "node:crypto";
import {
  WS_SESSION_MAX_SECONDS,
  WS_TOKEN_TTL_SECONDS,
  WsTokenResponseSchema,
  WsTokenSchema,
  type Principal,
  type Role,
  type SiteId,
  type WsTokenRequest,
  type WsTokenResponse,
} from "@mfc/protocol";
import type { Clock, DomainLogger } from "../ports";
import { safeErrorFields } from "../safe-error";
import { originAllowed } from "./origin";
import { sessionEnded, type ConnectionRecord } from "./session";

/** Bytes of entropy of a token: 256 bits. */
const TOKEN_BYTES = 32;

/** Seconds a token record stays in the store after it expires, so the TTL sweep removes it, not a redemption. */
const TOKEN_TTL_GRACE_SECONDS = 60;

/** A token record to store: the hash, never the token, and what the token authorises. */
export interface TokenRecord {
  readonly tokenHash: string;
  readonly sub: string;
  readonly role: Role;
  readonly siteId: SiteId;
  readonly sessionExpiresAtMs: number;
  readonly expiresAtMs: number;
}

/** What a redeemed token authorises. */
export interface RedeemedToken {
  readonly sub: string;
  readonly role: Role;
  readonly siteId: SiteId;
  readonly sessionExpiresAtMs: number;
}

/**
 * Store of tokens and connection records. The adapter maps these operations onto the connections table.
 */
export interface WsSessionStore {
  /**
   * Stores a token record. Fails when the hash already exists.
   *
   * @param token - The record.
   */
  putToken(token: TokenRecord): Promise<void>;
  /**
   * Atomically deletes a token that is present and not expired. A token is redeemable once: the second
   * attempt finds nothing.
   *
   * @param tokenHash - The SHA-256 hex digest of the token.
   * @param nowMs - The current instant, in epoch milliseconds.
   * @returns What the token authorised, or null when it is absent, expired or already used.
   */
  redeemToken(tokenHash: string, nowMs: number): Promise<RedeemedToken | null>;
  /**
   * Stores a new connection record. Fails when the identifier already exists.
   *
   * @param connection - The record, not yet subscribed.
   */
  putConnection(connection: ConnectionRecord): Promise<void>;
  /**
   * Reads a connection record with a consistent read.
   *
   * @param connectionId - The connection.
   * @returns The record, or null when it does not exist.
   */
  getConnection(connectionId: string): Promise<ConnectionRecord | null>;
  /**
   * Marks a connection as subscribed to a site. Succeeds only when the record still exists.
   *
   * @param connectionId - The connection.
   * @param siteId - The site.
   * @returns False when the record no longer exists.
   */
  subscribe(connectionId: string, siteId: SiteId): Promise<boolean>;
  /**
   * Removes a connection record. Removing an absent record succeeds.
   *
   * @param connectionId - The connection.
   */
  remove(connectionId: string): Promise<void>;
  /**
   * Counts one client frame against the connection's rate window. Atomic in the store, so concurrent frames of
   * one connection cannot all pass a full window.
   *
   * @param connectionId - The connection.
   * @param nowMs - The current instant, in epoch milliseconds.
   * @returns `true` when the frame is within the rate, `false` when the window is full.
   */
  countFrame(connectionId: string, nowMs: number): Promise<boolean>;
}

/** Dependencies of {@link issueToken}. */
export interface IssueDeps {
  readonly store: WsSessionStore;
  readonly clock: Clock;
  /** Source of random bytes. Production passes the node crypto generator; tests pass a fixed one. */
  readonly random: (size: number) => Buffer;
  /** The WebSocket URL the console connects to. */
  readonly url: string;
}

/** Dependencies of {@link redeemAndConnect}. */
export interface ConnectDeps {
  readonly store: WsSessionStore;
  readonly clock: Clock;
  readonly allowedOrigins: readonly string[];
  readonly logger: DomainLogger;
}

/** Status returned to API Gateway for a `$connect`. */
export type ConnectStatus = 200 | 401 | 403 | 500;

/** Why an issue request was refused. */
export type WsDeniedCode = "FORBIDDEN_SITE" | "INVALID_SESSION";

/**
 * Refusal of a token request. The code is the only thing it carries, so it can reach a log safely.
 */
export class WsDenied extends Error {
  /** The rule that refused the request. */
  readonly code: WsDeniedCode;

  /** @param code - The rule that refused the request. */
  constructor(code: WsDeniedCode) {
    super(code);
    this.name = "WsDenied";
    this.code = code;
  }
}

/**
 * SHA-256 digest of a token, in lowercase hexadecimal. This is what the store keeps.
 *
 * @param token - The token, as the console presents it.
 * @returns The 64-character digest.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Generates a token: 32 random bytes encoded in base64url, 43 characters with no padding.
 *
 * @param random - The source of random bytes.
 * @returns The token.
 * @throws {Error} When the source returns the wrong number of bytes, so no short token is ever issued.
 */
export function newToken(random: (size: number) => Buffer): string {
  const bytes = random(TOKEN_BYTES);
  if (bytes.length !== TOKEN_BYTES) {
    throw new Error("token entropy source returned a wrong length");
  }
  return WsTokenSchema.parse(bytes.toString("base64url"));
}

/**
 * Time-to-live attribute of a token record, in epoch seconds: the expiry plus a grace period.
 *
 * @param expiresAtMs - The expiry of the token, in epoch milliseconds.
 * @returns The value of the table's TTL attribute.
 */
export function tokenExpiresAtSeconds(expiresAtMs: number): number {
  return Math.ceil(expiresAtMs / 1000) + TOKEN_TTL_GRACE_SECONDS;
}

/**
 * Issues a single-use token for one site of the principal.
 *
 * The site must be one the principal may see, and the session window must be in the future and at most one
 * access-token lifetime away: the session end is copied into the token, so it is bounded here, once.
 *
 * @param principal - The verified identity. In M5 it is built from the IAM-authenticated invoke.
 * @param request - The site the console wants to watch.
 * @param deps - The store, clock, entropy source and URL.
 * @returns The token response, validated against the shared schema.
 * @throws {WsDenied} `FORBIDDEN_SITE` when the site is not granted, `INVALID_SESSION` when the session window
 * is not in the allowed range. Nothing is stored in either case.
 */
export async function issueToken(
  principal: Principal,
  request: WsTokenRequest,
  deps: IssueDeps,
): Promise<WsTokenResponse> {
  if (!principal.siteIds.includes(request.siteId)) {
    throw new WsDenied("FORBIDDEN_SITE");
  }
  const nowMs = deps.clock.now().getTime();
  const sessionExpiresAtMs = Date.parse(principal.sessionExpiresAt);
  if (sessionExpiresAtMs <= nowMs || sessionExpiresAtMs > nowMs + WS_SESSION_MAX_SECONDS * 1000) {
    throw new WsDenied("INVALID_SESSION");
  }

  const token = newToken(deps.random);
  const expiresAtMs = nowMs + WS_TOKEN_TTL_SECONDS * 1000;
  await deps.store.putToken({
    tokenHash: hashToken(token),
    sub: principal.sub,
    role: principal.role,
    siteId: request.siteId,
    sessionExpiresAtMs,
    expiresAtMs,
  });
  return WsTokenResponseSchema.parse({
    token,
    expiresAt: new Date(expiresAtMs).toISOString(),
    sessionExpiresAt: principal.sessionExpiresAt,
    url: deps.url,
  });
}

/**
 * Handles one `$connect`: checks the token shape, the origin, then redeems the token and records the
 * connection.
 *
 * The order is part of the contract. A malformed token never reaches the store. A refused origin is refused
 * before redemption, so a foreign page cannot burn a token. Any token that reaches redemption is consumed,
 * even when the connection record then fails to store: the console asks for a new token (fail closed).
 * Every refusal returns the same bare status, so the response does not tell an attacker which check failed.
 *
 * @param attempt - The token as presented (untrusted), the origin header, and the connection identifier.
 * @param deps - The store, clock, origin allow-list and logger.
 * @returns The status for API Gateway. Never throws: an infrastructure error is logged by name and returns 500.
 */
export async function redeemAndConnect(
  attempt: {
    readonly token: unknown;
    readonly origin: string | undefined;
    readonly connectionId: string;
  },
  deps: ConnectDeps,
): Promise<{ readonly statusCode: ConnectStatus }> {
  const token = WsTokenSchema.safeParse(attempt.token);
  if (!token.success) {
    return { statusCode: 401 };
  }
  if (!originAllowed(attempt.origin, deps.allowedOrigins)) {
    return { statusCode: 403 };
  }
  const nowMs = deps.clock.now().getTime();
  try {
    const redeemed = await deps.store.redeemToken(hashToken(token.data), nowMs);
    if (redeemed === null || sessionEnded(redeemed.sessionExpiresAtMs, nowMs)) {
      return { statusCode: 401 };
    }
    await deps.store.putConnection({
      connectionId: attempt.connectionId,
      sub: redeemed.sub,
      role: redeemed.role,
      siteId: redeemed.siteId,
      connectedAtMs: nowMs,
      sessionExpiresAtMs: redeemed.sessionExpiresAtMs,
      subscribed: false,
    });
    return { statusCode: 200 };
  } catch (error) {
    deps.logger.error("connection record failed", safeErrorFields(error));
    return { statusCode: 500 };
  }
}
