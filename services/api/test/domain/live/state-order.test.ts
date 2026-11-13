/**
 * Ordering of live samples by (bootId, seq): the table of the design, and the batch reduction.
 */
import { describe, expect, it } from "vitest";
import { isNewer, latestPerRobot } from "../../../src/domain/live/state-order";
import { BOOT_A, BOOT_B } from "../../fakes/live";

describe("isNewer", () => {
  it.each([
    [{ bootId: BOOT_A, seq: 5 }, { bootId: BOOT_A, seq: 5 }, false],
    [{ bootId: BOOT_A, seq: 5 }, { bootId: BOOT_A, seq: 4 }, false],
    [{ bootId: BOOT_A, seq: 5 }, { bootId: BOOT_A, seq: 6 }, true],
    [{ bootId: BOOT_A, seq: 5 }, { bootId: BOOT_B, seq: 0 }, true],
    [{ bootId: BOOT_B, seq: 5 }, { bootId: BOOT_A, seq: 99 }, false],
  ])("compares %j with %j", (prev, next, expected) => {
    expect(isNewer(prev, next)).toBe(expected);
  });

  it("accepts any sample when nothing is held", () => {
    expect(isNewer(undefined, { bootId: BOOT_A, seq: 0 })).toBe(true);
  });
});

describe("latestPerRobot", () => {
  it("keeps the newest sample per robot and counts the superseded ones", () => {
    const items = [
      { robotId: "r1", bootId: BOOT_A, seq: 4 },
      { robotId: "r1", bootId: BOOT_A, seq: 9 },
      { robotId: "r1", bootId: BOOT_A, seq: 7 },
      { robotId: "r2", bootId: BOOT_A, seq: 1 },
    ];

    const { latest, superseded } = latestPerRobot(items);

    expect(latest.get("r1")?.seq).toBe(9);
    expect(latest.get("r2")?.seq).toBe(1);
    expect(superseded).toBe(2);
  });

  it("prefers a later boot even with a lower sequence", () => {
    const { latest } = latestPerRobot([
      { robotId: "r1", bootId: BOOT_B, seq: 0 },
      { robotId: "r1", bootId: BOOT_A, seq: 500 },
    ]);
    expect(latest.get("r1")?.bootId).toBe(BOOT_B);
  });

  it("is empty for an empty batch", () => {
    expect(latestPerRobot([])).toStrictEqual({ latest: new Map(), superseded: 0 });
  });
});
