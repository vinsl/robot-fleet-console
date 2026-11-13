/**
 * Extraction of the fields of a failed call that are safe to log, shared by the domain and the handlers.
 *
 * The extraction reads the shape of a thrown value and nothing else, so it is pure and belongs to the
 * domain: the SDK-specific matching of error names lives in the adapters (`adapters/aws-errors.ts`).
 */

/**
 * Fields of a failed call that may be logged: the error code, the HTTP status and the request id.
 */
export interface SafeErrorFields {
  /** The service error code, or `UnknownError` when the value is not a plausible error code. */
  readonly errorName: string;
  /** HTTP status of the response, when the SDK recorded one. */
  readonly httpStatus?: number;
  /** AWS request id, for correlation with CloudTrail and the service logs. */
  readonly requestId?: string;
}

/** Reported when the thrown value carries no plausible error code. */
const UNKNOWN_ERROR_NAME = "UnknownError";

/**
 * Grammar of a service error code: letters first, then letters, digits, dots, underscores or hyphens.
 * A value outside it is not logged, because it may be an arbitrary message.
 */
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;

/** Grammar of an AWS request id: a bounded run of letters, digits and hyphens. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/;

/**
 * Reads the `name` of a thrown value without trusting it.
 *
 * @param error - Any thrown value.
 * @returns The `name` when the value is an object with a string `name`, otherwise undefined.
 */
export function errorNameOf(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return undefined;
  }
  return typeof error.name === "string" ? error.name : undefined;
}

/**
 * Extracts the fields of a failed call that are safe to log.
 *
 * The message is deliberately not read. SDK messages can echo the request, including ARNs, account
 * identifiers and, for some validation errors, fragments of the input. Only the error code, the HTTP
 * status and the request id are logged.
 *
 * @param error - Any thrown value.
 * @returns The safe fields. Never throws, whatever the input.
 */
export function safeErrorFields(error: unknown): SafeErrorFields {
  const rawName = errorNameOf(error);
  const errorName =
    rawName !== undefined && ERROR_NAME_PATTERN.test(rawName) ? rawName : UNKNOWN_ERROR_NAME;
  const metadata = metadataOf(error);
  const httpStatus = metadata?.httpStatusCode;
  const requestId = metadata?.requestId;

  return {
    errorName,
    ...(typeof httpStatus === "number" && Number.isInteger(httpStatus) ? { httpStatus } : {}),
    ...(typeof requestId === "string" && REQUEST_ID_PATTERN.test(requestId) ? { requestId } : {}),
  };
}

/** The response metadata the SDK attaches to its errors, read without trusting its shape. */
interface ResponseMetadata {
  readonly httpStatusCode?: unknown;
  readonly requestId?: unknown;
}

/**
 * Reads the `$metadata` object the SDK attaches to its errors.
 *
 * @param error - Any thrown value.
 * @returns The metadata object, or undefined when the value carries none.
 */
function metadataOf(error: unknown): ResponseMetadata | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }
  const metadata = error.$metadata;
  return typeof metadata === "object" && metadata !== null ? metadata : undefined;
}
