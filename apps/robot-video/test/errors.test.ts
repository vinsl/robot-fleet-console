import { describe, expect, it } from "vitest";
import { VideoPageError, type VideoPageErrorCode } from "../src/lib/errors";

describe("VideoPageError", () => {
  it.each([
    [
      "ENDPOINT_UNEXPECTED",
      "AWS returned a signaling endpoint outside the expected region or protocol.",
    ],
    ["KVS_SDK_MISSING", "The vendored KVS WebRTC SDK is missing. Run the vendor script again."],
    [
      "KVS_SDK_VERSION",
      "The vendored KVS WebRTC SDK is not the pinned version. Run the vendor script again.",
    ],
    ["NO_LOCAL_DESCRIPTION", "The browser did not produce a local description for the connection."],
    ["AWS_CALL_FAILED", "An AWS call failed. The status line shows the error name."],
  ] as const)("carries the code %s and its fixed message", (code: VideoPageErrorCode, message) => {
    const error = new VideoPageError(code);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("VideoPageError");
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
    expect(error.detail).toBeUndefined();
  });

  it("carries the name of an AWS error as detail, and keeps the message fixed", () => {
    const error = new VideoPageError("AWS_CALL_FAILED", "AccessDeniedException");

    expect(error.detail).toBe("AccessDeniedException");
    expect(error.message).toBe("An AWS call failed. The status line shows the error name.");
  });
});
