/**
 * Lock store: frames and answers set the holder, a release clears it, "mine" is decided by the verified subject,
 * and the holder is named by the last four characters of the subject.
 */
import i18next from "i18next";
import { beforeEach, describe, expect, it } from "vitest";
import type { WsServerMessage } from "@mfc/protocol";
import { holderLabel, isLockMine, useLockStore } from "../../src/control/lock-store";
import { OTHER_SUB, ROBOT, SITE, SUB, lockState } from "./support";

const EVENT_ENVELOPE = {
  schemaVersion: "1.0.0",
  messageId: "0190f3a2-7b1c-7000-8000-000000000010",
  robotId: ROBOT,
  siteId: SITE,
  ts: "2026-11-04T10:00:00.000Z",
  seq: 3,
  bootId: "0190f3a2-7b1c-7000-8000-000000000001",
};

/**
 * Builds a `lock.changed` frame.
 *
 * @param held - Whether the lock is held after the change.
 * @param holder - The holder, when held.
 * @returns The frame.
 */
function lockChanged(held: boolean, holder?: string): WsServerMessage {
  return {
    type: "lock.changed",
    siteId: SITE,
    robotId: ROBOT,
    held,
    ...(holder === undefined ? {} : { holder }),
    cause: held ? "ACQUIRED" : "RELEASED",
  };
}

beforeEach(() => {
  useLockStore.setState({ locks: new Map() });
});

describe("lock store", () => {
  it("lock-changed-frame-sets-holder", () => {
    useLockStore.getState().applyFrame(lockChanged(true, OTHER_SUB));

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: true, holder: OTHER_SUB });
  });

  it("robot-event-lock-released-clears", () => {
    useLockStore.getState().applyFrame(lockChanged(true, OTHER_SUB));
    useLockStore.getState().applyFrame({
      type: "robot.event",
      siteId: SITE,
      robotId: ROBOT,
      event: { ...EVENT_ENVELOPE, kind: "LOCK_CHANGED", held: false, cause: "RELEASED" },
    });

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: false });
  });

  it("robot-event-lock-acquired-sets-holder and ignores other robot events", () => {
    useLockStore.getState().applyFrame({
      type: "robot.event",
      siteId: SITE,
      robotId: ROBOT,
      event: {
        ...EVENT_ENVELOPE,
        kind: "LOCK_CHANGED",
        held: true,
        holder: SUB,
        cause: "ACQUIRED",
      },
    });
    useLockStore.getState().applyFrame({
      type: "robot.event",
      siteId: SITE,
      robotId: ROBOT,
      event: { ...EVENT_ENVELOPE, kind: "HEARTBEAT", state: "IDLE", battery: 80 },
    });

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: true, holder: SUB });
  });

  it("seeds from the API answer and never keeps more than the lock state", () => {
    useLockStore.getState().applyState(ROBOT, lockState(true, OTHER_SUB));

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: true, holder: OTHER_SUB });
    expect(isLockMine(useLockStore.getState().locks.get(ROBOT), OTHER_SUB)).toBe(true);
  });

  it("is-mine-by-sub: the lock is mine only when the holder is the signed-in subject", () => {
    useLockStore.getState().applyFrame(lockChanged(true, SUB));

    expect(isLockMine(useLockStore.getState().locks.get(ROBOT), SUB)).toBe(true);
    expect(isLockMine(useLockStore.getState().locks.get(ROBOT), OTHER_SUB)).toBe(false);
    expect(isLockMine(useLockStore.getState().locks.get(ROBOT), null)).toBe(false);
    expect(isLockMine(undefined, SUB)).toBe(false);
    expect(isLockMine(useLockStore.getState().locks.get("sim-02"), SUB)).toBe(false);
  });

  it("given no entry, when the initial read is seeded, then the entry is written", () => {
    useLockStore.getState().seedLock(ROBOT, lockState(true, OTHER_SUB));

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: true, holder: OTHER_SUB });
  });

  it("given a take answer, when a late initial read is seeded, then the answer is kept", () => {
    useLockStore.getState().applyState(ROBOT, lockState(true, SUB));
    useLockStore.getState().seedLock(ROBOT, lockState(false));

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: true, holder: SUB });
  });

  it("given a lock.changed frame, when a stale initial read is seeded, then the frame is kept", () => {
    useLockStore.getState().applyFrame(lockChanged(true, OTHER_SUB));
    useLockStore.getState().seedLock(ROBOT, lockState(false));

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: true, holder: OTHER_SUB });
  });

  it("given a held lock, when a take answer arrives, then the authoritative answer replaces the entry", () => {
    useLockStore.getState().applyState(ROBOT, lockState(true, OTHER_SUB));
    useLockStore.getState().applyState(ROBOT, lockState(false));

    expect(useLockStore.getState().locks.get(ROBOT)).toEqual({ held: false });
  });

  it("given locks of a previous user, when the store is reset, then no lock is kept", () => {
    useLockStore.getState().applyFrame(lockChanged(true, SUB));
    useLockStore.getState().reset();

    expect(useLockStore.getState().locks.size).toBe(0);
  });

  it("holder-label-last-4: names the holder by the last four characters, without dashes", () => {
    const t = i18next.getFixedT("en", "robot");

    expect(holderLabel("11111111-2222-3333-4444-5555566a3f9a", t)).toBe("Operator 3f9a");
    expect(holderLabel(SUB, t)).toBe("Operator 5555");
  });
});
