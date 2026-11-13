/**
 * Command store of the robot panel: one entry per command the console sent, and a rolling log per robot.
 *
 * The robot's answer arrives as a `command.ack` frame, so the state lives in Zustand and not in the query cache
 * (ADR 0066). The first terminal result wins: an `ACK` followed by a late `DUPLICATE` keeps the `ACK`, and a
 * command that already shows "No answer" is not revived by a late frame. The latency is measured with
 * `performance.now()` on both ends, so it never depends on the wall clock.
 *
 * The transitions are pure functions over a {@link CommandBook}, so they are tested without React or a store.
 */
import { create } from "zustand";
import {
  COMMAND_ACK_TIMEOUT_MS,
  type Ack,
  type AckReason,
  type ControlledCommandType,
  type RobotId,
} from "@mfc/protocol";

/** Number of entries kept per robot. Older entries are dropped together with their log position. */
export const COMMAND_LOG_CAPACITY = 20;

/** Types the console can send: the controlled commands and the two lock commands sent through the lock routes. */
export type CommandKind = ControlledCommandType | "TAKE_CONTROL" | "RELEASE_CONTROL";

/**
 * Where a command stands. `pending` is the only non-terminal status. `failed` means the request never got an
 * answer from the API, so the command may or may not have reached the robot; the log shows that honestly.
 */
export type CommandStatus = "pending" | "ack" | "reject" | "no-answer" | "failed";

/** One command the console sent, as the panel shows it. */
export interface CommandEntry {
  /** Identifier minted by the console for this send. A retry is a new identifier. */
  readonly commandId: string;
  /** Robot the command was sent to. */
  readonly robotId: RobotId;
  /** Command type, for the label. */
  readonly type: CommandKind;
  /** `performance.now()` when the request was started. */
  readonly sentAt: number;
  /** Current status. */
  readonly status: CommandStatus;
  /** Refusal reason, present exactly when the status is `reject`. */
  readonly reason?: AckReason;
  /** Round trip from the send to the answer, present once the answer arrived. */
  readonly latencyMs?: number;
}

/** What the store needs to start tracking a command. */
export interface NewCommand {
  readonly commandId: string;
  readonly robotId: RobotId;
  readonly type: CommandKind;
  readonly sentAt: number;
}

/**
 * The whole command state, as a value the pure transitions read and return. Maps are keyed by identifiers that
 * arrive from the network and the user, so they are maps and not records: no prototype key can be read or
 * written by accident.
 */
export interface CommandBook {
  /** Every tracked entry, by command identifier. */
  readonly entries: ReadonlyMap<string, CommandEntry>;
  /** Identifiers of each robot's entries, oldest first, at most {@link COMMAND_LOG_CAPACITY}. */
  readonly logByRobot: ReadonlyMap<RobotId, readonly string[]>;
}

/** The empty book. */
export const EMPTY_COMMAND_BOOK: CommandBook = { entries: new Map(), logByRobot: new Map() };

/**
 * Starts tracking a command as pending, and drops the oldest entry of the robot when the log is full.
 *
 * @param book - The current state.
 * @param command - The command that was just sent.
 * @returns The new state.
 */
export function beginCommand(book: CommandBook, command: NewCommand): CommandBook {
  const entry: CommandEntry = {
    commandId: command.commandId,
    robotId: command.robotId,
    type: command.type,
    sentAt: command.sentAt,
    status: "pending",
  };
  const kept = [...(book.logByRobot.get(command.robotId) ?? []), command.commandId];
  const keptLog = kept.slice(Math.max(0, kept.length - COMMAND_LOG_CAPACITY));
  const dropped = new Set(kept.slice(0, kept.length - keptLog.length));
  const entries = new Map(book.entries);
  for (const commandId of dropped) {
    entries.delete(commandId);
  }
  entries.set(command.commandId, entry);
  const logByRobot = new Map(book.logByRobot);
  logByRobot.set(command.robotId, keptLog);
  return { entries, logByRobot };
}

/**
 * Applies the robot's answer. Only a pending entry of the same robot takes it, so the first terminal result wins.
 *
 * @param book - The current state.
 * @param ack - The validated acknowledgement.
 * @param receivedAt - `performance.now()` when the frame arrived.
 * @returns The new state, or the same state when the answer does not apply.
 */
export function applyAckToBook(book: CommandBook, ack: Ack, receivedAt: number): CommandBook {
  const entry = book.entries.get(ack.commandId);
  if (entry === undefined || entry.status !== "pending" || entry.robotId !== ack.robotId) {
    return book;
  }
  const latencyMs = Math.max(0, receivedAt - entry.sentAt);
  const settled: CommandEntry =
    ack.result === "ACK"
      ? { ...entry, status: "ack", latencyMs }
      : { ...entry, status: "reject", reason: ack.reason, latencyMs };
  return withEntry(book, settled);
}

/**
 * Returns the book with one entry replaced.
 *
 * @param book - The current state.
 * @param entry - The entry to store under its command identifier.
 * @returns The new state.
 */
function withEntry(book: CommandBook, entry: CommandEntry): CommandBook {
  const entries = new Map(book.entries);
  entries.set(entry.commandId, entry);
  return { ...book, entries };
}

/**
 * Marks every pending entry older than the acknowledgement timeout as "No answer".
 *
 * @param book - The current state.
 * @param now - `performance.now()` at the moment of the check.
 * @returns The new state, or the same state when nothing expired.
 */
export function expireBook(book: CommandBook, now: number): CommandBook {
  let next = book;
  for (const entry of book.entries.values()) {
    if (entry.status === "pending" && now - entry.sentAt >= COMMAND_ACK_TIMEOUT_MS) {
      next = withEntry(next, { ...entry, status: "no-answer" });
    }
  }
  return next;
}

/**
 * Marks a pending command as failed, because its request got no answer from the API.
 *
 * @param book - The current state.
 * @param commandId - The command whose request failed.
 * @returns The new state, or the same state when the command is not pending.
 */
export function failBook(book: CommandBook, commandId: string): CommandBook {
  const entry = book.entries.get(commandId);
  if (entry === undefined || entry.status !== "pending") {
    return book;
  }
  return withEntry(book, { ...entry, status: "failed" });
}

/** Actions of the command store. */
export interface CommandState extends CommandBook {
  /**
   * Starts tracking a command that is about to be sent.
   *
   * @param command - The command.
   */
  begin(command: NewCommand): void;
  /**
   * Applies an acknowledgement received on the socket.
   *
   * @param ack - The validated acknowledgement.
   * @param receivedAt - `performance.now()` when the frame arrived.
   */
  applyAck(ack: Ack, receivedAt: number): void;
  /**
   * Expires the pending commands that waited too long.
   *
   * @param now - `performance.now()` at the moment of the check.
   */
  expire(now: number): void;
  /**
   * Marks a command whose request failed.
   *
   * @param commandId - The command.
   */
  fail(commandId: string): void;
  /** Forgets every command. */
  reset(): void;
}

/** Store of the commands sent from the console, read by the robot panel and by the acquire flow. */
export const useCommandStore = create<CommandState>()((set) => ({
  ...EMPTY_COMMAND_BOOK,
  begin: (command) => {
    set((state) => beginCommand(state, command));
  },
  applyAck: (ack, receivedAt) => {
    set((state) => applyAckToBook(state, ack, receivedAt));
  },
  expire: (now) => {
    set((state) => expireBook(state, now));
  },
  fail: (commandId) => {
    set((state) => failBook(state, commandId));
  },
  reset: () => {
    set(EMPTY_COMMAND_BOOK);
  },
}));
