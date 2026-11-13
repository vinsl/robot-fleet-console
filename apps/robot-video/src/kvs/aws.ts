/**
 * AWS SDK calls of the video page: the channel endpoints, the ICE servers and the signaling client.
 *
 * The pages hold temporary credentials in memory only, so every call takes them as a static object
 * and never reads a profile, a file or the environment. Each call has its own timeout, and an SDK
 * failure leaves here as a `VideoPageError` that carries only the AWS error name: the SDK message can
 * quote the request it failed on.
 */
import {
  GetSignalingChannelEndpointCommand,
  KinesisVideoClient,
} from "@aws-sdk/client-kinesis-video";
import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from "@aws-sdk/client-kinesis-video-signaling";
import { buildIceServers } from "../lib/ice";
import { endpointsByProtocol, type SignalingEndpoints } from "../lib/endpoints";
import { VideoPageError } from "../lib/errors";
import type { RunSession } from "../lib/session";
import { SILENT_LOGGER, type KvsRole, type KvsWebRtc, type KvsSignalingClient } from "./kvs-webrtc";

/** Upper bound of one AWS call. The SDK's own retries apply within it. */
const AWS_CALL_TIMEOUT_MS = 5_000;

/** What a viewer or a master needs to open the signaling channel. */
export interface ChannelAccess {
  readonly endpoints: SignalingEndpoints;
  /** Clock offset the SDK applies to its signatures, in milliseconds. */
  readonly systemClockOffsetMs: number;
}

/**
 * Keeps an AWS error name when it is a plain identifier, and drops everything else.
 *
 * @param error - The value thrown by the SDK.
 * @returns The error name, or `undefined` when it is not a simple identifier.
 */
function awsErrorName(error: unknown): string | undefined {
  if (error instanceof Error && /^[A-Za-z0-9.]{1,64}$/.test(error.name)) {
    return error.name;
  }
  return undefined;
}

/**
 * Runs one AWS call and converts its failure into a `VideoPageError`.
 *
 * @param call - The call, starting when invoked.
 * @returns The result of the call.
 * @throws {VideoPageError} `AWS_CALL_FAILED`, with the AWS error name as detail.
 */
async function callAws<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error: unknown) {
    throw new VideoPageError("AWS_CALL_FAILED", awsErrorName(error));
  }
}

/**
 * Returns the SDK credentials of a session, as a plain object the SDK accepts.
 *
 * @param session - The validated session.
 * @returns The three credential fields.
 */
function sdkCredentials(session: RunSession): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
} {
  return {
    accessKeyId: session.credentials.accessKeyId,
    secretAccessKey: session.credentials.secretAccessKey,
    sessionToken: session.credentials.sessionToken,
  };
}

/**
 * Resolves the WSS and HTTPS endpoints of the channel for one role, and the clock offset.
 *
 * @param session - The validated session.
 * @param role - `MASTER` or `VIEWER`.
 * @returns The checked endpoints and the clock offset.
 * @throws {VideoPageError} `AWS_CALL_FAILED` or `ENDPOINT_UNEXPECTED`.
 */
export async function resolveChannelAccess(
  session: RunSession,
  role: KvsRole,
): Promise<ChannelAccess> {
  const client = new KinesisVideoClient({
    region: session.region,
    credentials: sdkCredentials(session),
  });
  const output = await callAws(() =>
    client.send(
      new GetSignalingChannelEndpointCommand({
        ChannelARN: session.channelArn,
        SingleMasterChannelEndpointConfiguration: {
          Protocols: ["WSS", "HTTPS"],
          Role: role,
        },
      }),
      { abortSignal: AbortSignal.timeout(AWS_CALL_TIMEOUT_MS) },
    ),
  );
  return {
    endpoints: endpointsByProtocol(output.ResourceEndpointList, session.region),
    systemClockOffsetMs: client.config.systemClockOffset,
  };
}

/**
 * Fetches the STUN and TURN servers of the channel.
 *
 * TURN credentials expire after about five minutes, so the caller fetches them for every peer
 * connection rather than once per session.
 *
 * @param session - The validated session.
 * @param httpsEndpoint - The HTTPS signaling endpoint from {@link resolveChannelAccess}.
 * @param clientId - The viewer's id, required by KVS for a viewer, omitted for a master.
 * @returns The ICE servers to pass to the peer connection.
 * @throws {VideoPageError} `AWS_CALL_FAILED`.
 */
export async function fetchIceServers(
  session: RunSession,
  httpsEndpoint: string,
  clientId?: string,
): Promise<RTCIceServer[]> {
  const client = new KinesisVideoSignalingClient({
    region: session.region,
    endpoint: httpsEndpoint,
    credentials: sdkCredentials(session),
  });
  const output = await callAws(() =>
    client.send(
      new GetIceServerConfigCommand({
        ChannelARN: session.channelArn,
        ClientId: clientId,
        Service: "TURN",
      }),
      { abortSignal: AbortSignal.timeout(AWS_CALL_TIMEOUT_MS) },
    ),
  );
  return buildIceServers(session.region, output.IceServerList);
}

/**
 * Creates a signaling client for the channel, with the SDK's logger silenced.
 *
 * @param kvs - The vendored SDK, from `loadKvsWebRtc`.
 * @param session - The validated session.
 * @param access - The endpoints and clock offset from {@link resolveChannelAccess}.
 * @param role - `MASTER` or `VIEWER`.
 * @param clientId - The viewer's id; omitted for a master.
 * @returns A client that is not open yet: the caller registers its listeners, then opens it.
 */
export function createSignalingClient(
  kvs: KvsWebRtc,
  session: RunSession,
  access: ChannelAccess,
  role: KvsRole,
  clientId?: string,
): KvsSignalingClient {
  return new kvs.SignalingClient({
    channelARN: session.channelArn,
    channelEndpoint: access.endpoints.wss,
    credentials: sdkCredentials(session),
    region: session.region,
    role,
    clientId,
    systemClockOffset: access.systemClockOffsetMs,
    logger: SILENT_LOGGER,
  });
}
