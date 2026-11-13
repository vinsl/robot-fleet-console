/**
 * @vitest-environment jsdom
 *
 * Mapping step: roles are changed through the select, the scale gates the continue button, and a layer name is
 * shown as text whatever it contains.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/i18n";
import { MappingStep, type MappingStepProps } from "../../../src/site/editor/MappingStep";
import { suggestMapping } from "../../../src/site/dxf/layer-mapping";
import type { DxfDocument } from "../../../src/site/dxf/types";
import { SMALL_DOC } from "./support";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

/**
 * Props of the step for the small drawing, with callbacks that can be checked.
 *
 * @param overrides - Props to replace.
 * @returns The props.
 */
function props(overrides: Partial<MappingStepProps> = {}): MappingStepProps {
  return {
    doc: SMALL_DOC,
    mapping: suggestMapping(SMALL_DOC.layers),
    metresPerUnit: 0.001,
    error: null,
    onRole: vi.fn(),
    onScale: vi.fn(),
    onContinue: vi.fn(),
    onBack: vi.fn(),
    ...overrides,
  };
}

describe("MappingStep", () => {
  it("shows each layer with its entity count and its suggested role", () => {
    render(<MappingStep {...props()} />);
    const walls = screen.getByRole("combobox", { name: "Role: WALLS" });
    expect((walls as HTMLSelectElement).value).toBe("wall");
    // Only the walls and the racks match their suggestion; TEXT is ignored by default and is suggested too.
    expect(
      within(screen.getByRole("row", { name: /WALLS/ })).getByText("(suggested)"),
    ).toBeTruthy();
    expect(screen.getByRole("row", { name: /TEXT/ }).textContent).toContain("1");
  });

  it("reports a role change for the layer that changed", async () => {
    const onRole = vi.fn();
    const user = userEvent.setup();
    render(<MappingStep {...props({ onRole })} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "Role: TEXT" }), "wall");

    expect(onRole).toHaveBeenCalledWith("TEXT", "wall");
  });

  it("is reached in the tab order, so the keyboard can change a role", async () => {
    const user = userEvent.setup();
    render(<MappingStep {...props()} />);

    // The region is focusable, then the first select, which the keyboard then operates natively.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Drawing layers" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Role: WALLS" }));
  });

  it("refuses to continue without a usable scale, and marks the field invalid", () => {
    render(
      <MappingStep {...props({ metresPerUnit: null, doc: { ...SMALL_DOC, insUnits: null } })} />,
    );
    const continueButton = screen.getByRole("button", { name: "Continue to the editor" });
    expect(continueButton.getAttribute("disabled")).not.toBeNull();
    expect(
      screen.getByRole("spinbutton", { name: "Metres per unit" }).getAttribute("aria-invalid"),
    ).toBe("true");
    expect(screen.getByText(/The drawing gives no unit/)).toBeTruthy();
  });

  it.each([0, -3])("refuses the scale %s", (scale) => {
    render(<MappingStep {...props({ metresPerUnit: scale })} />);
    expect(
      screen.getByRole("button", { name: "Continue to the editor" }).getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("reports the scale as it is typed", async () => {
    const onScale = vi.fn();
    const user = userEvent.setup();
    render(
      <MappingStep
        {...props({ onScale, metresPerUnit: null, doc: { ...SMALL_DOC, insUnits: null } })}
      />,
    );
    const scale = screen.getByRole("spinbutton", { name: "Metres per unit" });

    await user.type(scale, "2");
    expect(onScale).toHaveBeenLastCalledWith(2);
  });

  it("shows a layer name as text, never as markup", () => {
    const hostile: DxfDocument = {
      ...SMALL_DOC,
      layers: [
        {
          name: "<img src=x onerror=alert(1)>",
          label: "<img src=x onerror=alert(1)>",
          entityCount: 1,
        },
      ],
    };
    const { container } = render(
      <MappingStep
        {...props({ doc: hostile, mapping: { "<img src=x onerror=alert(1)>": "ignore" } })}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("rowheader", { name: "<img src=x onerror=alert(1)>" })).toBeTruthy();
  });

  it("offers the layer table as a labelled, focusable region", () => {
    render(<MappingStep {...props()} />);
    const region = screen.getByRole("region", { name: "Drawing layers" });
    expect(region.getAttribute("tabindex")).toBe("0");
    expect(within(region).getByRole("table")).toBeTruthy();
  });

  it("continues and goes back through their buttons", async () => {
    const onContinue = vi.fn();
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<MappingStep {...props({ onContinue, onBack })} />);

    await user.click(screen.getByRole("button", { name: "Continue to the editor" }));
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
