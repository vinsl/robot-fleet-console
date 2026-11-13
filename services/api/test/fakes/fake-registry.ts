/**
 * In-memory registry with the conditional semantics of the DynamoDB adapter.
 *
 * Records are stored as the adapter would store them: validated, and with absent optional fields removed.
 */
import { isDeepStrictEqual } from "node:util";
import type { RobotId, SiteId } from "@mfc/protocol";
import type { RegistryPort, ReplaceOutcome, ReserveOutcome } from "../../src/domain/ports";
import { RobotRecordSchema, type RobotRecord } from "../../src/domain/robots/registry";
import { CallGate } from "./call-gate";

/** Operations of the registry fake, the names used by failure injection. */
export type RegistryMethod = "reserve" | "get" | "replace";

/**
 * Stores a record the way the adapter does: through the schema, with absent optional fields removed.
 *
 * @param record - A record.
 * @returns A detached copy of the record as it would be stored.
 */
function normalise(record: RobotRecord): RobotRecord {
  const copy: unknown = JSON.parse(JSON.stringify(record));
  return RobotRecordSchema.parse(copy);
}

/**
 * @param siteId - Site of the robot.
 * @param robotId - Robot identifier.
 * @returns The key of the robot record.
 */
function keyOf(siteId: string, robotId: string): string {
  return `${siteId}/${robotId}`;
}

/** Registry fake. */
export class FakeRegistry implements RegistryPort {
  /** Robot records by site and robot identifier. */
  readonly items = new Map<string, RobotRecord>();
  /** Site that holds the claim of each robot identifier. */
  readonly claims = new Map<string, SiteId>();
  /** Idempotency tokens received by `reserve`. */
  readonly tokens: string[] = [];
  /**
   * Outcomes of the next `replace` calls, consumed in order. `conflict` refuses the write; `pass` (or an
   * empty queue) applies the normal rule.
   */
  readonly replaceScript: ("pass" | "conflict")[] = [];
  /** Calls and scripted failures. */
  readonly gate = new CallGate<RegistryMethod>([], "registry");

  /**
   * Seeds a record, as if a previous invocation had written it.
   *
   * @param record - The record to store and claim.
   */
  seed(record: RobotRecord): void {
    this.claims.set(record.robotId, record.siteId);
    this.items.set(keyOf(record.siteId, record.robotId), normalise(record));
  }

  /**
   * @param record - The record to create.
   * @param clientRequestToken - The idempotency token.
   * @returns `taken` if the id is claimed or the record exists, otherwise `reserved`.
   */
  async reserve(record: RobotRecord, clientRequestToken: string): Promise<ReserveOutcome> {
    await this.gate.enter("reserve");
    this.tokens.push(clientRequestToken);
    const key = keyOf(record.siteId, record.robotId);
    if (this.claims.has(record.robotId) || this.items.has(key)) {
      return "taken";
    }
    this.seed(record);
    return "reserved";
  }

  /**
   * @param siteId - Site of the robot.
   * @param robotId - Robot identifier.
   * @returns A copy of the record, or null.
   */
  async get(siteId: SiteId, robotId: RobotId): Promise<RobotRecord | null> {
    await this.gate.enter("get");
    const item = this.items.get(keyOf(siteId, robotId));
    return item === undefined ? null : normalise(item);
  }

  /**
   * Conditional replace with the adapter's rule: the write lands when the stored version is the expected one;
   * otherwise an identical stored record is an `ok` (a retried write), and anything else is a `conflict`.
   *
   * @param expectedVersion - The version the caller read.
   * @param next - The record to store.
   * @returns `ok` or `conflict`.
   * @throws {Error} When `next` does not advance the version by exactly one (a bug in the caller).
   */
  async replace(expectedVersion: number, next: RobotRecord): Promise<ReplaceOutcome> {
    await this.gate.enter("replace");
    const scripted = this.replaceScript.shift();
    if (scripted === "conflict") {
      return "conflict";
    }
    if (next.version !== expectedVersion + 1) {
      throw new Error("test: a replace must advance the version by one");
    }
    const key = keyOf(next.siteId, next.robotId);
    const stored = this.items.get(key);
    if (stored === undefined) {
      return "conflict";
    }
    if (stored.version === expectedVersion) {
      this.items.set(key, normalise(next));
      return "ok";
    }
    return isDeepStrictEqual(stored, normalise(next)) ? "ok" : "conflict";
  }
}
