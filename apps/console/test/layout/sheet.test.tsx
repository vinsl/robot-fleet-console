/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/i18n";
import { Sheet } from "../../src/layout/Sheet";

/** A sheet opened by a button, so that the test can check where focus returns. */
function OpenSheet({ onClose }: { readonly onClose: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Open alerts
      </button>
      {open ? (
        <Sheet
          title="Alerts"
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <button type="button">Inside</button>
        </Sheet>
      ) : null}
    </>
  );
}

afterEach(() => {
  cleanup();
});

describe("Sheet", () => {
  it("is a modal dialog named by its title", () => {
    render(
      <Sheet title="Alerts" onClose={vi.fn()}>
        <p>Body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Alerts" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("moves focus inside when it opens", () => {
    render(
      <Sheet title="Alerts" onClose={vi.fn()}>
        <button type="button">Inside</button>
      </Sheet>,
    );
    expect(screen.getByRole("button", { name: "Close" }).matches(":focus")).toBe(true);
  });

  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <Sheet title="Alerts" onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the dialog, in both directions", async () => {
    const user = userEvent.setup();
    render(
      <Sheet title="Alerts" onClose={vi.fn()}>
        <button type="button">Inside</button>
      </Sheet>,
    );
    // Stops: the close button, then "Inside". Forward from the last stop returns to the first.
    await user.tab();
    expect(screen.getByRole("button", { name: "Inside" }).matches(":focus")).toBe(true);
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" }).matches(":focus")).toBe(true);
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Inside" }).matches(":focus")).toBe(true);
  });

  it("returns focus to the element that opened it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<OpenSheet onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open alerts" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener.matches(":focus")).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
