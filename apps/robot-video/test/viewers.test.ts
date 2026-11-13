import { describe, expect, it } from "vitest";
import { admitViewer, isValidClientId, MAX_VIEWERS, ViewerSlots } from "../src/lib/viewers";

describe("admitViewer", () => {
  it("admits a new valid viewer while there is room", () => {
    expect(admitViewer(new Set(), "viewer-1")).toBe("admit");
    expect(admitViewer(new Set(["a", "b"]), "viewer-3")).toBe("admit");
  });

  it("replaces the connection of a viewer that is already connected", () => {
    expect(admitViewer(new Set(["viewer-1"]), "viewer-1")).toBe("replace");
  });

  it("rejects a new viewer when the master is full", () => {
    const full = new Set(["a", "b", "c"]);

    expect(MAX_VIEWERS).toBe(3);
    expect(admitViewer(full, "viewer-4")).toBe("reject");
  });

  it("still replaces a connected viewer when the master is full", () => {
    expect(admitViewer(new Set(["a", "b", "c"]), "b")).toBe("replace");
  });

  it("honours an explicit limit", () => {
    expect(admitViewer(new Set(["a"]), "b", 1)).toBe("reject");
    expect(admitViewer(new Set(), "b", 1)).toBe("admit");
  });

  it.each(["a b", "", "x".repeat(257), "viewer/1", "viewer:1"])(
    "rejects the invalid client id %j",
    (clientId) => {
      expect(admitViewer(new Set(), clientId)).toBe("reject");
    },
  );
});

describe("isValidClientId", () => {
  it("accepts letters, digits, underscore, dot and dash up to 256 characters", () => {
    expect(isValidClientId("viewer-0_1.a")).toBe(true);
    expect(isValidClientId("x".repeat(256))).toBe(true);
  });

  it("rejects an empty id, an id of 257 characters and any other character", () => {
    expect(isValidClientId("")).toBe(false);
    expect(isValidClientId("x".repeat(257))).toBe(false);
    expect(isValidClientId("a b")).toBe(false);
    expect(isValidClientId("a\n")).toBe(false);
  });
});

describe("ViewerSlots", () => {
  it("admits viewers up to the limit and refuses the next one", () => {
    const slots = new ViewerSlots(2);

    expect(slots.reserve("a").decision).toBe("admit");
    expect(slots.reserve("b").decision).toBe("admit");
    expect(slots.reserve("c")).toEqual({ decision: "reject" });
    expect(slots.size).toBe(2);
    expect(slots.has("c")).toBe(false);
  });

  it("counts a reservation that is still pending, before any connection exists", () => {
    const slots = new ViewerSlots();

    const first = slots.reserve("a");
    expect(first.decision).toBe("admit");
    expect(slots.size).toBe(1);
    expect(slots.has("a")).toBe(true);
    expect(first).toHaveProperty("ticket");
  });

  it("lets only one of several offers that arrive together take the last slot", () => {
    const slots = new ViewerSlots(3);
    const decisions = ["a", "b", "c", "d", "e"].map((id) => slots.reserve(id).decision);

    expect(decisions).toEqual(["admit", "admit", "admit", "reject", "reject"]);
    expect(slots.size).toBe(3);
  });

  it("replaces the reservation of a viewer that is already known, keeping one slot", () => {
    const slots = new ViewerSlots(1);
    const first = slots.reserve("a");
    const second = slots.reserve("a");

    expect(second.decision).toBe("replace");
    expect(slots.size).toBe(1);
    if (first.decision === "reject" || second.decision === "reject") {
      throw new Error("both reservations must be granted");
    }
    expect(second.ticket).not.toBe(first.ticket);
    expect(slots.isCurrent("a", first.ticket)).toBe(false);
    expect(slots.isCurrent("a", second.ticket)).toBe(true);
  });

  it("does not release a slot with the ticket of a replaced reservation", () => {
    const slots = new ViewerSlots();
    const first = slots.reserve("a");
    const second = slots.reserve("a");
    if (first.decision === "reject" || second.decision === "reject") {
      throw new Error("both reservations must be granted");
    }

    expect(slots.release("a", first.ticket)).toBe(false);
    expect(slots.has("a")).toBe(true);
    expect(slots.release("a", second.ticket)).toBe(true);
    expect(slots.has("a")).toBe(false);
  });

  it("frees the slot on release, so that a new viewer can be admitted", () => {
    const slots = new ViewerSlots(1);
    const held = slots.reserve("a");
    expect(slots.reserve("b")).toEqual({ decision: "reject" });
    if (held.decision === "reject") {
      throw new Error("the first reservation must be granted");
    }

    expect(slots.release("a", held.ticket)).toBe(true);
    expect(slots.size).toBe(0);
    expect(slots.reserve("b").decision).toBe("admit");
  });

  it("returns false and changes nothing when releasing an unknown viewer", () => {
    const slots = new ViewerSlots();
    const held = slots.reserve("a");
    if (held.decision === "reject") {
      throw new Error("the reservation must be granted");
    }

    expect(slots.release("zz", held.ticket)).toBe(false);
    expect(slots.size).toBe(1);
  });

  it("makes every ticket stale and frees every slot when cleared", () => {
    const slots = new ViewerSlots();
    const held = slots.reserve("a");
    if (held.decision === "reject") {
      throw new Error("the reservation must be granted");
    }

    slots.clear();

    expect(slots.size).toBe(0);
    expect(slots.isCurrent("a", held.ticket)).toBe(false);
    expect(slots.release("a", held.ticket)).toBe(false);
  });

  it("still refuses an invalid client id, without taking a slot", () => {
    const slots = new ViewerSlots();

    expect(slots.reserve("a b")).toEqual({ decision: "reject" });
    expect(slots.size).toBe(0);
  });
});
