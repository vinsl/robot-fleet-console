/**
 * The in-memory storage that replaces localStorage for the authentication library.
 */
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "../../src/auth/memory-storage";

describe("MemoryStorage", () => {
  it("stores, reads, removes and clears values", () => {
    const storage = new MemoryStorage();
    expect(storage.getItem("missing")).toBeNull();

    storage.setItem("token", "value-1");
    expect(storage.getItem("token")).toBe("value-1");

    storage.removeItem("token");
    expect(storage.getItem("token")).toBeNull();

    storage.setItem("a", "1");
    storage.setItem("b", "2");
    storage.clear();
    expect(storage.getItem("a")).toBeNull();
    expect(storage.getItem("b")).toBeNull();
  });

  it("keeps values per instance", () => {
    const first = new MemoryStorage();
    const second = new MemoryStorage();
    first.setItem("key", "only-first");
    expect(second.getItem("key")).toBeNull();
  });
});
