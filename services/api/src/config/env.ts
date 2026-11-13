/**
 * Environment of the API Lambda functions, parsed and validated once at cold start.
 *
 * Every value the functions depend on comes from Terraform, so an invalid value is a deployment error.
 * The parsers fail closed: a function that cannot read its environment does not start, and the error
 * names the variables at fault, never their values.
 */
import {
  AwsRegionSchema,
  IotCredentialsEndpointSchema,
  IotDataEndpointSchema,
  WsTokenResponseSchema,
} from "@mfc/protocol";
import { z } from "zod";

/**
 * HTTPS endpoint of a WebSocket stage's management API, `https://<api-id>.execute-api.<region>.amazonaws.com/<stage>`.
 * The regions come from {@link AwsRegionSchema}, so a region is added in one place.
 */
// The alternation is built from a closed enum, never from input, so the dynamic pattern is safe.
// eslint-disable-next-line security/detect-non-literal-regexp -- built from AwsRegionSchema.options only
const MANAGEMENT_ENDPOINT_PATTERN = new RegExp(
  `^https://[a-z0-9]+\\.execute-api\\.(${AwsRegionSchema.options.join("|")})\\.amazonaws\\.com/[a-z0-9-]{1,128}$`,
);

/**
 * Tags written on every resource a function creates. The keys match the provider default tags, so the
 * resources a function creates carry the same ownership as the rest of the stack. Strict: an extra key
 * means the deployment and the code disagree.
 */
export const ResourceTagsSchema = z.strictObject({
  project: z.literal("mfc"),
  env: z.literal("demo"),
  component: z.string().regex(/^[a-z-]{1,32}$/),
  owner: z.string().regex(/^[a-z0-9-]{1,32}$/),
});

/** Tags applied to resources a function creates. */
export type ResourceTags = z.infer<typeof ResourceTagsSchema>;

/** Name of a DynamoDB table of the demo stack, as created by the data-tables module. */
const TableNameSchema = z.string().regex(/^mfc-demo-[a-z0-9-]{1,40}$/);

/** Bound on the raw tags string, so that a malformed variable cannot make the parser work on a large input. */
const MAX_RESOURCE_TAGS_LENGTH = 1024;

/**
 * JSON text decoded into a value that the next schema then checks. A decoding error is reported as a
 * plain issue, so the message never repeats the input.
 */
const JsonStringSchema = z
  .string()
  .max(MAX_RESOURCE_TAGS_LENGTH)
  .transform((value, ctx) => {
    try {
      const decoded: unknown = JSON.parse(value);
      return decoded;
    } catch {
      ctx.addIssue({ code: "custom", message: "not valid JSON" });
      return z.NEVER;
    }
  });

/**
 * Environment of the `robots` function. `z.object` strips the many unrelated keys of the Lambda runtime
 * environment, so only the declared names are read.
 */
export const RobotsEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  FLEET_TABLE_NAME: TableNameSchema,
  EVENTS_TABLE_NAME: TableNameSchema,
  IOT_DATA_ENDPOINT: IotDataEndpointSchema,
  IOT_CREDENTIALS_ENDPOINT: IotCredentialsEndpointSchema,
  RESOURCE_TAGS: JsonStringSchema.pipe(ResourceTagsSchema),
});

/** A validated `robots` environment. */
export type RobotsEnv = z.infer<typeof RobotsEnvSchema>;

/**
 * Name of an S3 bucket, by the rules S3 applies: 3 to 63 characters of lowercase letters, digits, dots and
 * hyphens, starting and ending with a letter or a digit.
 */
const BucketNameSchema = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);

/**
 * Environment of the `site` function. The names are read under their Terraform names and returned under the names
 * the domain uses, so the handler wiring names what each one is.
 */
export const SiteEnvSchema = z
  .object({
    AWS_REGION: AwsRegionSchema,
    FLEET_TABLE_NAME: TableNameSchema,
    EVENTS_TABLE_NAME: TableNameSchema,
    SITE_MAPS_BUCKET_NAME: BucketNameSchema,
  })
  .transform((env) => ({
    region: env.AWS_REGION,
    fleetTable: env.FLEET_TABLE_NAME,
    eventsTable: env.EVENTS_TABLE_NAME,
    bucket: env.SITE_MAPS_BUCKET_NAME,
  }));

/** A validated `site` environment. */
export type SiteEnv = z.infer<typeof SiteEnvSchema>;

/** Endpoint of the WebSocket management API, the only address the realtime fan-out posts to. */
const ManagementEndpointSchema = z.string().regex(MANAGEMENT_ENDPOINT_PATTERN);

/** Environment of the `ingest-events` function. */
export const IngestEventsEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  FLEET_TABLE_NAME: TableNameSchema,
  EVENTS_TABLE_NAME: TableNameSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
  WS_MANAGEMENT_ENDPOINT: ManagementEndpointSchema,
});

/** A validated `ingest-events` environment. */
export type IngestEventsEnv = z.infer<typeof IngestEventsEnvSchema>;

/** Environment of the `ingest-telemetry` function. */
export const IngestTelemetryEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  FLEET_TABLE_NAME: TableNameSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
  WS_MANAGEMENT_ENDPOINT: ManagementEndpointSchema,
});

/** A validated `ingest-telemetry` environment. */
export type IngestTelemetryEnv = z.infer<typeof IngestTelemetryEnvSchema>;

/**
 * Environment of the `alerts` function. It reads the fleet table for the open-alert markers, the events table for
 * the alerts and their audit records, and the connections table with the management endpoint for the live relay.
 */
export const AlertsEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  FLEET_TABLE_NAME: TableNameSchema,
  EVENTS_TABLE_NAME: TableNameSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
  WS_MANAGEMENT_ENDPOINT: ManagementEndpointSchema,
});

/** A validated `alerts` environment. */
export type AlertsEnv = z.infer<typeof AlertsEnvSchema>;

/**
 * Environment of the `control` function. It reads the fleet table for the registry, the lock items, the command
 * claims and the demo flag; the events table for the audit records; the connections table and the management
 * endpoint for the live relay of the lock changes; and the IoT data-plane endpoint for the commands it publishes.
 */
export const ControlEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  FLEET_TABLE_NAME: TableNameSchema,
  EVENTS_TABLE_NAME: TableNameSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
  WS_MANAGEMENT_ENDPOINT: ManagementEndpointSchema,
  IOT_DATA_ENDPOINT: IotDataEndpointSchema,
});

/** A validated `control` environment. */
export type ControlEnv = z.infer<typeof ControlEnvSchema>;

/** Origin of a browser console: scheme and host, as the Terraform variable `ws_allowed_origins` validates it. */
const AllowedOriginSchema = z.string().regex(/^https?:\/\/[a-z0-9.:-]{1,253}$/);

/** Bound on the number of allowed origins. The demo needs the dev server and the console origin. */
const MAX_ALLOWED_ORIGINS = 10;

/**
 * Environment of the `ws-token` function. `WS_URL` is the URL the token response returns, so it is checked
 * with the protocol's own pattern: the function never returns a URL the console would refuse.
 */
export const WsTokenEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
  WS_URL: WsTokenResponseSchema.shape.url,
});

/** A validated `ws-token` environment. */
export type WsTokenEnv = z.infer<typeof WsTokenEnvSchema>;

/**
 * Environment of the `ws-connect` function. `WS_ALLOWED_ORIGINS` is a JSON array of origins, the same
 * encoding as `RESOURCE_TAGS`; an empty list would refuse every browser, so at least one is required.
 */
export const WsConnectEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
  WS_ALLOWED_ORIGINS: JsonStringSchema.pipe(
    z.array(AllowedOriginSchema).min(1).max(MAX_ALLOWED_ORIGINS),
  ),
});

/** A validated `ws-connect` environment. */
export type WsConnectEnv = z.infer<typeof WsConnectEnvSchema>;

/** Environment of the `ws-disconnect` function. */
export const WsDisconnectEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
});

/** A validated `ws-disconnect` environment. */
export type WsDisconnectEnv = z.infer<typeof WsDisconnectEnvSchema>;

/**
 * Environment of the `ws-message` function. It has no management endpoint: the function derives it from the
 * request context of each event, so the function does not depend on the API that routes to it.
 */
export const WsMessageEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  CONNECTIONS_TABLE_NAME: TableNameSchema,
  FLEET_TABLE_NAME: TableNameSchema,
  IOT_DATA_ENDPOINT: IotDataEndpointSchema,
});

/** A validated `ws-message` environment. */
export type WsMessageEnv = z.infer<typeof WsMessageEnvSchema>;

/** Version reported by the health endpoint: a release label, never a build identifier that reveals the account. */
const AppVersionSchema = z.string().regex(/^[A-Za-z0-9._+-]{1,64}$/);

/**
 * Environment of the `health` function. `APP_VERSION` is set by the deployment; it defaults to `dev` so that a
 * local run reports something a reader can tell apart from a deployed release.
 */
export const HealthEnvSchema = z.object({
  APP_VERSION: AppVersionSchema.default("dev"),
});

/** A validated `health` environment. */
export type HealthEnv = z.infer<typeof HealthEnvSchema>;

/**
 * Validates an environment against a schema and returns the parsed value.
 *
 * @param schema - The schema of the function's environment.
 * @param env - The raw environment, as read from `process.env`.
 * @returns The validated environment.
 * @throws {Error} `invalid environment: <paths>` listing the variables that failed. Only the paths are
 * included: a value can be a secret or a personal identifier, and it must never reach a log.
 */
function parseEnvironment<Output>(schema: z.ZodType<Output>, env: NodeJS.ProcessEnv): Output {
  const result = schema.safeParse(env);
  if (!result.success) {
    const paths = new Set(result.error.issues.map((issue) => issue.path.map(String).join(".")));
    throw new Error(`invalid environment: ${[...paths].join(", ")}`);
  }
  return result.data;
}

/**
 * Parses the environment of the `robots` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadRobotsEnv(env: NodeJS.ProcessEnv): RobotsEnv {
  return parseEnvironment(RobotsEnvSchema, env);
}

/**
 * Parses the environment of the `site` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadSiteEnv(env: NodeJS.ProcessEnv): SiteEnv {
  return parseEnvironment(SiteEnvSchema, env);
}

/**
 * Parses the environment of the `ingest-events` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadIngestEventsEnv(env: NodeJS.ProcessEnv): IngestEventsEnv {
  return parseEnvironment(IngestEventsEnvSchema, env);
}

/**
 * Parses the environment of the `ingest-telemetry` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadIngestTelemetryEnv(env: NodeJS.ProcessEnv): IngestTelemetryEnv {
  return parseEnvironment(IngestTelemetryEnvSchema, env);
}

/**
 * Parses the environment of the `alerts` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadAlertsEnv(env: NodeJS.ProcessEnv): AlertsEnv {
  return parseEnvironment(AlertsEnvSchema, env);
}

/**
 * Parses the environment of the `control` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadControlEnv(env: NodeJS.ProcessEnv): ControlEnv {
  return parseEnvironment(ControlEnvSchema, env);
}

/**
 * Parses the environment of the `ws-token` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadWsTokenEnv(env: NodeJS.ProcessEnv): WsTokenEnv {
  return parseEnvironment(WsTokenEnvSchema, env);
}

/**
 * Parses the environment of the `ws-connect` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadWsConnectEnv(env: NodeJS.ProcessEnv): WsConnectEnv {
  return parseEnvironment(WsConnectEnvSchema, env);
}

/**
 * Parses the environment of the `ws-disconnect` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadWsDisconnectEnv(env: NodeJS.ProcessEnv): WsDisconnectEnv {
  return parseEnvironment(WsDisconnectEnvSchema, env);
}

/**
 * Parses the environment of the `ws-message` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} When a variable is missing or malformed; the message names the variables only.
 */
export function loadWsMessageEnv(env: NodeJS.ProcessEnv): WsMessageEnv {
  return parseEnvironment(WsMessageEnvSchema, env);
}

/**
 * Parses the environment of the `health` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment, with the default version when the variable is absent.
 * @throws {Error} When `APP_VERSION` is present and malformed; the message names the variable only.
 */
export function loadHealthEnv(env: NodeJS.ProcessEnv): HealthEnv {
  return parseEnvironment(HealthEnvSchema, env);
}
