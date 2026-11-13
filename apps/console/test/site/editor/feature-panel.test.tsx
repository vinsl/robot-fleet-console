/**
 * @vitest-environment jsdom
 *
 * The feature panel over the real reducer: the workstation size is typed and checked, and the fields of a no-go zone
 * follow the zone while it is resized by a drag.
 */
import { act, useReducer, type Dispatch } from "react";
import type * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import "../../../src/i18n";
import { FeaturePanel } from "../../../src/site/editor/FeaturePanel";
import {
  INITIAL_WIZARD_STATE,
  wizardReducer,
  type WizardAction,
  type WizardState,
} from "../../../src/site/editor/wizard-reducer";
import { SMALL_DOC } from "./support";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

/**
 * A state with the small drawing confirmed, one workstation at the middle of the plan and one no-go zone.
 *
 * @returns The state.
 */
function populated(): WizardState {
  const confirmed = wizardReducer(
    wizardReducer(INITIAL_WIZARD_STATE, { type: "parsed", doc: SMALL_DOC }),
    { type: "confirmMapping" },
  );
  return wizardReducer(wizardReducer(confirmed, { type: "addWorkstation", at: [5, 1] }), {
    type: "addNogo",
    rect: { x: 1, y: 0, w: 4, h: 2 },
  });
}

/** Where the test harness sends its dispatcher, so a test can change the state the way a drag does. */
interface Exposed {
  dispatch: Dispatch<WizardAction> | null;
}

/**
 * Hosts the feature panel over the real reducer, and shows the features as JSON for the assertions.
 *
 * @param props - The initial state and the holder of the dispatcher.
 * @returns The panel.
 */
function Harness({
  initial,
  exposed,
}: {
  readonly initial: WizardState;
  readonly exposed: Exposed;
}): React.JSX.Element {
  const [state, dispatch] = useReducer(wizardReducer, initial);
  exposed.dispatch = dispatch;
  if (state.imported === null) {
    return <p>no plan</p>;
  }
  return (
    <>
      <FeaturePanel
        imported={state.imported}
        editor={state.editor}
        selection={state.selection}
        dispatch={dispatch}
      />
      <pre data-testid="editor">{JSON.stringify(state.editor)}</pre>
    </>
  );
}

/** The part of the features the assertions read, as the harness shows them. */
interface ShownEditor {
  readonly workstations: readonly { readonly size: { readonly width: number } }[];
}

/**
 * The features the reducer holds, as the harness shows them.
 *
 * @returns The parsed editor features.
 */
function editorOnScreen(): ShownEditor {
  return JSON.parse(screen.getByTestId("editor").textContent) as ShownEditor;
}

/**
 * The value of the labelled numeric field of a row, in order when several share the label.
 *
 * @param label - The field label.
 * @param index - Which field, in order.
 * @returns The field element.
 */
function numberField(label: string, index = 0): HTMLInputElement {
  const field = screen.getAllByRole("spinbutton", { name: label }).at(index);
  if (field === undefined) throw new Error(`no field ${label}`);
  return field as HTMLInputElement;
}

describe("FeaturePanel sizes", () => {
  it("types the width and height of a workstation into the editor", async () => {
    const user = userEvent.setup();
    render(<Harness initial={populated()} exposed={{ dispatch: null }} />);

    const width = numberField("width (m)", 0);
    await user.clear(width);
    await user.type(width, "3");

    expect(editorOnScreen().workstations[0]?.size.width).toBe(3);
  });

  it("says which size is out of range, on the field and in the row", async () => {
    const user = userEvent.setup();
    render(<Harness initial={populated()} exposed={{ dispatch: null }} />);

    const height = numberField("height (m)", 0);
    await user.clear(height);
    await user.type(height, "60");

    expect(height.getAttribute("aria-invalid")).toBe("true");
    const describedBy = height.getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      "Enter a width and a height between 0.1 and 50 m.",
    );
  });

  it("keeps the no-go fields in step with the zone while it is resized", () => {
    const exposed: Exposed = { dispatch: null };
    render(<Harness initial={populated()} exposed={exposed} />);

    act(() => {
      exposed.dispatch?.({
        type: "resizeTo",
        target: { kind: "nogo", index: 0 },
        handle: "se",
        to: [7, 1],
      });
    });

    expect(numberField("x (m)", 1).value).toBe("1");
    expect(numberField("y (m)", 1).value).toBe("1");
    expect(numberField("width (m)", 1).value).toBe("6");
    expect(numberField("height (m)", 1).value).toBe("1");
  });

  it("keeps the workstation fields in step with a resize of the workstation", () => {
    const exposed: Exposed = { dispatch: null };
    render(<Harness initial={populated()} exposed={exposed} />);

    act(() => {
      exposed.dispatch?.({
        type: "resizeBy",
        target: { kind: "workstation", index: 0 },
        dw: 0.1,
        dh: 0,
      });
    });

    expect(numberField("width (m)", 0).value).toBe("2.1");
    expect(numberField("x (m)", 0).value).toBe("5.05");
  });

  it("explains the resize keys in the panel", () => {
    render(<Harness initial={populated()} exposed={{ dispatch: null }} />);

    expect(screen.getByText(/Alt\+Shift\+Arrow resizes the selected item by 0\.1 m/)).toBeTruthy();
  });
});
