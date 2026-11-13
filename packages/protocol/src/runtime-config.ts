/**
 * Runtime configuration of the console, written by the publish step from the Terraform outputs (ADR 0048).
 *
 * The console fetches it when the page loads, so one build serves every environment. The file arrives from
 * outside the bundle, which makes it a trust boundary: the schema is strict, and the URLs are pinned to their
 * schemes.
 */
import { z } from "zod";

/** AWS region identifier, for example `eu-west-3`. */
const RegionSchema = z.string().regex(/^[a-z]{2}-[a-z-]{2,20}-\d$/);

/** Cognito user pool identifier, for example `eu-west-3_AbCdEf123`. */
const UserPoolIdSchema = z.string().regex(/^[a-z]{2}-[a-z-]{2,20}-\d_[A-Za-z0-9]{1,64}$/);

/** Cognito app client identifier: lowercase alphanumerics, no secret. */
const UserPoolClientIdSchema = z.string().regex(/^[a-z0-9]{1,128}$/);

/** Cognito identity pool identifier, for example `eu-west-3:00000000-0000-0000-0000-000000000000`. */
const IdentityPoolIdSchema = z.string().regex(/^[a-z]{2}-[a-z-]{2,20}-\d:[0-9a-f-]{36}$/);

/**
 * The console configuration. Strict, so a stray key written by a publish step cannot pass unnoticed.
 * The API is reached over HTTPS and the realtime endpoint over WSS, and nothing else is accepted.
 */
export const RuntimeConfigSchema = z.strictObject({
  apiUrl: z.url({ protocol: /^https$/ }),
  wsUrl: z.url({ protocol: /^wss$/ }),
  region: RegionSchema,
  userPoolId: UserPoolIdSchema,
  userPoolClientId: UserPoolClientIdSchema,
  identityPoolId: IdentityPoolIdSchema,
});

/** A validated console configuration. */
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;
