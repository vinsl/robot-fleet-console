/**
 * Master controller: shares the webcam of the robot with the viewers of its channel.
 *
 * Lifecycle: starting (camera, then channel access), live (up to three viewers), then stopped. Every
 * stop path (Stop, page hide, expiry, camera loss, agent loss, channel gone) goes through `stopRun`,
 * which cancels a start in progress, closes every peer connection, the signaling client and the
 * camera, so that nothing outlives the run. The session lives in closure variables only.
 */
import {
  createSignalingClient,
  fetchIceServers,
  resolveChannelAccess,
  type ChannelAccess,
} from "./kvs/aws";
import type { KvsSignalingClient, KvsWebRtc } from "./kvs/kvs-webrtc";
import { t, type MessageKey } from "./i18n";
import { CandidateBuffer } from "./lib/candidate-buffer";
import { isChannelGone, VideoPageError } from "./lib/errors";
import { pickFresherSession, type RunSession } from "./lib/session";
import { MAX_VIEWERS, ViewerSlots } from "./lib/viewers";
import { describeFailure, setStatus, startCountdown } from "./ui/dom";

/** Upper bound of the video bitrate per viewer, in bits per second (FR-VID-1). */
const MAX_VIDEO_BITRATE_BPS = 1_500_000;

/** Upper bound of the frame rate per viewer, in frames per second (FR-VID-1). */
const MAX_FRAMERATE = 15;

/** Delays before each signaling reconnection attempt, in milliseconds. KVS closes idle sockets. */
const RECONNECT_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];

/** Below this much session time left, a signaling drop is not retried: the session is ending. */
const MIN_SESSION_LEFT_FOR_RETRY_MS = 60_000;

/** Camera request preferred by the page: 720p at 15 frames per second. */
const PREFERRED_CAMERA: MediaStreamConstraints = {
  audio: false,
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: MAX_FRAMERATE, max: MAX_FRAMERATE },
  },
};

/** Why a run stops. Each reason has one status line. */
export type StopReason = "stopped" | "expired" | "camera-lost" | "agent-lost" | "channel-gone";

/**
 * A start in progress: from the first camera request until the run is live.
 *
 * It exists before the camera is opened, so that Stop, the page hide and the expiry can cancel it
 * while the browser asks for the camera or the channel is being resolved.
 */
interface StartAttempt {
  readonly stopCountdown: () => void;
  /** The camera, once it is granted, so that a cancel can stop it. */
  stream: MediaStream | null;
  cancelled: boolean;
}

/**
 * Tells whether a start has been cancelled by Stop, the page hide or the expiry.
 *
 * A function rather than a property read: the flag is set during an await, and TypeScript would
 * otherwise keep the narrowing it had before the await and reject a correct check.
 *
 * @param attempt - The start in progress.
 * @returns True once the start has been cancelled.
 */
function isCancelled(attempt: StartAttempt): boolean {
  return attempt.cancelled;
}

/** One live run: the session, its channel access, the camera and the connections. */
interface ActiveRun {
  /** The session in use. A refresh replaces it while the run lives. */
  session: RunSession;
  readonly access: ChannelAccess;
  readonly stream: MediaStream;
  client: KvsSignalingClient | null;
  /** Peer connections, by viewer id. Each one belongs to the current ticket of its viewer. */
  readonly peers: Map<string, RTCPeerConnection>;
  /** Slots taken by offers, pending or connected. The count of admission. */
  readonly viewers: ViewerSlots;
  /** Remote candidates of each viewer, kept until its remote description is applied. */
  readonly candidates: CandidateBuffer<RTCIceCandidateInit>;
  reconnectAttempts: number;
  reconnectTimer: number | null;
  readonly stopCountdown: () => void;
  stopped: boolean;
}

/** Elements of the master part of the page. */
export interface MasterElements {
  readonly status: HTMLElement;
  readonly viewers: HTMLElement;
  readonly expiry: HTMLElement;
  readonly localVideo: HTMLVideoElement;
  readonly captureSettings: HTMLElement;
  readonly stop: HTMLButtonElement;
  readonly retryCamera: HTMLButtonElement;
}

/** What the page needs from the master: start, refresh the credentials, and stop. */
export interface MasterController {
  /**
   * Starts a run with a session accepted by the page. Nothing happens while a run is live.
   *
   * @param session - The session, with credentials that are still valid.
   */
  start(session: RunSession): void;
  /**
   * Replaces the credentials in use by a session that expires later. An earlier session is ignored,
   * so a late refresh never shortens the credentials.
   *
   * @param next - The refreshed session from the agent.
   */
  refreshSession(next: RunSession): void;
  /**
   * Stops the run, or cancels a start in progress, and shows the status of the reason.
   *
   * @param reason - Why the run stops.
   */
  stopRun(reason: StopReason): void;
}

/**
 * Returns the message of a failed camera request. Every camera failure is retryable, so the caller
 * shows the retry button for any value this returns.
 *
 * @param error - The value thrown by `getUserMedia`.
 * @returns The key of the sentence to show.
 */
function cameraMessageKey(error: unknown): MessageKey {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
      return "camera.denied";
    case "NotFoundError":
      return "camera.notFound";
    case "NotReadableError":
      return "camera.busy";
    default:
      return "error.generic";
  }
}

/**
 * Returns the name of an error, for the one status line that shows it. Never the message.
 *
 * @param error - The caught value.
 * @returns The error name, or `unknown`.
 */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Opens the camera with the preferred constraints, then with any camera if the browser cannot meet
 * them. The audio track is never requested: the page shares video only.
 *
 * @returns The video-only stream.
 */
async function openCamera(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia(PREFERRED_CAMERA);
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
    throw error;
  }
}

/**
 * Stops every track of a stream.
 *
 * @param stream - The stream to stop.
 */
function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * Mounts the master controller on the page.
 *
 * @param kvs - The vendored SDK, already checked.
 * @param elements - The page elements of the master part.
 * @returns The controller the page drives.
 */
export function mountMaster(kvs: KvsWebRtc, elements: MasterElements): MasterController {
  let current: ActiveRun | null = null;
  let starting: StartAttempt | null = null;
  /** The session in use, from the first start: it survives a failed camera for the retry. */
  let latest: RunSession | null = null;
  /** The one-time retry on `devicechange`, kept so that it can be removed. */
  let deviceRetry: (() => void) | null = null;

  /**
   * Expiry of the session in use, for the countdown. The countdown starts after `latest` is set, so
   * the fallback is never read; it is the epoch so that a missing session can only read as expired.
   *
   * @returns The expiry instant.
   */
  const expiryOf = (): Date => latest?.credentials.expiration ?? new Date(0);

  const updateViewerCount = (run: ActiveRun): void => {
    elements.viewers.textContent = t("viewers", {
      count: run.viewers.size,
      max: MAX_VIEWERS,
    });
  };

  /**
   * Closes one viewer's peer connection and forgets its candidates. The slot is not touched: the
   * caller decides whether the viewer keeps it (replacement) or gives it back (release).
   *
   * @param run - The live run.
   * @param clientId - The viewer's id.
   */
  const closePeer = (run: ActiveRun, clientId: string): void => {
    run.candidates.forget(clientId);
    const peer = run.peers.get(clientId);
    if (peer !== undefined) {
      run.peers.delete(clientId);
      peer.close();
    }
    updateViewerCount(run);
  };

  /**
   * Gives back the slot of one offer and closes its connection.
   *
   * If a newer offer from the same viewer has taken the reservation, the slot and the connection
   * belong to that offer: only `peer`, which is this offer's connection, is closed.
   *
   * @param run - The live run.
   * @param clientId - The viewer's id.
   * @param ticket - The ticket of the offer that gives its slot back.
   * @param peer - The connection of that offer, if it has created one.
   */
  const releaseViewer = (
    run: ActiveRun,
    clientId: string,
    ticket: symbol,
    peer: RTCPeerConnection | null,
  ): void => {
    peer?.close();
    if (run.viewers.release(clientId, ticket)) {
      closePeer(run, clientId);
    }
    updateViewerCount(run);
  };

  /**
   * Applies one remote candidate to a viewer's peer connection. A refusal is a note, not a failure.
   *
   * @param run - The live run.
   * @param clientId - The viewer's id.
   * @param candidate - The candidate, from the signaling channel or from the buffer.
   */
  const applyCandidate = (
    run: ActiveRun,
    clientId: string,
    candidate: RTCIceCandidateInit,
  ): void => {
    const peer = run.peers.get(clientId);
    if (peer === undefined) {
      return;
    }
    peer.addIceCandidate(candidate).catch(() => {
      // A candidate that arrives after the run stopped is expected to fail: the stop status stays.
      if (!run.stopped) {
        setStatus(elements.status, "working", t("status.candidateRefused"));
      }
    });
  };

  /** Removes the one-time retry on `devicechange`, if it is armed. */
  const disarmDeviceRetry = (): void => {
    if (deviceRetry !== null) {
      navigator.mediaDevices.removeEventListener("devicechange", deviceRetry);
      deviceRetry = null;
    }
  };

  /** Shows the retry button and retries once when the device list changes (a camera replugged). */
  const offerCameraRetry = (): void => {
    elements.retryCamera.hidden = false;
    disarmDeviceRetry();
    const listener = (): void => {
      deviceRetry = null;
      retryCamera();
    };
    deviceRetry = listener;
    navigator.mediaDevices.addEventListener("devicechange", listener, { once: true });
  };

  /** Starts again with the session in use, after a camera failure. */
  const retryCamera = (): void => {
    disarmDeviceRetry();
    elements.retryCamera.hidden = true;
    if (latest !== null && current === null && starting === null) {
      void start(latest);
    }
  };

  /**
   * Stops the run, or cancels a start in progress: every connection, the signaling client and the
   * camera. The status line shows the reason.
   *
   * @param reason - Why the run stops.
   */
  const stopRun = (reason: StopReason): void => {
    const attempt = starting;
    const run = current;
    starting = null;
    current = null;
    disarmDeviceRetry();
    elements.retryCamera.hidden = true;
    if (attempt !== null) {
      attempt.cancelled = true;
      attempt.stopCountdown();
      if (attempt.stream !== null) {
        stopTracks(attempt.stream);
      }
    }
    if (run !== null) {
      run.stopped = true;
      if (run.reconnectTimer !== null) {
        window.clearTimeout(run.reconnectTimer);
      }
      run.stopCountdown();
      for (const clientId of [...run.peers.keys()]) {
        closePeer(run, clientId);
      }
      run.viewers.clear();
      run.candidates.clear();
      updateViewerCount(run);
      run.client?.close();
      stopTracks(run.stream);
    }
    elements.localVideo.srcObject = null;
    elements.expiry.textContent = "";
    elements.captureSettings.textContent = "";
    switch (reason) {
      case "expired":
        setStatus(elements.status, "error", t("status.sessionExpired"));
        break;
      case "camera-lost":
        setStatus(elements.status, "error", t("camera.lost"));
        break;
      case "agent-lost":
        setStatus(elements.status, "error", t("status.agentLost"));
        break;
      case "channel-gone":
        setStatus(elements.status, "error", t("status.channelGone"));
        break;
      case "stopped":
        setStatus(elements.status, "idle", t("status.stopped"));
        break;
    }
  };

  /**
   * Ends a start that failed: the camera is released, the countdown stops and the status shows why.
   *
   * @param attempt - The start that failed.
   * @param message - The status line to show, already translated.
   * @param cameraFailed - True when the camera caused the failure, so a retry is offered.
   */
  const failStart = (attempt: StartAttempt, message: string, cameraFailed: boolean): void => {
    attempt.cancelled = true;
    if (starting === attempt) {
      starting = null;
    }
    attempt.stopCountdown();
    if (attempt.stream !== null) {
      stopTracks(attempt.stream);
    }
    elements.expiry.textContent = "";
    setStatus(elements.status, "error", message);
    if (cameraFailed) {
      offerCameraRetry();
    }
  };

  /**
   * Schedules a new signaling client after a drop, while the session still has time left.
   *
   * @param run - The live run.
   */
  const scheduleReconnect = (run: ActiveRun): void => {
    const remainingMs = run.session.credentials.expiration.getTime() - Date.now();
    if (run.stopped || remainingMs <= MIN_SESSION_LEFT_FOR_RETRY_MS) {
      return;
    }
    const delay = RECONNECT_DELAYS_MS.at(run.reconnectAttempts);
    if (delay === undefined) {
      setStatus(elements.status, "error", t("status.signallingLost"));
      return;
    }
    run.reconnectAttempts += 1;
    setStatus(
      elements.status,
      "working",
      t("status.reconnecting", {
        attempt: run.reconnectAttempts,
        max: RECONNECT_DELAYS_MS.length,
      }),
    );
    run.reconnectTimer = window.setTimeout(() => {
      run.reconnectTimer = null;
      if (!run.stopped) {
        connectSignaling(run);
      }
    }, delay);
  };

  /**
   * Applies the sender tuning: at most 1.5 Mbit/s and 15 frames per second.
   *
   * Browsers may refuse the change; that is not fatal, so the failure is shown as a note only.
   *
   * @param peer - The peer connection of one viewer.
   */
  const tuneSender = async (peer: RTCPeerConnection): Promise<void> => {
    const sender = peer.getSenders().find((candidate) => candidate.track?.kind === "video");
    if (sender === undefined) {
      return;
    }
    try {
      const parameters = sender.getParameters();
      const first = parameters.encodings[0];
      if (first === undefined) {
        return;
      }
      parameters.encodings[0] = {
        ...first,
        maxBitrate: MAX_VIDEO_BITRATE_BPS,
        maxFramerate: MAX_FRAMERATE,
      };
      await sender.setParameters(parameters);
    } catch (error: unknown) {
      setStatus(
        elements.status,
        "working",
        t("status.senderTuningSkipped", { name: errorName(error) }),
      );
    }
  };

  /**
   * Answers one viewer's offer with a peer connection of its own.
   *
   * The slot is reserved before the first await, so offers that arrive together cannot exceed the
   * limit, and a pending reservation counts in the viewer count. A failure, or a newer offer from
   * the same viewer, affects this viewer's connection only; the other viewers keep their media.
   *
   * @param run - The live run.
   * @param offer - The viewer's offer.
   * @param clientId - The viewer's id.
   */
  const handleOffer = async (
    run: ActiveRun,
    offer: RTCSessionDescriptionInit,
    clientId: string,
  ): Promise<void> => {
    const reservation = run.viewers.reserve(clientId);
    if (reservation.decision === "reject") {
      setStatus(elements.status, "error", t("status.viewerRefused", { max: MAX_VIEWERS }));
      return;
    }
    if (reservation.decision === "replace") {
      closePeer(run, clientId);
    }
    updateViewerCount(run);
    const { ticket } = reservation;
    // Once the run stops or a newer offer from this viewer takes the reservation, the path that
    // did so has already closed this offer's connection, so this offer only returns.
    const isLive = (): boolean => !run.stopped && run.viewers.isCurrent(clientId, ticket);

    // Kept outside the try, so that a failure closes this offer's connection and no other one.
    let created: RTCPeerConnection | null = null;
    try {
      // TURN credentials last about five minutes, so they are fetched for every connection.
      const iceServers = await fetchIceServers(run.session, run.access.endpoints.https);
      if (!isLive()) {
        return;
      }
      const peer = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: "all",
        bundlePolicy: "max-bundle",
      });
      created = peer;
      run.peers.set(clientId, peer);
      peer.onicecandidate = ({ candidate }) => {
        if (candidate !== null) {
          run.client?.sendIceCandidate(candidate, clientId);
        }
      };
      peer.onconnectionstatechange = () => {
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          releaseViewer(run, clientId, ticket, peer);
        }
      };
      for (const track of run.stream.getTracks()) {
        peer.addTrack(track, run.stream);
      }
      await peer.setRemoteDescription(offer);
      if (!isLive()) {
        return;
      }
      for (const candidate of run.candidates.remoteDescriptionApplied(clientId)) {
        applyCandidate(run, clientId, candidate);
      }
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);
      if (peer.localDescription === null) {
        throw new VideoPageError("NO_LOCAL_DESCRIPTION");
      }
      if (!isLive()) {
        return;
      }
      run.client?.sendSdpAnswer(peer.localDescription, clientId);
      await tuneSender(peer);
    } catch (error: unknown) {
      if (!isLive()) {
        created?.close();
        return;
      }
      releaseViewer(run, clientId, ticket, created);
      setStatus(elements.status, "error", describeFailure(error));
    }
  };

  /**
   * Opens a signaling client for the run and registers its listeners. A new client is opened on
   * every reconnection, so it always carries the credentials in use at that moment.
   *
   * @param run - The live run.
   */
  const connectSignaling = (run: ActiveRun): void => {
    const client = createSignalingClient(kvs, run.session, run.access, "MASTER");
    run.client = client;
    client.on("open", () => {
      run.reconnectAttempts = 0;
      setStatus(elements.status, "ok", t("status.waitingViewers"));
    });
    client.on("sdpOffer", (offer, clientId) => {
      void handleOffer(run, offer, clientId);
    });
    client.on("iceCandidate", (candidate, clientId) => {
      // Candidates are kept only for a viewer that holds a slot: nothing else can grow the buffer.
      if (clientId === undefined || !run.viewers.has(clientId)) {
        return;
      }
      if (run.candidates.receive(clientId, candidate)) {
        applyCandidate(run, clientId, candidate);
      }
    });
    client.on("statusResponse", (status) => {
      if (typeof status === "object" && status !== null && "errorType" in status) {
        setStatus(elements.status, "error", t("status.signallingError"));
      }
    });
    client.on("error", (error: unknown) => {
      if (run.client !== client || run.stopped) {
        return;
      }
      if (isChannelGone(error)) {
        stopRun("channel-gone");
        return;
      }
      setStatus(elements.status, "error", t("status.signallingError"));
    });
    client.on("close", () => {
      if (run.client === client) {
        scheduleReconnect(run);
      }
    });
    client.open();
  };

  /**
   * Starts a run: countdown, camera, channel access, signaling. Stop, page hide and expiry can
   * cancel it at any await.
   *
   * @param session - The session accepted by the page.
   */
  const start = async (session: RunSession): Promise<void> => {
    latest = session;
    disarmDeviceRetry();
    elements.retryCamera.hidden = true;
    const attempt: StartAttempt = {
      stream: null,
      cancelled: false,
      stopCountdown: startCountdown(elements.expiry, expiryOf, () => {
        stopRun("expired");
      }),
    };
    starting = attempt;
    setStatus(elements.status, "working", t("status.startingCamera"));

    let stream: MediaStream;
    try {
      stream = await openCamera();
    } catch (error: unknown) {
      if (!isCancelled(attempt)) {
        failStart(attempt, t(cameraMessageKey(error)), true);
      }
      return;
    }
    if (isCancelled(attempt)) {
      stopTracks(stream);
      return;
    }
    attempt.stream = stream;

    let access: ChannelAccess;
    try {
      access = await resolveChannelAccess(session, "MASTER");
    } catch (error: unknown) {
      if (!isCancelled(attempt)) {
        if (isChannelGone(error)) {
          stopRun("channel-gone");
        } else {
          failStart(attempt, describeFailure(error), false);
        }
      }
      return;
    }
    if (isCancelled(attempt)) {
      // Stop already stopped the camera that this attempt holds.
      return;
    }
    starting = null;

    const [videoTrack] = stream.getVideoTracks();
    if (videoTrack !== undefined) {
      videoTrack.contentHint = "motion";
      const settings = videoTrack.getSettings();
      elements.captureSettings.textContent = t("capture", {
        width: settings.width ?? "?",
        height: settings.height ?? "?",
        fps: settings.frameRate ?? "?",
      });
    }
    elements.localVideo.srcObject = stream;

    const run: ActiveRun = {
      session: latest,
      access,
      stream,
      client: null,
      peers: new Map(),
      viewers: new ViewerSlots(),
      candidates: new CandidateBuffer<RTCIceCandidateInit>(),
      reconnectAttempts: 0,
      reconnectTimer: null,
      stopCountdown: attempt.stopCountdown,
      stopped: false,
    };
    current = run;
    updateViewerCount(run);
    setStatus(elements.status, "working", t("status.connectingSignalling"));
    videoTrack?.addEventListener("ended", () => {
      // A track that ends (camera unplugged or taken by another app) ends the run. The check keeps
      // a late event from an earlier run from stopping this one.
      if (current === run) {
        stopRun("camera-lost");
      }
    });
    connectSignaling(run);
  };

  elements.stop.addEventListener("click", () => {
    stopRun("stopped");
  });
  elements.retryCamera.addEventListener("click", () => {
    retryCamera();
  });
  window.addEventListener("pagehide", () => {
    stopRun("stopped");
  });

  return {
    start: (session: RunSession): void => {
      void start(session);
    },
    refreshSession: (next: RunSession): void => {
      if (latest === null) {
        return;
      }
      latest = pickFresherSession(latest, next);
      if (current !== null) {
        current.session = latest;
      }
    },
    stopRun,
  };
}
