/**
 * Builders of DXF text for the tests: records are written as group pairs, so a test reads like the file it
 * describes.
 */

/** A group code and its value, as the tests write them. */
export type Pair = readonly [number, string];

/**
 * Builds a DXF text from records. The file ends with the `EOF` group, as real files do.
 *
 * @param records - The pairs, in order.
 * @returns The text, with LF line endings.
 */
export function dxf(...records: readonly (readonly Pair[])[]): string {
  const pairs = [...records.flat(), [0, "EOF"] as const];
  return pairs.map(([code, value]) => `${String(code)}\n${value}`).join("\n") + "\n";
}

/**
 * Wraps records in a named section.
 *
 * @param name - Section name.
 * @param records - The records of the section.
 * @returns The pairs of the section.
 */
export function section(name: string, ...records: readonly (readonly Pair[])[]): Pair[] {
  return [[0, "SECTION"], [2, name], ...records.flat(), [0, "ENDSEC"]];
}

/**
 * Header with the `$INSUNITS` value.
 *
 * @param units - The unit code.
 * @returns The pairs of the header section.
 */
export function header(units: number): Pair[] {
  return section("HEADER", [
    [9, "$INSUNITS"],
    [70, String(units)],
  ]);
}

/**
 * A LINE record.
 *
 * @param layer - Layer name.
 * @param a - Start point.
 * @param b - End point.
 * @returns The pairs of the record.
 */
export function line(
  layer: string,
  a: readonly [number, number],
  b: readonly [number, number],
): Pair[] {
  return [
    [0, "LINE"],
    [8, layer],
    [10, String(a[0])],
    [20, String(a[1])],
    [11, String(b[0])],
    [21, String(b[1])],
  ];
}
