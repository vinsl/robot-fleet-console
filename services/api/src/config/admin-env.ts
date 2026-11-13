/**
 * Environment of the admin API functions (audit, and later the robots and users functions), parsed and validated once
 * at cold start.
 *
 * It follows the parsers of `env.ts` and fails the same way: a function that cannot read its environment does not
 * start, and the error names the variables at fault, never their values. The admin functions live in their own module
 * so that the environment of the existing functions is left as it is.
 */
import { AwsRegionSchema } from "@mfc/protocol";
import { z } from "zod";

/** Name of a DynamoDB table of the demo stack, as created by the data-tables module. */
const TableNameSchema = z.string().regex(/^mfc-demo-[a-z0-9-]{1,40}$/);

/**
 * Environment of the `audit` function. It reads the events table only, through the status index that lists the audit
 * records; it has no write permission and no other table.
 */
export const AuditEnvSchema = z.object({
  AWS_REGION: AwsRegionSchema,
  EVENTS_TABLE_NAME: TableNameSchema,
});

/** A validated `audit` environment. */
export type AuditEnv = z.infer<typeof AuditEnvSchema>;

/**
 * Parses the environment of the `audit` function.
 *
 * @param env - The raw environment, normally `process.env`.
 * @returns The validated environment.
 * @throws {Error} `invalid environment: <paths>` listing the variables that failed. Only the paths are included: a
 * value must never reach a log.
 */
export function loadAuditEnv(env: NodeJS.ProcessEnv): AuditEnv {
  const result = AuditEnvSchema.safeParse(env);
  if (!result.success) {
    const paths = new Set(result.error.issues.map((issue) => issue.path.map(String).join(".")));
    throw new Error(`invalid environment: ${[...paths].join(", ")}`);
  }
  return result.data;
}
