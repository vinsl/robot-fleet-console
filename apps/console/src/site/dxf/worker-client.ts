/**
 * Main-thread client of the DXF worker: checks the file, runs the parse in a worker, and gives back the
 * document or a refusal.
 *
 * The file is refused before it is read when its name or size is wrong. The worker is terminated after every
 * outcome, so a hung parse cannot keep a thread busy, and a timer bounds the wait.
 */
import { DXF_LIMITS, DxfError, isDxfErrorCode, type DxfDocument } from "./types";
import type { DxfReply, DxfRequest } from "./dxf.worker";

/** Extension of a DXF file, compared case-insensitively. */
const DXF_EXTENSION = ".dxf";

/** The part of a worker that the client drives. Structural, so a fake can stand in for it in tests. */
export interface DxfWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: DxfRequest): void;
  terminate(): void;
}

/** Injection points of {@link parseDxfFile}. */
interface DxfWorkerDeps {
  /** Creates the worker. Defaults to the module worker of this folder. */
  readonly createWorker?: () => DxfWorkerPort;
}

/**
 * Creates the production worker. The URL is a literal relative to this module, so the build emits the worker
 * as a separate script of the same origin, which the content security policy allows.
 *
 * @returns The worker.
 */
function defaultWorker(): DxfWorkerPort {
  return new Worker(new URL("./dxf.worker.ts", import.meta.url), { type: "module" });
}

/**
 * Reads a reply from the worker. Only the shape of the envelope is checked here: the document is produced by
 * the worker bundled with this client, and the file itself is validated by the parser inside it.
 *
 * @param data - The message data.
 * @returns The reply; an unrecognised message is a refusal.
 */
function readReply(data: unknown): DxfReply {
  if (typeof data !== "object" || data === null || !("ok" in data)) {
    return { ok: false, code: "not-dxf" };
  }
  if (data.ok === true && "doc" in data && typeof data.doc === "object" && data.doc !== null) {
    // The document is not re-validated: it is built by the parser bundled in this same module graph, and only
    // the worker script of this origin can post to this client (CSP `worker-src 'self' blob:`). A forged reply
    // would need script execution on the page already, which no schema here could defend against.
    return { ok: true, doc: data.doc as DxfDocument };
  }
  // A refusal is only trusted when its code is one the UI knows; anything else is a malformed reply.
  if (data.ok === false && "code" in data && isDxfErrorCode(data.code)) {
    return { ok: false, code: data.code };
  }
  return { ok: false, code: "not-dxf" };
}

/**
 * Runs the parse in a worker and waits for its reply.
 *
 * @param text - The file text.
 * @param create - Creates the worker.
 * @returns The parsed document.
 * @throws {DxfError} The refusal code from the worker, `timeout` when the worker does not answer in time, or
 *   `too-complex` when the worker cannot start or fails (an out-of-memory failure on a hostile file looks like
 *   this).
 */
function runInWorker(text: string, create: () => DxfWorkerPort): Promise<DxfDocument> {
  return new Promise<DxfDocument>((resolve, reject) => {
    let worker: DxfWorkerPort;
    try {
      worker = create();
    } catch {
      // A worker that cannot start (blocked by the browser or the policy) is refused like a failed parse, so
      // the caller has one failure path to handle; the file itself is not at fault.
      reject(new DxfError("too-complex"));
      return;
    }
    let settled = false;

    const timer = setTimeout(() => {
      settle(() => {
        reject(new DxfError("timeout"));
      });
    }, DXF_LIMITS.timeoutMs);

    const settle = (outcome: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      outcome();
    };

    worker.onmessage = (event: MessageEvent<unknown>) => {
      const reply = readReply(event.data);
      settle(() => {
        if (reply.ok) {
          resolve(reply.doc);
        } else {
          reject(new DxfError(reply.code));
        }
      });
    };
    worker.onerror = () => {
      settle(() => {
        reject(new DxfError("too-complex"));
      });
    };
    worker.postMessage({ text });
  });
}

/**
 * Reads a DXF file and parses it in a worker.
 *
 * @param file - The file the operator chose or dropped.
 * @param deps - Injection points, empty in production.
 * @returns The parsed document.
 * @throws {DxfError} `wrong-type` for a file that is not named `.dxf`, `too-large` above the size limit (both
 *   before the file is read), and the refusal codes of the parser.
 */
export async function parseDxfFile(file: File, deps: DxfWorkerDeps = {}): Promise<DxfDocument> {
  if (!file.name.toLowerCase().endsWith(DXF_EXTENSION)) {
    throw new DxfError("wrong-type");
  }
  if (file.size > DXF_LIMITS.maxBytes) {
    throw new DxfError("too-large");
  }
  const text = await file.text();
  return runInWorker(text, deps.createWorker ?? defaultWorker);
}
