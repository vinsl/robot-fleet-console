/**
 * Claims the console reads from a Cognito access token to show the signed-in user.
 *
 * The console never trusts these claims for authorization: the API verifies the token on every call. They only
 * decide what the UI shows, so the schema keeps only the claims it uses and ignores the rest.
 */
import { z } from "zod";
import { UserSubSchema } from "./ids";

/** Subject and groups of an access token. Other claims are ignored, so Cognito can add some without a break. */
export const CognitoAccessClaimsSchema = z.object({
  sub: UserSubSchema,
  "cognito:groups": z.array(z.string()).optional(),
});

/** Validated access token claims. */
export type CognitoAccessClaims = z.infer<typeof CognitoAccessClaimsSchema>;
