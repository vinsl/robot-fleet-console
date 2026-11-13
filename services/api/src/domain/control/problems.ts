/**
 * The fixed refusals of the control use cases. Each one is a single sentence the operator can act on, and none of
 * them echoes the request or an internal error.
 */
import type { UseCaseProblem } from "../result";

/** The refusals of the control use cases, keyed by the situation they name. */
export const CONTROL_PROBLEMS = {
  robotNotFound: {
    type: "robot-not-found",
    status: 404,
    detail: "No robot matches this request.",
  },
  robotRetired: {
    type: "robot-state-conflict",
    status: 409,
    detail: "The robot is retired or being retired.",
  },
  lockHeld: {
    type: "lock-held",
    status: 409,
    detail: "Another operator has control of this robot.",
  },
  lockNotHeld: {
    type: "lock-not-held",
    status: 409,
    detail: "Take control of the robot first.",
  },
  commandConflict: {
    type: "command-conflict",
    status: 409,
    detail: "This command identifier was already used for another request.",
  },
  demoModeOff: {
    type: "demo-mode-off",
    status: 409,
    detail: "Demo mode is off for this site.",
  },
  notSimulated: {
    type: "not-simulated",
    status: 409,
    detail: "The robot is not simulated.",
  },
  roleNotAllowed: {
    type: "forbidden",
    status: 403,
    detail: "The role does not allow this request.",
  },
  publishFailed: {
    type: "upstream-failed",
    status: 502,
    detail: "The command could not be sent. Send it again with the same identifier.",
  },
  tooLate: {
    type: "upstream-failed",
    status: 503,
    detail: "The request ran out of time. Nothing was sent.",
  },
} as const satisfies Record<string, UseCaseProblem>;
