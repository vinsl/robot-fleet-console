/**
 * Response schema of the public health endpoint.
 *
 * The schema is strict so that a handler cannot leak extra fields (build metadata,
 * account identifiers) without the contract, the OpenAPI document and the tests
 * changing together.
 */
import { z } from "zod";

/** Health response: fixed status, application version and an ISO 8601 UTC timestamp with milliseconds. */
export const HealthResponseSchema = z.strictObject({
  status: z.literal("ok"),
  version: z.string().min(1).max(64),
  // Millisecond precision and the Z suffix keep the timestamp unambiguous for clients.
  time: z.iso.datetime({ precision: 3 }),
});

/** A validated health response. */
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
