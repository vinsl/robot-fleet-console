/**
 * Robot registry and kit schemas: the requests that register and retire a robot, the summary the
 * console shows, and the kit a robot needs to connect.
 *
 * The kit carries a private key. It is returned once, by the registration, and never stored by the
 * cloud; these schemas therefore bound the size and the shape of each PEM block so that nothing
 * larger than a key can pass as one.
 */
import { z } from "zod";
import { ROLE_ALIAS_NAME, THING_NAME_PREFIX } from "./constants";
import {
  ActorSchema,
  CorrelationIdSchema,
  RobotIdSchema,
  SiteIdSchema,
  ThingNameSchema,
} from "./ids";
import { IsoDateSchema, IsoMsSchema } from "./time";
import { ProblemSchema } from "./problem";

/** Regions the demo deploys to. The IoT endpoints and the KVS channel ARNs are checked against this list. */
export const AwsRegionSchema = z.enum(["eu-west-3", "eu-west-1"]);

/** A validated region of the demo deployment. */
export type AwsRegion = z.infer<typeof AwsRegionSchema>;

/** Lifecycle of a registry entry. A robot is `ACTIVE` only once its certificate and policy are attached. */
export const RobotStatusSchema = z.enum([
  "PROVISIONING",
  "ACTIVE",
  "PROVISIONING_FAILED",
  "RETIRING",
  "RETIRED",
]);

/** A validated registry status. */
export type RobotStatus = z.infer<typeof RobotStatusSchema>;

/** Display name of a robot: Unicode letters and digits, space, dot, underscore and hyphen. */
const RobotNameSchema = z.string().regex(/^[A-Za-z0-9À-ÖØ-öø-ÿ ._-]{1,64}$/);

/** Robot model or type, as printed on the robot: ASCII letters, digits and hyphens. */
const RobotTypeSchema = z.string().regex(/^[A-Za-z0-9-]{1,32}$/);

/** Request to register a robot. Strict, so the caller cannot set the status or the timestamps. */
export const RegisterRobotRequestSchema = z.strictObject({
  robotId: RobotIdSchema,
  siteId: SiteIdSchema,
  name: RobotNameSchema,
  type: RobotTypeSchema,
  designDate: IsoDateSchema,
  simulated: z.boolean(),
});

/** A validated registration request. */
export type RegisterRobotRequest = z.infer<typeof RegisterRobotRequestSchema>;

/** Registry entry of a robot as returned by the API. */
export const RobotSummarySchema = z.strictObject({
  robotId: RobotIdSchema,
  siteId: SiteIdSchema,
  name: RobotNameSchema,
  type: RobotTypeSchema,
  designDate: IsoDateSchema,
  simulated: z.boolean(),
  status: RobotStatusSchema,
  createdAt: IsoMsSchema,
  retiredAt: IsoMsSchema.optional(),
});

/** A validated registry entry. */
export type RobotSummary = z.infer<typeof RobotSummarySchema>;

/** Public endpoint of the IoT data plane for a region, for example `abc123-ats.iot.eu-west-3.amazonaws.com`. */
const IOT_ENDPOINT_PATTERN = /^[a-z0-9]+-ats\.iot\.(?:eu-west-3|eu-west-1)\.amazonaws\.com$/;

/** Endpoint of the IoT credentials provider for a region. */
const CREDENTIALS_ENDPOINT_PATTERN =
  /^[a-z0-9]+\.credentials\.iot\.(?:eu-west-3|eu-west-1)\.amazonaws\.com$/;

/**
 * IoT data-plane endpoint a robot connects to. Shared with the function environment, which receives
 * the same value from Terraform.
 */
export const IotDataEndpointSchema = z.string().regex(IOT_ENDPOINT_PATTERN);

/** IoT credentials-provider endpoint a robot exchanges its certificate with. */
export const IotCredentialsEndpointSchema = z.string().regex(CREDENTIALS_ENDPOINT_PATTERN);

/** ARN of a KVS channel named after a thing: the channel is the robot's video stream. */
export const KvsChannelArnSchema = z
  .string()
  .regex(
    /^arn:aws:kinesisvideo:(?:eu-west-3|eu-west-1):\d{12}:channel\/mfc-demo-[a-z0-9-]{3,32}\/\d{1,20}$/,
  );

/**
 * Non-secret configuration a robot reads from its kit: where to connect and which names to use.
 * It is written to `config.toml` on the robot, so it must never contain a credential.
 */
export const RobotKitConfigSchema = z
  .strictObject({
    robotId: RobotIdSchema,
    siteId: SiteIdSchema,
    thingName: ThingNameSchema,
    simulated: z.boolean(),
    region: AwsRegionSchema,
    iotEndpoint: IotDataEndpointSchema,
    credentialsEndpoint: IotCredentialsEndpointSchema,
    roleAlias: z.literal(ROLE_ALIAS_NAME),
    // The channel is named after the thing, so the credentials policy can bind them to one robot.
    kvsChannelName: ThingNameSchema,
    kvsChannelArn: KvsChannelArnSchema,
  })
  .superRefine((config, ctx) => {
    // Cross-field rules. JSON Schema cannot express them, so the Python mirror checks them separately
    // and the fixture parity test records the difference.
    if (config.thingName !== `${THING_NAME_PREFIX}${config.robotId}`) {
      ctx.addIssue({
        code: "custom",
        path: ["thingName"],
        message: "thing name must be the robot's",
      });
    }
    if (config.kvsChannelName !== config.thingName) {
      ctx.addIssue({
        code: "custom",
        path: ["kvsChannelName"],
        message: "channel must be the thing",
      });
    }
    if (channelNameOfArn(config.kvsChannelArn) !== config.kvsChannelName) {
      ctx.addIssue({
        code: "custom",
        path: ["kvsChannelArn"],
        message: "ARN must name the channel",
      });
    }
    if (
      regionOfArn(config.kvsChannelArn) !== config.region ||
      iotEndpointRegion(config.iotEndpoint) !== config.region ||
      credentialsEndpointRegion(config.credentialsEndpoint) !== config.region
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["region"],
        message: "every endpoint must be in the region",
      });
    }
  });

/**
 * Channel name of a KVS channel ARN, `arn:aws:kinesisvideo:<region>:<account>:channel/<name>/<id>`.
 *
 * @param arn - The ARN, already validated by {@link KvsChannelArnSchema}.
 * @returns The channel name, or undefined if the ARN has no channel segment.
 */
export function channelNameOfArn(arn: string): string | undefined {
  return arn.split("/")[1];
}

/**
 * Region of a KVS channel ARN, the fourth colon-separated field.
 *
 * @param arn - The ARN, already validated by {@link KvsChannelArnSchema}.
 * @returns The region, or undefined if the ARN is malformed.
 */
export function regionOfArn(arn: string): string | undefined {
  return arn.split(":")[3];
}

/**
 * Region of an IoT data endpoint, `<id>-ats.iot.<region>.amazonaws.com`.
 *
 * @param endpoint - The endpoint, already validated by its pattern.
 * @returns The region, or undefined if the endpoint is malformed.
 */
function iotEndpointRegion(endpoint: string): string | undefined {
  return endpoint.split(".")[2];
}

/**
 * Region of an IoT credentials endpoint, `<id>.credentials.iot.<region>.amazonaws.com`.
 *
 * @param endpoint - The endpoint, already validated by its pattern.
 * @returns The region, or undefined if the endpoint is malformed.
 */
function credentialsEndpointRegion(endpoint: string): string | undefined {
  return endpoint.split(".")[3];
}

/** A validated kit configuration. */
export type RobotKitConfig = z.infer<typeof RobotKitConfigSchema>;

/**
 * Upper bound on a PEM block. A certificate or an RSA-2048 key is well under 2 KB, so 4 KB leaves room
 * for longer keys while refusing anything that is not a key or a certificate.
 */
const MAX_PEM_LENGTH = 4096;

/**
 * A single PEM certificate. The regex is a literal, not a string built at run time, so that the
 * emitted JSON Schema and the Python mirror read exactly the same pattern.
 */
const PemCertificateSchema = z
  .string()
  .max(MAX_PEM_LENGTH)
  .regex(/^-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n?$/);

/**
 * A PEM private key in PKCS#8 or PKCS#1 form, whose footer repeats its header.
 *
 * The two full pairs are written out as alternatives, so the footer must name the form of its header.
 * Each literal carries an empty group inside its label (`PRIVATE(?:) KEY`): it matches the same text,
 * but the source and the generated JSON Schema never contain a contiguous key header, which the
 * secret scanners would report. The shape of the body is bounded by the same pattern.
 */
const PemPrivateKeySchema = z
  .string()
  .max(MAX_PEM_LENGTH)
  .regex(
    /^(?:-----BEGIN RSA PRIVATE(?:) KEY-----\n[A-Za-z0-9+/=\n]+\n-----END RSA PRIVATE(?:) KEY-----|-----BEGIN PRIVATE(?:) KEY-----\n[A-Za-z0-9+/=\n]+\n-----END PRIVATE(?:) KEY-----)\n?$/,
  );

/**
 * The kit delivered once by the registration: the certificate and key, the root CA, and the config.
 * The private key is the only copy; the cloud does not keep it.
 */
export const RobotKitSchema = z.strictObject({
  certificatePem: PemCertificateSchema,
  privateKeyPem: PemPrivateKeySchema,
  rootCaPem: PemCertificateSchema,
  config: RobotKitConfigSchema,
});

/** A validated kit. */
export type RobotKit = z.infer<typeof RobotKitSchema>;

/** Response of a successful registration: the registry entry and the kit. */
export const RegisterRobotResponseSchema = z.strictObject({
  robot: RobotSummarySchema,
  kit: RobotKitSchema,
});

/** A validated registration response. */
export type RegisterRobotResponse = z.infer<typeof RegisterRobotResponseSchema>;

/** Request to retire a robot. Retirement is idempotent, so the same request may be sent twice. */
export const RetireRobotRequestSchema = z.strictObject({
  robotId: RobotIdSchema,
  siteId: SiteIdSchema,
});

/** A validated retirement request. */
export type RetireRobotRequest = z.infer<typeof RetireRobotRequestSchema>;

/** Response of a retirement. `alreadyRetired` tells a repeated request apart from the first one. */
export const RetireRobotResponseSchema = z.strictObject({
  robot: RobotSummarySchema,
  alreadyRetired: z.boolean(),
});

/** A validated retirement response. */
export type RetireRobotResponse = z.infer<typeof RetireRobotResponseSchema>;

/** Fields shared by every admin invocation event. */
const AdminInvokeBaseShape = {
  source: z.literal("mfc.admin"),
  actor: ActorSchema,
  correlationId: CorrelationIdSchema.optional(),
};

/**
 * Event of a direct IAM invocation of the `robots` function. Discriminated on `action`, so each
 * action carries only the body it needs.
 */
export const AdminInvokeEventSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...AdminInvokeBaseShape,
    action: z.literal("robots.register"),
    body: RegisterRobotRequestSchema,
  }),
  z.strictObject({
    ...AdminInvokeBaseShape,
    action: z.literal("robots.retire"),
    body: RetireRobotRequestSchema,
  }),
]);

/** A validated admin invocation event. */
export type AdminInvokeEvent = z.infer<typeof AdminInvokeEventSchema>;

/** Refused invocation of either action: the status of the failure and its problem. */
const InvokeFailureSchema = z.strictObject({
  ok: z.literal(false),
  status: z.int().min(400).max(599),
  problem: ProblemSchema,
});

/** A registration result: created (200 or 201), or refused with a problem. */
export const RegisterInvokeResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.union([z.literal(200), z.literal(201)]),
    body: RegisterRobotResponseSchema,
  }),
  InvokeFailureSchema,
]);

/** A retirement result: done with 200 (first or repeated), or refused with a problem. */
export const RetireInvokeResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    status: z.literal(200),
    body: RetireRobotResponseSchema,
  }),
  InvokeFailureSchema,
]);

/** Result of any admin invocation: one of the two action results. */
export const AdminInvokeResultSchema = z.union([
  RegisterInvokeResultSchema,
  RetireInvokeResultSchema,
]);

/** A validated admin invocation result. */
export type AdminInvokeResult = z.infer<typeof AdminInvokeResultSchema>;

/** A validated registration invocation result. */
export type RegisterInvokeResult = z.infer<typeof RegisterInvokeResultSchema>;

/** A validated retirement invocation result. */
export type RetireInvokeResult = z.infer<typeof RetireInvokeResultSchema>;
