/**
 * WebSocket protocol between the fleet console and the cloud: tokens, client messages and server frames.
 *
 * Every frame is a JSON text message validated by these schemas on both sides. Client messages are
 * small and checked before any side effect; server frames are bounded so that one fan-out fits in one
 * WebSocket frame (32 KB quota), and a consumer refuses the rest.
 */
import { z } from "zod";
import {
  CorrelationIdSchema,
  MissionIdSchema,
  RobotIdSchema,
  SiteIdSchema,
  UserSubSchema,
} from "./ids";
import { IsoMsSchema } from "./time";
import { RobotEventSchema, LockChangeCauseSchema } from "./events";
import { AckSchema } from "./acks";
import { AlertRecordSchema } from "./alerts";
import { FaultCodeSchema, RobotStateSchema } from "./robot-state";
import { RobotEnvelopeShape } from "./envelope";
import { TelemetrySchema } from "./telemetry";
import { RobotLiveStateSchema } from "./fleet-state";
import { AwsRegionSchema } from "./robots";

/** Lifetime of a single-use WebSocket token, in seconds. It only has to live until `$connect`. */
export const WS_TOKEN_TTL_SECONDS = 60;

/** Lifetime of a WebSocket session, in seconds. Matches the access token lifetime (FR-AUTH-4). */
export const WS_SESSION_MAX_SECONDS = 3600;

/** Largest client frame the server reads. A subscribe or a heartbeat is a few hundred bytes. */
export const WS_MAX_CLIENT_MESSAGE_BYTES = 2048;

/** Largest server frame the cloud sends, under the 32 KB WebSocket frame quota with a margin. */
export const WS_MAX_SERVER_FRAME_BYTES = 30_000;

/**
 * Largest number of robots in one `fleet.delta` frame. It is sized so that a worst-case sample (longest
 * identifiers, mission and fault, full-precision numbers) serialises under {@link WS_MAX_SERVER_FRAME_BYTES};
 * the tests serialise that worst case. A larger batch is split by the cloud across several frames.
 */
export const FLEET_DELTA_MAX_ROBOTS = 70;

/**
 * Largest number of robots in one `fleet.snapshot` frame. A snapshot record is larger than a delta sample
 * (it carries the site and the receive time), so the bound is lower, sized by the same worst-case test.
 * A fleet larger than this is sent as several snapshot frames, each carrying a slice of the robots.
 */
export const SNAPSHOT_MAX_ROBOTS = 60;

/** Most sites one principal may be granted. Bounds the size of the verified identity. */
const PRINCIPAL_MAX_SITES = 8;

/** Role of a console user, as granted by the identity provider. */
export const RoleSchema = z.enum(["Admin", "Operator", "Viewer"]);

/** A validated role. */
export type Role = z.infer<typeof RoleSchema>;

/**
 * Verified identity the domain works with. It is built from the IAM-authenticated invoke in M5 and
 * from the verified JWT claims in M6; the domain does not know which.
 */
export const PrincipalSchema = z.strictObject({
  sub: UserSubSchema,
  role: RoleSchema,
  siteIds: z.array(SiteIdSchema).min(1).max(PRINCIPAL_MAX_SITES),
  sessionExpiresAt: IsoMsSchema,
});

/** A validated principal. */
export type Principal = z.infer<typeof PrincipalSchema>;

/**
 * Single-use token that authorises one WebSocket connection. It is 32 random bytes in base64url,
 * so its length is fixed at 43 characters. The cloud stores only its hash.
 */
export const WsTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

/** A validated WebSocket token. */
export type WsToken = z.infer<typeof WsTokenSchema>;

/** Body of a request for a WebSocket token: the site the console wants to watch. */
export const WsTokenRequestSchema = z.strictObject({ siteId: SiteIdSchema });

/** A validated token request. */
export type WsTokenRequest = z.infer<typeof WsTokenRequestSchema>;

/**
 * Pattern of the WebSocket URL: the regions come from {@link AwsRegionSchema}, so a region is added in one
 * place. The stage follows API Gateway naming for the lowercase, digit and hyphen subset this project uses.
 */
// The alternation is built from a closed enum, never from input, so the dynamic pattern is safe.
// eslint-disable-next-line security/detect-non-literal-regexp -- built from AwsRegionSchema.options only
const WS_URL_PATTERN = new RegExp(
  `^wss://[a-z0-9]+\\.execute-api\\.(${AwsRegionSchema.options.join("|")})\\.amazonaws\\.com/[a-z0-9-]{1,128}$`,
);

/**
 * Answer to a token request: the token, when it expires, when the session expires, and the WebSocket
 * URL to connect to. The URL is pinned to the demo endpoint shape, so a response cannot redirect the
 * console to another host.
 */
export const WsTokenResponseSchema = z.strictObject({
  token: WsTokenSchema,
  expiresAt: IsoMsSchema,
  sessionExpiresAt: IsoMsSchema,
  url: z.string().regex(WS_URL_PATTERN),
});

/** A validated token response. */
export type WsTokenResponse = z.infer<typeof WsTokenResponseSchema>;

/**
 * Client-to-server frames. The discriminator `type` is the only routing key; the server dispatches on
 * the parsed union and never on raw fields.
 */
export const WsClientMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscribe"), siteId: SiteIdSchema }),
  // The lock token never leaves the cloud: the server finds the holder from the verified connection.
  z.strictObject({ type: z.literal("heartbeat"), robotId: RobotIdSchema }),
  z.strictObject({ type: z.literal("ping") }),
]);

/** A validated client frame. */
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

/**
 * One robot sample inside a `fleet.delta` frame: a telemetry message without the envelope fields the
 * frame already carries. Bounds are those of the telemetry schema, so a sample that the cloud accepted
 * is never refused by a console.
 */
export const FleetRobotSampleSchema = z.strictObject({
  robotId: RobotEnvelopeShape.robotId,
  bootId: RobotEnvelopeShape.bootId,
  seq: RobotEnvelopeShape.seq,
  ts: IsoMsSchema,
  x: TelemetrySchema.shape.x,
  y: TelemetrySchema.shape.y,
  heading: TelemetrySchema.shape.heading,
  speed: TelemetrySchema.shape.speed,
  battery: TelemetrySchema.shape.battery,
  state: RobotStateSchema,
  missionId: MissionIdSchema.optional(),
  errorCode: FaultCodeSchema.optional(),
});

/** A validated sample of a fleet delta. */
export type FleetRobotSample = z.infer<typeof FleetRobotSampleSchema>;

/** Presence of a robot as the cloud sees it from the broker connection. */
export const PresenceSchema = z.enum(["ONLINE", "OFFLINE"]);

/** What changed about an alert in an `alert.changed` frame. */
export const AlertChangeSchema = z.enum(["OPENED", "ACKNOWLEDGED", "RESOLVED"]);

/** Refusal codes of an `error` frame. Each one names a rule, never an internal fault. */
export const WsErrorCodeSchema = z.enum([
  "INVALID_MESSAGE",
  "FORBIDDEN_SITE",
  "FORBIDDEN_ROLE",
  "SESSION_EXPIRED",
  "UNSUPPORTED",
  "SNAPSHOT_FAILED",
]);

/** A validated error code of a server frame. */
export type WsErrorCode = z.infer<typeof WsErrorCodeSchema>;

/**
 * Server-to-client frames. Each member is strict. The console applies a `fleet.delta` sample only when
 * its `(bootId, seq)` is greater than the one it holds for that robot, and treats a robot as OFFLINE
 * locally after `OFFLINE_SILENCE_MS` without any message.
 */
export const WsServerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("fleet.delta"),
    siteId: SiteIdSchema,
    sentAt: IsoMsSchema,
    robots: z.array(FleetRobotSampleSchema).min(1).max(FLEET_DELTA_MAX_ROBOTS),
  }),
  z.strictObject({
    type: z.literal("fleet.snapshot"),
    siteId: SiteIdSchema,
    sentAt: IsoMsSchema,
    robots: z.array(RobotLiveStateSchema).max(SNAPSHOT_MAX_ROBOTS),
  }),
  z.strictObject({
    type: z.literal("robot.presence"),
    siteId: SiteIdSchema,
    robotId: RobotIdSchema,
    presence: PresenceSchema,
    at: IsoMsSchema,
  }),
  z.strictObject({
    type: z.literal("robot.event"),
    siteId: SiteIdSchema,
    robotId: RobotIdSchema,
    event: RobotEventSchema,
  }),
  z.strictObject({
    type: z.literal("command.ack"),
    siteId: SiteIdSchema,
    ack: AckSchema,
  }),
  z.strictObject({
    type: z.literal("alert.changed"),
    siteId: SiteIdSchema,
    change: AlertChangeSchema,
    alert: AlertRecordSchema,
  }),
  z.strictObject({
    type: z.literal("lock.changed"),
    siteId: SiteIdSchema,
    robotId: RobotIdSchema,
    held: z.boolean(),
    holder: UserSubSchema.optional(),
    cause: LockChangeCauseSchema,
  }),
  z.strictObject({
    type: z.literal("error"),
    code: WsErrorCodeSchema,
    correlationId: CorrelationIdSchema.optional(),
  }),
]);

/** A validated server frame. */
export type WsServerMessage = z.infer<typeof WsServerMessageSchema>;
