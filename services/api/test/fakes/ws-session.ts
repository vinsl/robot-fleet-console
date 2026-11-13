/**
 * In-memory fakes of the WebSocket session store and of its metrics, for the domain and handler tests.
 *
 * The store follows the adapter's contract: a redemption is atomic and returns nothing for an absent, expired or
 * used token, and a repeated insert fails. Every call is recorded, so a test can assert that a refused request
 * never touched the store.
 */
import type { SiteId } from "@mfc/protocol";
import type { ConnectionRecord } from "../../src/domain/ws/session";
import type { WsMetricName, WsMetricsPort } from "../../src/domain/ws/metrics";
import type { RedeemedToken, TokenRecord, WsSessionStore } from "../../src/domain/ws/token";

/** In-memory session store. */
export class FakeWsSession implements WsSessionStore {
  /** Token records by hash, as stored. */
  readonly tokens = new Map<string, TokenRecord>();
  /** Connection records by identifier. */
  readonly connections = new Map<string, ConnectionRecord>();
  /** The site each connection subscribed to, by identifier. */
  readonly subscribedTo = new Map<string, SiteId>();
  /** Connection identifiers removed, in order. */
  readonly removed: string[] = [];
  /** Names of the store operations called, in order. */
  readonly calls: string[] = [];
  /** When set, every operation rejects with this error (an infrastructure failure). */
  failure: Error | null = null;
  /** The answer of every frame count: `false` simulates a connection over its frame rate. */
  frameAllowed = true;

  /** @param token - The record. */
  putToken(token: TokenRecord): Promise<void> {
    this.calls.push("putToken");
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    if (this.tokens.has(token.tokenHash)) {
      return Promise.reject(new Error("duplicate token"));
    }
    this.tokens.set(token.tokenHash, token);
    return Promise.resolve();
  }

  /**
   * @param tokenHash - The hash of the token.
   * @param nowMs - The current instant.
   * @returns What the token authorised, or null when absent, expired or already used.
   */
  redeemToken(tokenHash: string, nowMs: number): Promise<RedeemedToken | null> {
    this.calls.push("redeemToken");
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    const token = this.tokens.get(tokenHash);
    if (token === undefined || token.expiresAtMs <= nowMs) {
      return Promise.resolve(null);
    }
    this.tokens.delete(tokenHash);
    return Promise.resolve({
      sub: token.sub,
      role: token.role,
      siteId: token.siteId,
      sessionExpiresAtMs: token.sessionExpiresAtMs,
    });
  }

  /** @param connection - The record. */
  putConnection(connection: ConnectionRecord): Promise<void> {
    this.calls.push("putConnection");
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    if (this.connections.has(connection.connectionId)) {
      return Promise.reject(new Error("duplicate connection"));
    }
    this.connections.set(connection.connectionId, connection);
    return Promise.resolve();
  }

  /** @param connectionId - The connection. */
  getConnection(connectionId: string): Promise<ConnectionRecord | null> {
    this.calls.push("getConnection");
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve(this.connections.get(connectionId) ?? null);
  }

  /**
   * @param connectionId - The connection.
   * @param siteId - The site.
   * @returns False when the record does not exist.
   */
  subscribe(connectionId: string, siteId: SiteId): Promise<boolean> {
    this.calls.push("subscribe");
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    const connection = this.connections.get(connectionId);
    if (connection === undefined) {
      return Promise.resolve(false);
    }
    this.connections.set(connectionId, { ...connection, subscribed: true });
    this.subscribedTo.set(connectionId, siteId);
    return Promise.resolve(true);
  }

  /** @param connectionId - The connection. */
  remove(connectionId: string): Promise<void> {
    this.calls.push("remove");
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    this.connections.delete(connectionId);
    this.removed.push(connectionId);
    return Promise.resolve();
  }

  /** Every frame is counted against the scripted answer, whatever the connection. */
  countFrame(): Promise<boolean> {
    this.calls.push("countFrame");
    if (this.failure !== null) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve(this.frameAllowed);
  }
}

/** Metrics port that keeps every counted name. */
export class RecordingWsMetrics implements WsMetricsPort {
  /** Counted names, in order. */
  readonly counted: WsMetricName[] = [];
  /** How many times the stored metrics were published. */
  published = 0;

  /** @param name - The metric. */
  count(name: WsMetricName): void {
    this.counted.push(name);
  }

  /** Records one publication. */
  publishStoredMetrics(): void {
    this.published += 1;
  }
}
