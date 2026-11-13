/**
 * Small DOM helpers for the video page: typed element lookups, the status line and the countdown.
 *
 * A state is shown by a symbol and by its text, never by colour alone. Everything is written with
 * `textContent`, so no value from the network is ever parsed as markup.
 */
import { VideoPageError, type VideoPageErrorCode } from "../lib/errors";
import { t, type MessageKey } from "../i18n";

/** The four states a status line can show. */
export type StatusState = "idle" | "working" | "ok" | "error";

/**
 * Finds an element of the page by id, with its type checked.
 *
 * @param id - The id in the HTML.
 * @param type - The element class the caller expects, for example `HTMLButtonElement`.
 * @returns The element.
 * @throws {Error} When the element is missing or is of another type. The page is broken then, and
 *   the error is for the developer, so it is not a `VideoPageError`.
 */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) {
    throw new Error(`page element #${id} is missing or has the wrong type`);
  }
  return element;
}

/**
 * Returns the symbol that accompanies a state, so that the state is not carried by colour alone.
 *
 * @param state - The state.
 * @returns A single symbol.
 */
function symbolFor(state: StatusState): string {
  switch (state) {
    case "idle":
      return "○";
    case "working":
      return "◐";
    case "ok":
      return "●";
    case "error":
      return "✕";
  }
}

/**
 * Writes a status line: the state in `data-state`, its symbol, then the text.
 *
 * @param element - The status element.
 * @param state - The state shown.
 * @param text - The message, already translated. Plain text only.
 */
export function setStatus(element: HTMLElement, state: StatusState, text: string): void {
  element.dataset.state = state;
  element.textContent = `${symbolFor(state)} ${text}`;
}

/** Message key of each error code of the page. The switch has no default: a new code must be translated. */
function messageKeyFor(code: VideoPageErrorCode): MessageKey {
  switch (code) {
    case "ENDPOINT_UNEXPECTED":
      return "error.endpoint";
    case "KVS_SDK_MISSING":
    case "KVS_SDK_VERSION":
      return "error.sdk";
    case "NO_LOCAL_DESCRIPTION":
      return "error.localDescription";
    case "AWS_CALL_FAILED":
      return "error.awsCall";
  }
}

/**
 * Describes a failure for the status line, in the language of the page, without any value that
 * could carry a secret.
 *
 * A page error shows its translated sentence and, for a failed AWS call, the error name. Any other
 * error shows the generic sentence: its message can quote a request.
 *
 * @param error - The caught value.
 * @returns A short sentence for the operator.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof VideoPageError) {
    return t(
      messageKeyFor(error.code),
      error.code === "AWS_CALL_FAILED" ? { name: error.detail ?? "unknown" } : {},
    );
  }
  return t("error.generic");
}

/**
 * Formats a remaining duration as `mm:ss`, rounding down.
 *
 * @param remainingMs - Milliseconds left, positive.
 * @returns The text, with minutes that may exceed 59.
 */
export function formatRemaining(remainingMs: number): string {
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/** Interval between two countdown updates, in milliseconds. */
const COUNTDOWN_TICK_MS = 1_000;

/**
 * Shows the time left until the credentials expire, and calls back once when they do.
 *
 * The expiry is read at every tick, so a refreshed session moves the countdown with it.
 *
 * @param element - Where the countdown is written.
 * @param expiry - Returns the expiry instant currently in use.
 * @param onExpired - Called once, when the instant is reached. The run stops then.
 * @returns A function that stops the countdown without calling back.
 */
export function startCountdown(
  element: HTMLElement,
  expiry: () => Date,
  onExpired: () => void,
): () => void {
  const tick = (): void => {
    const remainingMs = expiry().getTime() - Date.now();
    if (remainingMs <= 0) {
      window.clearInterval(timer);
      onExpired();
      return;
    }
    element.textContent = t("status.expiresIn", { time: formatRemaining(remainingMs) });
  };
  const timer = window.setInterval(tick, COUNTDOWN_TICK_MS);
  tick();
  return () => {
    window.clearInterval(timer);
  };
}
