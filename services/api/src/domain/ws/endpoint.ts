/**
 * The management endpoint of the WebSocket stage that delivered a message.
 *
 * `ws-message` posts to the connections of the stage that routed the message to it. API Gateway puts the
 * domain name and the stage of that stage in the request context, so the function derives the endpoint from
 * the event instead of carrying it in its environment. The derived value is checked against the execute-api
 * shape before any use, because it becomes the address of an outgoing request.
 */
import type { AwsRegion } from "@mfc/protocol";

/** Shape of an execute-api domain name: `<api-id>.execute-api.<region>.amazonaws.com`. */
const DOMAIN_NAME_PATTERN = /^([a-z0-9]{1,32})\.execute-api\.([a-z0-9-]{1,32})\.amazonaws\.com$/;

/** Shape of a stage name: the lowercase, digit and hyphen subset this project uses. */
const STAGE_PATTERN = /^[a-z0-9-]{1,128}$/;

/**
 * Builds the management endpoint of the stage of a request, when the request context has the expected shape.
 *
 * The region of the domain name must be the region the function runs in: the management client signs its
 * requests for that region, and a request signed for another one would be refused.
 *
 * @param context - The domain name and the stage from the request context.
 * @param region - The region the function runs in.
 * @returns `https://<domain>/<stage>`, or null when the context does not name a stage of this region.
 */
export function managementEndpointOf(
  context: { readonly domainName: string; readonly stage: string },
  region: AwsRegion,
): string | null {
  const match = DOMAIN_NAME_PATTERN.exec(context.domainName);
  if (match === null || match[2] !== region || !STAGE_PATTERN.test(context.stage)) {
    return null;
  }
  return `https://${context.domainName}/${context.stage}`;
}
