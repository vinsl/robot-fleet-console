/**
 * Problems of the robot use cases: status, title, type and detail of each code, and the default detail
 * of the domain error.
 */
import { PROBLEM_TYPES, ProblemSchema } from "@mfc/protocol";
import { describe, expect, it } from "vitest";
import {
  PROBLEM_DETAILS,
  problemResult,
  RobotsError,
  type RobotsFailureCode,
} from "../../../src/domain/robots/problems";

const CORRELATION_ID = "corr-00000001";

describe("problemResult", () => {
  const table: [RobotsFailureCode, number, string][] = [
    ["invalid-request", 400, "Invalid request"],
    ["robot-exists", 409, "Robot already registered"],
    ["robot-not-found", 404, "Robot not found"],
    ["robot-state-conflict", 409, "Robot state conflict"],
    ["provisioning-failed", 502, "Provisioning failed"],
    ["retirement-failed", 502, "Retirement failed"],
    ["internal", 500, "Internal error"],
  ];

  it.each(table)("builds the problem of %s with status %i", (code, status, title) => {
    const result = problemResult(code, PROBLEM_DETAILS.internal, CORRELATION_ID);
    expect(result).toStrictEqual({
      ok: false,
      status,
      problem: {
        type: `urn:mfc:problem:${code}`,
        title,
        status,
        detail: PROBLEM_DETAILS.internal,
        correlationId: CORRELATION_ID,
      },
    });
    expect(ProblemSchema.safeParse(result.problem).success).toBe(true);
  });

  it("covers every problem type of the protocol", () => {
    const notRobotFacing: readonly string[] = [
      "unauthorized",
      "forbidden",
      "not-found",
      "payload-too-large",
      "rate-limited",
      "map-not-found",
      "map-invalid",
      "version-limit",
      "alert-not-found",
      "alert-state-conflict",
      "lock-held",
      "lock-not-held",
      "command-conflict",
      "demo-mode-off",
      "not-simulated",
      "upstream-failed",
    ];
    const robotFacing = PROBLEM_TYPES.filter((type) => !notRobotFacing.includes(type));
    expect(table.map(([code]) => code).sort()).toStrictEqual([...robotFacing].sort());
  });

  it("refuses a correlation identifier the protocol does not accept", () => {
    expect(() => problemResult("internal", PROBLEM_DETAILS.internal, "x")).toThrow();
  });
});

describe("RobotsError", () => {
  it("uses the default detail of its code", () => {
    const error = new RobotsError("retirement-failed");
    expect(error.detail).toBe(PROBLEM_DETAILS.retirementFailed);
    expect(error.message).toBe("retirement-failed");
    expect(error.name).toBe("RobotsError");
  });

  it("uses the detail of the case when one is given", () => {
    const error = new RobotsError("robot-state-conflict", PROBLEM_DETAILS.tooManyAttempts);
    expect(error.code).toBe("robot-state-conflict");
    expect(error.detail).toBe(PROBLEM_DETAILS.tooManyAttempts);
  });
});
