/**
 * Robot state machine: the vocabulary of triggers, guards and effects, and the transition table that
 * the robot agent mirrors row for row.
 *
 * The table is written once below in set notation, then expanded into one row per (origin, trigger,
 * guard). A pair with no row is refused by the command pipeline (`INVALID_STATE`) or ignored (internal
 * triggers), so the table never has to list what does not happen.
 *
 * The state machine is the safety core of the robot. Every change to it is covered by the invariant
 * tests in `test/state-machine.test.ts`, and the agent's parity tests compare its own table with the
 * generated `state-machine.json`.
 */
import { z } from "zod";
import type { AckReason } from "./acks";
import { FaultCodeSchema, RobotReportedStateSchema } from "./robot-state";
import type { RobotReportedState, RobotState } from "./robot-state";

/**
 * Commands that drive the state machine. `DRIVE` is absent on purpose: it is reserved for a bonus
 * the robot does not implement, so it is rejected before the table is consulted.
 */
export const CommandTriggerSchema = z.enum([
  "ESTOP",
  "ESTOP_RELEASE",
  "PAUSE",
  "RESUME",
  "RETURN_TO_BASE",
  "TAKE_CONTROL",
  "RELEASE_CONTROL",
  "HEARTBEAT",
  ...FaultCodeSchema.options.map((fault) => `SIMULATE_FAULT:${fault}` as const),
]);

/** A trigger that comes from a command or from the simulator's fault injection. */
export type CommandTrigger = z.infer<typeof CommandTriggerSchema>;

/** Triggers raised by the robot itself: sensors, mission progress, battery and timers. */
export const InternalTriggerSchema = z.enum([
  "BOOT",
  "MISSION_ASSIGNED",
  "ARRIVED",
  "WORK_DONE",
  "CHARGED",
  "OBSTACLE_DETECTED",
  "SENSOR_FAULT",
  "CAUSE_CLEARED",
  "BATTERY_LOW",
  "DEADMAN_EXPIRED",
  "LOCK_EXPIRED",
]);

/** A trigger raised by the robot itself. */
export type InternalTrigger = z.infer<typeof InternalTriggerSchema>;

/** Any trigger the robot can act on. */
export const TriggerSchema = z.union([CommandTriggerSchema, InternalTriggerSchema]);

/** A validated trigger. */
export type Trigger = z.infer<typeof TriggerSchema>;

/**
 * What may be recorded as the cause of a state change. `BOOT` is excluded: a boot is announced by the
 * `BOOT` event, and its row starts from the non-state origin `START`, so it never changes a state the
 * robot already reported.
 */
export const StateChangeCauseSchema = z.union([
  CommandTriggerSchema,
  InternalTriggerSchema.exclude(["BOOT"]),
]);

/**
 * Triggers raised by the cloud. They are kept apart from the robot triggers: the robot never acts on
 * them and they are never a valid `cause` in an event.
 */
export const CloudTriggerSchema = z.enum([
  "CLOUD_DISCONNECTED",
  "CLOUD_SILENCE_15S",
  "ROBOT_REPORTED",
]);

/** A validated cloud trigger. */
export type CloudTrigger = z.infer<typeof CloudTriggerSchema>;

/**
 * Conditions a row may depend on. The caller evaluates them against the robot model and passes the
 * ones that hold. `ALWAYS` holds unconditionally and is never passed.
 */
export const GuardSchema = z.enum([
  "ALWAYS",
  "CAUSE_CLEARED",
  "CAUSE_PENDING",
  "DEST_CHARGER",
  "DEST_STATION",
  "CHARGE_REQUESTED",
  "MISSION_REMAINING",
  "MISSION_COMPLETE",
  "LATCH_SET",
  "LATCH_NOT_SET",
  "ESTOP_FROM_IDLE",
  "ESTOP_FROM_OTHER",
]);

/** A validated guard. */
export type Guard = z.infer<typeof GuardSchema>;

/** Side effects a row asks the robot model to perform. The table never performs them itself. */
export const EffectSchema = z.enum([
  "STOP_MOTION",
  "ABORT_MISSION",
  "END_MISSION",
  "SET_DEST_CHARGER",
  "SET_DEST_STATION",
  "RESUME_TARGET_FROM",
  "RESUME_TARGET_IDLE",
  "MARK_CAUSE",
  "CLEAR_CAUSE",
  "REQUEST_CHARGE",
  "SET_BATTERY_LOW",
  "DROP_LINK",
  "ACQUIRE_LOCK",
  "RELEASE_LOCK",
  "LATCH_ESTOP",
  "CLEAR_ESTOP_LATCH",
  "RECORD_ESTOP_ORIGIN",
]);

/** A validated effect. */
export type Effect = z.infer<typeof EffectSchema>;

/**
 * What the robot answers to a command. `ACK` is the answer to every accepted command, including a
 * no-op, which is an `ACK` with an unchanged state. `NONE` is for internal triggers and for
 * `HEARTBEAT`, which is never acknowledged.
 */
export const ReplySchema = z.enum(["ACK", "REJECT", "NONE"]);

/** A validated reply. */
export type Reply = z.infer<typeof ReplySchema>;

/**
 * Origin of the boot rows. It is not a state: the robot has not reported one yet. Only `BOOT` rows
 * use it, and it never appears in telemetry or events.
 */
export const BootOriginSchema = z.literal("START");

/** Where a row starts: a reported state, or the boot origin. */
export type RowOrigin = RobotReportedState | "START";

/** Where a row ends: a state, the same state (`SAME`), or the stored resume target. */
export type RowTarget = RobotReportedState | "SAME" | "RESUME_TARGET";

/** States in which the robot moves or is under teleoperation. The deadman and the lock apply to them. */
export const MOTION_STATES = ["TELEOP", "MOVING", "WORKING"] as const;

/** One row of the robot table, after expansion: a single origin, trigger and guard. */
export interface TransitionRow {
  readonly from: RowOrigin;
  readonly trigger: Trigger;
  readonly guard: Guard;
  readonly to: RowTarget;
  readonly effects: readonly Effect[];
  readonly reply: Reply;
  /** Present only on a `REJECT` row. */
  readonly reason?: AckReason;
}

/** One row of the cloud table: how the cloud marks a robot offline, and when it reports it back. */
export interface CloudTransitionRow {
  readonly from: RobotState;
  readonly trigger: CloudTrigger;
  readonly to: "OFFLINE" | "REPORTED";
}

/** Outcome of a robot transition, as the command pipeline and the event publisher use it. */
export interface TransitionResult {
  readonly to: RobotReportedState;
  readonly reply: Reply;
  readonly reason: AckReason | null;
  readonly effects: readonly Effect[];
  readonly changed: boolean;
}

/** Outcome of a cloud transition. */
export interface CloudTransitionResult {
  readonly to: RobotState;
  readonly changed: boolean;
}

/** Specification of one table line, in set notation. It is expanded by {@link expandSpec}. */
interface RowSpec {
  readonly from: readonly RowOrigin[];
  readonly trigger: Trigger;
  readonly guard?: Guard;
  readonly to: RowTarget;
  readonly effects?: readonly Effect[];
  readonly reply?: Reply;
  readonly reason?: AckReason;
}

const ALL_REPORTED: readonly RobotReportedState[] = RobotReportedStateSchema.options;
const ACTIVE: readonly RobotReportedState[] = ["IDLE", "WORKING", "MOVING", "CHARGING", "TELEOP"];
const COMMAND_TRIGGERS: ReadonlySet<string> = new Set<string>(CommandTriggerSchema.options);

/**
 * Removes the excluded states from a set, for the `ALL8 \ X` notation of the specification.
 *
 * @param states - The set to narrow.
 * @param excluded - The states to remove.
 * @returns A new array without the excluded states.
 */
function without(
  states: readonly RobotReportedState[],
  ...excluded: readonly RobotReportedState[]
): RobotReportedState[] {
  return states.filter((state) => !excluded.includes(state));
}

/** Effects that stop a blocked robot and remember what was interrupted, shared by every fault row. */
const BLOCK_EFFECTS: readonly Effect[] = ["STOP_MOTION", "RESUME_TARGET_FROM", "MARK_CAUSE"];

/**
 * The robot table in set notation. Rows are listed in the order of the design specification (section
 * 2.4), command rows first, then internal rows.
 */
const ROW_SPECS: readonly RowSpec[] = [
  // Command rows: a valid command, after the pipeline checks, is acknowledged unless stated otherwise.
  {
    from: without(ALL_REPORTED, "ESTOP"),
    trigger: "ESTOP",
    to: "ESTOP",
    effects: ["STOP_MOTION", "ABORT_MISSION", "LATCH_ESTOP", "RECORD_ESTOP_ORIGIN"],
  },
  { from: ["ESTOP"], trigger: "ESTOP", to: "SAME" },
  // The release goes back to IDLE only when the robot was IDLE at the e-stop. Any other origin, and an origin
  // lost in a reboot, goes to PAUSED: the robot never leaves the e-stop straight into motion.
  {
    from: ["ESTOP"],
    trigger: "ESTOP_RELEASE",
    guard: "ESTOP_FROM_IDLE",
    to: "IDLE",
    effects: ["CLEAR_ESTOP_LATCH", "RESUME_TARGET_IDLE"],
  },
  {
    from: ["ESTOP"],
    trigger: "ESTOP_RELEASE",
    guard: "ESTOP_FROM_OTHER",
    to: "PAUSED",
    effects: ["CLEAR_ESTOP_LATCH", "RESUME_TARGET_IDLE"],
  },
  { from: ACTIVE, trigger: "PAUSE", to: "PAUSED", effects: ["STOP_MOTION", "RESUME_TARGET_FROM"] },
  { from: ["PAUSED"], trigger: "PAUSE", to: "SAME" },
  { from: ["PAUSED"], trigger: "RESUME", to: "RESUME_TARGET" },
  {
    from: ["BLOCKED"],
    trigger: "RESUME",
    guard: "CAUSE_CLEARED",
    to: "RESUME_TARGET",
    effects: ["CLEAR_CAUSE"],
  },
  {
    from: ["BLOCKED"],
    trigger: "RESUME",
    guard: "CAUSE_PENDING",
    to: "SAME",
    reply: "REJECT",
    reason: "INVALID_STATE",
  },
  {
    from: ["IDLE", "WORKING", "PAUSED", "BLOCKED", "TELEOP"],
    trigger: "RETURN_TO_BASE",
    to: "MOVING",
    effects: ["ABORT_MISSION", "SET_DEST_CHARGER", "CLEAR_CAUSE"],
  },
  {
    from: ["MOVING"],
    trigger: "RETURN_TO_BASE",
    guard: "DEST_STATION",
    to: "MOVING",
    effects: ["ABORT_MISSION", "SET_DEST_CHARGER"],
  },
  { from: ["MOVING"], trigger: "RETURN_TO_BASE", guard: "DEST_CHARGER", to: "SAME" },
  { from: ["CHARGING"], trigger: "RETURN_TO_BASE", to: "SAME" },
  {
    from: ["IDLE", "WORKING", "MOVING", "CHARGING", "PAUSED"],
    trigger: "TAKE_CONTROL",
    to: "TELEOP",
    effects: ["ACQUIRE_LOCK", "STOP_MOTION", "ABORT_MISSION"],
  },
  { from: ["TELEOP"], trigger: "TAKE_CONTROL", to: "SAME", effects: ["ACQUIRE_LOCK"] },
  { from: ["BLOCKED", "ESTOP"], trigger: "TAKE_CONTROL", to: "SAME", effects: ["ACQUIRE_LOCK"] },
  {
    from: ["TELEOP"],
    trigger: "RELEASE_CONTROL",
    to: "PAUSED",
    effects: ["RELEASE_LOCK", "STOP_MOTION", "RESUME_TARGET_IDLE"],
  },
  {
    from: without(ALL_REPORTED, "TELEOP"),
    trigger: "RELEASE_CONTROL",
    to: "SAME",
    effects: ["RELEASE_LOCK"],
  },
  { from: ALL_REPORTED, trigger: "HEARTBEAT", to: "SAME", reply: "NONE" },
  {
    from: ["MOVING", "WORKING", "TELEOP"],
    trigger: "SIMULATE_FAULT:OBSTACLE",
    to: "BLOCKED",
    effects: BLOCK_EFFECTS,
  },
  {
    from: ["IDLE", "WORKING", "MOVING", "CHARGING", "PAUSED", "TELEOP"],
    trigger: "SIMULATE_FAULT:SENSOR_FAULT",
    to: "BLOCKED",
    effects: BLOCK_EFFECTS,
  },
  {
    from: without(ALL_REPORTED, "ESTOP"),
    trigger: "SIMULATE_FAULT:BATTERY_LOW",
    to: "SAME",
    effects: ["SET_BATTERY_LOW"],
  },
  {
    from: without(ALL_REPORTED, "ESTOP"),
    trigger: "SIMULATE_FAULT:LINK_LOSS",
    to: "SAME",
    effects: ["DROP_LINK"],
  },

  // Boot rows: the only rows whose origin is START. The latch decides between ESTOP and IDLE.
  { from: ["START"], trigger: "BOOT", guard: "LATCH_SET", to: "ESTOP", reply: "NONE" },
  { from: ["START"], trigger: "BOOT", guard: "LATCH_NOT_SET", to: "IDLE", reply: "NONE" },

  // Internal rows: raised by the robot, never acknowledged.
  { from: ["IDLE"], trigger: "MISSION_ASSIGNED", to: "MOVING", effects: ["SET_DEST_STATION"] },
  { from: ["MOVING"], trigger: "ARRIVED", guard: "DEST_STATION", to: "WORKING" },
  { from: ["MOVING"], trigger: "ARRIVED", guard: "DEST_CHARGER", to: "CHARGING" },
  {
    from: ["WORKING"],
    trigger: "WORK_DONE",
    guard: "CHARGE_REQUESTED",
    to: "MOVING",
    effects: ["END_MISSION", "SET_DEST_CHARGER"],
  },
  {
    from: ["WORKING"],
    trigger: "WORK_DONE",
    guard: "MISSION_REMAINING",
    to: "MOVING",
    effects: ["SET_DEST_STATION"],
  },
  {
    from: ["WORKING"],
    trigger: "WORK_DONE",
    guard: "MISSION_COMPLETE",
    to: "IDLE",
    effects: ["END_MISSION"],
  },
  { from: ["CHARGING"], trigger: "CHARGED", to: "IDLE" },
  {
    from: ["MOVING", "TELEOP"],
    trigger: "OBSTACLE_DETECTED",
    to: "BLOCKED",
    effects: BLOCK_EFFECTS,
  },
  {
    from: ["IDLE", "WORKING", "MOVING", "CHARGING", "PAUSED", "TELEOP"],
    trigger: "SENSOR_FAULT",
    to: "BLOCKED",
    effects: BLOCK_EFFECTS,
  },
  { from: ["BLOCKED"], trigger: "CAUSE_CLEARED", to: "SAME", effects: ["CLEAR_CAUSE"] },
  { from: ["IDLE"], trigger: "BATTERY_LOW", to: "MOVING", effects: ["SET_DEST_CHARGER"] },
  {
    from: without(ALL_REPORTED, "IDLE", "CHARGING"),
    trigger: "BATTERY_LOW",
    to: "SAME",
    effects: ["REQUEST_CHARGE"],
  },
  {
    from: ["TELEOP", "MOVING", "WORKING"],
    trigger: "DEADMAN_EXPIRED",
    to: "PAUSED",
    effects: ["STOP_MOTION", "RESUME_TARGET_FROM"],
  },
  {
    from: ["TELEOP"],
    trigger: "LOCK_EXPIRED",
    to: "PAUSED",
    effects: ["RELEASE_LOCK", "STOP_MOTION", "RESUME_TARGET_IDLE"],
  },
  {
    from: without(ALL_REPORTED, "TELEOP"),
    trigger: "LOCK_EXPIRED",
    to: "SAME",
    effects: ["RELEASE_LOCK"],
  },
];

/**
 * Expands one line of the specification into one row per origin.
 *
 * The default reply is `ACK` for a command and `NONE` for an internal trigger. A `REJECT` row carries
 * its reason; any other row does not, so the key is absent rather than undefined.
 *
 * @param spec - The line to expand.
 * @returns One row per origin in the line.
 */
function expandSpec(spec: RowSpec): TransitionRow[] {
  const reply: Reply = spec.reply ?? (COMMAND_TRIGGERS.has(spec.trigger) ? "ACK" : "NONE");
  return spec.from.map((from) => ({
    from,
    trigger: spec.trigger,
    guard: spec.guard ?? "ALWAYS",
    to: spec.to,
    effects: spec.effects ?? [],
    reply,
    ...(spec.reason === undefined ? {} : { reason: spec.reason }),
  }));
}

/** Every robot transition row, expanded. Exported for the generator and the tests; do not mutate. */
export const TRANSITIONS: readonly TransitionRow[] = ROW_SPECS.flatMap(expandSpec);

/**
 * Cloud rows. Every reported state goes `OFFLINE` on either disconnect trigger; `OFFLINE` returns to
 * whatever state the robot reports next. A pair without a row leaves the state unchanged.
 */
export const CLOUD_TRANSITIONS: readonly CloudTransitionRow[] = [
  ...ALL_REPORTED.flatMap((from) =>
    (["CLOUD_DISCONNECTED", "CLOUD_SILENCE_15S"] as const).map((trigger) => ({
      from,
      trigger,
      to: "OFFLINE" as const,
    })),
  ),
  { from: "OFFLINE", trigger: "ROBOT_REPORTED", to: "REPORTED" },
];

/**
 * Lists every row for an origin and a trigger whose guard holds.
 *
 * @param from - The origin: a reported state, or START for a boot.
 * @param trigger - The trigger that arrived.
 * @param guards - The guards that hold; `ALWAYS` is implicit.
 * @returns The matching rows, in table order. The table makes this one row in every legal call.
 */
function matchingRows(
  from: RowOrigin,
  trigger: Trigger,
  guards: ReadonlySet<Guard>,
): TransitionRow[] {
  return TRANSITIONS.filter(
    (row) =>
      row.from === from &&
      row.trigger === trigger &&
      (row.guard === "ALWAYS" || guards.has(row.guard)),
  );
}

/**
 * Outcome of a command the robot refuses without changing state.
 *
 * @param state - The state the robot stays in.
 * @returns A `REJECT` with `INVALID_STATE`.
 */
function refusal(state: RobotReportedState): TransitionResult {
  return { to: state, reply: "REJECT", reason: "INVALID_STATE", effects: [], changed: false };
}

/**
 * Outcome of an internal trigger that no row handles: nothing happens, and nothing is answered.
 *
 * @param state - The state the robot stays in.
 * @returns A `NONE` reply without change.
 */
function ignored(state: RobotReportedState): TransitionResult {
  return { to: state, reply: "NONE", reason: null, effects: [], changed: false };
}

/**
 * Transition of the boot: the only rows whose origin is START. Exactly one latch guard must hold.
 *
 * @param trigger - The trigger that arrived. Only BOOT has a boot row.
 * @param guards - The guards that hold.
 * @returns The boot outcome; a boot always changes the state.
 * @throws TypeError If zero or two boot rows match.
 */
function bootTransition(trigger: Trigger, guards: ReadonlySet<Guard>): TransitionResult {
  const matches = matchingRows("START", trigger, guards);
  const [row] = matches;
  if (matches.length !== 1 || row === undefined) {
    throw new TypeError("a boot needs exactly one of LATCH_SET or LATCH_NOT_SET");
  }
  // Every START row targets a reported state (test "boot rows always target a reported state"), so
  // the target is narrowed here by the table rather than by a run-time branch.
  return {
    to: row.to as RobotReportedState,
    reply: row.reply,
    reason: null,
    effects: row.effects,
    changed: true,
  };
}

/**
 * Transition of a robot that has reported a state. Fails closed when more than one row matches: a
 * command is refused, and an internal trigger is a programming error.
 *
 * @param from - The reported state the robot is in.
 * @param trigger - The trigger that arrived.
 * @param guards - The guards that hold.
 * @param resumeTarget - The stored resume target, used by rows that resume.
 * @returns The outcome of the transition.
 * @throws TypeError If an internal trigger matches two rows, or a resuming row has no target.
 */
function reportedTransition(
  from: RobotReportedState,
  trigger: Trigger,
  guards: ReadonlySet<Guard>,
  resumeTarget: RobotReportedState | undefined,
): TransitionResult {
  const isCommand = COMMAND_TRIGGERS.has(trigger);
  const matches = matchingRows(from, trigger, guards);
  if (matches.length > 1) {
    // Two rival rows mean the caller passed guards that are not exclusive. A command is refused, so an
    // operator sees a rejection; an internal trigger has no safe answer and must not be guessed.
    if (isCommand) {
      return refusal(from);
    }
    throw new TypeError("two rows match an internal trigger: the guards must be exclusive");
  }
  const [row] = matches;
  if (row === undefined) {
    return isCommand ? refusal(from) : ignored(from);
  }

  let to: RobotReportedState;
  if (row.to === "SAME") {
    to = from;
  } else if (row.to === "RESUME_TARGET") {
    if (resumeTarget === undefined) {
      throw new TypeError("this transition resumes and needs the stored resume target");
    }
    to = resumeTarget;
  } else {
    to = row.to;
  }
  return {
    to,
    reply: row.reply,
    reason: row.reason ?? null,
    effects: row.effects,
    changed: to !== from,
  };
}

/**
 * Computes the outcome of a robot trigger. It is pure: the caller applies the returned effects.
 *
 * A pair with no row is refused with `INVALID_STATE` when it is a command, and ignored otherwise. The
 * guards passed must be exclusive; if two rival rows match, a command is refused and an internal trigger
 * throws, so an inconsistent model fails closed. The table is never consulted with the `OFFLINE`
 * origin, because the robot cannot act while the cloud considers it offline.
 *
 * @param from - The origin: a reported state, or START for a boot.
 * @param trigger - The trigger that arrived.
 * @param guards - The guards that hold; `ALWAYS` is implicit.
 * @param resumeTarget - The stored resume target. Required only by rows that resume; never `ESTOP`.
 * @returns The target, the reply, its reason, the effects and whether the state changed.
 * @throws TypeError If the origin is OFFLINE, the resume target is ESTOP or missing when needed, a boot
 *   has no single latch guard, or an internal trigger matches two rows.
 */
export function transition(
  from: RobotState | "START",
  trigger: Trigger,
  guards: ReadonlySet<Guard>,
  resumeTarget?: RobotReportedState,
): TransitionResult {
  if (from === "OFFLINE") {
    throw new TypeError("a robot cannot act while the cloud holds it OFFLINE");
  }
  if (resumeTarget === "ESTOP") {
    throw new TypeError("ESTOP is never a resume target");
  }
  if (from === "START") {
    return bootTransition(trigger, guards);
  }
  return reportedTransition(from, trigger, guards, resumeTarget);
}

/**
 * Computes the cloud view of a robot: `OFFLINE` on disconnect or silence, and the reported state again
 * once the robot speaks.
 *
 * @param state - The state the cloud currently holds for the robot.
 * @param trigger - The cloud trigger.
 * @param reported - The state the robot reported. Required only by `ROBOT_REPORTED` from `OFFLINE`.
 * @returns The new state and whether it changed. A pair with no row returns the state unchanged.
 * @throws TypeError If the trigger is unknown, or the row needs the reported state and it was not given.
 */
export function transitionCloud(
  state: RobotState,
  trigger: CloudTrigger,
  reported?: RobotReportedState,
): CloudTransitionResult {
  if (!CloudTriggerSchema.safeParse(trigger).success) {
    throw new TypeError("unknown cloud trigger");
  }
  const row = CLOUD_TRANSITIONS.find(
    (candidate) => candidate.from === state && candidate.trigger === trigger,
  );
  if (row === undefined) {
    return { to: state, changed: false };
  }
  if (row.to === "REPORTED") {
    if (reported === undefined) {
      throw new TypeError("ROBOT_REPORTED needs the state the robot reported");
    }
    return { to: reported, changed: reported !== state };
  }
  return { to: row.to, changed: row.to !== state };
}
