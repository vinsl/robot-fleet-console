/**
 * Domain logic for the health report.
 *
 * Pure function: the clock and the version are injected so that the output is
 * deterministic and testable without touching the environment.
 */
import { HealthResponseSchema, type HealthResponse } from "@mfc/protocol";

/** Inputs needed to build a health report. */
export interface HealthReportInput {
  /** Application version reported to clients. */
  readonly version: string;
  /** Instant at which the report is produced. */
  readonly now: Date;
}

/**
 * Builds a health report and validates it against the shared contract.
 *
 * Validation runs even though the inputs are typed, because the version comes from
 * the environment at runtime and must never produce a response the contract rejects.
 *
 * @param input - Version and instant to report.
 * @returns A validated health response.
 * @throws {RangeError} When `now` is not a valid date (`toISOString` would throw).
 * @throws {ZodError} When `version` violates the contract (for example, empty).
 */
export function buildHealthReport(input: HealthReportInput): HealthResponse {
  return HealthResponseSchema.parse({
    status: "ok",
    version: input.version,
    time: input.now.toISOString(),
  });
}
