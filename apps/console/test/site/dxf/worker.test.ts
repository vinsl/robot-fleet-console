/**
 * Worker entry and client: the worker answers with a document or a code; the client refuses a file before
 * reading it, times out a silent worker, and always terminates the worker.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { parseDxfFile, type DxfWorkerPort } from "../../../src/site/dxf/worker-client";
import type { DxfReply } from "../../../src/site/dxf/dxf.worker";
import {
  DXF_LIMITS,
  DxfError,
  type DxfDocument,
  type DxfErrorCode,
} from "../../../src/site/dxf/types";
import { dxf, header, line, section } from "./support";

const SAMPLE_TEXT = dxf(header(4), section("ENTITIES", line("WALLS", [0, 0], [1000, 0])));

/** The global scope the worker module installs its handler on. Stubbed before the module is loaded. */
const workerScope = {
  onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
  postMessage: vi.fn(),
};

/** The worker module, loaded once the global scope exists. */
let workerModule: { answer: (data: unknown) => DxfReply } | null = null;

beforeAll(async () => {
  vi.stubGlobal("self", workerScope);
  workerModule = await import("../../../src/site/dxf/dxf.worker");
});

/**
 * Answers a request with the worker module.
 *
 * @param data - The message data.
 * @returns The reply.
 */
function answer(data: unknown): DxfReply {
  if (workerModule === null) {
    throw new Error("worker module not loaded");
  }
  return workerModule.answer(data);
}

/** A fake worker that records what the client does to it and answers on demand. */
class FakeWorker implements DxfWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = 0;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated += 1;
  }

  /**
   * Delivers a reply as the worker would.
   *
   * @param data - The reply.
   */
  reply(data: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

/**
 * A worker that is created by the client and kept for assertions.
 *
 * @returns The fake and the factory to pass to the client.
 */
function workerFactory(): { worker: FakeWorker; create: () => DxfWorkerPort } {
  const worker = new FakeWorker();
  return { worker, create: () => worker };
}

/**
 * Builds a DXF file of the given name and size.
 *
 * @param name - File name.
 * @param size - Size to report, in bytes.
 * @returns The file.
 */
function dxfFile(name: string, size?: number): File {
  const file = new File([SAMPLE_TEXT], name);
  if (size !== undefined) {
    Object.defineProperty(file, "size", { value: size });
  }
  return file;
}

/**
 * Runs a promise that is expected to reject and returns its reason.
 *
 * @param promise - The promise.
 * @returns The rejection reason.
 */
async function reasonOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("worker answer", () => {
  it("answers a request with the parsed document", () => {
    const reply = answer({ text: SAMPLE_TEXT });

    expect(reply).toMatchObject({ ok: true, doc: { insUnits: 4 } });
  });

  it("answers a refusal with the code only", () => {
    expect(answer({ text: "hello world" })).toEqual({ ok: false, code: "not-dxf" });
    expect(answer({ text: "AutoCAD Binary DXF" })).toEqual({ ok: false, code: "binary" });
  });

  it("answers a malformed message as not DXF", () => {
    expect(answer(null)).toEqual({ ok: false, code: "not-dxf" });
    expect(answer({ text: 42 })).toEqual({ ok: false, code: "not-dxf" });
  });

  it("installs the handler on the worker global scope, and posts the reply", () => {
    workerScope.onmessage?.(new MessageEvent("message", { data: { text: "hello" } }));

    expect(workerScope.postMessage).toHaveBeenCalledWith({ ok: false, code: "not-dxf" });
  });
});

describe("parseDxfFile", () => {
  it("parses a file in the worker and terminates the worker after the reply", async () => {
    const { worker, create } = workerFactory();
    const doc: DxfDocument = { insUnits: 4, layers: [], entities: [], ignored: {} };
    const pending = parseDxfFile(dxfFile("plan.dxf"), { createWorker: create });
    await vi.waitFor(() => {
      expect(worker.posted).toHaveLength(1);
    });

    worker.reply({ ok: true, doc });

    await expect(pending).resolves.toEqual(doc);
    expect(worker.posted[0]).toEqual({ text: SAMPLE_TEXT });
    expect(worker.terminated).toBe(1);
  });

  it("maps a worker refusal to the matching DxfError", async () => {
    const { worker, create } = workerFactory();
    const pending = parseDxfFile(dxfFile("plan.dxf"), { createWorker: create });
    await vi.waitFor(() => {
      expect(worker.posted).toHaveLength(1);
    });

    worker.reply({ ok: false, code: "too-complex" satisfies DxfErrorCode });

    const failure = await reasonOf(pending);
    expect(failure).toBeInstanceOf(DxfError);
    expect(failure).toMatchObject({ code: "too-complex" });
    expect(worker.terminated).toBe(1);
  });

  it("treats an unrecognised reply as not DXF", async () => {
    const { worker, create } = workerFactory();
    const pending = parseDxfFile(dxfFile("plan.dxf"), { createWorker: create });
    await vi.waitFor(() => {
      expect(worker.posted).toHaveLength(1);
    });

    worker.reply({ ok: true, doc: "not an object" });

    await expect(reasonOf(pending)).resolves.toMatchObject({ code: "not-dxf" });
  });

  it("times out and terminates a worker that never answers", async () => {
    vi.useFakeTimers();
    const { worker, create } = workerFactory();
    const pending = parseDxfFile(dxfFile("plan.dxf"), { createWorker: create });
    const failure = reasonOf(pending);

    await vi.advanceTimersByTimeAsync(DXF_LIMITS.timeoutMs);

    await expect(failure).resolves.toMatchObject({ code: "timeout" });
    expect(worker.terminated).toBe(1);
  });

  it("reports a worker crash as too complex, without the browser message", async () => {
    const { worker, create } = workerFactory();
    const pending = parseDxfFile(dxfFile("plan.dxf"), { createWorker: create });
    await vi.waitFor(() => {
      expect(worker.posted).toHaveLength(1);
    });

    // The Node test environment has no ErrorEvent; the client ignores the event, so a plain Event stands in.
    worker.onerror?.(new Event("error") as ErrorEvent);

    await expect(reasonOf(pending)).resolves.toMatchObject({ code: "too-complex" });
    expect(worker.terminated).toBe(1);
  });

  it("refuses with a DxfError when the worker cannot be created at all", async () => {
    const create = (): DxfWorkerPort => {
      throw new Error("Worker blocked by policy");
    };
    await expect(
      reasonOf(parseDxfFile(dxfFile("plan.dxf"), { createWorker: create })),
    ).resolves.toMatchObject({ code: "too-complex" });
  });

  it("refuses a file that is not named .dxf before reading it", async () => {
    const file = dxfFile("plan.txt");
    const text = vi.spyOn(file, "text");

    await expect(reasonOf(parseDxfFile(file))).resolves.toMatchObject({ code: "wrong-type" });
    expect(text).not.toHaveBeenCalled();
  });

  it("refuses a file above the size limit before reading it, and accepts the .DXF extension", async () => {
    const big = dxfFile("plan.dxf", DXF_LIMITS.maxBytes + 1);
    const text = vi.spyOn(big, "text");

    await expect(reasonOf(parseDxfFile(big))).resolves.toMatchObject({ code: "too-large" });
    expect(text).not.toHaveBeenCalled();

    const { worker, create } = workerFactory();
    const upper = parseDxfFile(dxfFile("PLAN.DXF"), { createWorker: create });
    await vi.waitFor(() => {
      expect(worker.posted).toHaveLength(1);
    });
    worker.reply({ ok: false, code: "empty" });
    await expect(reasonOf(upper)).resolves.toMatchObject({ code: "empty" });
  });
});
