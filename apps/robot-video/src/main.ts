/**
 * Entry point of the video page: the claim, the session, the master and the status poller.
 *
 * The page runs the state machine of the design (ADR 0036): it checks the SDK before it claims the
 * one-time token, so a broken build never burns the token; it keeps the session key and the
 * credentials in closure variables only; and it stops for good whenever the agent stops answering.
 * The page has no path that sends a robot command: it calls the three agent routes and nothing else.
 */
import type { VideoStatus } from "@mfc/protocol";
import { loadKvsWebRtc, type KvsWebRtc } from "./kvs/kvs-webrtc";
import { mountMaster, type MasterController } from "./master";
import { applyLocale, isMessageKey, t, type MessageKey } from "./i18n";
import {
  createAgentApi,
  readClaimFromHash,
  type AgentApi,
  type ApiError,
} from "./lib/claim-client";
import { messageKeyForProblem } from "./lib/problem-kinds";
import {
  isExpired,
  needsRefresh,
  pickFresherSession,
  toRunSession,
  type RunSession,
} from "./lib/session";
import { startStatusPoller, type LostReason } from "./lib/status-poller";
import { renderBanner } from "./ui/banner";
import { byId, describeFailure, setStatus } from "./ui/dom";

/** Delays between two attempts to load the session while the credentials are unavailable, in ms. */
const LOAD_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000];

/** Delay between two load attempts once the list above is exhausted, in milliseconds. */
const LOAD_RETRY_STEADY_MS = 30_000;

/** Delays between two refreshes of the credentials that fail, in milliseconds. */
const REFRESH_RETRY_DELAYS_MS = [5_000, 10_000, 20_000];

/** Delay between two refreshes once the list above is exhausted, in milliseconds. */
const REFRESH_RETRY_STEADY_MS = 30_000;

/** Problem type the agent sends while its credentials provider has no credentials yet. */
const CREDENTIALS_UNAVAILABLE = "urn:mfc:problem:credentials-unavailable";

/**
 * Returns the delay before the next attempt to load the session.
 *
 * @param attempt - Zero for the first retry.
 * @returns The delay in milliseconds.
 */
function loadRetryDelay(attempt: number): number {
  return LOAD_RETRY_DELAYS_MS.at(attempt) ?? LOAD_RETRY_STEADY_MS;
}

/**
 * Returns the delay before the next attempt to refresh the credentials.
 *
 * @param attempt - Zero for the first retry.
 * @returns The delay in milliseconds; the steady value once the list is exhausted.
 */
function refreshRetryDelay(attempt: number): number {
  return REFRESH_RETRY_DELAYS_MS.at(attempt) ?? REFRESH_RETRY_STEADY_MS;
}

/**
 * Returns the status sentence for a failed request.
 *
 * @param error - The reason the request failed.
 * @returns The key of the sentence to show.
 */
function messageKeyFor(error: ApiError): MessageKey {
  switch (error.kind) {
    case "network":
      return "status.agentLost";
    case "invalid-response":
      return "error.generic";
    case "problem":
      return messageKeyForProblem(error.type);
  }
}

/**
 * Tells whether a failed request means that the credentials are not ready yet.
 *
 * @param error - The reason the request failed.
 * @returns True for the agent's `credentials-unavailable` problem.
 */
function isCredentialsUnavailable(error: ApiError): boolean {
  return error.kind === "problem" && error.type === CREDENTIALS_UNAVAILABLE;
}

/**
 * Writes the translated text of every element that names a message in its `data-i18n` attribute,
 * and of every element whose accessible label is named by `data-i18n-label`.
 *
 * @param root - The document to translate.
 * @throws {Error} When an attribute names a key that does not exist: the page is broken then.
 */
function applyStaticTexts(root: Document): void {
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = element.dataset.i18n ?? "";
    if (!isMessageKey(key)) {
      throw new Error(`unknown message key in the page: ${key}`);
    }
    element.textContent = t(key);
  }
  for (const element of root.querySelectorAll<HTMLElement>("[data-i18n-label]")) {
    const key = element.dataset.i18nLabel ?? "";
    if (!isMessageKey(key)) {
      throw new Error(`unknown message key in the page: ${key}`);
    }
    element.setAttribute("aria-label", t(key));
  }
}

/**
 * Writes the tags of the status: lock held, simulated robot, cloud link down. Each tag is text.
 *
 * @param container - The list that holds the tags.
 * @param status - The latest status.
 */
function renderTags(container: HTMLElement, status: VideoStatus): void {
  const keys: MessageKey[] = [];
  if (status.lockHeld) {
    keys.push("tag.lockHeld");
  }
  if (status.simulated) {
    keys.push("tag.simulated");
  }
  if (!status.connected) {
    keys.push("tag.linkDown");
  }
  container.replaceChildren(
    ...keys.map((key) => {
      const item = document.createElement("li");
      item.textContent = t(key);
      return item;
    }),
  );
}

/**
 * Runs the page after the SDK has been checked: claim, session, master, status.
 *
 * @param kvs - The checked SDK.
 * @param api - The agent's routes.
 * @param token - The one-time token read from the fragment.
 */
function runPage(kvs: KvsWebRtc, api: AgentApi, token: string): void {
  const status = byId("status", HTMLElement);
  const banner = byId("banner", HTMLElement);
  const tags = byId("tags", HTMLElement);
  const master: MasterController = mountMaster(kvs, {
    status,
    viewers: byId("viewers", HTMLElement),
    expiry: byId("expiry", HTMLElement),
    localVideo: byId("local-video", HTMLVideoElement),
    captureSettings: byId("capture-settings", HTMLElement),
    stop: byId("stop", HTMLButtonElement),
    retryCamera: byId("retry-camera", HTMLButtonElement),
  });

  let sessionKey: string | null = null;
  let session: RunSession | null = null;
  let agentGone = false;
  let refreshing = false;
  let refreshAttempt = 0;
  let nextRefreshAt = 0;
  let expiryHandled = false;
  let loadRetryTimer: number | undefined;

  /**
   * Reads the agent-lost flag through a function, so that the flow analysis does not keep the value
   * it had before an `await` (the flag is set by the poller while a request is pending).
   *
   * @returns True once the agent has been lost.
   */
  const isAgentGone = (): boolean => agentGone;

  /**
   * Refreshes the credentials in use. One refresh runs at a time; a failure waits before the next.
   *
   * @returns A promise that settles when the attempt is over.
   */
  const refresh = async (): Promise<void> => {
    if (sessionKey === null || refreshing) {
      return;
    }
    refreshing = true;
    const result = await api.session(sessionKey);
    refreshing = false;
    if (agentGone) {
      return;
    }
    if (result.ok) {
      const next = toRunSession(result.value);
      session = session === null ? next : pickFresherSession(session, next);
      master.refreshSession(next);
      refreshAttempt = 0;
      // A success waits too, so that a session still short of time is never refreshed every second.
      nextRefreshAt = Date.now() + refreshRetryDelay(0);
      return;
    }
    nextRefreshAt = Date.now() + refreshRetryDelay(refreshAttempt);
    refreshAttempt += 1;
  };

  /**
   * Handles one status from the agent: the banner, the tags, and the refresh of the credentials.
   *
   * @param latest - The status just received.
   */
  const onStatus = (latest: VideoStatus): void => {
    renderBanner(banner, latest);
    renderTags(tags, latest);
    if (session === null) {
      return;
    }
    const now = new Date();
    if (needsRefresh(session, now) && Date.now() >= nextRefreshAt) {
      void refresh();
    }
    if (!expiryHandled && isExpired(session, now)) {
      expiryHandled = true;
      master.stopRun("expired");
    }
  };

  /**
   * Stops the run when the agent is lost. The poller has already stopped itself.
   *
   * @param reason - Why the poller gave up.
   */
  const onLost = (reason: LostReason): void => {
    agentGone = true;
    window.clearTimeout(loadRetryTimer);
    master.stopRun("agent-lost");
    if (reason === "unauthorised") {
      setStatus(status, "error", t("error.unauthorised"));
    }
  };

  /**
   * Loads the session and starts the master. Credentials that are not ready yet are retried with
   * the delays of the design; any other refusal is final.
   *
   * @param key - The session key from the claim.
   * @param attempt - Zero for the first load, then the number of retries so far.
   * @returns A promise that settles when the attempt is over.
   */
  const loadSession = async (key: string, attempt: number): Promise<void> => {
    // A retry that fires after the agent was lost must not overwrite the lost or unauthorised status.
    if (isAgentGone()) {
      return;
    }
    setStatus(status, "working", t("status.loadingSession"));
    const result = await api.session(key);
    if (agentGone) {
      return;
    }
    if (result.ok) {
      const next = toRunSession(result.value);
      if (isExpired(next, new Date())) {
        setStatus(status, "error", t("status.sessionExpired"));
        return;
      }
      session = next;
      master.start(next);
      return;
    }
    if (isCredentialsUnavailable(result.error)) {
      setStatus(status, "error", t("status.credentialsUnavailable"));
      loadRetryTimer = window.setTimeout(() => {
        loadRetryTimer = undefined;
        void loadSession(key, attempt + 1);
      }, loadRetryDelay(attempt));
      return;
    }
    setStatus(status, "error", t(messageKeyFor(result.error)));
  };

  /**
   * Exchanges the one-time token for the session key, then starts the poller and loads the session.
   *
   * @returns A promise that settles when the page is running or has stopped.
   */
  const claim = async (): Promise<void> => {
    setStatus(status, "working", t("status.claiming"));
    const result = await api.claim(token);
    if (!result.ok) {
      setStatus(status, "error", t(messageKeyFor(result.error)));
      return;
    }
    sessionKey = result.value.sessionKey;
    startStatusPoller({
      api,
      sessionKey,
      onStatus,
      onLost,
    });
    await loadSession(sessionKey, 0);
  };

  void claim();
}

/**
 * Entry point. A page whose SDK is missing or of another version stops here, before the token is
 * used, so that the operator can build the page again without losing the address.
 */
function main(): void {
  applyLocale(navigator.language);
  applyStaticTexts(document);
  document.title = t("title");

  const status = byId("status", HTMLElement);
  let kvs: KvsWebRtc;
  try {
    kvs = loadKvsWebRtc();
  } catch (error: unknown) {
    setStatus(status, "error", describeFailure(error));
    byId("stop", HTMLButtonElement).disabled = true;
    return;
  }

  const claimToken = readClaimFromHash(window.location.hash);
  if (claimToken === null) {
    setStatus(status, "idle", t("status.waitingClaim"));
    return;
  }
  // The token leaves the address bar before any request is made, so a reload, the history and the
  // Referer header never carry it.
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  const api = createAgentApi(fetch, window.location.origin);
  runPage(kvs, api, claimToken);
}

main();
