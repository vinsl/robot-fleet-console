/**
 * Viewer of one robot's camera: the console side of the robot's KVS WebRTC channel (ADR 0025, ADR 0067).
 *
 * The console joins the channel as a viewer, receives the robot's video into a `<video>` element and reports the
 * round trip of the media path. The signalling library is the vendored browser bundle (ADR 0026), loaded once from
 * the console's own origin with a pinned Subresource Integrity value; the console adds no inline script and no
 * origin to its CSP.
 *
 * Every AWS value is checked before use: the channel ARN must name the channel asked for and sit in the session
 * region, and the endpoints must use the expected scheme, port and KVS host. Failure of any step moves the pane to
 * `unavailable` and releases everything the attempt opened; no SDK message reaches the screen or a log, because the
 * SDK can quote the signed request.
 */
import {
  DescribeSignalingChannelCommand,
  GetSignalingChannelEndpointCommand,
  KinesisVideoClient,
} from "@aws-sdk/client-kinesis-video";
import {
  GetIceServerConfigCommand,
  KinesisVideoSignalingClient,
} from "@aws-sdk/client-kinesis-video-signaling";
import { KvsChannelArnSchema, type RuntimeConfig, type ThingName } from "@mfc/protocol";
import type { ViewerCredentials } from "./kvs-credentials";
import { roundTripMsFromReport } from "./video-stats";
import { KVS_WEBRTC_VENDOR } from "./vendor-manifest";

declare global {
  interface Window {
    /** Set by the vendored bundle before its script element fires `load`. */
    KVSWebRTC?: unknown;
  }
}

/** Same-origin path of the vendored bundle, as the console's build serves it. */
export const KVS_WEBRTC_SCRIPT_PATH = "/vendor/kvs-webrtc.min.js";

/** AWS region of the session, as the runtime configuration validates it. */
export type Region = RuntimeConfig["region"];

/** Upper bound of one AWS call. The SDK's own retries apply within it. */
const AWS_CALL_TIMEOUT_MS = 5_000;

/** How long the robot may take to answer the offer before the pane gives up. */
const ANSWER_TIMEOUT_MS = 10_000;

/** Interval between two round-trip samples. */
const STATS_INTERVAL_MS = 1_000;

/** Key of the single master of the channel in the candidate buffer. */
const MASTER_KEY = "master";

/** What the pane shows: the video is connecting, playing, or cannot be shown. */
export type ViewerState = "connecting" | "live" | "unavailable";

/** A statistics sample: the round trip of the media path. */
export interface ViewerStats {
  readonly rttMs: number;
}

/** Deps of {@link connectViewer}. */
export interface ViewerDeps {
  /** The session region. Every ARN and endpoint must be in it. */
  readonly region: Region;
  /** The robot's channel name, `mfc-demo-<robotId>`, built from a validated robot id. */
  readonly channelName: ThingName;
  /** Yields valid credentials for the AWS calls and the signalling client. */
  readonly credentials: () => Promise<ViewerCredentials>;
  /** The element the robot's video plays in. It must be muted to autoplay. */
  readonly video: HTMLVideoElement;
  /** Receives every change of the pane state. Never called after the disposer has run. */
  readonly onState: (state: ViewerState) => void;
  /** Receives each round-trip sample. Never called after the disposer has run. */
  readonly onStats: (stats: ViewerStats) => void;
}

/** Reason codes of a {@link ViewerError}. They are for developers; the user sees a fixed message. */
export type ViewerErrorCode =
  | "CHANNEL_UNEXPECTED"
  | "ENDPOINT_UNEXPECTED"
  | "NO_LOCAL_DESCRIPTION"
  | "SCRIPT_FAILED"
  | "SDK_MISSING"
  | "SDK_VERSION";

/** A failure of the viewer that the console detected itself, with a fixed reason code. */
export class ViewerError extends Error {
  /** Why the viewer failed. */
  readonly code: ViewerErrorCode;

  /**
   * @param code - The reason code.
   */
  constructor(code: ViewerErrorCode) {
    super(`video viewer: ${code}`);
    this.name = "ViewerError";
    this.code = code;
  }
}

/** Signalling endpoints of the channel, both checked against the region. */
interface SignalingEndpoints {
  readonly wss: string;
  readonly https: string;
}

/** The part of an AWS `ResourceEndpointListItem` that the viewer reads. */
export interface ResourceEndpointLike {
  readonly Protocol?: string | undefined;
  readonly ResourceEndpoint?: string | undefined;
}

/**
 * Returns the checked WSS and HTTPS endpoints of a `GetSignalingChannelEndpoint` answer.
 *
 * @param list - The `ResourceEndpointList` of the answer, if AWS returned one.
 * @param region - The session region; every endpoint must be in it.
 * @returns The WSS and HTTPS endpoints, unchanged.
 * @throws {ViewerError} `ENDPOINT_UNEXPECTED` when an endpoint is missing, malformed, on another scheme, port or region.
 */
export function endpointsByProtocol(
  list: readonly ResourceEndpointLike[] | undefined,
  region: Region,
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
 * @param protocol - The AWS protocol name.
 * @returns The endpoint URL as AWS wrote it.
 * @throws {ViewerError} `ENDPOINT_UNEXPECTED` when the protocol is absent.
 */
function firstEndpoint(
  list: readonly ResourceEndpointLike[] | undefined,
  protocol: string,
): string {
  const endpoint = list?.find((item) => item.Protocol === protocol)?.ResourceEndpoint;
  if (endpoint === undefined) {
    throw new ViewerError("ENDPOINT_UNEXPECTED");
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
 * @throws {ViewerError} `ENDPOINT_UNEXPECTED` when any check fails.
 */
function checkEndpoint(endpoint: string, scheme: "wss:" | "https:", region: Region): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ViewerError("ENDPOINT_UNEXPECTED");
  }
  const suffix = `.kinesisvideo.${region}.amazonaws.com`;
  const defaultPort = url.port === "" || url.port === "443";
  if (url.protocol !== scheme || !defaultPort || !url.hostname.endsWith(suffix)) {
    throw new ViewerError("ENDPOINT_UNEXPECTED");
  }
  return endpoint;
}

/** The part of an AWS `IceServer` that the viewer reads. */
export interface IceServerLike {
  readonly Uris?: readonly string[] | undefined;
  readonly Username?: string | undefined;
  readonly Password?: string | undefined;
}

/**
 * One TURN or TURNS URI of KVS: a host under the KVS suffix, an optional port and an optional transport. The region
 * is captured so that the caller can compare it with the session region.
 */
const TURN_URI =
  /^turns?:([a-z0-9.-]+)\.kinesisvideo\.([a-z0-9-]+)\.amazonaws\.com:\d{1,5}(\?transport=(udp|tcp))?$/;

/**
 * Returns the STUN URL of the KVS endpoint of a region.
 *
 * @param region - The session region.
 * @returns The `stun:` URL on port 443, as KVS documents it.
 */
export function stunUrl(region: Region): string {
  return `stun:stun.kinesisvideo.${region}.amazonaws.com:443`;
}

/**
 * Tells whether a TURN URI points at a KVS host of the given region.
 *
 * @param uri - A URI from the AWS answer.
 * @param region - The session region.
 * @returns True when the URI matches the KVS TURN shape and names that region.
 */
function isKvsTurnUri(uri: string, region: Region): boolean {
  const match = TURN_URI.exec(uri);
  return match !== null && match[2] === region;
}

/**
 * Converts one AWS ICE server to an RTC entry, or to nothing when it is not usable. An entry is kept only with
 * credentials and with every URI pointing at KVS: one foreign URI makes the whole entry suspect, so it is dropped
 * as a unit.
 *
 * @param server - The AWS ICE server.
 * @param region - The session region.
 * @returns Zero or one RTC entry.
 */
function toTurnEntry(server: IceServerLike, region: Region): RTCIceServer[] {
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
 * @param region - The session region.
 * @param list - The `IceServerList` of the AWS answer, if any.
 * @returns The ICE servers to pass to `new RTCPeerConnection`.
 */
export function buildIceServers(
  region: Region,
  list: readonly IceServerLike[] | undefined,
): RTCIceServer[] {
  const turn = (list ?? []).flatMap((server) => toTurnEntry(server, region));
  return [{ urls: stunUrl(region) }, ...turn];
}

/** Candidates kept while the answer is being applied. A real master sends far fewer. */
export const MAX_BUFFERED_CANDIDATES = 64;

/**
 * Keeps the master's candidates until the answer is applied. A candidate can arrive before the answer that it
 * belongs to has been set, and a browser refuses a candidate while it has no remote description. The buffer is
 * bounded, so a flood of candidates cannot grow it without limit.
 */
export class CandidateBuffer<T> {
  private readonly pending = new Map<string, T[]>();
  private readonly applied = new Set<string>();

  /**
   * Receives a candidate. Returns true when the caller must apply it now, because the remote description is set.
   * Otherwise the candidate is kept for {@link remoteDescriptionApplied}. A candidate beyond the bound is dropped.
   *
   * @param key - The sender's key.
   * @param candidate - The candidate.
   * @returns True when the caller applies the candidate now.
   */
  receive(key: string, candidate: T): boolean {
    if (this.applied.has(key)) {
      return true;
    }
    const queue = this.pending.get(key) ?? [];
    if (queue.length < MAX_BUFFERED_CANDIDATES) {
      queue.push(candidate);
      this.pending.set(key, queue);
    }
    return false;
  }

  /**
   * Records that the remote description is set, and returns the kept candidates in arrival order.
   *
   * @param key - The sender's key.
   * @returns The kept candidates, empty when none arrived before the answer.
   */
  remoteDescriptionApplied(key: string): readonly T[] {
    this.applied.add(key);
    const queue = this.pending.get(key) ?? [];
    this.pending.delete(key);
    return queue;
  }

  /** Forgets every sender, when the viewer stops. */
  clear(): void {
    this.pending.clear();
    this.applied.clear();
  }
}

/** The logger shape the SDK expects. */
interface KvsLogger {
  debug(...data: unknown[]): void;
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
}

/**
 * Logger that drops everything. The SDK would otherwise print signed URLs, and those carry the session token.
 */
const SILENT_LOGGER: KvsLogger = {
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
};

/** Static credentials in the form the SDK clients and the signalling client take. */
interface SdkCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

/** Configuration of the vendored signalling client, as the SDK reads it. */
interface KvsSignalingClientConfig {
  readonly channelARN: string;
  readonly channelEndpoint: string;
  readonly credentials: SdkCredentials;
  readonly region: string;
  readonly role: "VIEWER";
  readonly clientId: string;
  readonly systemClockOffset: number;
  readonly logger: KvsLogger;
}

/** A signalling client of the vendored bundle. Only the events the viewer uses are declared. */
interface KvsSignalingClient {
  open(): void;
  close(): void;
  sendSdpOffer(offer: RTCSessionDescription): void;
  sendIceCandidate(candidate: RTCIceCandidate): void;
  on(event: "open", listener: () => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(event: "sdpAnswer", listener: (answer: RTCSessionDescriptionInit) => void): this;
  on(event: "iceCandidate", listener: (candidate: RTCIceCandidateInit) => void): this;
}

/** The part of the vendored SDK global that the viewer uses. */
interface KvsWebRtc {
  readonly VERSION: string;
  readonly SignalingClient: new (config: KvsSignalingClientConfig) => KvsSignalingClient;
}

/**
 * Tells whether a value has the shape of the SDK global.
 *
 * @param value - Anything found on `window.KVSWebRTC`.
 * @returns True for an object with a string `VERSION` and a `SignalingClient` function.
 */
function isKvsWebRtc(value: unknown): value is KvsWebRtc {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "VERSION" in value &&
    typeof value.VERSION === "string" &&
    "SignalingClient" in value &&
    typeof value.SignalingClient === "function"
  );
}

/**
 * Returns the SDK global after checking that it is the pinned version.
 *
 * @param candidate - The value of `window.KVSWebRTC`.
 * @returns The SDK.
 * @throws {ViewerError} `SDK_MISSING` for an absent or malformed global, `SDK_VERSION` for another version.
 */
function checkKvsWebRtc(candidate: unknown): KvsWebRtc {
  if (!isKvsWebRtc(candidate)) {
    throw new ViewerError("SDK_MISSING");
  }
  if (candidate.VERSION !== KVS_WEBRTC_VENDOR.version) {
    throw new ViewerError("SDK_VERSION");
  }
  return candidate;
}

/** The bundle load, shared by every viewer of the page. It is retried after a failure. */
let bundleLoad: Promise<KvsWebRtc> | null = null;

/**
 * Loads the vendored bundle once. The script element carries the pinned Subresource Integrity value, so the browser
 * refuses a changed file before it runs.
 *
 * @returns The checked SDK global.
 * @throws {ViewerError} `SCRIPT_FAILED`, `SDK_MISSING` or `SDK_VERSION`.
 */
function loadKvsWebRtc(): Promise<KvsWebRtc> {
  bundleLoad ??= injectBundle().catch((error: unknown) => {
    bundleLoad = null;
    throw error;
  });
  return bundleLoad;
}

/**
 * Adds the script element and resolves with the checked SDK global once the script has run.
 *
 * @returns The checked SDK global.
 * @throws {ViewerError} `SCRIPT_FAILED` when the script does not load, or the global check errors.
 */
function injectBundle(): Promise<KvsWebRtc> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = KVS_WEBRTC_SCRIPT_PATH;
    script.integrity = KVS_WEBRTC_VENDOR.sha384Integrity;
    script.onload = () => {
      resolve();
    };
    script.onerror = () => {
      // Removed so that a retry adds one fresh element rather than stacking failed ones.
      script.remove();
      reject(new ViewerError("SCRIPT_FAILED"));
    };
    document.head.append(script);
  }).then(() => checkKvsWebRtc(window.KVSWebRTC));
}

/** Channel facts the viewer needs before it opens the signalling client. */
interface ChannelAccess {
  readonly arn: string;
  readonly endpoints: SignalingEndpoints;
  readonly clockOffsetMs: number;
}

/**
 * Resolves the ARN of the robot's channel by its name, then its signalling endpoints.
 *
 * The channel ARN carries the account and a creation stamp that the console does not know, so it is read from AWS
 * by name. The answer is accepted only when its ARN names the channel asked for and sits in the session region.
 *
 * @param credentials - Static credentials for the Kinesis Video client.
 * @param region - The session region.
 * @param channelName - The channel name, built from a validated robot id.
 * @returns The ARN, the endpoints and the clock offset the SDK signs with.
 * @throws {ViewerError} `CHANNEL_UNEXPECTED` or `ENDPOINT_UNEXPECTED`; SDK errors are thrown unchanged.
 */
async function resolveChannel(
  credentials: SdkCredentials,
  region: Region,
  channelName: ThingName,
): Promise<ChannelAccess> {
  const client = new KinesisVideoClient({ region, credentials });
  const described = await client.send(
    new DescribeSignalingChannelCommand({ ChannelName: channelName }),
    { abortSignal: AbortSignal.timeout(AWS_CALL_TIMEOUT_MS) },
  );
  const parsed = KvsChannelArnSchema.safeParse(described.ChannelInfo?.ChannelARN);
  // The name is the segment after the first slash and the region the fourth colon-separated field of the ARN.
  if (
    !parsed.success ||
    parsed.data.split("/")[1] !== channelName ||
    parsed.data.split(":")[3] !== region
  ) {
    throw new ViewerError("CHANNEL_UNEXPECTED");
  }
  const output = await client.send(
    new GetSignalingChannelEndpointCommand({
      ChannelARN: parsed.data,
      SingleMasterChannelEndpointConfiguration: { Protocols: ["WSS", "HTTPS"], Role: "VIEWER" },
    }),
    { abortSignal: AbortSignal.timeout(AWS_CALL_TIMEOUT_MS) },
  );
  return {
    arn: parsed.data,
    endpoints: endpointsByProtocol(output.ResourceEndpointList, region),
    clockOffsetMs: client.config.systemClockOffset,
  };
}

/**
 * Fetches the STUN and TURN servers of the channel for this viewer. TURN credentials expire within minutes, so the
 * call is made for every connection rather than once per session.
 *
 * @param credentials - Static credentials for the signalling client.
 * @param region - The session region.
 * @param access - The channel ARN and HTTPS endpoint from {@link resolveChannel}.
 * @param clientId - The viewer's id, required by KVS for a viewer.
 * @returns The ICE servers to pass to the peer connection.
 */
async function fetchIceServers(
  credentials: SdkCredentials,
  region: Region,
  access: ChannelAccess,
  clientId: string,
): Promise<RTCIceServer[]> {
  const client = new KinesisVideoSignalingClient({
    region,
    endpoint: access.endpoints.https,
    credentials,
  });
  const output = await client.send(
    new GetIceServerConfigCommand({ ChannelARN: access.arn, ClientId: clientId, Service: "TURN" }),
    { abortSignal: AbortSignal.timeout(AWS_CALL_TIMEOUT_MS) },
  );
  return buildIceServers(region, output.IceServerList);
}

/**
 * Copies the three credential fields the SDK needs, so that no other field of the provider's object is passed on.
 *
 * @param credentials - The viewer's credentials.
 * @returns The static credentials.
 */
function toSdkCredentials(credentials: ViewerCredentials): SdkCredentials {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };
}

/**
 * One viewer attempt and its live resources: the peer connection, the signalling client, the timers and the
 * candidates kept while the answer is applied. Stopping it releases all of them; a stopped attempt makes no more
 * callbacks, so a late AWS answer cannot touch an unmounted pane.
 */
class KvsViewerConnection {
  private stopped = false;
  private signaling: KvsSignalingClient | null = null;
  private peer: RTCPeerConnection | null = null;
  private answerTimer: number | null = null;
  private statsTimer: number | null = null;
  private readonly candidates = new CandidateBuffer<RTCIceCandidateInit>();

  /**
   * @param deps - The viewer's dependencies.
   */
  constructor(private readonly deps: ViewerDeps) {}

  /** Starts the connection. The promise is not awaited: every outcome is reported through the callbacks. */
  start(): void {
    void this.connect();
  }

  /**
   * Tells whether the attempt has stopped. Read through a method rather than the field: TypeScript keeps a field
   * narrowed across awaits, so a second check on the field looks always false to the compiler, and the answer
   * does change while an AWS call is in flight.
   *
   * @returns True once {@link stop} has run.
   */
  isStopped(): boolean {
    return this.stopped;
  }

  /** Stops the attempt and releases its resources. Idempotent. */
  stop(): void {
    this.stopped = true;
    this.release();
  }

  /**
   * Runs the AWS steps and opens the peer connection. Each await is followed by a stop check, so a stop during a
   * call leaves nothing behind.
   */
  private async connect(): Promise<void> {
    try {
      const kvs = await loadKvsWebRtc();
      const credentials = toSdkCredentials(await this.deps.credentials());
      if (this.isStopped()) {
        return;
      }
      const access = await resolveChannel(credentials, this.deps.region, this.deps.channelName);
      const clientId = `viewer-${crypto.randomUUID()}`;
      const iceServers = await fetchIceServers(credentials, this.deps.region, access, clientId);
      if (this.isStopped()) {
        return;
      }
      this.open(kvs, { access, clientId, credentials, iceServers });
    } catch {
      this.fail();
    }
  }

  /**
   * Opens the peer connection and the signalling client, and attaches their listeners before the client opens.
   *
   * @param kvs - The checked SDK global.
   * @param setup - The channel access, the client id, the credentials and the ICE servers.
   */
  private open(
    kvs: KvsWebRtc,
    setup: {
      readonly access: ChannelAccess;
      readonly clientId: string;
      readonly credentials: SdkCredentials;
      readonly iceServers: RTCIceServer[];
    },
  ): void {
    const peer = new RTCPeerConnection({
      iceServers: setup.iceServers,
      bundlePolicy: "max-bundle",
    });
    const signaling = new kvs.SignalingClient({
      channelARN: setup.access.arn,
      channelEndpoint: setup.access.endpoints.wss,
      credentials: setup.credentials,
      region: this.deps.region,
      role: "VIEWER",
      clientId: setup.clientId,
      systemClockOffset: setup.access.clockOffsetMs,
      logger: SILENT_LOGGER,
    });
    this.peer = peer;
    this.signaling = signaling;

    peer.addTransceiver("video", { direction: "recvonly" });
    peer.ontrack = (event) => {
      this.deps.video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    };
    peer.onicecandidate = ({ candidate }) => {
      if (candidate !== null) {
        signaling.sendIceCandidate(candidate);
      }
    };
    peer.onconnectionstatechange = () => {
      this.onConnectionState(peer.connectionState);
    };
    signaling.on("open", () => {
      void this.sendOffer();
    });
    signaling.on("sdpAnswer", (answer) => {
      void this.acceptAnswer(answer);
    });
    signaling.on("iceCandidate", (candidate) => {
      this.acceptCandidate(candidate);
    });
    signaling.on("error", () => {
      this.fail();
    });

    this.answerTimer = window.setTimeout(() => {
      this.answerTimer = null;
      this.fail();
    }, ANSWER_TIMEOUT_MS);
    signaling.open();
  }

  /**
   * Reacts to a change of the peer connection state. A `disconnected` path may come back by itself, so the pane
   * keeps trying; a `failed` path ends the attempt.
   *
   * @param state - The new connection state.
   */
  private onConnectionState(state: RTCPeerConnectionState): void {
    switch (state) {
      case "connected":
        this.emit("live");
        this.startStats();
        break;
      case "disconnected":
        this.emit("connecting");
        break;
      case "failed":
        this.fail();
        break;
      default:
        break;
    }
  }

  /** Creates the offer and sends it to the robot. */
  private async sendOffer(): Promise<void> {
    const peer = this.peer;
    const signaling = this.signaling;
    if (peer === null || signaling === null || this.isStopped()) {
      return;
    }
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.localDescription === null) {
        throw new ViewerError("NO_LOCAL_DESCRIPTION");
      }
      signaling.sendSdpOffer(peer.localDescription);
    } catch {
      this.fail();
    }
  }

  /**
   * Applies the robot's answer, then the candidates that arrived before it.
   *
   * @param answer - The answer from the robot.
   */
  private async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    this.clearAnswerTimer();
    const peer = this.peer;
    if (peer === null) {
      return;
    }
    try {
      await peer.setRemoteDescription(answer);
    } catch {
      this.fail();
      return;
    }
    if (this.isStopped()) {
      return;
    }
    const kept = this.candidates.remoteDescriptionApplied(MASTER_KEY);
    await Promise.all(kept.map((candidate) => this.addCandidate(peer, candidate)));
  }

  /**
   * Applies a candidate now when the answer is set, and keeps it otherwise.
   *
   * @param candidate - The robot's candidate.
   */
  private acceptCandidate(candidate: RTCIceCandidateInit): void {
    const peer = this.peer;
    if (peer !== null && this.candidates.receive(MASTER_KEY, candidate)) {
      void this.addCandidate(peer, candidate);
    }
  }

  /**
   * Adds one candidate. A refused candidate does not end the attempt: the others may still reach the robot.
   *
   * @param peer - The peer connection.
   * @param candidate - The candidate.
   * @returns A promise that always resolves.
   */
  private addCandidate(peer: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    return peer.addIceCandidate(candidate).then(
      () => undefined,
      () => undefined,
    );
  }

  /** Starts the round-trip sampling once, when the connection is up. */
  private startStats(): void {
    if (this.statsTimer !== null) {
      return;
    }
    this.statsTimer = window.setInterval(() => {
      void this.sampleStats();
    }, STATS_INTERVAL_MS);
  }

  /** Reads one sample and reports the round trip. A failed sample is skipped; the next one is a second away. */
  private async sampleStats(): Promise<void> {
    const peer = this.peer;
    if (peer === null || this.isStopped()) {
      return;
    }
    try {
      const report = await peer.getStats();
      if (this.isStopped()) {
        return;
      }
      const rttMs = roundTripMsFromReport(report.values());
      if (rttMs !== null) {
        this.deps.onStats({ rttMs });
      }
    } catch {
      // Skipped on purpose: a missing sample only leaves the last figure on screen.
    }
  }

  /**
   * Reports a state unless the attempt has stopped.
   *
   * @param state - The state to report.
   */
  private emit(state: ViewerState): void {
    if (!this.isStopped()) {
      this.deps.onState(state);
    }
  }

  /** Ends the attempt after a failure: the pane shows `unavailable` and nothing stays open. */
  private fail(): void {
    if (this.isStopped()) {
      return;
    }
    this.emit("unavailable");
    this.stop();
  }

  /** Clears the answer timer, once an answer arrives or the attempt ends. */
  private clearAnswerTimer(): void {
    if (this.answerTimer !== null) {
      window.clearTimeout(this.answerTimer);
      this.answerTimer = null;
    }
  }

  /** Clears every timer, closes the signalling client and the peer connection, and detaches the video. */
  private release(): void {
    this.clearAnswerTimer();
    if (this.statsTimer !== null) {
      window.clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    this.signaling?.close();
    this.peer?.close();
    this.signaling = null;
    this.peer = null;
    this.candidates.clear();
    this.deps.video.srcObject = null;
  }
}

/**
 * Connects the viewer of a robot's channel to a video element.
 *
 * @param deps - The channel, the credentials, the element and the callbacks.
 * @returns A disposer that stops the attempt and releases its resources. Calling it twice is harmless.
 */
export function connectViewer(deps: ViewerDeps): () => void {
  const connection = new KvsViewerConnection(deps);
  deps.onState("connecting");
  connection.start();
  return () => {
    connection.stop();
  };
}
