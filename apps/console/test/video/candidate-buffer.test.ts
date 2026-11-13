import { describe, expect, it } from "vitest";
import { CandidateBuffer, MAX_BUFFERED_CANDIDATES } from "../../src/video/kvs-viewer";

describe("CandidateBuffer", () => {
  it("keeps the candidates that arrive before the answer, in arrival order", () => {
    const buffer = new CandidateBuffer<string>();

    expect(buffer.receive("master", "c1")).toBe(false);
    expect(buffer.receive("master", "c2")).toBe(false);
    expect(buffer.remoteDescriptionApplied("master")).toEqual(["c1", "c2"]);
  });

  it("applies a candidate at once once the answer is applied", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.remoteDescriptionApplied("master");

    expect(buffer.receive("master", "c3")).toBe(true);
    expect(buffer.remoteDescriptionApplied("master")).toEqual([]);
  });

  it("returns the kept candidates once, then nothing", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.receive("master", "c1");

    expect(buffer.remoteDescriptionApplied("master")).toEqual(["c1"]);
    expect(buffer.remoteDescriptionApplied("master")).toEqual([]);
  });

  it("keeps the buffers of different senders apart", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.receive("v1", "a");
    buffer.receive("v2", "b");

    expect(buffer.remoteDescriptionApplied("v2")).toEqual(["b"]);
    expect(buffer.receive("v1", "c")).toBe(false);
    expect(buffer.remoteDescriptionApplied("v1")).toEqual(["a", "c"]);
  });

  it("drops the candidates beyond the bound, and keeps the first ones", () => {
    const buffer = new CandidateBuffer<number>();
    for (let index = 0; index < MAX_BUFFERED_CANDIDATES + 10; index += 1) {
      buffer.receive("master", index);
    }

    const kept = buffer.remoteDescriptionApplied("master");
    expect(kept).toHaveLength(MAX_BUFFERED_CANDIDATES);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(MAX_BUFFERED_CANDIDATES - 1);
  });

  it("forgets every sender when cleared", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.receive("master", "a");
    buffer.remoteDescriptionApplied("other");

    buffer.clear();

    expect(buffer.remoteDescriptionApplied("master")).toEqual([]);
    expect(buffer.receive("other", "b")).toBe(false);
  });
});
