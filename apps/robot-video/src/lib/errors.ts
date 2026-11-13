/**
 * Errors of the video page.
 *
 * Every error carries a fixed English message chosen by its code. The messages never include request
 * data, credentials or AWS identifiers. The page shows the operator a translated sentence chosen by
 * the code (see `ui/dom.ts`), never the message of the SDK, because an SDK message can quote the
 * request it failed on.
 */

/** Reasons a video page operation stops, each with a fixed message. */
export type VideoPageErrorCode =
  | "ENDPOINT_UNEXPECTED"
  | "KVS_SDK_MISSING"
  | "KVS_SDK_VERSION"
  | "NO_LOCAL_DESCRIPTION"
  | "AWS_CALL_FAILED";

/** AWS error name that means the channel does not exist any more (ADR 0036, edge cases). */
const CHANNEL_GONE_ERROR = "ResourceNotFoundException";

/**
 * Returns the fixed English message of an error code.
 *
 * The switch has no default branch on purpose: a new code without a message fails to compile.
 *
 * @param code - The error code.
 * @returns The message, for developers and tests.
 */
function messageFor(code: VideoPageErrorCode): string {
  switch (code) {
    case "ENDPOINT_UNEXPECTED":
      return "AWS returned a signaling endpoint outside the expected region or protocol.";
    case "KVS_SDK_MISSING":
      return "The vendored KVS WebRTC SDK is missing. Run the vendor script again.";
    case "KVS_SDK_VERSION":
      return "The vendored KVS WebRTC SDK is not the pinned version. Run the vendor script again.";
    case "NO_LOCAL_DESCRIPTION":
      return "The browser did not produce a local description for the connection.";
    case "AWS_CALL_FAILED":
      return "An AWS call failed. The status line shows the error name.";
  }
}

/**
 * An expected failure of the page. `detail` is the only variable part: the name of an AWS error
 * (for example `AccessDeniedException`), which the operator needs to diagnose a denied call. Callers
 * keep the message of the SDK out of it.
 */
export class VideoPageError extends Error {
  /**
   * Creates the error for a code. The message is derived from the code, never from the cause.
   *
   * @param code - Why the operation stopped.
   * @param detail - Optional name of the AWS error that caused it. Never a message.
   */
  constructor(
    readonly code: VideoPageErrorCode,
    readonly detail?: string,
  ) {
    super(messageFor(code));
    this.name = "VideoPageError";
  }
}

/**
 * Tells whether an error means that the robot's channel no longer exists.
 *
 * The page then stops for good: retrying a deleted channel only repeats the same failure.
 *
 * @param error - The value caught by the page.
 * @returns True for an AWS `ResourceNotFoundException`, raised by the API or by the signalling client.
 */
export function isChannelGone(error: unknown): boolean {
  if (error instanceof VideoPageError) {
    return error.detail === CHANNEL_GONE_ERROR;
  }
  return error instanceof Error && error.name === CHANNEL_GONE_ERROR;
}
