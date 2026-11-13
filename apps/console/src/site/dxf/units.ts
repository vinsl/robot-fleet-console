/**
 * Length units of the DXF header (`$INSUNITS`) and their size in metres.
 *
 * Only the units an architect uses for a warehouse plan are listed. Any other code, and a file without the
 * header, yield `null`: the operator then gives the scale by hand, rather than the console guessing it.
 */

/** Metres per unit, keyed by the `$INSUNITS` code. */
const METRES_PER_UNIT: ReadonlyMap<number, number> = new Map([
  [1, 0.0254], // inches
  [2, 0.3048], // feet
  [4, 0.001], // millimetres
  [5, 0.01], // centimetres
  [6, 1], // metres
  [7, 1000], // kilometres
  [10, 0.9144], // yards
  [14, 0.1], // decimetres
]);

/**
 * Converts a `$INSUNITS` code into metres per unit.
 *
 * @param insUnits - The header code, or `null` when the file has none.
 * @returns Metres per drawing unit, or `null` when the unit is unknown.
 */
export function metresPerUnit(insUnits: number | null): number | null {
  if (insUnits === null) {
    return null;
  }
  return METRES_PER_UNIT.get(insUnits) ?? null;
}
