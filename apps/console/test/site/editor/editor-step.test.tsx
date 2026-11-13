/**
 * @vitest-environment jsdom
 *
 * Editor step, driven through the real reducer: the pointer places and moves features, the keyboard reaches and
 * moves every feature, the panel gives exact values, and the issues say when the draft is complete.
 */
import { useReducer } from "react";
import type * as React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/i18n";
import { Sheet } from "../../../src/layout/Sheet";
import { EditorStep } from "../../../src/site/editor/EditorStep";
import {
  INITIAL_WIZARD_STATE,
  wizardReducer,
  type WizardState,
} from "../../../src/site/editor/wizard-reducer";
import { SMALL_DOC } from "./support";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * A state with the small drawing confirmed and nothing placed yet.
 *
 * @returns The state.
 */
function confirmed(): WizardState {
  return wizardReducer(wizardReducer(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC }), {
    type: "confirmMapping",
  });
}

/**
 * Hosts the editor step over the real reducer.
 *
 * @param props - The initial state.
 * @returns The editor.
 */
function Harness({ initial }: { readonly initial: WizardState }): React.JSX.Element {
  const [state, dispatch] = useReducer(wizardReducer, initial);
  if (state.imported === null) {
    return <p>no plan</p>;
  }
  return (
    <EditorStep
      imported={state.imported}
      editor={state.editor}
      tool={state.tool}
      selection={state.selection}
      dispatch={dispatch}
      save={{ kind: "idle" }}
      onSave={() => undefined}
      onRetryValidation={() => undefined}
      onBack={() => undefined}
    />
  );
}

/**
 * The value of a labelled numeric field of the panel.
 *
 * @param label - The field label.
 * @param index - Which field of that label, in order, when several share it.
 * @returns The field's value.
 */
function fieldValue(label: string, index = 0): string {
  return screen.getAllByRole("spinbutton", { name: label }).at(index)?.getAttribute("value") ?? "";
}

describe("EditorStep", () => {
  it("lists what the draft still needs, and keeps save disabled until the draft is complete", () => {
    render(<Harness initial={confirmed()} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Place the charger.");
    expect(status.textContent).toContain("Add at least two workstations.");
    expect(screen.getByRole("button", { name: "Save as new version" })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("selects a tool from the toolbar and from the keyboard shortcuts", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    const toolbar = screen.getByRole("toolbar", { name: "Editor tools" });
    const workstation = within(toolbar).getByRole("button", { name: "Workstation" });

    screen.getByRole("button", { name: "Select" }).focus();
    await user.keyboard("w");
    expect(workstation.getAttribute("aria-pressed")).toBe("true");

    await user.keyboard("n");
    expect(
      within(toolbar).getByRole("button", { name: "No-go zone" }).getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("places the charger where the pointer clicks, with the plan flipped", () => {
    // The plan is 14 m by 6 m in view units, drawn in a 140 by 60 pixel box: the centre of the box is (5, 1) m.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: 140,
      height: 60,
      right: 140,
      bottom: 60,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    render(<Harness initial={confirmed()} />);
    fireEvent.click(screen.getByRole("button", { name: "Charger" }));

    const plan = document.querySelector<SVGRectElement>('rect[fill="transparent"]');
    expect(plan).not.toBeNull();
    if (plan === null) return;
    fireEvent.pointerDown(plan, { clientX: 70, clientY: 30, pointerId: 1 });
    fireEvent.pointerUp(plan, { clientX: 70, clientY: 30, pointerId: 1 });

    expect(fieldValue("x (m)")).toBe("5");
    expect(fieldValue("y (m)")).toBe("1");
  });

  it("adds a workstation at the middle of the plan, with the next free name", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));
    await user.click(screen.getByRole("button", { name: "Add workstation" }));

    expect(
      screen
        .getAllByRole("textbox", { name: "Name" })
        .map((field) => (field as HTMLInputElement).value),
    ).toEqual(["ws-01", "ws-02"]);
    expect(fieldValue("x (m)", 0)).toBe("5");
  });

  it("moves a focused feature by a tenth of a metre with an arrow key, and by a metre with Shift", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));

    const station = screen.getByRole("button", { name: /ws-01/ });
    station.focus();
    await user.keyboard("{ArrowRight}");
    expect(fieldValue("x (m)")).toBe("5.1");

    await user.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(fieldValue("y (m)")).toBe("2");
  });

  it("marks the selected feature with aria-current, not as a toggle", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));

    // A new feature is selected when it is added, so it is the one marked.
    const station = screen.getByRole("button", { name: /ws-01/ });
    expect(station.getAttribute("aria-current")).toBe("true");
    expect(station.getAttribute("aria-pressed")).toBeNull();
  });

  it("writes the coordinates of a feature with the decimal separator of the language", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));
    const station = screen.getByRole("button", { name: /ws-01/ });
    station.focus();
    await user.keyboard("{ArrowRight}");
    expect(station.getAttribute("aria-label")).toContain("x 5.1 m");

    await i18n.changeLanguage("fr");
    expect(screen.getByRole("button", { name: /ws-01/ }).getAttribute("aria-label")).toContain(
      "x 5,1 m",
    );
  });

  it("removes a focused feature with the Delete key", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));

    screen.getByRole("button", { name: /ws-01/ }).focus();
    await user.keyboard("{Delete}");

    expect(screen.getByText("Nothing placed yet.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /ws-01/ })).toBeNull();
  });

  it("refuses a name the protocol does not accept, and says so in the issues", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));

    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Bad Name");

    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain(
      "Workstation 1: use 1 to 32 lowercase letters",
    );
  });

  it("reports a complete draft once the charger, two workstations and a no-go zone are placed", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Place charger" }));
    await user.click(screen.getByRole("button", { name: "Add workstation" }));
    await user.click(screen.getByRole("button", { name: "Add workstation" }));
    await user.click(screen.getByRole("button", { name: "Add no-go zone" }));

    expect(screen.getByRole("status").textContent).toContain("The draft is complete.");
  });

  it("states a no-go zone with a zero side as an issue", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add no-go zone" }));

    const width = screen.getAllByRole("spinbutton", { name: "width (m)" })[0];
    if (width === undefined) throw new Error("no width field");
    await user.clear(width);
    await user.type(width, "0");

    expect(screen.getByRole("status").textContent).toContain(
      "No-go zone 1 needs a width and a height",
    );
  });
});

describe("EditorStep pointer targets", () => {
  /**
   * Gives the plan a width on the screen, so that the pointer targets are measured as they are in a browser.
   *
   * @param widthPx - The width of the plan, in pixels.
   */
  function layOutPlan(widthPx: number): void {
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      width: widthPx,
      height: widthPx,
      right: widthPx,
      bottom: widthPx,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
  }

  /**
   * The on-screen side of a pointer target along its width, in pixels, for a plan laid out at `widthPx`.
   *
   * @param target - The pointer target, a rectangle in site metres.
   * @param widthPx - The width of the plan, in pixels.
   * @returns The side in pixels.
   */
  function targetPx(target: Element, widthPx: number): number {
    const viewBox = document.querySelector("svg")?.getAttribute("viewBox") ?? "";
    const viewWidthM = Number(viewBox.split(" ")[2]);
    return (Number(target.getAttribute("width")) * widthPx) / viewWidthM;
  }

  it("gives a small workstation a pointer target of at least 44 px on the screen", async () => {
    layOutPlan(600);
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));

    expect(targetPx(screen.getByRole("button", { name: /ws-01/ }), 600)).toBeGreaterThanOrEqual(44);
  });

  it("gives the charger a pointer target of at least 44 px on the screen", () => {
    layOutPlan(600);
    const placed = wizardReducer(confirmed(), { type: "placeCharger", at: [5, 1] });
    render(<Harness initial={placed} />);

    expect(
      targetPx(screen.getByRole("button", { name: /Charger, x 5 m/ }), 600),
    ).toBeGreaterThanOrEqual(44);
  });

  it("keeps a tiny no-go zone easy to hit, and its outline at the real size", () => {
    layOutPlan(600);
    const placed = wizardReducer(confirmed(), {
      type: "addNogo",
      rect: { x: 1, y: 1, w: 0.5, h: 0.5 },
    });
    render(<Harness initial={placed} />);
    const zone = screen.getByRole("button", { name: /No-go zone 1, x 1 m/ });
    expect(targetPx(zone, 600)).toBeGreaterThanOrEqual(44);

    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 0, clientY: 0 });
    // The outline is the element drawn after the target, at the real size, and it is not interactive.
    const outline = zone.nextElementSibling;
    expect(outline?.getAttribute("aria-hidden")).toBe("true");
    expect(outline?.getAttribute("width")).toBe("0.5");
  });

  it("keeps a selected zone selected when the pointer goes down inside it", () => {
    layOutPlan(600);
    const placed = wizardReducer(confirmed(), {
      type: "addNogo",
      rect: { x: 1, y: 1, w: 3, h: 2 },
    });
    render(<Harness initial={placed} />);
    const zone = screen.getByRole("button", { name: /No-go zone 1, x 1 m/ });

    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 0, clientY: 0 });
    fireEvent.pointerDown(zone, { pointerId: 1, clientX: 0, clientY: 0 });

    expect(zone.getAttribute("aria-current")).toBe("true");
  });
});

describe("EditorStep resizing", () => {
  /** Screen pixels per metre of the test plan, the same at every zoom the test uses. */
  const PX_PER_M = 40;

  /**
   * The view box of the plan on the page, as its four numbers.
   *
   * @returns The numbers of `viewBox`, or none when there is no plan.
   */
  function planViewBox(): number[] {
    return (document.querySelector("svg")?.getAttribute("viewBox") ?? "").split(" ").map(Number);
  }

  beforeEach(() => {
    // The plan is laid out at PX_PER_M for whatever its view box is, since the view grows with the features placed.
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => {
      const [, , viewWidth = 0, viewHeight = 0] = planViewBox();
      const width = viewWidth * PX_PER_M;
      const height = viewHeight * PX_PER_M;
      return {
        left: 0,
        top: 0,
        width,
        height,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    });
  });

  /**
   * The client position of a site point on the plan laid out in `beforeEach`. SVG y is the negative of the site y.
   *
   * @param point - The site point, in metres.
   * @returns The client coordinates.
   */
  function clientAt(point: readonly [number, number]): { clientX: number; clientY: number } {
    const [minX = 0, minY = 0] = planViewBox();
    return {
      clientX: (point[0] - minX) * PX_PER_M,
      clientY: (-point[1] - minY) * PX_PER_M,
    };
  }

  /**
   * The pointer target of a handle of the selected shape.
   *
   * @param name - The handle name.
   * @returns The pointer target.
   */
  function handleTarget(name: string): SVGRectElement {
    const target = document.querySelector(`g[data-handle="${name}"]`)?.querySelectorAll("rect")[1];
    if (target === undefined) throw new Error(`no handle ${name}`);
    return target;
  }

  /**
   * A state with a no-go zone of 4 m by 2 m at (1, 0), selected. The plan is 10 m by 2 m, so the zone fills its height.
   *
   * @returns The state.
   */
  function withNogo(): WizardState {
    return wizardReducer(confirmed(), { type: "addNogo", rect: { x: 1, y: 0, w: 4, h: 2 } });
  }

  it("draws the eight handles on the selected zone only, out of the keyboard path", () => {
    render(<Harness initial={withNogo()} />);

    expect(document.querySelectorAll("g[data-handle]").length).toBe(8);
    expect(
      document.querySelector("g[data-handle]")?.parentElement?.getAttribute("aria-hidden"),
    ).toBe("true");
  });

  it("draws no handles when the selection is a charger", () => {
    const placed = wizardReducer(confirmed(), { type: "placeCharger", at: [5, 1] });
    render(<Harness initial={placed} />);

    expect(document.querySelectorAll("g[data-handle]").length).toBe(0);
  });

  it("draws no handles outside the select tool", () => {
    render(<Harness initial={{ ...withNogo(), tool: "nogo" }} />);

    expect(document.querySelectorAll("g[data-handle]").length).toBe(0);
  });

  it("drags the south-east handle: the opposite edges stay where they are", () => {
    render(<Harness initial={withNogo()} />);
    const handle = handleTarget("se");

    fireEvent.pointerDown(handle, { pointerId: 1, ...clientAt([5, 0]) });
    fireEvent.pointerMove(handle, { pointerId: 1, ...clientAt([7, 1]) });
    fireEvent.pointerUp(handle, { pointerId: 1, ...clientAt([7, 1]) });

    expect(fieldValue("x (m)")).toBe("1");
    expect(fieldValue("y (m)")).toBe("1");
    expect(fieldValue("width (m)")).toBe("6");
    expect(fieldValue("height (m)")).toBe("1");
  });

  it("stops a drag at the minimum size instead of flipping the zone", () => {
    render(<Harness initial={withNogo()} />);
    const handle = handleTarget("e");

    fireEvent.pointerDown(handle, { pointerId: 1, ...clientAt([5, 1]) });
    fireEvent.pointerMove(handle, { pointerId: 1, ...clientAt([0, 1]) });
    fireEvent.pointerUp(handle, { pointerId: 1, ...clientAt([0, 1]) });

    expect(fieldValue("x (m)")).toBe("1");
    expect(fieldValue("width (m)")).toBe("0.5");
  });

  it("keeps a dragged edge inside the plan", () => {
    const state = withNogo();
    render(<Harness initial={state} />);
    const handle = handleTarget("w");

    fireEvent.pointerDown(handle, { pointerId: 1, ...clientAt([1, 1]) });
    fireEvent.pointerMove(handle, { pointerId: 1, ...clientAt([-5, 1]) });
    fireEvent.pointerUp(handle, { pointerId: 1, ...clientAt([-5, 1]) });

    expect(fieldValue("x (m)")).toBe("0");
    expect(fieldValue("width (m)")).toBe("5");
  });

  it("cancels a drag with Escape, and the zone keeps its start size afterwards", () => {
    render(<Harness initial={withNogo()} />);
    const handle = handleTarget("se");

    fireEvent.pointerDown(handle, { pointerId: 1, ...clientAt([5, 0]) });
    fireEvent.pointerMove(handle, { pointerId: 1, ...clientAt([7, 1]) });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerMove(handle, { pointerId: 1, ...clientAt([8, 1]) });

    expect(fieldValue("x (m)")).toBe("1");
    expect(fieldValue("y (m)")).toBe("0");
    expect(fieldValue("width (m)")).toBe("4");
    expect(fieldValue("height (m)")).toBe("2");
  });

  it("keeps the sheet open when Escape cancels a drag, and closes it on the next Escape", () => {
    const onClose = vi.fn<() => void>();
    render(
      <Sheet title="Site editor" onClose={onClose}>
        <Harness initial={withNogo()} />
      </Sheet>,
    );
    const handle = handleTarget("se");

    fireEvent.pointerDown(handle, { pointerId: 1, ...clientAt([5, 0]) });
    fireEvent.pointerMove(handle, { pointerId: 1, ...clientAt([7, 1]) });
    // The event is dispatched on the page, as it is from the keyboard; `false` means the default was prevented.
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);

    expect(fieldValue("x (m)")).toBe("1");
    expect(fieldValue("y (m)")).toBe("0");
    expect(fieldValue("width (m)")).toBe("4");
    expect(fieldValue("height (m)")).toBe("2");
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("resizes a focused zone by a tenth of a metre with Alt+Shift+Arrow", () => {
    render(<Harness initial={withNogo()} />);
    const zone = screen.getByRole("button", { name: /^No-go zone 1, x/ });

    fireEvent.keyDown(zone, { key: "ArrowRight", altKey: true, shiftKey: true });

    expect(fieldValue("width (m)")).toBe("4.1");
    expect(fieldValue("x (m)")).toBe("1");
  });

  it("shrinks a workstation from the top with Alt+Shift+ArrowDown, and stops at the minimum size", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));
    const station = screen.getByRole("button", { name: /ws-01/ });

    fireEvent.keyDown(station, { key: "ArrowDown", altKey: true, shiftKey: true });
    expect(fieldValue("height (m)")).toBe("1.9");
    expect(fieldValue("y (m)")).toBe("0.95");

    for (let press = 0; press < 20; press += 1) {
      fireEvent.keyDown(station, { key: "ArrowDown", altKey: true, shiftKey: true });
    }
    expect(fieldValue("height (m)")).toBe("0.5");
  });

  it("moves a focused feature with the plain arrows, and does not resize it", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));
    screen.getByRole("button", { name: /ws-01/ }).focus();

    await user.keyboard("{ArrowRight}");

    expect(fieldValue("x (m)")).toBe("5.1");
    expect(fieldValue("width (m)")).toBe("2");
  });

  it("does not move or resize a charger with Alt+Shift+Arrow", () => {
    const placed = wizardReducer(confirmed(), { type: "placeCharger", at: [5, 1] });
    render(<Harness initial={placed} />);
    const charger = screen.getByRole("button", { name: /Charger, x 5 m/ });

    fireEvent.keyDown(charger, { key: "ArrowRight", altKey: true, shiftKey: true });

    expect(fieldValue("x (m)")).toBe("5");
  });

  it("announces the resize shortcuts on a resizable feature, and not on a charger", () => {
    const placed = wizardReducer(withNogo(), { type: "placeCharger", at: [5, 1] });
    render(<Harness initial={placed} />);

    expect(
      screen.getByRole("button", { name: /^No-go zone 1, x/ }).getAttribute("aria-keyshortcuts"),
    ).toContain("Alt+Shift+ArrowRight");
    expect(
      screen.getByRole("button", { name: /^Charger, x/ }).getAttribute("aria-keyshortcuts"),
    ).toBeNull();
  });

  it("says in the issues when a typed workstation size is out of range", async () => {
    const user = userEvent.setup();
    render(<Harness initial={confirmed()} />);
    await user.click(screen.getByRole("button", { name: "Add workstation" }));

    const width = screen.getAllByRole("spinbutton", { name: "width (m)" })[0];
    if (width === undefined) throw new Error("no width field");
    await user.clear(width);
    await user.type(width, "60");

    expect(screen.getByRole("status").textContent).toContain(
      "Workstation ws-01 needs a width and a height between 0.1 and 50 m.",
    );
  });
});
