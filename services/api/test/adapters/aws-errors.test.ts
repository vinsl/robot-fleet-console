/**
 * AWS error recognition by service error code, the matching the SDK adapters use to tell a missing item
 * or a failed condition from an unexpected failure.
 */
import { describe, expect, it } from "vitest";
import { isAwsError } from "../../src/adapters/aws-errors";

/** Builds an error shaped like an SDK error: a name and a message. */
function sdkError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("isAwsError", () => {
  it("matches the name of an SDK error among the given names", () => {
    const error = sdkError("ResourceNotFoundException", "not found");
    expect(isAwsError(error, "ConditionalCheckFailedException", "ResourceNotFoundException")).toBe(
      true,
    );
  });

  it("does not match a name that was not given", () => {
    const error = sdkError("ResourceNotFoundException", "not found");
    expect(isAwsError(error, "ResourceInUseException")).toBe(false);
  });

  it("does not match when no name is given", () => {
    expect(isAwsError(sdkError("Error", "x"))).toBe(false);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "ResourceNotFoundException"],
    ["an object without a name", { message: "x" }],
    ["an object whose name is not a string", { name: 42 }],
  ])("returns false for %s", (_label, value) => {
    expect(isAwsError(value, "ResourceNotFoundException")).toBe(false);
  });
});
