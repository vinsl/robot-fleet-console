/**
 * Keyboard shortcut that opens the robot search from anywhere in the console.
 *
 * `/` (without a modifier) and Ctrl/Cmd+K both go to the robot list with the search field focused. A bare `/`
 * is typed text when the focus is in a field, so it is ignored there.
 */

/** Route of the robot search: the robot list, with its search field focused on arrival. */
export const SEARCH_PATH = "/robots?focus=search";

/** The part of a keyboard event the shortcut reads. A `KeyboardEvent` satisfies it. */
export interface ShortcutEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly target: EventTarget | null;
}

/** Elements that take typed text, where a bare `/` must reach the field. */
const TEXT_ENTRY_TAGS: readonly string[] = ["INPUT", "TEXTAREA", "SELECT"];

/**
 * Tells whether the event is the search shortcut.
 *
 * @param event - The keyboard event.
 * @returns `true` for Ctrl/Cmd+K, and for `/` outside a text field.
 */
export function isSearchShortcut(event: ShortcutEvent): boolean {
  if (event.altKey) {
    return false;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    return true;
  }
  if (event.key !== "/" || event.ctrlKey || event.metaKey) {
    return false;
  }
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return true;
  }
  return !(TEXT_ENTRY_TAGS.includes(target.tagName) || target.isContentEditable);
}
