/**
 * Typed view of the vendored KVS WebRTC browser bundle (ADR 0026).
 *
 * The bundle is a classic script that sets `window.KVSWebRTC`, and it ships no declarations for the
 * browser. This module declares the subset the page uses, checks that the global is the SDK and is
 * the pinned version, and silences the SDK's own logger: the SDK would print signed URLs, and those
 * carry the session token.
 */
import { VideoPageError } from "../lib/errors";
import { KVS_WEBRTC_VENDOR } from "./vendor-manifest";

declare global {
  interface Window {
    /** Set by the vendored bundle, `kvs-webrtc.min.js`, before the page module runs. */
    KVSWebRTC?: unknown;
  }
}

/** Signaling role of a client on the channel. */
export type KvsRole = "MASTER" | "VIEWER";

/** Temporary credentials handed to the SDK. The SDK signs its requests with them. */
export interface KvsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken: string;
}

/** The logger shape the SDK expects. */
export interface KvsLogger {
  debug(...data: unknown[]): void;
  log(...data: unknown[]): void;
  warn(...data: unknown[]): void;
}

/** Configuration of one signaling client, as the SDK reads it. */
export interface KvsSignalingClientConfig {
  readonly channelARN: string;
  readonly channelEndpoint: string;
  readonly credentials: KvsCredentials;
  readonly region: string;
  readonly role: KvsRole;
  readonly clientId?: string | undefined;
  readonly systemClockOffset?: number | undefined;
  readonly logger?: KvsLogger | undefined;
}

/**
 * A signaling client. Events are the SDK's: `open`, `close`, `error`, `sdpOffer`, `sdpAnswer`,
 * `iceCandidate` and `statusResponse`.
 */
export interface KvsSignalingClient {
  open(): void;
  close(): void;
  sendSdpOffer(offer: RTCSessionDescription, recipientClientId?: string): void;
  sendSdpAnswer(answer: RTCSessionDescription, recipientClientId?: string): void;
  sendIceCandidate(candidate: RTCIceCandidate, recipientClientId?: string): void;
  on(event: "open" | "close", listener: () => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  on(
    event: "sdpOffer",
    listener: (offer: RTCSessionDescriptionInit, remoteClientId: string) => void,
  ): this;
  on(
    event: "sdpAnswer",
    listener: (answer: RTCSessionDescriptionInit, remoteClientId?: string) => void,
  ): this;
  on(
    event: "iceCandidate",
    listener: (candidate: RTCIceCandidateInit, remoteClientId?: string) => void,
  ): this;
  on(event: "statusResponse", listener: (status: unknown) => void): this;
}

/** The part of the SDK global that the pages use. */
export interface KvsWebRtc {
  readonly VERSION: string;
  readonly SignalingClient: new (config: KvsSignalingClientConfig) => KvsSignalingClient;
}

/**
 * Tells whether a value has the shape of the SDK global.
 *
 * @param value - Anything found on `window.KVSWebRTC`.
 * @returns True for an object with a string `VERSION` and a `SignalingClient` function.
 */
export function isKvsWebRtc(value: unknown): value is KvsWebRtc {
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
 * @returns The SDK.
 * @throws {VideoPageError} `KVS_SDK_MISSING` when the global is absent or malformed, and
 *   `KVS_SDK_VERSION` when it is another version than the manifest pins.
 */
export function loadKvsWebRtc(): KvsWebRtc {
  const candidate: unknown = window.KVSWebRTC;
  if (!isKvsWebRtc(candidate)) {
    throw new VideoPageError("KVS_SDK_MISSING");
  }
  if (candidate.VERSION !== KVS_WEBRTC_VENDOR.version) {
    throw new VideoPageError("KVS_SDK_VERSION");
  }
  return candidate;
}

/**
 * Logger that drops everything. It is passed to every client, so that no SDK message reaches the
 * console or a log with a signed URL in it.
 */
export const SILENT_LOGGER: KvsLogger = {
  debug: () => undefined,
  log: () => undefined,
  warn: () => undefined,
};
