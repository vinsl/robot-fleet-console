/**
 * @vitest-environment jsdom
 */
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../src/i18n";
import i18n from "i18next";
import type { WsState } from "../../src/ws/ws-client";
import { renderStatusLine } from "../support/status-line-harness";
import { resetConsole } from "../support/console-harness";

beforeEach(async () => {
  resetConsole();
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

describe("StatusLine connection", () => {
  it.each<[WsState, string]>([
    ["open", "Live"],
    ["connecting", "Reconnecting…"],
    ["reconnecting", "Reconnecting…"],
    ["closed", "Offline"],
    ["idle", "Offline"],
  ])("shows the text of the %s state", (ws, label) => {
    renderStatusLine({ ws });
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole("status", { name: `Connection: ${label}` })).toBeTruthy();
  });

  it("gives the API latency as the description of the connection", () => {
    renderStatusLine({ ws: "open", api: { ok: true, latencyMs: 42 } });
    const indicator = screen.getByText("Live").closest("span[aria-describedby]");
    const tooltipId = indicator?.getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(tooltipId)?.textContent).toBe("API answers in 42 ms");
  });

  it("says when the API does not answer", () => {
    renderStatusLine({ api: { ok: false, latencyMs: null } });
    expect(screen.getByText("API does not answer")).toBeTruthy();
  });

  it("shows the role and the robot count", () => {
    renderStatusLine({ role: "Operator", robotsOnline: 3 });
    expect(screen.getByText("Operator")).toBeTruthy();
    expect(screen.getByText("3 online")).toBeTruthy();
  });

  it("renders in French", async () => {
    await i18n.changeLanguage("fr");
    renderStatusLine({ ws: "open", role: "Admin", robotsOnline: null });
    expect(screen.getByText("Temps réel")).toBeTruthy();
    expect(screen.getByText("Administrateur")).toBeTruthy();
    expect(screen.getByText("Robots : pas encore de données")).toBeTruthy();
  });
});
