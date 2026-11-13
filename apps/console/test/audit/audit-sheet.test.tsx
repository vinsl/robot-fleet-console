// @vitest-environment jsdom
// @vitest-environment jsdom
/**
 * The audit sheet: rows show the result with an icon and a text, the correlation identifier is in the monospace
 * code element, and "Load more" fetches the next page with its cursor.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEMO_SITE_ID, type AuditRecord, type Role } from "@mfc/protocol";
import "../../src/i18n";
import { AuditSheet } from "../../src/audit/AuditSheet";
import { useFleetStore } from "../../src/live/fleet-store";
import { robotOf } from "../live/support";
import {
  renderAlerts,
  resetAlertsState,
  signIn,
  type CannedResponse,
  type RecordedRequest,
} from "../alerts/alerts-harness";

/** A subject whose last four hexadecimal characters are `3f9a`. */
const OPERATOR_SUB = "9b1e0c2a-5d7f-4a6b-8c3e-1d2f3e4a3f9a";

/** A command the operator ran and the robot accepted. */
const SUCCEEDED: AuditRecord = {
  auditId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9d",
  ts: "2026-11-04T10:00:00.000Z",
  siteId: DEMO_SITE_ID,
  robotId: "sim-01",
  actor: OPERATOR_SUB,
  actorSource: "mfc.jwt",
  action: "command.pause",
  commandId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9e",
  result: "SUCCEEDED",
  correlationId: "corr-0001-abcd",
};

/** A command the cloud refused because the caller did not hold the lock. */
const REFUSED: AuditRecord = {
  auditId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c9f",
  ts: "2026-11-04T09:58:00.000Z",
  siteId: DEMO_SITE_ID,
  robotId: "sim-02",
  actor: OPERATOR_SUB,
  actorSource: "mfc.jwt",
  action: "command.resume",
  commandId: "0190a7c4-5b1e-7d2a-9c3f-4e5d6a7b8c90",
  result: "REFUSED",
  problemType: "lock-not-held",
  correlationId: "corr-0002-abcd",
};

/**
 * Answers the audit list from a page map keyed by cursor, the empty cursor being the first page.
 *
 * @param pages - Response of each page, by the cursor that requests it.
 * @returns The responder.
 */
function auditResponder(
  pages: Readonly<Record<string, CannedResponse>>,
): (request: RecordedRequest) => CannedResponse {
  return (request) => {
    const cursor = new URL(request.url).searchParams.get("cursor") ?? "";
    // A Map, not an index lookup: the cursor comes from the response, so it is not trusted as a key.
    return new Map(Object.entries(pages)).get(cursor) ?? { status: 500, body: {} };
  };
}

beforeEach(async () => {
  await resetAlertsState();
});

afterEach(() => {
  cleanup();
  useFleetStore.setState({ robots: {} });
});

/**
 * Answers the audit list by its outcome filter: the records of `result`, or the default page when no outcome is set.
 *
 * @param byResult - The records to answer with, by outcome filter.
 * @returns The responder.
 */
function filteredResponder(
  byResult: Readonly<Record<string, CannedResponse>>,
): (request: RecordedRequest) => CannedResponse {
  return (request) => {
    const result = new URL(request.url).searchParams.get("result") ?? "";
    return (
      new Map(Object.entries(byResult)).get(result) ?? { status: 200, body: { items: [SUCCEEDED] } }
    );
  };
}

describe("AuditSheet", () => {
  it("audit-rows-render-with-result-icon-and-text", async () => {
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: auditResponder({
        "": { status: 200, body: { items: [SUCCEEDED, REFUSED] } },
      }),
    });

    // The filter bar names the outcomes too, so the table is searched on its own.
    const table = await screen.findByRole("region", { name: "Audited actions" });
    const refused = within(table).getByText("Refused");
    expect(within(table).getByText("Succeeded")).toBeTruthy();
    // The result is an icon and a text: the icon is an SVG next to the label, never the colour alone.
    expect(refused.parentElement?.querySelector("svg")).not.toBeNull();

    const correlation = screen.getByText("corr-0001-abcd");
    expect(correlation.tagName).toBe("CODE");
    // The subject is shown as the holder label only, never as the full identifier.
    expect(screen.getAllByText("Operator 3f9a")).toHaveLength(2);
    expect(screen.queryByText(OPERATOR_SUB)).toBeNull();
    expect(screen.getByText("sim-01")).toBeTruthy();
  });

  it("audit-load-more", async () => {
    const user = userEvent.setup();
    signIn({ role: "Operator", userId: OPERATOR_SUB });
    const { requests } = renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: auditResponder({
        "": { status: 200, body: { items: [SUCCEEDED], nextCursor: "page_2-cursor" } },
        "page_2-cursor": { status: 200, body: { items: [REFUSED] } },
      }),
    });

    await screen.findByText("corr-0001-abcd");
    expect(requests[0]?.url).toContain("limit=50");
    expect(screen.queryByText("corr-0002-abcd")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("corr-0002-abcd")).toBeTruthy();
    expect(requests[1]?.url).toContain("cursor=page_2-cursor");
    // No next cursor on the last page, so the button goes away.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    });
  });

  it.each<Role>(["Viewer", "Operator", "Admin"])(
    "audit-readable-by-every-role (%s)",
    async (role) => {
      signIn({ role, userId: OPERATOR_SUB });
      renderAlerts(<AuditSheet />, {
        route: "/audit",
        respond: auditResponder({ "": { status: 200, body: { items: [SUCCEEDED] } } }),
      });
      expect(await screen.findByText("corr-0001-abcd")).toBeTruthy();
    },
  );
});

describe("AuditSheet filters", () => {
  it("pressing Refused fetches the refused records and marks the outcome as pressed", async () => {
    const user = userEvent.setup();
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    const { requests } = renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: filteredResponder({ REFUSED: { status: 200, body: { items: [REFUSED] } } }),
    });
    await screen.findByText("corr-0001-abcd");
    expect(screen.getByRole("button", { name: "Refused" }).getAttribute("aria-pressed")).toBe(
      "false",
    );

    await user.click(screen.getByRole("button", { name: "Refused" }));

    expect(await screen.findByText("corr-0002-abcd")).toBeTruthy();
    expect(requests[1]?.url).toContain("result=REFUSED");
    expect(screen.getByRole("button", { name: "Refused" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByText("corr-0001-abcd")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Showing: All robots, Refused");
  });

  it("selects a robot and sends it with the request", async () => {
    const user = userEvent.setup();
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    useFleetStore.setState({
      robots: {
        "sim-02": robotOf({ robotId: "sim-02", lastHeardAt: Date.now() }),
        "sim-01": robotOf({ robotId: "sim-01", lastHeardAt: Date.now() }),
      },
    });
    const { requests } = renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: auditResponder({ "": { status: 200, body: { items: [SUCCEEDED] } } }),
    });
    await screen.findByText("corr-0001-abcd");

    await user.selectOptions(screen.getByLabelText("Robot"), "sim-02");

    await waitFor(() => {
      expect(requests.at(-1)?.url).toContain("robotId=sim-02");
    });
    expect(screen.getByRole("status").textContent).toBe("Showing: sim-02, All");
  });

  it("an empty page with a next page offers the search, which loads the next page", async () => {
    const user = userEvent.setup();
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    const { requests } = renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: (request) => {
        const url = new URL(request.url);
        if (url.searchParams.get("result") !== "REFUSED") {
          return { status: 200, body: { items: [SUCCEEDED] } };
        }
        return url.searchParams.get("cursor") === "older-cursor"
          ? { status: 200, body: { items: [REFUSED] } }
          : { status: 200, body: { items: [], nextCursor: "older-cursor" } };
      },
    });
    await screen.findByText("corr-0001-abcd");

    await user.click(screen.getByRole("button", { name: "Refused" }));

    expect(await screen.findByText("No matching record in the records read so far.")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Search older records" }));

    expect(await screen.findByText("corr-0002-abcd")).toBeTruthy();
    expect(requests.at(-1)?.url).toContain("cursor=older-cursor");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Search older records" })).toBeNull();
    });
  });

  it("an empty last page with a filter says that no record matches", async () => {
    const user = userEvent.setup();
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: filteredResponder({ FAILED: { status: 200, body: { items: [] } } }),
    });
    await screen.findByText("corr-0001-abcd");

    await user.click(screen.getByRole("button", { name: "Failed" }));

    expect(await screen.findByText("No record matches these filters.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Search older records" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("Clear filters resets the outcome and the trail to the unfiltered first page", async () => {
    const user = userEvent.setup();
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    const { requests } = renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: filteredResponder({ REFUSED: { status: 200, body: { items: [REFUSED] } } }),
    });
    await screen.findByText("corr-0001-abcd");
    await user.click(screen.getByRole("button", { name: "Refused" }));
    await screen.findByText("corr-0002-abcd");

    await user.click(screen.getByRole("button", { name: "Clear filters" }));

    expect(await screen.findByText("corr-0001-abcd")).toBeTruthy();
    expect(requests.at(-1)?.url).not.toContain("result=");
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
    expect(screen.getByRole("button", { name: "Refused" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
  });
});

describe("AuditSheet states", () => {
  it("shows the loading state until the first page arrives", async () => {
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: auditResponder({ "": { status: 200, body: { items: [SUCCEEDED] } } }),
    });
    expect(screen.getByRole("status").textContent).toBe("Loading the audit trail…");
    expect(await screen.findByText("corr-0001-abcd")).toBeTruthy();
  });

  it("shows the error with a retry that refetches the first page", async () => {
    const user = userEvent.setup();
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    let calls = 0;
    const { requests } = renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: () => {
        calls += 1;
        return calls === 1
          ? { status: 500, body: {} }
          : { status: 200, body: { items: [SUCCEEDED] } };
      },
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The audit trail could not be loaded.");

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText("corr-0001-abcd")).toBeTruthy();
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).not.toContain("cursor=");
  });

  it("shows the empty message when the trail has no record", async () => {
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: auditResponder({ "": { status: 200, body: { items: [] } } }),
    });
    expect(await screen.findByText("No audited action yet.")).toBeTruthy();
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("names the table distinctly from the sheet title", async () => {
    signIn({ role: "Viewer", userId: OPERATOR_SUB });
    renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: auditResponder({ "": { status: 200, body: { items: [SUCCEEDED] } } }),
    });
    const region = await screen.findByRole("region", { name: "Audited actions" });
    expect(region).toBeTruthy();
  });

  it("labels an administration call as the admin tool, never as a person", async () => {
    signIn({ role: "Admin", userId: OPERATOR_SUB });
    renderAlerts(<AuditSheet />, {
      route: "/audit",
      respond: auditResponder({
        "": {
          status: 200,
          body: {
            items: [
              {
                ...SUCCEEDED,
                action: "site.update",
                robotId: undefined,
                commandId: undefined,
                actor: "vincent",
                actorSource: "mfc.admin",
              },
            ],
          },
        },
      }),
    });
    expect(await screen.findByText("Admin tool")).toBeTruthy();
    expect(screen.queryByText("Operator cent")).toBeNull();
    expect(screen.queryByText("vincent")).toBeNull();
  });
});
