/**
 * Validation of the signaling endpoints that AWS returns for the robot channel.
 *
 * The endpoints are the hosts the page opens sockets to, with credentials attached. Each one must
 * use the expected scheme and sit under the KVS suffix of the bundle's region, so a manipulated
 * answer cannot send the page to another host.
 */
import { VideoPageError } from "./errors";
import type { VideoRegion } from "./regions";

/** Signaling endpoints of the channel, both validated against the region. */
export interface SignalingEndpoints {
  readonly wss: string;
  readonly https: string;
}

/** The part of an AWS `ResourceEndpointListItem` that the pages read. */
export interface ResourceEndpointLike {
  readonly Protocol?: string | undefined;
  readonly ResourceEndpoint?: string | undefined;
}

/**
 * Returns the checked WSS and HTTPS endpoints from a `GetSignalingChannelEndpoint` answer.
 *
 * @param list - The `ResourceEndpointList` of the answer, if AWS returned one.
 * @param region - The region of the session; every endpoint must be in it.
 * @returns The WSS and HTTPS endpoints, unchanged.
 * @throws {VideoPageError} `ENDPOINT_UNEXPECTED` when an endpoint is missing, malformed, on another
 *   scheme, port or region.
 */
export function endpointsByProtocol(
  list: readonly ResourceEndpointLike[] | undefined,
  region: VideoRegion,
): SignalingEndpoints {
  return {
    wss: checkEndpoint(firstEndpoint(list, "WSS"), "wss:", region),
    https: checkEndpoint(firstEndpoint(list, "HTTPS"), "https:", region),
  };
}

/**
 * Returns the first endpoint of a protocol in the answer.
 *
 * @param list - The endpoint list of the answer.
 * @param protocol - The AWS protocol name, `WSS` or `HTTPS`.
 * @returns The endpoint URL as AWS wrote it.
 * @throws {VideoPageError} `ENDPOINT_UNEXPECTED` when the protocol is absent.
 */
function firstEndpoint(
  list: readonly ResourceEndpointLike[] | undefined,
  protocol: string,
): string {
  const endpoint = list?.find((item) => item.Protocol === protocol)?.ResourceEndpoint;
  if (endpoint === undefined) {
    throw new VideoPageError("ENDPOINT_UNEXPECTED");
  }
  return endpoint;
}

/**
 * Checks one endpoint URL: scheme, default port and the KVS suffix of the region.
 *
 * @param endpoint - The URL to check.
 * @param scheme - The only scheme accepted for this endpoint.
 * @param region - The region whose KVS suffix the host must end with.
 * @returns The endpoint, unchanged.
 * @throws {VideoPageError} `ENDPOINT_UNEXPECTED` when any check fails.
 */
function checkEndpoint(endpoint: string, scheme: "wss:" | "https:", region: VideoRegion): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new VideoPageError("ENDPOINT_UNEXPECTED");
  }
  const suffix = `.kinesisvideo.${region}.amazonaws.com`;
  const defaultPort = url.port === "" || url.port === "443";
  if (url.protocol !== scheme || !defaultPort || !url.hostname.endsWith(suffix)) {
    throw new VideoPageError("ENDPOINT_UNEXPECTED");
  }
  return endpoint;
}
