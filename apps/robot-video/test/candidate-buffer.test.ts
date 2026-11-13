import { describe, expect, it } from "vitest";
import { CandidateBuffer, MAX_BUFFERED_CANDIDATES } from "../src/lib/candidate-buffer";

describe("CandidateBuffer", () => {
  it("keeps the candidates that arrive before the remote description, in arrival order", () => {
    const buffer = new CandidateBuffer<string>();

    expect(buffer.receive("v1", "c1")).toBe(false);
    expect(buffer.receive("v1", "c2")).toBe(false);
    expect(buffer.remoteDescriptionApplied("v1")).toEqual(["c1", "c2"]);
  });

  it("applies a candidate at once once the remote description is applied", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.remoteDescriptionApplied("v1");

    expect(buffer.receive("v1", "c3")).toBe(true);
    expect(buffer.remoteDescriptionApplied("v1")).toEqual([]);
  });

  it("returns the kept candidates once, then nothing", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.receive("v1", "c1");

    expect(buffer.remoteDescriptionApplied("v1")).toEqual(["c1"]);
    expect(buffer.remoteDescriptionApplied("v1")).toEqual([]);
  });

  it("keeps the buffers of different viewers apart", () => {
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
      buffer.receive("v1", index);
    }

    const kept = buffer.remoteDescriptionApplied("v1");
    expect(kept).toHaveLength(MAX_BUFFERED_CANDIDATES);
    expect(kept[0]).toBe(0);
    expect(kept.at(-1)).toBe(MAX_BUFFERED_CANDIDATES - 1);
  });

  it("forgets a viewer, so that its next offer starts buffering again", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.receive("v1", "old");
    buffer.remoteDescriptionApplied("v1");

    buffer.forget("v1");

    expect(buffer.receive("v1", "new")).toBe(false);
    expect(buffer.remoteDescriptionApplied("v1")).toEqual(["new"]);
  });

  it("forgets every viewer when cleared", () => {
    const buffer = new CandidateBuffer<string>();
    buffer.receive("v1", "a");
    buffer.remoteDescriptionApplied("v2");

    buffer.clear();

    expect(buffer.remoteDescriptionApplied("v1")).toEqual([]);
    expect(buffer.receive("v2", "b")).toBe(false);
  });
});
