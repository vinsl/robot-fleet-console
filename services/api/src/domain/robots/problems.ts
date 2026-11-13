/**
 * Failure codes of the robot use cases and the RFC 7807 problem each one returns.
 *
 * Titles and details are fixed text written in this module. No AWS error message, ARN, account
 * identifier or stack trace reaches a problem: the operator finds the cause in the logs, by the
 * correlation identifier. Keeping the text here also lets every problem be tested as a table.
 */
import { PROBLEM_TYPES, ProblemSchema, type CorrelationId, type Problem } from "@mfc/protocol";

/** A problem type of the robot use cases. Each one is published as `urn:mfc:problem:<code>`. */
// The HTTP-only problems (authentication, authorisation, size, rate) are never produced by the robot
// functions, and the site, alert and control problems have their own catalogues, so this catalogue
// excludes them and its switch stays exhaustive over what it can return.
export type RobotsFailureCode = Exclude<
  (typeof PROBLEM_TYPES)[number],
  | "unauthorized"
  | "forbidden"
  | "not-found"
  | "payload-too-large"
  | "rate-limited"
  | "map-not-found"
  | "map-invalid"
  | "version-limit"
  | "alert-not-found"
  | "alert-state-conflict"
  | "lock-held"
  | "lock-not-held"
  | "command-conflict"
  | "demo-mode-off"
  | "not-simulated"
  | "upstream-failed"
>;

/** The fixed details the API may return. A detail is never built from input or from an internal error. */
export const PROBLEM_DETAILS = {
  invalidRequest: "The request does not match the schema.",
  robotExists: "This robot id is already registered.",
  robotNotFound: "No robot with this id at this site.",
  busy: "Another operation is in progress on this robot; retry in two minutes.",
  tooManyAttempts: "Too many registration attempts; retire the robot.",
  provisioningFailed: "Registration failed and was rolled back; send the same registration again.",
  retirementFailed: "Retirement is incomplete; send the same retirement again.",
  internal: "Unexpected error; quote the correlation id.",
} as const;

/** One of the fixed details of {@link PROBLEM_DETAILS}. */
export type ProblemDetail = (typeof PROBLEM_DETAILS)[keyof typeof PROBLEM_DETAILS];

/** HTTP status, fixed title and default detail of one problem type. */
interface ProblemCatalogEntry {
  readonly status: number;
  readonly title: string;
  readonly detail: ProblemDetail;
}

/**
 * Catalogue of the problem types.
 *
 * A switch rather than an object lookup: the code is a union, so the compiler rejects a missing case,
 * and no property is read with a value that comes from the caller.
 *
 * @param code - The problem type.
 * @returns The status, title and default detail of that type.
 */
function catalogOf(code: RobotsFailureCode): ProblemCatalogEntry {
  switch (code) {
    case "invalid-request":
      return { status: 400, title: "Invalid request", detail: PROBLEM_DETAILS.invalidRequest };
    case "robot-exists":
      return {
        status: 409,
        title: "Robot already registered",
        detail: PROBLEM_DETAILS.robotExists,
      };
    case "robot-not-found":
      return { status: 404, title: "Robot not found", detail: PROBLEM_DETAILS.robotNotFound };
    case "robot-state-conflict":
      return { status: 409, title: "Robot state conflict", detail: PROBLEM_DETAILS.busy };
    case "provisioning-failed":
      return {
        status: 502,
        title: "Provisioning failed",
        detail: PROBLEM_DETAILS.provisioningFailed,
      };
    case "retirement-failed":
      return { status: 502, title: "Retirement failed", detail: PROBLEM_DETAILS.retirementFailed };
    case "internal":
      return { status: 500, title: "Internal error", detail: PROBLEM_DETAILS.internal };
  }
}

/**
 * Error thrown inside the domain to stop an operation with a known problem type.
 *
 * The message is the code alone: the error can reach a log, and nothing else of it is safe to log.
 */
export class RobotsError extends Error {
  /** The problem type the error stands for. */
  readonly code: RobotsFailureCode;
  /** The fixed detail of the problem, the default one of the code unless a case needs another. */
  readonly detail: ProblemDetail;

  /**
   * @param code - The problem type.
   * @param detail - A fixed detail to use instead of the default of the code.
   */
  constructor(code: RobotsFailureCode, detail?: ProblemDetail) {
    super(code);
    this.name = "RobotsError";
    this.code = code;
    this.detail = detail ?? catalogOf(code).detail;
  }
}

/** A refused or failed invocation: the HTTP status and the RFC 7807 problem to return. */
export interface FailedInvocation {
  readonly ok: false;
  readonly status: number;
  readonly problem: Problem;
}

/**
 * Builds the failed result of an invocation, with the problem validated against the shared schema.
 *
 * @param code - The problem type.
 * @param detail - The fixed detail of the case.
 * @param correlationId - The correlation identifier of the invocation, echoed to the caller.
 * @returns The failed invocation, ready to be returned by the use case.
 */
export function problemResult(
  code: RobotsFailureCode,
  detail: ProblemDetail,
  correlationId: CorrelationId,
): FailedInvocation {
  const { status, title } = catalogOf(code);
  return {
    ok: false,
    status,
    problem: ProblemSchema.parse({
      type: `urn:mfc:problem:${code}`,
      title,
      status,
      detail,
      correlationId,
    }),
  };
}
