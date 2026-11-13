/**
 * @vitest-environment jsdom
 */
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/i18n";
import { SidePanel } from "../../src/layout/SidePanel";

afterEach(() => {
  cleanup();
});

describe("SidePanel", () => {
  it("is a complementary region named by its title", () => {
    render(
      <SidePanel title="Robot R-03" onClose={vi.fn()}>
        <p>Battery 54 %</p>
      </SidePanel>,
    );
    expect(screen.getByRole("complementary", { name: "Robot R-03" })).toBeTruthy();
    expect(screen.getByText("Battery 54 %")).toBeTruthy();
  });

  it("offers no width toggle unless it is expandable", () => {
    render(
      <SidePanel title="Robot R-03" onClose={vi.fn()}>
        <p>Body</p>
      </SidePanel>,
    );
    expect(screen.queryByRole("button", { name: "Widen the panel" })).toBeNull();
  });

  it("widens and narrows from the toggle on its left edge", async () => {
    render(
      <SidePanel title="Robot R-03" onClose={vi.fn()} expandable>
        <p>Body</p>
      </SidePanel>,
    );
    const user = userEvent.setup();
    const widen = screen.getByRole("button", { name: "Widen the panel" });
    expect(widen.getAttribute("aria-expanded")).toBe("false");
    await user.click(widen);
    const narrow = screen.getByRole("button", { name: "Narrow the panel" });
    expect(narrow.getAttribute("aria-expanded")).toBe("true");
    await user.click(narrow);
    expect(screen.getByRole("button", { name: "Widen the panel" })).toBeTruthy();
  });

  it("closes from its close button", async () => {
    const onClose = vi.fn();
    render(
      <SidePanel title="Robot R-03" onClose={onClose}>
        <p>Body</p>
      </SidePanel>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and does not trap Tab (the map stays reachable)", async () => {
    const onClose = vi.fn();
    render(
      <>
        <SidePanel title="Robot R-03" onClose={onClose}>
          <button type="button">Inside</button>
        </SidePanel>
        <button type="button">Behind the panel</button>
      </>,
    );
    const user = userEvent.setup();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Behind the panel" }).matches(":focus")).toBe(true);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
