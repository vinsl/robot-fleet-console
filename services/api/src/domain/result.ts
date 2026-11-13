/**
 * Outcome of a use case, shared by every API domain: the value, or the problem the HTTP layer returns as
 * RFC 7807.
 *
 * A use case never throws for a refusal. The problems are fixed in the module that owns them, with their
 * status and their detail, so the handler maps them without building any text from input or from an
 * exception.
 */
import type { PROBLEM_TYPES } from "@mfc/protocol";

/** Type of a problem an API use case can return. */
export type ProblemType = (typeof PROBLEM_TYPES)[number];

/** A refusal of a use case: its problem type, HTTP status and fixed detail sentence. */
export interface UseCaseProblem {
  /** Problem type, published as `urn:mfc:problem:<type>`. */
  readonly type: ProblemType;
  /** HTTP status of the response. */
  readonly status: number;
  /** Fixed sentence written by the API. Never built from input or from an error. */
  readonly detail: string;
}

/**
 * One schema issue of a refused payload, as plain data: the path of the offending field and the zod code. The
 * values are never carried, since an issue can echo the input. The handler formats the path for its log.
 */
export interface UseCaseIssue {
  /** Path of the offending field, from the root of the payload. */
  readonly path: readonly PropertyKey[];
  /** Zod issue code, such as `invalid_type`. */
  readonly code: string;
}

/**
 * Outcome of a use case: the value on success, or the problem on refusal. A refusal caused by a schema
 * check may also carry the issues, for the handler to log.
 */
export type UseCaseResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly problem: UseCaseProblem;
      readonly issues?: readonly UseCaseIssue[];
    };

/**
 * Wraps a value as a successful outcome.
 *
 * @param value - The value to return.
 * @returns The successful outcome.
 */
export function succeed<T>(value: T): UseCaseResult<T> {
  return { ok: true, value };
}

/**
 * Wraps a problem as a refused outcome.
 *
 * @param problem - The refusal.
 * @param issues - The schema issues behind the refusal, when there are some.
 * @returns The refused outcome.
 */
export function refuse<T = never>(
  problem: UseCaseProblem,
  issues?: readonly UseCaseIssue[],
): UseCaseResult<T> {
  return issues === undefined ? { ok: false, problem } : { ok: false, problem, issues };
}
