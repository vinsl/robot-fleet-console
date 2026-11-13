/**
 * Lock store of the robot control: who holds the lock of each robot, as the console last learned it.
 *
 * The state is seeded by `GET .../lock` and then patched by the `lock.changed` frame and by the `robot.event`
 * `LOCK_CHANGED` frame (ADR 0066). The store holds the holder's subject, never a lock token: the cloud keeps
 * the token (ADR 0062), and the console has no use for it.
 */
import { create } from "zustand";
import type { LockState, RobotId, UserSub, WsServerMessage } from "@mfc/protocol";
import type { TFunction } from "i18next";

/** Number of hexadecimal characters of the subject that identify an operator on screen. */
const HOLDER_ID_LENGTH = 4;

/** What the console knows about one robot's lock. */
export interface LockEntry {
  /** Whether a live holder exists. */
  readonly held: boolean;
  /** Subject of the holder, present exactly when `held` is true. */
  readonly holder?: UserSub;
}

/**
 * Lock state keyed by robot. A map, because the keys are identifiers from the network. A robot the console has
 * not heard about has no entry.
 */
export type LockBook = ReadonlyMap<RobotId, LockEntry>;

/**
 * Whether the signed-in user holds the lock of a robot. The comparison is on the verified subject only.
 *
 * @param entry - The lock entry of the robot, if known.
 * @param userId - Subject of the signed-in user, or `null` when signed out.
 * @returns `true` when the lock is held and its holder is the user.
 */
export function isLockMine(entry: LockEntry | undefined, userId: string | null): boolean {
  return entry?.held === true && userId !== null && entry.holder === userId;
}

/**
 * Names the holder of a lock on screen: `Operator` and the last four hexadecimal characters of the subject. The
 * full subject is never shown, so a colleague can tell operators apart without learning identifiers.
 *
 * @param sub - Subject of the holder.
 * @param t - Translation function of the `robot` namespace.
 * @returns The localised label.
 */
export function holderLabel(sub: UserSub, t: TFunction): string {
  const compact = sub.replace(/-/g, "");
  return t("lock.holder", { ns: "robot", id: compact.slice(-HOLDER_ID_LENGTH) });
}

/**
 * Converts the API's lock state to a store entry. The token is not part of the schema, so it cannot be kept.
 *
 * @param lock - The validated lock state.
 * @returns The entry.
 */
function entryOf(lock: LockState): LockEntry {
  return lock.held && lock.holder !== undefined
    ? { held: true, holder: lock.holder }
    : { held: false };
}

/**
 * Returns the book with one robot's entry replaced.
 *
 * @param book - The current state.
 * @param robotId - The robot.
 * @param entry - The new entry.
 * @returns The new state.
 */
function withLock(book: LockBook, robotId: RobotId, entry: LockEntry): LockBook {
  const next = new Map(book);
  next.set(robotId, entry);
  return next;
}

/**
 * Applies a frame to the lock state. Only `lock.changed` and `robot.event` `LOCK_CHANGED` carry lock changes;
 * every other frame leaves the state as it is.
 *
 * @param book - The current state.
 * @param frame - A validated server frame.
 * @returns The new state, or the same state when the frame does not concern locks.
 */
export function applyLockFrame(book: LockBook, frame: WsServerMessage): LockBook {
  if (frame.type === "lock.changed") {
    return withLock(
      book,
      frame.robotId,
      frame.held && frame.holder !== undefined
        ? { held: true, holder: frame.holder }
        : { held: false },
    );
  }
  if (frame.type === "robot.event" && frame.event.kind === "LOCK_CHANGED") {
    const event = frame.event;
    return withLock(
      book,
      frame.robotId,
      event.held ? { held: true, holder: event.holder } : { held: false },
    );
  }
  return book;
}

/** Actions and selectors of the lock store. */
export interface LockStoreState {
  /** Lock state by robot. */
  readonly locks: LockBook;
  /**
   * Records the lock state the API answered to a take, a release or a refetch after a conflict. The answer is
   * authoritative: it replaces whatever the store held.
   *
   * @param robotId - The robot.
   * @param lock - The validated lock state. Its token, which the schema never carries, is not stored.
   */
  applyState(robotId: RobotId, lock: LockState): void;
  /**
   * Seeds the state from the initial read of the lock. Writes only when the store has no entry for the robot: a
   * read that resolves late must not overwrite a take answer or a newer `lock.changed` frame.
   *
   * @param robotId - The robot.
   * @param lock - The validated lock state.
   */
  seedLock(robotId: RobotId, lock: LockState): void;
  /**
   * Applies a server frame that may change a lock.
   *
   * @param frame - A validated server frame.
   */
  applyFrame(frame: WsServerMessage): void;
  /** Forgets every lock. Called at sign-out, so that the next user never sees the previous user's locks. */
  reset(): void;
}

/** Store of the lock state, keyed by robot. */
export const useLockStore = create<LockStoreState>()((set) => ({
  locks: new Map(),
  applyState: (robotId, lock) => {
    set((state) => ({ locks: withLock(state.locks, robotId, entryOf(lock)) }));
  },
  seedLock: (robotId, lock) => {
    set((state) =>
      state.locks.has(robotId) ? state : { locks: withLock(state.locks, robotId, entryOf(lock)) },
    );
  },
  applyFrame: (frame) => {
    set((state) => ({ locks: applyLockFrame(state.locks, frame) }));
  },
  reset: () => {
    set({ locks: new Map() });
  },
}));
