/**
 * Joins CSS class names, skipping the empty ones. CSS modules type every class as possibly undefined, so the
 * components use this instead of template strings.
 */

/**
 * Joins the class names that are present.
 *
 * @param names - Class names, possibly absent.
 * @returns The present names separated by one space.
 */
export function classNames(...names: readonly (string | null | undefined | false)[]): string {
  return names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");
}
