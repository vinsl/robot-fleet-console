/**
 * Robot and cloud state machine: the invariants I1 to I8 of the design, the rows the design spells out,
 * and the refusals of a caller that passes an incomplete context.
 */
import { describe, expect, it } from "vitest";
import {
  CLOUD_TRANSITIONS,
  CommandTriggerSchema,
  GuardSchema,
  InternalTriggerSchema,
  LOCK_REQUIRED_COMMANDS,
  MOTION_STATES,
  RobotReportedStateSchema,
  StateChangeCauseSchema,
  TRANSITIONS,
  transition,
  transitionCloud,
  type CloudTrigger,
  type Guard,
  type RowTarget,
  type TransitionRow,
} from "../src/index";

const ALL8 = RobotReportedStateSchema.options;
const RowGuardOptions = GuardSchema.options.filter((guard) => guard !== "ALWAYS");
const NO_GUARDS: ReadonlySet<Guard> = new Set<Guard>();
const PRE_STATE_ORIGINS = ["PAUSED", "ESTOP", "BLOCKED", "TELEOP"] as const;

/** Target of a row once `SAME` is resolved to the row's own origin. Undefined for the `RESUME_TARGET` rows. */
function resolvedTarget(row: TransitionRow): RowTarget {
  return row.to === "SAME" && row.from !== "START" ? row.from : row.to;
}

/** True for a trigger raised by the robot itself, which never produces an acknowledgement on its own. */
function isInternal(row: TransitionRow): boolean {
  return InternalTriggerSchema.safeParse(row.trigger).success;
}

describe("row table", () => {
  it("has exactly one row per origin, trigger and guard", () => {
    const keys = TRANSITIONS.map((row) => `${row.from}|${row.trigger}|${row.guard}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never mixes ALWAYS with a conditional row for the same origin and trigger", () => {
    const groups = new Map<string, Set<Guard>>();
    for (const row of TRANSITIONS) {
      const key = `${row.from}|${row.trigger}`;
      const guards = groups.get(key) ?? new Set<Guard>();
      guards.add(row.guard);
      groups.set(key, guards);
    }
    for (const [key, guards] of groups) {
      if (guards.has("ALWAYS")) {
        expect(guards.size, key).toBe(1);
      }
    }
  });

  it("has no row that starts from START except the boot rows", () => {
    const starts = TRANSITIONS.filter((row) => row.from === "START");
    expect(starts.length).toBeGreaterThan(0);
    expect(starts.every((row) => row.trigger === "BOOT")).toBe(true);
  });

  it("never names BOOT as the cause of a state change", () => {
    expect(StateChangeCauseSchema.safeParse("BOOT").success).toBe(false);
  });
});

describe("invariant I1: ESTOP is reachable from every state", () => {
  it.each(ALL8)("sends %s to ESTOP", (state) => {
    expect(transition(state, "ESTOP", NO_GUARDS).to).toBe("ESTOP");
  });

  it("acknowledges an ESTOP received while already stopped without a change", () => {
    const result = transition("ESTOP", "ESTOP", NO_GUARDS);
    expect(result).toMatchObject({ to: "ESTOP", reply: "ACK", changed: false });
  });
});

describe("invariant I2: ESTOP is left only by ESTOP_RELEASE, to IDLE or PAUSED, never to motion", () => {
  const leaving = TRANSITIONS.filter(
    (row) => row.from === "ESTOP" && resolvedTarget(row) !== "ESTOP",
  );

  it("has only ESTOP_RELEASE rows leaving ESTOP, one per origin guard", () => {
    expect(leaving.map((row) => row.trigger)).toEqual(["ESTOP_RELEASE", "ESTOP_RELEASE"]);
    const byGuard = Object.fromEntries(leaving.map((row) => [row.guard, row.to]));
    expect(byGuard).toEqual({ ESTOP_FROM_IDLE: "IDLE", ESTOP_FROM_OTHER: "PAUSED" });
  });

  it("never targets a motion state, and always clears the latch", () => {
    for (const row of leaving) {
      expect(MOTION_STATES).not.toContain(row.to);
      expect(row.effects).toContain("CLEAR_ESTOP_LATCH");
    }
  });

  it("returns an e-stopped IDLE robot to IDLE", () => {
    const result = transition("ESTOP", "ESTOP_RELEASE", new Set<Guard>(["ESTOP_FROM_IDLE"]));
    expect(result).toMatchObject({ to: "IDLE", reply: "ACK", changed: true });
  });

  it("pauses a robot that was not IDLE, or whose origin is unknown", () => {
    const result = transition("ESTOP", "ESTOP_RELEASE", new Set<Guard>(["ESTOP_FROM_OTHER"]));
    expect(result).toMatchObject({ to: "PAUSED", reply: "ACK", changed: true });
  });

  it("refuses the release when no origin guard or both hold", () => {
    expect(transition("ESTOP", "ESTOP_RELEASE", NO_GUARDS)).toMatchObject({
      reply: "REJECT",
      reason: "INVALID_STATE",
    });
    const both = new Set<Guard>(["ESTOP_FROM_IDLE", "ESTOP_FROM_OTHER"]);
    expect(transition("ESTOP", "ESTOP_RELEASE", both)).toMatchObject({
      reply: "REJECT",
      reason: "INVALID_STATE",
    });
  });

  it("records the origin on every e-stop entry, and leaves a repeated e-stop effect-free", () => {
    const entering = TRANSITIONS.filter(
      (row) => row.trigger === "ESTOP" && resolvedTarget(row) === "ESTOP" && row.from !== "ESTOP",
    );
    expect(entering.length).toBeGreaterThan(0);
    for (const row of entering) {
      expect(row.effects).toContain("RECORD_ESTOP_ORIGIN");
    }
    const repeated = TRANSITIONS.find((row) => row.from === "ESTOP" && row.trigger === "ESTOP");
    expect(repeated?.effects ?? []).toEqual([]);
  });
});

describe("invariant I3: TELEOP is entered only by a lock-gated command", () => {
  it("is entered only by TAKE_CONTROL, or by RESUME to a stored TELEOP target", () => {
    const entering = TRANSITIONS.filter((row) => row.to === "TELEOP");
    expect(new Set(entering.map((row) => row.trigger))).toEqual(new Set(["TAKE_CONTROL"]));
    const resuming = TRANSITIONS.filter((row) => row.to === "RESUME_TARGET");
    expect(resuming.every((row) => row.trigger === "RESUME")).toBe(true);
  });

  it.each(["RELEASE_CONTROL", "LOCK_EXPIRED"] as const)(
    "always leaves TELEOP to PAUSED on %s",
    (trigger) => {
      const rows = TRANSITIONS.filter((row) => row.from === "TELEOP" && row.trigger === trigger);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.to).toBe("PAUSED");
    },
  );
});

describe("invariant I4: BLOCKED is left only by RESUME after the cause is cleared, RETURN_TO_BASE or ESTOP", () => {
  it("has leaving rows only for those three triggers", () => {
    const leaving = TRANSITIONS.filter(
      (row) => row.from === "BLOCKED" && resolvedTarget(row) !== "BLOCKED",
    );
    const triggers = new Set(leaving.map((row) => row.trigger));
    expect(triggers).toEqual(new Set(["RESUME", "RETURN_TO_BASE", "ESTOP"]));
    expect(leaving.filter((row) => row.trigger === "RESUME").map((row) => row.guard)).toEqual([
      "CAUSE_CLEARED",
    ]);
  });
});

describe("invariant I5: internal triggers never enter a motion state from a stopped or teleoperated state", () => {
  it("has no internal row from PAUSED, ESTOP, BLOCKED or TELEOP into MOVING, WORKING or TELEOP", () => {
    const offending = TRANSITIONS.filter(
      (row) =>
        isInternal(row) &&
        PRE_STATE_ORIGINS.some((origin) => origin === row.from) &&
        (MOTION_STATES as readonly RowTarget[]).includes(row.to),
    );
    expect(offending).toEqual([]);
  });
});

describe("invariant I6: the robot table never targets OFFLINE", () => {
  it("has no row whose target is OFFLINE", () => {
    expect(TRANSITIONS.map((row) => row.to)).not.toContain("OFFLINE");
  });
});

describe("invariant I7: deadman and lock expiry never enter a motion state", () => {
  it.each(["DEADMAN_EXPIRED", "LOCK_EXPIRED"] as const)("%s", (trigger) => {
    const rows = TRANSITIONS.filter((row) => row.trigger === trigger);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect((MOTION_STATES as readonly RowTarget[]).includes(row.to), row.from).toBe(false);
    }
  });
});

describe("invariant I8: every command that enters a motion state is lock-gated or takes the lock", () => {
  it("only lock-required commands and TAKE_CONTROL reach a motion state", () => {
    const allowed = new Set<string>([...LOCK_REQUIRED_COMMANDS, "TAKE_CONTROL"]);
    const reaching = TRANSITIONS.filter(
      (row) =>
        !isInternal(row) &&
        (row.to === "RESUME_TARGET" || (MOTION_STATES as readonly RowTarget[]).includes(row.to)),
    );
    expect(reaching.length).toBeGreaterThan(0);
    for (const row of reaching) {
      expect(allowed.has(row.trigger), `${row.from} ${row.trigger}`).toBe(true);
    }
  });
});

describe("rows the design spells out", () => {
  it("refuses RESUME while the cause is still pending, with INVALID_STATE", () => {
    const guards = new Set<Guard>(["CAUSE_PENDING"]);
    expect(transition("BLOCKED", "RESUME", guards)).toEqual({
      to: "BLOCKED",
      reply: "REJECT",
      reason: "INVALID_STATE",
      effects: [],
      changed: false,
    });
  });

  it("moves a teleoperated robot to PAUSED on deadman expiry, keeping TELEOP as the resume target", () => {
    const result = transition("TELEOP", "DEADMAN_EXPIRED", NO_GUARDS);
    expect(result.to).toBe("PAUSED");
    expect(result.changed).toBe(true);
    expect(result.effects).toContain("RESUME_TARGET_FROM");
    expect(result.reply).toBe("NONE");
  });

  it("resumes to the stored target and refuses to resume without one", () => {
    expect(transition("PAUSED", "RESUME", NO_GUARDS, "TELEOP").to).toBe("TELEOP");
    expect(() => transition("PAUSED", "RESUME", NO_GUARDS)).toThrow(TypeError);
  });

  it("acknowledges TAKE_CONTROL from the holder as a no-op that still refreshes the lock", () => {
    expect(transition("TELEOP", "TAKE_CONTROL", NO_GUARDS)).toMatchObject({
      to: "TELEOP",
      reply: "ACK",
      changed: false,
      effects: ["ACQUIRE_LOCK"],
    });
  });

  it("answers HEARTBEAT silently in every state", () => {
    for (const state of ALL8) {
      expect(transition(state, "HEARTBEAT", NO_GUARDS)).toMatchObject({
        to: state,
        reply: "NONE",
        changed: false,
      });
    }
  });

  it("refuses a command with no row, with INVALID_STATE, and ignores an internal trigger with no row", () => {
    expect(transition("IDLE", "RESUME", NO_GUARDS)).toMatchObject({
      to: "IDLE",
      reply: "REJECT",
      reason: "INVALID_STATE",
    });
    expect(transition("IDLE", "CHARGED", NO_GUARDS)).toMatchObject({
      to: "IDLE",
      reply: "NONE",
      changed: false,
    });
  });

  it("boots into ESTOP when the latch is set and into IDLE when it is not", () => {
    expect(transition("START", "BOOT", new Set<Guard>(["LATCH_SET"]))).toMatchObject({
      to: "ESTOP",
      reply: "NONE",
      changed: true,
    });
    expect(transition("START", "BOOT", new Set<Guard>(["LATCH_NOT_SET"])).to).toBe("IDLE");
  });

  it("refuses a boot that names neither latch guard", () => {
    expect(() => transition("START", "BOOT", NO_GUARDS)).toThrow(TypeError);
  });

  it("keeps a repeated return to base at the charger without a change", () => {
    expect(transition("MOVING", "RETURN_TO_BASE", new Set<Guard>(["DEST_CHARGER"]))).toMatchObject({
      to: "MOVING",
      changed: false,
      reply: "ACK",
    });
  });
});

describe("cloud table", () => {
  it.each(ALL8)("moves %s to OFFLINE on each disconnect trigger", (state) => {
    for (const trigger of ["CLOUD_DISCONNECTED", "CLOUD_SILENCE_15S"] as const) {
      expect(transitionCloud(state, trigger)).toEqual({ to: "OFFLINE", changed: true });
    }
  });

  it("has sixteen disconnect rows and one reporting row", () => {
    expect(CLOUD_TRANSITIONS).toHaveLength(17);
    expect(CLOUD_TRANSITIONS.some((row) => row.from === "OFFLINE")).toBe(true);
  });

  it("returns OFFLINE to the state the robot reports", () => {
    expect(transitionCloud("OFFLINE", "ROBOT_REPORTED", "MOVING")).toEqual({
      to: "MOVING",
      changed: true,
    });
  });

  it("refuses ROBOT_REPORTED from OFFLINE when no reported state is given", () => {
    expect(() => transitionCloud("OFFLINE", "ROBOT_REPORTED")).toThrow(TypeError);
  });

  it("leaves the state unchanged for a pair with no row", () => {
    expect(transitionCloud("OFFLINE", "CLOUD_DISCONNECTED")).toEqual({
      to: "OFFLINE",
      changed: false,
    });
    expect(transitionCloud("IDLE", "ROBOT_REPORTED", "IDLE")).toEqual({
      to: "IDLE",
      changed: false,
    });
  });
});

describe("reply invariants over every origin and trigger", () => {
  const triggers = [...CommandTriggerSchema.options, ...InternalTriggerSchema.options];
  const oneGuardSets: ReadonlySet<Guard>[] = [
    new Set<Guard>(),
    ...RowGuardOptions.map((guard) => new Set<Guard>([guard])),
  ];

  for (const origin of ALL8) {
    it(`answers every trigger from ${origin} with a reply that matches its kind`, () => {
      for (const trigger of triggers) {
        for (const guards of oneGuardSets) {
          const result = transition(origin, trigger, guards, "IDLE");
          if (CommandTriggerSchema.safeParse(trigger).success) {
            // A command is answered, except HEARTBEAT, which is never acknowledged.
            if (trigger === "HEARTBEAT") {
              expect(result.reply, `${origin} ${trigger}`).toBe("NONE");
            } else {
              expect(["ACK", "REJECT"], `${origin} ${trigger}`).toContain(result.reply);
            }
          } else {
            // An internal trigger is never acknowledged and never refused.
            expect(result.reply, `${origin} ${trigger}`).toBe("NONE");
          }
          expect(result.changed, `${origin} ${trigger}`).toBe(result.to !== origin);
        }
      }
    });
  }

  it("boots from START only through a latch guard, to ESTOP or IDLE, and changes the state", () => {
    expect(transition("START", "BOOT", new Set<Guard>(["LATCH_SET"]), undefined)).toMatchObject({
      to: "ESTOP",
      reply: "NONE",
      changed: true,
    });
    expect(transition("START", "BOOT", new Set<Guard>(["LATCH_NOT_SET"]), undefined)).toMatchObject(
      {
        to: "IDLE",
        reply: "NONE",
        changed: true,
      },
    );
  });

  it("refuses every trigger other than BOOT from START, because no row starts there", () => {
    for (const trigger of triggers) {
      if (trigger === "BOOT") continue;
      expect(() => transition("START", trigger, new Set<Guard>(["LATCH_SET"]))).toThrow(TypeError);
    }
  });

  it("boot rows always target a reported state, never SAME or RESUME_TARGET", () => {
    const boot = TRANSITIONS.filter((row) => row.from === "START");
    expect(boot.length).toBeGreaterThan(0);
    for (const row of boot) {
      expect(RobotReportedStateSchema.safeParse(row.to).success, row.guard).toBe(true);
    }
  });
});

describe("fail-closed refusals", () => {
  it("refuses a command that two rival rows match, without a state change", () => {
    const guards = new Set<Guard>(["DEST_STATION", "DEST_CHARGER"]);
    expect(transition("MOVING", "RETURN_TO_BASE", guards)).toMatchObject({
      to: "MOVING",
      reply: "REJECT",
      reason: "INVALID_STATE",
      changed: false,
    });
  });

  it("throws for an internal trigger that two rival rows match", () => {
    const guards = new Set<Guard>(["CHARGE_REQUESTED", "MISSION_REMAINING"]);
    expect(() => transition("WORKING", "WORK_DONE", guards)).toThrow(TypeError);
  });

  it("refuses to act for a robot the cloud holds OFFLINE", () => {
    expect(() => transition("OFFLINE", "HEARTBEAT", new Set<Guard>())).toThrow(TypeError);
  });

  it("never accepts ESTOP as the stored resume target", () => {
    expect(() => transition("PAUSED", "RESUME", new Set<Guard>(), "ESTOP")).toThrow(TypeError);
  });

  it("refuses an unknown cloud trigger", () => {
    expect(() => transitionCloud("IDLE", "BOGUS" as CloudTrigger)).toThrow(TypeError);
  });
});
