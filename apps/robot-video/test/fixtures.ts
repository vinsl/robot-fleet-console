/**
 * Fixed values shared by the page tests. The credentials are the AWS documentation examples, which
 * have the shape the protocol checks but grant nothing.
 */
import type { VideoSession, VideoStatus } from "@mfc/protocol";

/** A session as the agent sends it: the robot's own channel, valid for an hour from the given time. */
export function sessionWithExpiry(expiration: string): VideoSession {
  return {
    robotId: "kali-01",
    region: "eu-west-3",
    channelName: "mfc-demo-kali-01",
    channelArn:
      "arn:aws:kinesisvideo:eu-west-3:111122223333:channel/mfc-demo-kali-01/1700000000000",
    credentials: {
      accessKeyId: "ASIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: "FQoGZXIvYXdzEBYaDHjEXAMPLESESSIONTOKEN0123==",
      expiration,
    },
  };
}

/** A well-formed claim token: 43 characters of the base64url alphabet. */
export const CLAIM_TOKEN = "A".repeat(43);

/** A well-formed session key, the shape of the agent's `VideoClaimResponse`. */
export const SESSION_KEY = "B".repeat(43);

/** An idle status with no banner and the link up. */
export const IDLE_STATUS: VideoStatus = {
  state: "IDLE",
  banner: "NONE",
  lockHeld: false,
  connected: true,
  simulated: false,
};
