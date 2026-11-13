/**
 * Worker entry of the DXF import. It parses the text off the main thread, so a large or hostile file cannot
 * freeze the page, and it replies with the document or with a refusal code only.
 *
 * The worker never sends the text back, and never sends an error message: an unexpected failure becomes the
 * generic `not-dxf` refusal, because a message can echo part of the file.
 */
import { parseDxf } from "./parse-dxf";
import { DxfError, type DxfDocument, type DxfErrorCode } from "./types";

/** Request posted to the worker: the file text. */
export interface DxfRequest {
  readonly text: string;
}

/** Reply of the worker: the parsed document, or the refusal code. */
export type DxfReply =
  | { readonly ok: true; readonly doc: DxfDocument }
  | { readonly ok: false; readonly code: DxfErrorCode };

/** The part of the worker global scope this module uses. Typed here because the DOM library types `self` as a window. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: DxfReply): void;
}

/**
 * Tells whether a message is a request, before it is parsed.
 *
 * @param data - The message data.
 * @returns `true` when the data is an object with a text field.
 */
function isRequest(data: unknown): data is DxfRequest {
  return (
    typeof data === "object" && data !== null && "text" in data && typeof data.text === "string"
  );
}

/**
 * Answers one request: parses the text, or maps the failure to a refusal code.
 *
 * @param data - The message data as received.
 * @returns The reply to post back.
 */
export function answer(data: unknown): DxfReply {
  if (!isRequest(data)) {
    return { ok: false, code: "not-dxf" };
  }
  try {
    return { ok: true, doc: parseDxf(data.text) };
  } catch (error) {
    return { ok: false, code: error instanceof DxfError ? error.code : "not-dxf" };
  }
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (event: MessageEvent<unknown>) => {
  scope.postMessage(answer(event.data));
};
