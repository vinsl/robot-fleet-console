/**
 * Outcome of a site use case. The generic outcome lives in `domain/result.ts`; this module keeps the site
 * problems and the names the site use cases and their tests import.
 */
import type { ProblemType, UseCaseIssue, UseCaseProblem, UseCaseResult } from "../result";

export { refuse, succeed } from "../result";

/** Type of a problem a site use case can return. */
export type SiteProblemType = ProblemType;

/** A refusal of a site use case: its problem type, HTTP status and fixed detail sentence. */
export type SiteProblem = UseCaseProblem;

/** One schema issue of a refused site payload. See {@link UseCaseIssue}. */
export type SiteIssue = UseCaseIssue;

/** Outcome of a site use case. See {@link UseCaseResult}. */
export type SiteResult<T> = UseCaseResult<T>;

/** The fixed refusals of the site use cases. Each one is a single sentence the operator can act on. */
export const SITE_PROBLEMS = {
  mapNotFound: {
    type: "map-not-found",
    status: 404,
    detail: "No map version matches this request.",
  },
  noActiveMap: {
    type: "map-not-found",
    status: 404,
    detail: "The site has no active map.",
  },
  noUpload: {
    type: "map-invalid",
    status: 422,
    detail: "No file was uploaded.",
  },
  mapRejected: {
    type: "map-invalid",
    status: 422,
    detail: "The uploaded file is not a valid site map.",
  },
  validateFirst: {
    type: "map-invalid",
    status: 422,
    detail: "Validate the map first.",
  },
  versionLimit: {
    type: "version-limit",
    status: 409,
    detail: "The site has reached its map version limit.",
  },
} as const satisfies Record<string, SiteProblem>;
