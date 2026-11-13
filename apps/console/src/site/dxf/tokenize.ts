/**
 * Tokenizer of the DXF text format: turns the file into group code and value pairs, one line at a time.
 *
 * A DXF file is a list of pairs, a group code line then a value line. The tokenizer reads lazily, so a file
 * that breaks the format fails at the first bad line, and it refuses too many pairs before building them
 * all. Code lines are matched by a bounded pattern: the input is hostile, and an unbounded pattern could
 * backtrack for a long time on a crafted line.
 */
import { DXF_LIMITS, DxfError } from "./types";

/** A group code and its value, the value trimmed of surrounding whitespace. */
export type DxfPair = readonly [code: number, value: string];

/** A group code line: optional blanks, an optional minus sign, one to four digits, optional blanks. */
const CODE_PATTERN = /^\s*-?\d{1,4}\s*$/;

/** Longest code line the tokenizer inspects. A valid code line is at most a few characters. */
const CODE_LINE_MAX = 16;

/** Value of the group code that ends the file. */
const EOF_VALUE = "EOF";

/**
 * Reads the line that starts at a position, without its line feed and without a trailing carriage return.
 *
 * @param text - The whole file.
 * @param start - Position of the first character of the line.
 * @returns The line and the position of the next line.
 */
function lineAt(text: string, start: number): { readonly line: string; readonly next: number } {
  const newline = text.indexOf("\n", start);
  const end = newline === -1 ? text.length : newline;
  const raw = text.slice(start, end);
  return { line: raw.endsWith("\r") ? raw.slice(0, -1) : raw, next: end + 1 };
}

/**
 * Reads the group code and value pairs of a DXF text, up to and including the `EOF` group.
 *
 * @param text - The DXF text. Its size is checked by the caller.
 * @yields Each pair in file order.
 * @throws {DxfError} `not-dxf` when a code line is not a code, or a code has no value; `too-complex` when
 *   the file holds more pairs than {@link DXF_LIMITS.maxPairs}.
 */
export function* readPairs(text: string): Generator<DxfPair> {
  let position = 0;
  let pairs = 0;
  while (position < text.length) {
    const codeLine = lineAt(text, position);
    position = codeLine.next;
    if (codeLine.line.length > CODE_LINE_MAX || !CODE_PATTERN.test(codeLine.line)) {
      throw new DxfError("not-dxf");
    }
    if (position >= text.length) {
      throw new DxfError("not-dxf");
    }

    const valueLine = lineAt(text, position);
    position = valueLine.next;
    pairs += 1;
    if (pairs > DXF_LIMITS.maxPairs) {
      throw new DxfError("too-complex");
    }

    const code = Number(codeLine.line.trim());
    const pair: DxfPair = [code, valueLine.line.trim()];
    yield pair;
    if (code === 0 && pair[1] === EOF_VALUE) {
      return;
    }
  }
}
