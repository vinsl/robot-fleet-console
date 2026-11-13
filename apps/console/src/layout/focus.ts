/**
 * Focus helpers shared by the dialog-like surfaces (sheets and panels).
 *
 * Selectors list what a keyboard user can reach. Elements hidden with `display: none` are not in the DOM
 * order a user sees, so the browser skips them when focus moves; the list here is only used to find the
 * first and last stop of a trap.
 */

/** Selector of the elements a keyboard user can focus. Disabled controls and `tabindex="-1"` are excluded. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

/**
 * Lists the focusable elements inside a container, in document order.
 *
 * @param root - The container to search.
 * @returns The focusable descendants of `root`.
 */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}
