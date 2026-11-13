/**
 * Persist decisions and the bounded in-container memory.
 */
import { describe, expect, it } from "vitest";
import { PersistPolicy } from "../../../src/domain/live/persist-policy";
import { BOOT_A, BOOT_B } from "../../fakes/live";

const T0 = 1_000_000;
const moving = { robotId: "kali-01", bootId: BOOT_A, state: "MOVING" as const };

describe("PersistPolicy.shouldPersist", () => {
  it("persists the first sample, skips a repeat within the interval, persists after it", () => {
    const policy = new PersistPolicy();
    expect(policy.shouldPersist(moving, T0)).toBe(true);
    policy.recordPersisted(moving, T0);

    expect(policy.shouldPersist(moving, T0 + 3000)).toBe(false);
    expect(policy.shouldPersist(moving, T0 + 10_000)).toBe(true);
  });

  it("persists at once when the state, the boot or the mission changed", () => {
    const policy = new PersistPolicy();
    policy.recordPersisted(moving, T0);

    expect(policy.shouldPersist({ ...moving, state: "WORKING" }, T0 + 1)).toBe(true);
    expect(policy.shouldPersist({ ...moving, bootId: BOOT_B }, T0 + 1)).toBe(true);
    expect(policy.shouldPersist({ ...moving, missionId: "m-1" }, T0 + 1)).toBe(true);
  });

  it("clears the whole map when a new robot meets a full map, so memory stays bounded", () => {
    const policy = new PersistPolicy(1000);
    for (let i = 0; i < 1000; i += 1) {
      policy.recordPersisted({ robotId: `r-${String(i)}`, bootId: BOOT_A, state: "IDLE" }, T0);
    }
    expect(policy.shouldPersist({ robotId: "r-0", bootId: BOOT_A, state: "IDLE" }, T0 + 1)).toBe(
      false,
    );

    policy.recordPersisted({ robotId: "r-new", bootId: BOOT_A, state: "IDLE" }, T0);

    expect(policy.shouldPersist({ robotId: "r-0", bootId: BOOT_A, state: "IDLE" }, T0 + 1)).toBe(
      true,
    );
  });

  it("does not clear the map when a known robot is updated in a full map", () => {
    const policy = new PersistPolicy(1);
    policy.recordPersisted(moving, T0);
    policy.recordPersisted(moving, T0 + 1);
    expect(policy.shouldPersist(moving, T0 + 2)).toBe(false);
  });
});

describe("PersistPolicy in-container ordering", () => {
  it("remembers the newest sample seen per robot", () => {
    const policy = new PersistPolicy();
    expect(policy.lastSeen("kali-01")).toBeUndefined();

    policy.recordSeen("kali-01", BOOT_A, 9);

    expect(policy.lastSeen("kali-01")).toStrictEqual({ bootId: BOOT_A, seq: 9 });
  });

  it("clears the seen memory when a new robot meets a full memory", () => {
    const policy = new PersistPolicy(1);
    policy.recordSeen("r1", BOOT_A, 1);
    policy.recordSeen("r2", BOOT_A, 1);

    expect(policy.lastSeen("r1")).toBeUndefined();
    expect(policy.lastSeen("r2")).toStrictEqual({ bootId: BOOT_A, seq: 1 });
  });
});
