/**
 * ICE server list for the video page peer connections.
 *
 * STUN and TURN come from KVS. A TURN entry reaches the browser with its credentials, so only the
 * entries that point at the KVS hosts of the bundle's region are kept; anything else is dropped
 * rather than trusted.
 */
import type { VideoRegion } from "./regions";

/** The part of an AWS `IceServer` (from `GetIceServerConfig`) that the pages read. */
export interface IceServerLike {
  readonly Uris?: readonly string[] | undefined;
  readonly Username?: string | undefined;
  readonly Password?: string | undefined;
}

/**
 * One TURN or TURNS URI of KVS: a host under the KVS suffix, an optional port and an optional
 * transport. The region is captured so that the caller can compare it with the session region.
 */
const TURN_URI =
  /^turns?:([a-z0-9.-]+)\.kinesisvideo\.([a-z0-9-]+)\.amazonaws\.com:\d{1,5}(\?transport=(udp|tcp))?$/;

/**
 * Returns the STUN URL of the KVS endpoint of a region.
 *
 * @param region - The region of the session.
 * @returns The `stun:` URL on port 443, as KVS documents it.
 */
export function stunUrl(region: VideoRegion): string {
  return `stun:stun.kinesisvideo.${region}.amazonaws.com:443`;
}

/**
 * Tells whether a TURN URI points at a KVS host of the given region.
 *
 * @param uri - A URI from the AWS answer.
 * @param region - The region of the session.
 * @returns True when the URI matches the KVS TURN shape and names that region.
 */
function isKvsTurnUri(uri: string, region: VideoRegion): boolean {
  const match = TURN_URI.exec(uri);
  return match !== null && match[2] === region;
}

/**
 * Converts one AWS ICE server to an RTC entry, or to nothing when it is not usable.
 *
 * An entry is kept only with credentials and with every URI pointing at KVS: one foreign URI
 * makes the whole entry suspect, so it is dropped as a unit.
 *
 * @param server - The AWS ICE server.
 * @param region - The region of the session.
 * @returns Zero or one RTC entry.
 */
function toTurnEntry(server: IceServerLike, region: VideoRegion): RTCIceServer[] {
  const uris = server.Uris ?? [];
  const { Username: username, Password: password } = server;
  if (uris.length === 0 || username === undefined || username === "") {
    return [];
  }
  if (password === undefined || password === "") {
    return [];
  }
  if (!uris.every((uri) => isKvsTurnUri(uri, region))) {
    return [];
  }
  return [{ urls: [...uris], username, credential: password }];
}

/**
 * Builds the `RTCConfiguration.iceServers` list: the STUN entry first, then each usable TURN entry.
 *
 * @param region - The region of the session.
 * @param list - The `IceServerList` of the AWS answer, if any.
 * @returns The ICE servers to pass to `new RTCPeerConnection`.
 */
export function buildIceServers(
  region: VideoRegion,
  list: readonly IceServerLike[] | undefined,
): RTCIceServer[] {
  const turn = (list ?? []).flatMap((server) => toTurnEntry(server, region));
  return [{ urls: stunUrl(region) }, ...turn];
}
