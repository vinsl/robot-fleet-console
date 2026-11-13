/**
 * @vitest-environment jsdom
 *
 * Pick step: a file is read through the parser, a refusal is shown with its reason, and every refusal code has a
 * message in both languages.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18n from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../src/i18n";
import { PickStep } from "../../../src/site/editor/PickStep";
import { DXF_ERROR_CODES, DxfError, type DxfDocument } from "../../../src/site/dxf/types";
import { SMALL_DOC } from "./support";

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  cleanup();
});

/**
 * A DXF file for the picker.
 *
 * @param name - File name.
 * @returns The file.
 */
function dxfFile(name: string): File {
  return new File(["0\nSECTION\n"], name, { type: "application/dxf" });
}

describe("PickStep", () => {
  it("reads the chosen file and hands the drawing on", async () => {
    const parse = vi.fn(() => Promise.resolve(SMALL_DOC));
    const onParsed = vi.fn<(doc: DxfDocument) => void>();
    const user = userEvent.setup();
    render(<PickStep onParsed={onParsed} parse={parse} />);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    if (input === null) return;
    await user.upload(input, dxfFile("plan.dxf"));

    await waitFor(() => {
      expect(onParsed).toHaveBeenCalledWith(SMALL_DOC);
    });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("opens the file chooser from the labelled button, which the keyboard can reach", async () => {
    const user = userEvent.setup();
    render(<PickStep onParsed={vi.fn()} parse={vi.fn()} />);
    const button = screen.getByRole("button", { name: "Choose a DXF file" });
    button.focus();
    expect(document.activeElement).toBe(button);
    await user.keyboard("{Enter}");
    expect(button.getAttribute("disabled")).toBeNull();
  });

  it("names the file being read in a polite status while the parse runs", async () => {
    const parse = vi.fn(() => new Promise<DxfDocument>(() => undefined));
    const user = userEvent.setup();
    render(<PickStep onParsed={vi.fn()} parse={parse} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    await user.upload(input, dxfFile("plan.dxf"));

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Reading the drawing");
    expect(
      screen.getByRole("button", { name: "Choose a DXF file" }).getAttribute("disabled"),
    ).not.toBeNull();
  });

  it.each(DXF_ERROR_CODES)("shows the message of the refusal %s", async (code) => {
    const parse = vi.fn(() => Promise.reject(new DxfError(code)));
    const user = userEvent.setup();
    render(<PickStep onParsed={vi.fn()} parse={parse} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    await user.upload(input, dxfFile("plan.dxf"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      i18n.getFixedT("en", "site")(`errors.dxf.${code}`, { limitMb: 20 }),
    );
  });

  it("shows a generic message for a failure without a refusal code", async () => {
    const parse = vi.fn(() => Promise.reject(new Error("internal detail")));
    const user = userEvent.setup();
    render(<PickStep onParsed={vi.fn()} parse={parse} />);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("no file input");
    await user.upload(input, dxfFile("plan.dxf"));

    expect((await screen.findByRole("alert")).textContent).toBe("Something went wrong. Try again.");
    expect(screen.queryByText(/internal detail/)).toBeNull();
  });
});

describe("DXF refusal messages", () => {
  it.each(["en", "fr"] as const)("has a message for every refusal code in %s", (language) => {
    const t = i18n.getFixedT(language, "site");
    for (const code of DXF_ERROR_CODES) {
      const text = t(`errors.dxf.${code}`, { limitMb: 20 });
      expect(text, `${language}/${code}`).not.toMatch(/^errors\.dxf\./);
      expect(text.length, `${language}/${code}`).toBeGreaterThan(0);
    }
  });
});
