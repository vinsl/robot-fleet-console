/**
 * Local video page API: the contract between the robot agent and the page served on the robot's
 * loopback interface.
 *
 * The page is operated by a person at the robot. It claims a one-time token, receives temporary KVS
 * credentials for the robot's own channel, and shows the robot state and the control banner. These
 * schemas describe what the page may receive; they do not describe any cloud API.
 */
import { z } from "zod";
import { THING_NAME_PREFIX } from "./constants";
import { RobotIdSchema, ThingNameSchema } from "./ids";
import { AwsRegionSchema, KvsChannelArnSchema, channelNameOfArn, regionOfArn } from "./robots";
import { RobotReportedStateSchema } from "./robot-state";

/** Response to a one-time token claim: the session key the page keeps in memory. */
export const VideoClaimResponseSchema = z.strictObject({
  // 32 random bytes encoded as unpadded base64url gives exactly 43 characters.
  sessionKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** A validated claim response. */
export type VideoClaimResponse = z.infer<typeof VideoClaimResponseSchema>;

/**
 * Temporary credentials from the IoT credentials provider. They are scoped to the robot's channel
 * by the role alias and expire after about an hour; the page refreshes them before they lapse.
 */
const VideoCredentialsSchema = z.strictObject({
  // Temporary access key ids start with `ASIA`; long-lived ones start with `AKIA` and never reach a robot.
  accessKeyId: z.string().regex(/^ASIA[A-Z0-9]{16}$/),
  secretAccessKey: z.string().regex(/^[A-Za-z0-9/+]{40}$/),
  sessionToken: z.string().regex(/^[A-Za-z0-9+/=]{16,8192}$/),
  expiration: z.iso.datetime({ offset: true }),
});

/** Session returned to the page: the robot's channel and the credentials that reach it. */
export const VideoSessionSchema = z
  .strictObject({
    robotId: RobotIdSchema,
    region: AwsRegionSchema,
    channelName: ThingNameSchema,
    channelArn: KvsChannelArnSchema,
    credentials: VideoCredentialsSchema,
  })
  .superRefine((session, ctx) => {
    // Cross-field rules: the page may only ever open the channel of the robot it was given. JSON Schema
    // cannot express them; the Python mirror checks them and the fixture parity test records that.
    if (session.channelName !== `${THING_NAME_PREFIX}${session.robotId}`) {
      ctx.addIssue({
        code: "custom",
        path: ["channelName"],
        message: "channel must be the robot's",
      });
    }
    if (channelNameOfArn(session.channelArn) !== session.channelName) {
      ctx.addIssue({ code: "custom", path: ["channelArn"], message: "ARN must name the channel" });
    }
    if (regionOfArn(session.channelArn) !== session.region) {
      ctx.addIssue({ code: "custom", path: ["region"], message: "ARN must be in the region" });
    }
  });

/** A validated video session. */
export type VideoSession = z.infer<typeof VideoSessionSchema>;

/** Banner the page shows across the top of the screen. It is a state, never a colour alone. */
export const VideoBannerSchema = z.enum(["NONE", "ESTOP", "TELEOP"]);

/** Status the page polls once per second. */
export const VideoStatusSchema = z.strictObject({
  state: RobotReportedStateSchema,
  banner: VideoBannerSchema,
  lockHeld: z.boolean(),
  /** False while the agent has no live link to the cloud; the page shows the link as down. */
  connected: z.boolean(),
  /** True for a simulated robot; the page shows a badge, nothing else changes. */
  simulated: z.boolean(),
});

/** A validated video status. */
export type VideoStatus = z.infer<typeof VideoStatusSchema>;
