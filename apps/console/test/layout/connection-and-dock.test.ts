/**
 * Pure rules of the shell: which connection visual applies to a realtime state, and which dock entries a role
 * sees. Both decide what the operator reads, so both are pinned here.
 */
import { describe, expect, it } from "vitest";
import { connectionStatusOf } from "../../src/layout/connection";
import { dockItemsFor } from "../../src/layout/dock-items";
import type { WsState } from "../../src/ws/ws-client";

describe("connectionStatusOf", () => {
  it.each<[WsState, string]>([
    ["open", "live"],
    ["connecting", "reconnecting"],
    ["reconnecting", "reconnecting"],
    ["idle", "offline"],
    ["closed", "offline"],
  ])("maps %s to %s", (state, expected) => {
    expect(connectionStatusOf(state)).toBe(expected);
  });
});

describe("dockItemsFor", () => {
  const ids = (role: Parameters<typeof dockItemsFor>[0]): string[] =>
    dockItemsFor(role).map((item) => item.id);

  it("shows the administration entries to Admin only", () => {
    expect(ids("Admin")).toEqual(["fleet", "alerts", "kpi", "audit", "robots", "site"]);
    expect(ids("Operator")).toEqual(["fleet", "alerts", "kpi", "audit", "robots"]);
    expect(ids("Viewer")).toEqual(["fleet", "alerts", "kpi", "audit", "robots"]);
  });

  it("shows nothing without a role", () => {
    expect(ids(null)).toEqual([]);
  });
});
