/**
 * Formatting of the battery charge, shared by every place that shows it so that they all read the same.
 */

/**
 * Formats a charge in percent to the tenth, always with one decimal ("79.4"), in the number style of the language.
 *
 * @param percent - The charge, from 0 to 100.
 * @param locale - The UI language.
 * @returns The number without its unit.
 */
export function formatBattery(percent: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(percent);
}
