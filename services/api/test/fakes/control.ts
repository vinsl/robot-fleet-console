/**
 * In-memory fakes of the control ports, and the dependencies and fixtures the control tests share.
 *
 * Every fake appends one `<port>.<method>` entry to one shared log, so a test can assert that a refused request reached
 * no port at all (`world.calls` is empty), and in which order the effects happened (publish before audit for the e-stop).
 * The lock fake follows the conditions of the DynamoDB adapter, so the domain sees the same outcomes it sees in
 * production.
 */
import {
  CommandSchema,
  LockTokenSchema,
  uuidv7,
  type Command,
  type AuditRecord,
  type CorrelationId,
  type DemoState,
  type LockToken,
  type RobotId,
  type SiteId,
  type UserSub,
  type Uuidv7,
} from "@mfc/protocol";
import type { Principal } from "../../src/domain/authz";
import { RobotRecordSchema, type RobotRecord } from "../../src/domain/robots/registry";
import type {
  ControlCall,
  ControlDeps,
  ControlMetricName,
  LockAcquireOutcome,
  LockChangeCause,
  LockItem,
  CommandClaim,
  CommandClaimOutcome,
  LockStorePort,
  CommandClaimPort,
  DemoStorePort,
  RobotReadPort,
  CommandPublisherPort,
  ControlRelayPort,
  AuditPort,
  ControlMetrics,
} from "../../src/domain/control/ports";
import { FixedClock, SequentialIds } from "./fixed";
import { RecordingLogger } from "./recording";

/** Site of the control fixtures: the demo site of the principals below. */
export const CONTROL_SITE: SiteId = "paris-01";

/** Robot of the control fixtures: a simulated robot, registered and active. */
export const CONTROL_ROBOT: RobotId = "sim-03";

/** Robot of the control fixtures that is a real robot. */
export const REAL_ROBOT: RobotId = "kali-01";

/** Instant every control test starts at. */
export const CONTROL_START = new Date("2026-11-04T10:00:00.000Z");

/** Epoch seconds of {@link CONTROL_START}. */
export const CONTROL_START_SECONDS = Math.floor(CONTROL_START.getTime() / 1000);

/** Subject of the Operator of the fixtures. */
export const OPERATOR_SUB: UserSub = "00000000-0000-4000-8000-0000000000a1";

/** Subject of a second Operator, who holds no lock in most tests. */
export const OTHER_OPERATOR_SUB: UserSub = "00000000-0000-4000-8000-0000000000a2";

/** Subject of the Admin of the fixtures. */
export const ADMIN_SUB: UserSub = "00000000-0000-4000-8000-0000000000a3";

/** The verified Operator of the control tests. */
export const OPERATOR: Principal = { userId: OPERATOR_SUB, role: "Operator", siteId: CONTROL_SITE };

/** The verified Admin of the control tests. */
export const ADMIN: Principal = { userId: ADMIN_SUB, role: "Admin", siteId: CONTROL_SITE };

/** A valid client identifier of the given number: distinct, time-ordered, and of the UUIDv7 grammar. */
export function commandIdOf(n: number): Uuidv7 {
  return uuidv7(1_700_000_000_000 + n, (count) => new Uint8Array(count).fill(n % 256));
}

/** Robot record of the given robot, registered, active and simulated unless told otherwise. */
export function robotOf(robotId: RobotId, overrides: Partial<RobotRecord> = {}): RobotRecord {
  return RobotRecordSchema.parse({
    robotId,
    siteId: CONTROL_SITE,
    name: "Sim 03",
    type: "SIM",
    designDate: "2026-11-02",
    simulated: true,
    status: "ACTIVE",
    createdAt: "2026-11-02T10:00:00.000Z",
    thingName: `mfc-demo-${robotId}`,
    version: 1,
    updatedAt: "2026-11-02T10:00:00.000Z",
    certificates: [],
    lastCorrelationId: "corr-00000000",
    ...overrides,
  });
}

/**
 * Refuses a site other than the fixture site. A fake that accepted any site would hide a scoping bug in the domain, so
 * every port that takes a site checks it.
 *
 * @param siteId - The site the domain passed.
 */
function assertSite(siteId: SiteId): void {
  if (siteId !== CONTROL_SITE) {
    throw new Error("control fixture reached for another site");
  }
}

/**
 * Lock store fake. Its acquire follows the adapter's condition: a free or expired lock is taken, a live lock of the
 * same holder is refreshed, any other live lock is held.
 */
export class FakeLockStore implements LockStorePort {
  /** Lock items by robot. */
  readonly items = new Map<RobotId, LockItem>();
  /** The expiry the last refresh wrote, in epoch seconds. */
  lastRefreshExpiry: number | undefined = undefined;
  private raceNext = false;
  private refuseRelease = false;
  private releaseFailure: Error | undefined = undefined;

  /**
   * @param calls - The shared log of the control fakes.
   */
  constructor(private readonly calls: string[]) {}

  /**
   * Stores a lock as another operator's, as a setup step.
   *
   * @param item - The lock item.
   */
  put(item: LockItem): void {
    this.items.set(item.robotId, item);
  }

  /** Makes the next acquire lose the race to another holder. */
  loseNextAcquire(): void {
    this.raceNext = true;
  }

  /** Makes every release report a lost condition. */
  refuseEveryRelease(): void {
    this.refuseRelease = true;
  }

  /** Makes every release throw, as a store outage does. */
  failEveryRelease(error: Error): void {
    this.releaseFailure = error;
  }

  /** @inheritdoc */
  get(siteId: SiteId, robotId: RobotId): Promise<LockItem | null> {
    this.calls.push("locks.get");
    assertSite(siteId);
    return Promise.resolve(this.items.get(robotId) ?? null);
  }

  /** @inheritdoc */
  acquire(siteId: SiteId, next: LockItem, nowSeconds: number): Promise<LockAcquireOutcome> {
    this.calls.push("locks.acquire");
    assertSite(siteId);
    if (this.raceNext) {
      this.raceNext = false;
      return Promise.resolve("HELD");
    }
    const previous = this.items.get(next.robotId);
    if (previous === undefined || previous.expiresAt <= nowSeconds) {
      this.items.set(next.robotId, next);
      return Promise.resolve("ACQUIRED");
    }
    if (previous.holder === next.holder) {
      this.items.set(next.robotId, next);
      return Promise.resolve("REFRESHED");
    }
    return Promise.resolve("HELD");
  }

  /** @inheritdoc */
  refresh(
    siteId: SiteId,
    robotId: RobotId,
    holder: UserSub,
    token: LockToken,
    expiresAtSeconds: number,
    nowSeconds: number,
  ): Promise<boolean> {
    this.calls.push("locks.refresh");
    assertSite(siteId);
    const item = this.items.get(robotId);
    if (
      item === undefined ||
      item.holder !== holder ||
      item.token !== token ||
      item.expiresAt <= nowSeconds
    ) {
      return Promise.resolve(false);
    }
    this.items.set(robotId, { ...item, expiresAt: expiresAtSeconds });
    this.lastRefreshExpiry = expiresAtSeconds;
    return Promise.resolve(true);
  }

  /** @inheritdoc */
  release(siteId: SiteId, robotId: RobotId, holder: UserSub, token: LockToken): Promise<boolean> {
    this.calls.push("locks.release");
    assertSite(siteId);
    if (this.releaseFailure !== undefined) {
      return Promise.reject(this.releaseFailure);
    }
    const item = this.items.get(robotId);
    if (
      this.refuseRelease ||
      item === undefined ||
      item.holder !== holder ||
      item.token !== token
    ) {
      return Promise.resolve(false);
    }
    this.items.delete(robotId);
    return Promise.resolve(true);
  }
}

/** Claim fake: the first claim of an identifier wins, later ones read it back. */
export class FakeCommandClaims implements CommandClaimPort {
  /** Claims by identifier. */
  readonly claims = new Map<Uuidv7, CommandClaim>();
  /** Retention of the last claim written, in epoch seconds. */
  lastExpiry: number | undefined = undefined;
  /** Error thrown by every claim when set, as a store outage does. */
  failure: Error | undefined = undefined;

  /**
   * @param calls - The shared log of the control fakes.
   */
  constructor(private readonly calls: string[]) {}

  /** @inheritdoc */
  claim(
    siteId: SiteId,
    claim: CommandClaim,
    expiresAtSeconds: number,
  ): Promise<CommandClaimOutcome> {
    this.calls.push("claims.claim");
    assertSite(siteId);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const existing = this.claims.get(claim.commandId);
    if (existing !== undefined) {
      return Promise.resolve({ kind: "EXISTS", claim: existing });
    }
    this.claims.set(claim.commandId, claim);
    this.lastExpiry = expiresAtSeconds;
    return Promise.resolve({ kind: "CLAIMED" });
  }

  /** @inheritdoc */
  abandon(siteId: SiteId, commandId: Uuidv7): Promise<void> {
    this.calls.push("claims.abandon");
    assertSite(siteId);
    this.claims.delete(commandId);
    return Promise.resolve();
  }
}

/** Demo store fake: disabled until switched. */
export class FakeDemoStore implements DemoStorePort {
  /** Current state. */
  state: DemoState = { enabled: false };

  /**
   * @param calls - The shared log of the control fakes.
   */
  constructor(private readonly calls: string[]) {}

  /** @inheritdoc */
  get(siteId: SiteId): Promise<DemoState> {
    this.calls.push("demo.get");
    assertSite(siteId);
    return Promise.resolve(this.state);
  }

  /** @inheritdoc */
  set(siteId: SiteId, next: DemoState): Promise<DemoState> {
    this.calls.push("demo.set");
    assertSite(siteId);
    this.state = next;
    return Promise.resolve(next);
  }
}

/** Registry read fake. */
export class FakeRobots implements RobotReadPort {
  /** Records by robot. */
  readonly records = new Map<RobotId, RobotRecord>();
  /** Error thrown by every read when set, as a store outage does. */
  failure: Error | undefined = undefined;

  /**
   * @param calls - The shared log of the control fakes.
   */
  constructor(private readonly calls: string[]) {}

  /** @inheritdoc */
  get(siteId: SiteId, robotId: RobotId): Promise<RobotRecord | null> {
    this.calls.push("robots.get");
    assertSite(siteId);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    return Promise.resolve(this.records.get(robotId) ?? null);
  }

  /** @inheritdoc */
  list(siteId: SiteId): Promise<RobotRecord[]> {
    this.calls.push("robots.list");
    return Promise.resolve([...this.records.values()].filter((record) => record.siteId === siteId));
  }
}

/** Publisher fake that keeps every payload, and can be told to fail. */
export class FakePublisher implements CommandPublisherPort {
  /** Every publish attempted, in order, with the payload as text. */
  readonly published: { readonly topic: string; readonly payload: string }[] = [];
  /** Error thrown by every publish when set. */
  failure: Error | undefined = undefined;

  /**
   * @param calls - The shared log of the control fakes.
   */
  constructor(private readonly calls: string[]) {}

  /** @inheritdoc */
  publish(topic: string, payload: string): Promise<void> {
    this.calls.push("publisher.publish");
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    this.published.push({ topic, payload });
    return Promise.resolve();
  }
}

/** Relay fake that keeps every lock change it is asked to send. */
export class FakeControlRelay implements ControlRelayPort {
  /** Every change relayed, in order. */
  readonly changes: {
    readonly siteId: SiteId;
    readonly robotId: RobotId;
    readonly held: boolean;
    readonly holder: UserSub | undefined;
    readonly cause: LockChangeCause;
  }[] = [];

  /**
   * @param calls - The shared log of the control fakes.
   */
  constructor(private readonly calls: string[]) {}

  /** @inheritdoc */
  lockChanged(
    siteId: SiteId,
    robotId: RobotId,
    held: boolean,
    holder: UserSub | undefined,
    cause: LockChangeCause,
  ): Promise<void> {
    this.calls.push("relay.lockChanged");
    this.changes.push({ siteId, robotId, held, holder, cause });
    return Promise.resolve();
  }
}

/** Audit fake that keeps every record, and can be told to fail. */
export class FakeControlAudit implements AuditPort {
  /** Every record written, in order. */
  readonly records: AuditRecord[] = [];
  /** Error thrown by every write when set. */
  failure: Error | undefined = undefined;

  /**
   * @param calls - The shared log of the control fakes.
   */
  constructor(private readonly calls: string[]) {}

  /** @inheritdoc */
  write(record: AuditRecord): Promise<void> {
    this.calls.push("audit.write");
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    this.records.push(record);
    return Promise.resolve();
  }
}

/** Metrics fake that counts in memory. */
export class CountingControlMetrics implements ControlMetrics {
  private readonly counts = new Map<ControlMetricName, number>();

  /** @inheritdoc */
  count(name: ControlMetricName): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  /**
   * @param name - The metric.
   * @returns How many times it was counted; zero when never.
   */
  value(name: ControlMetricName): number {
    return this.counts.get(name) ?? 0;
  }
}

/** Every collaborator of the control use cases, with the fakes behind them. */
export interface ControlWorld {
  /** The dependencies of the use cases. */
  readonly deps: ControlDeps;
  /** Shared log of every port call, in order. Empty when nothing was reached. */
  readonly calls: string[];
  readonly locks: FakeLockStore;
  readonly claims: FakeCommandClaims;
  readonly demo: FakeDemoStore;
  readonly robots: FakeRobots;
  readonly publisher: FakePublisher;
  readonly relay: FakeControlRelay;
  readonly audit: FakeControlAudit;
  readonly metrics: CountingControlMetrics;
  readonly logger: RecordingLogger;
  readonly clock: FixedClock;
  /**
   * A call with the given time left, read by the use case when it asks.
   *
   * @param remainingMs - Milliseconds left in the invocation.
   * @returns The call.
   */
  callWith(remainingMs?: number): ControlCall;
}

/** Fixed random bytes: one byte value for every token, so tests can find a token in a response. */
function fixedRandom(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x5a);
}

/**
 * Builds the dependencies of one control test, with fresh fakes. The demo site has the demo mode off, and the robot
 * registry holds {@link CONTROL_ROBOT} (simulated) and {@link REAL_ROBOT} (real), both active.
 *
 * @returns The dependencies and the fakes behind them.
 */
export function controlWorld(): ControlWorld {
  const calls: string[] = [];
  const locks = new FakeLockStore(calls);
  const claims = new FakeCommandClaims(calls);
  const demo = new FakeDemoStore(calls);
  const robots = new FakeRobots(calls);
  robots.records.set(CONTROL_ROBOT, robotOf(CONTROL_ROBOT));
  robots.records.set(
    REAL_ROBOT,
    robotOf(REAL_ROBOT, { simulated: false, name: "Kali 01", type: "KALI" }),
  );
  const publisher = new FakePublisher(calls);
  const relay = new FakeControlRelay(calls);
  const audit = new FakeControlAudit(calls);
  const metrics = new CountingControlMetrics();
  const logger = new RecordingLogger();
  const clock = new FixedClock(CONTROL_START);
  const deps: ControlDeps = {
    locks,
    claims,
    demo,
    robots,
    publisher,
    relay,
    audit,
    clock,
    ids: new SequentialIds(),
    randomBytes: fixedRandom,
    logger,
    metrics,
  };
  return {
    deps,
    calls,
    locks,
    claims,
    demo,
    robots,
    publisher,
    relay,
    audit,
    metrics,
    logger,
    clock,
    callWith: (remainingMs = 5000) => ({
      correlationId: "corr-00000001" satisfies CorrelationId,
      remainingMs: () => remainingMs,
    }),
  };
}

/** Token of the lock fixtures: 43 characters, the shape the cloud mints. */
export const FIXTURE_TOKEN = LockTokenSchema.parse("a".repeat(43));

/**
 * A lock item of the control fixture robot, held by `holder`.
 *
 * @param holder - Subject of the holder.
 * @param ttlSeconds - Seconds from the control start until the expiry; negative for an expired lock.
 * @param robotId - The robot of the lock.
 * @returns The lock item.
 */
export function liveLockOf(
  holder: UserSub,
  ttlSeconds = 30,
  robotId: RobotId = CONTROL_ROBOT,
): LockItem {
  return {
    robotId,
    holder,
    token: FIXTURE_TOKEN,
    acquiredAt: CONTROL_START.toISOString(),
    expiresAt: CONTROL_START_SECONDS + ttlSeconds,
  };
}

/**
 * The command published at a position, parsed by the protocol schema. Fails the test when nothing was published there.
 *
 * @param world - The control world of the test.
 * @param index - Position of the publish, in order.
 * @returns The validated command.
 */
export function sentCommandOf(world: ControlWorld, index = 0): Command {
  const entry = world.publisher.published.at(index);
  if (entry === undefined) {
    throw new Error("no command was published at this position");
  }
  const parsed: unknown = JSON.parse(entry.payload);
  return CommandSchema.parse(parsed);
}
