/**
 * Recognition of AWS SDK errors by their service error code.
 *
 * The SDK reports failures as errors whose `name` is the service error code (for example
 * `ConditionalCheckFailedException`). Matching on the name keeps the SDK classes out of the domain, and
 * works for errors from any copy of the SDK. The safe-field extraction used for logs is in the domain
 * (`domain/safe-error.ts`), because it reads no SDK type.
 */
import { errorNameOf } from "../domain/safe-error";

/**
 * Tells whether a thrown value is one of the named AWS errors.
 *
 * @param error - Any thrown value, typically the rejection of an SDK `send`.
 * @param names - Service error codes to match, for example `ResourceNotFoundException`.
 * @returns True when the value's name is one of `names`; false for any other value.
 */
export function isAwsError(error: unknown, ...names: string[]): boolean {
  const name = errorNameOf(error);
  return name !== undefined && names.includes(name);
}
