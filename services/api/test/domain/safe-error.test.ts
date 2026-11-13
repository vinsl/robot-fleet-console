/**
 * Safe-field extraction used by every log line of a failed call. The extraction must never copy a
 * message, and must never throw, whatever the thrown value.
 */
import { describe, expect, it } from "vitest";
import { safeErrorFields } from "../../src/domain/safe-error";

/** Builds an error shaped like an SDK error: a name, the response metadata and a message. */
function sdkError(name: string, message: string, metadata: Record<string, unknown>): Error {
  const error = new Error(message);
  error.name = name;
  return Object.assign(error, { $metadata: metadata });
}

describe("safeErrorFields", () => {
  it("extracts the code, the HTTP status and the request id", () => {
    const error = sdkError("ThrottlingException", "Rate exceeded for arn:aws:iot:...", {
      httpStatusCode: 400,
      requestId: "7f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7",
    });
    expect(safeErrorFields(error)).toStrictEqual({
      errorName: "ThrottlingException",
      httpStatus: 400,
      requestId: "7f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7",
    });
  });

  it("never copies the message, which can echo an ARN or an account id", () => {
    const error = sdkError(
      "InvalidRequestException",
      "arn:aws:iot:eu-west-3:123456789012:cert/x",
      {},
    );
    const fields = safeErrorFields(error);
    expect(JSON.stringify(fields)).not.toContain("123456789012");
    expect(fields).toStrictEqual({ errorName: "InvalidRequestException" });
  });

  it("omits the optional fields when the SDK recorded none", () => {
    expect(safeErrorFields(sdkError("ResourceNotFoundException", "x", {}))).toStrictEqual({
      errorName: "ResourceNotFoundException",
    });
  });

  it("drops a status that is not an integer and a request id outside its grammar", () => {
    const error = sdkError("ServiceException", "x", {
      httpStatusCode: 500.5,
      requestId: "not a request id!",
    });
    expect(safeErrorFields(error)).toStrictEqual({ errorName: "ServiceException" });
  });

  it("reports an unknown name when the name is not a plausible error code", () => {
    const error = new Error("x");
    error.name = "Bad Name with spaces and an account 123456789012";
    expect(safeErrorFields(error)).toStrictEqual({ errorName: "UnknownError" });
  });

  it("reports an unknown name for a plain value, without throwing", () => {
    expect(safeErrorFields("boom")).toStrictEqual({ errorName: "UnknownError" });
    expect(safeErrorFields(undefined)).toStrictEqual({ errorName: "UnknownError" });
    expect(safeErrorFields(null)).toStrictEqual({ errorName: "UnknownError" });
  });

  it("ignores a metadata field that is not an object", () => {
    const error = Object.assign(new Error("x"), { $metadata: "not-an-object" });
    expect(safeErrorFields(error)).toStrictEqual({ errorName: "Error" });
  });
});
