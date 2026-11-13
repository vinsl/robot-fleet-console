/**
 * @vitest-environment jsdom
 *
 * The search shortcut: `/` outside a text field, and Ctrl/Cmd+K anywhere. A bare `/` typed in a field is text.
 */
import { describe, expect, it } from "vitest";
import { isSearchShortcut, type ShortcutEvent } from "../../src/layout/shortcuts";

/**
 * Builds a key event with no modifier, on the given target.
 *
 * @param key - The key value.
 * @param target - The element that has the focus.
 * @param modifiers - Modifier flags to set.
 * @returns The event fields the shortcut reads.
 */
function eventOf(
  key: string,
  target: EventTarget | null,
  modifiers: Partial<Pick<ShortcutEvent, "ctrlKey" | "metaKey" | "altKey">> = {},
): ShortcutEvent {
  return { key, target, ctrlKey: false, metaKey: false, altKey: false, ...modifiers };
}

describe("isSearchShortcut", () => {
  it("opens the search on a bare slash outside a field", () => {
    expect(isSearchShortcut(eventOf("/", document.body))).toBe(true);
    expect(isSearchShortcut(eventOf("/", null))).toBe(true);
  });

  it.each(["input", "textarea", "select"])("leaves a slash typed in a %s alone", (tag) => {
    const field = document.createElement(tag);
    document.body.append(field);
    expect(isSearchShortcut(eventOf("/", field))).toBe(false);
    field.remove();
  });

  it("opens the search on Ctrl+K and Cmd+K, wherever the focus is", () => {
    const field = document.createElement("input");
    document.body.append(field);
    expect(isSearchShortcut(eventOf("k", field, { ctrlKey: true }))).toBe(true);
    expect(isSearchShortcut(eventOf("K", document.body, { metaKey: true }))).toBe(true);
    field.remove();
  });

  it("ignores plain letters, slashes with a modifier, and Alt chords", () => {
    expect(isSearchShortcut(eventOf("k", document.body))).toBe(false);
    expect(isSearchShortcut(eventOf("/", document.body, { ctrlKey: true }))).toBe(false);
    expect(isSearchShortcut(eventOf("k", document.body, { altKey: true, ctrlKey: true }))).toBe(
      false,
    );
  });
});
