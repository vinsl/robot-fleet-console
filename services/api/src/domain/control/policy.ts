/**
 * The command policy: for each controlled command, the roles that may send it, whether it needs the lock, the demo
 * mode or a simulated robot, and the audit action it writes.
 *
 * One table, read row by row by the tests, so a rule cannot be added in one handler and forgotten in another. A test
 * checks the lock column against the protocol's `LOCK_REQUIRED_COMMANDS` and `LOCK_FREE_COMMANDS` (ADR 0062).
 */
import type { AuditAction, ControlledCommandType, Role } from "@mfc/protocol";

/** What a controlled command requires before it is published. */
export interface CommandPolicy {
  /** Roles that may send the command. */
  readonly roles: readonly Role[];
  /** The caller must hold the robot lock. */
  readonly needsLock: boolean;
  /** The site must have the demo mode on. */
  readonly needsDemoMode: boolean;
  /** The robot must be registered as simulated. */
  readonly needsSimulated: boolean;
  /** The audit action written after the outcome. */
  readonly auditAction: AuditAction;
}

/** Roles that act on the fleet: every role except the Viewer. */
const OPERATORS: readonly Role[] = ["Admin", "Operator"];

/** Roles that may inject a fault: the demo administrator only. */
const ADMIN: readonly Role[] = ["Admin"];

/** Policy of every controlled command, keyed by its type. */
export const COMMAND_POLICY: Readonly<Record<ControlledCommandType, CommandPolicy>> = {
  PAUSE: {
    roles: OPERATORS,
    needsLock: true,
    needsDemoMode: false,
    needsSimulated: false,
    auditAction: "command.pause",
  },
  RESUME: {
    roles: OPERATORS,
    needsLock: true,
    needsDemoMode: false,
    needsSimulated: false,
    auditAction: "command.resume",
  },
  RETURN_TO_BASE: {
    roles: OPERATORS,
    needsLock: true,
    needsDemoMode: false,
    needsSimulated: false,
    auditAction: "command.return_to_base",
  },
  // An e-stop is never queued behind a lock check: an operator must always be able to stop a robot.
  ESTOP: {
    roles: OPERATORS,
    needsLock: false,
    needsDemoMode: false,
    needsSimulated: false,
    auditAction: "command.estop",
  },
  ESTOP_RELEASE: {
    roles: OPERATORS,
    needsLock: true,
    needsDemoMode: false,
    needsSimulated: false,
    auditAction: "command.estop_release",
  },
  SIMULATE_FAULT: {
    roles: ADMIN,
    needsLock: false,
    needsDemoMode: true,
    needsSimulated: true,
    auditAction: "command.simulate_fault",
  },
};
