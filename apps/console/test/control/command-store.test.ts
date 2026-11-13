/**
 * Command store: the first terminal result wins, a rejection keeps its reason, silence becomes "No answer", and the
 * log keeps the last twenty commands of a robot.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@mfc/protocol";
import {
  COMMAND_LOG_CAPACITY,
  EMPTY_COMMAND_BOOK,
  applyAckToBook,
  beginCommand,
  expireBook,
  failBook,
  useCommandStore,
  type CommandBook,
} from "../../src/control/command-store";
import { ackOf, ROBOT } from "./support";

/** Starts a command on the robot at the given send time. */
function sent(book: CommandBook, sentAt: number, commandId = uuidv7()): CommandBook {
  return beginCommand(book, { commandId, robotId: ROBOT, type: "PAUSE", sentAt });
}

beforeEach(() => {
  useCommandStore.getState().reset();
});

describe("command store", () => {
  it("first-terminal-wins: a DUPLICATE after an ACK does not overwrite the ACK", () => {
    const id = uuidv7();
    let book = sent(EMPTY_COMMAND_BOOK, 1000, id);
    book = applyAckToBook(book, ackOf(id), 1143);
    book = applyAckToBook(book, ackOf(id, "DUPLICATE"), 1500);

    expect(book.entries.get(id)).toMatchObject({ status: "ack", latencyMs: 143 });
  });

  it("reject-keeps-reason: a rejection keeps the reason and its latency", () => {
    const id = uuidv7();
    const book = applyAckToBook(
      sent(EMPTY_COMMAND_BOOK, 1000, id),
      ackOf(id, "INVALID_STATE"),
      1040,
    );

    expect(book.entries.get(id)).toMatchObject({
      status: "reject",
      reason: "INVALID_STATE",
      latencyMs: 40,
    });
  });

  it("expire-after-5s-no-answer: a pending command reads No answer once five seconds passed", () => {
    const id = uuidv7();
    const book = sent(EMPTY_COMMAND_BOOK, 1000, id);

    expect(expireBook(book, 5999).entries.get(id)?.status).toBe("pending");
    expect(expireBook(book, 6000).entries.get(id)?.status).toBe("no-answer");
  });

  it("a late acknowledgement does not revive a command that already shows No answer", () => {
    const id = uuidv7();
    let book = expireBook(sent(EMPTY_COMMAND_BOOK, 1000, id), 7000);
    book = applyAckToBook(book, ackOf(id), 7100);

    expect(book.entries.get(id)?.status).toBe("no-answer");
  });

  it("ignores an acknowledgement for an unknown command or for another robot", () => {
    const id = uuidv7();
    const book = sent(EMPTY_COMMAND_BOOK, 1000, id);
    const otherRobot = { ...ackOf(id), robotId: "sim-02" };

    expect(applyAckToBook(book, ackOf(uuidv7()), 1100)).toBe(book);
    expect(applyAckToBook(book, otherRobot, 1100)).toBe(book);
  });

  it("marks a failed request as failed, and only while it is pending", () => {
    const id = uuidv7();
    const failed = failBook(sent(EMPTY_COMMAND_BOOK, 1000, id), id);

    expect(failed.entries.get(id)?.status).toBe("failed");
    expect(failBook(applyAckToBook(failed, ackOf(id), 1100), id).entries.get(id)?.status).toBe(
      "failed",
    );
  });

  it("log-capped-at-20: the log keeps the last twenty commands and forgets the older entries", () => {
    const ids = Array.from({ length: COMMAND_LOG_CAPACITY + 3 }, () => uuidv7());
    let book = EMPTY_COMMAND_BOOK;
    for (const id of ids) {
      book = sent(book, 1000, id);
    }

    expect(book.logByRobot.get(ROBOT)).toEqual(ids.slice(3));
    expect(book.entries.size).toBe(COMMAND_LOG_CAPACITY);
    expect(book.entries.has(ids[0] ?? "")).toBe(false);
  });

  it("is driven through the store actions", () => {
    const id = uuidv7();
    useCommandStore.getState().begin({ commandId: id, robotId: ROBOT, type: "PAUSE", sentAt: 10 });
    useCommandStore.getState().applyAck(ackOf(id), 60);

    expect(useCommandStore.getState().entries.get(id)).toMatchObject({
      status: "ack",
      latencyMs: 50,
    });
    useCommandStore.getState().reset();
    expect(useCommandStore.getState().entries.size).toBe(0);
  });
});
