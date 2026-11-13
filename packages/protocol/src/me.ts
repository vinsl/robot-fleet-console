/**
 * Response schema of `GET /me`: the identity the console shows, derived from the verified access token.
 *
 * The schema is strict so that no claim beyond the identity (email, name, token fields) can reach the
 * browser without the contract changing with it.
 */
import { z } from "zod";
import { SiteIdSchema, UserSubSchema } from "./ids";
import { RoleSchema } from "./ws";

/** Identity of the calling user: subject, role and the site the console works on. */
export const MeSchema = z.strictObject({
  userId: UserSubSchema,
  role: RoleSchema,
  siteId: SiteIdSchema,
});

/** A validated identity response. */
export type Me = z.infer<typeof MeSchema>;
