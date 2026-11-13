/**
 * Parser of the DXF subset the site import understands: LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC and INSERT,
 * with the `$INSUNITS` header value. Every other entity is counted, not drawn.
 *
 * Block insertions are expanded one level: a block that inserts another block is counted, not expanded, so
 * the work is bounded by the limits rather than by the depth of the file. Every number is checked for
 * finiteness and range, and every count is checked against {@link DXF_LIMITS} while the file is read, so a
 * hostile file stops early instead of exhausting memory.
 */
import { readPairs, type DxfPair } from "./tokenize";
import { DXF_LIMITS, DxfError, type DxfDocument, type DxfEntity, type Point } from "./types";

/** Signature of a binary DXF file, which the text tokenizer cannot read. */
const BINARY_SIGNATURE = "AutoCAD Binary DXF";

/** Largest absolute coordinate or angle accepted. Larger values are a corrupt file, not a warehouse. */
const COORDINATE_LIMIT = 1e9;

/** Longest numeric text inspected. A number of a few digits is far below this. */
const NUMBER_TEXT_MAX = 64;

/**
 * Plain decimal number. Only digits and dots are admitted here; `Number` then rejects a malformed mantissa
 * such as `1.2.3`, and the finiteness check rejects anything out of range.
 */
const PLAIN_NUMBER_PATTERN = /^[+-]?[0-9.]+$/;

/** Decimal number with an exponent of at most three digits, written as a separate pattern to stay simple. */
const EXPONENT_NUMBER_PATTERN = /^[+-]?[0-9.]+[eE][+-]?[0-9]{1,3}$/;

/** DXF entity or section name: upper-case letters, digits, hyphen and underscore. */
const TYPE_PATTERN = /^[A-Z][A-Z0-9_-]{0,31}$/;

/** Layer used when an entity names none, and the layer that inherits the insertion layer in a block. */
const DEFAULT_LAYER = "0";

/** Largest number of distinct keys of the ignored counts. Beyond it, new keys share one bucket. */
const MAX_IGNORED_KEYS = 256;

/** Key of the ignored count for keys beyond {@link MAX_IGNORED_KEYS}. */
const OTHER_KEY = "other";

/** Vertices of a circle as drawn by the geometry step: 24 steps plus the closing position. */
const CIRCLE_POSITIONS = 25;

/** Largest number of positions of an arc as drawn: a full turn in steps of at most 10 degrees, plus one. */
const ARC_POSITIONS = 37;

/** A DXF record: an entity, section or table entry, with the group pairs that follow its type. */
interface RecordItem {
  readonly type: string;
  readonly body: readonly DxfPair[];
}

/**
 * Something read from the file that may produce drawable geometry. `entity` is `null` for an entity that is
 * only counted; `notes` are the keys to count each time the entity is emitted.
 */
interface Raw {
  readonly entity: DxfEntity | null;
  readonly layer: string;
  readonly notes: readonly string[];
  readonly bulges: number;
}

/** An `INSERT` of a top-level entity, resolved once the whole file has been read. */
interface InsertSpec {
  readonly layer: string;
  readonly block: string;
  readonly at: Point;
  readonly sx: number;
  readonly sy: number;
  readonly rotationDeg: number;
}

/** Outcome of reading one entity record: geometry to emit, or an insertion to expand. */
type Parsed =
  | { readonly kind: "raw"; readonly raw: Raw }
  | { readonly kind: "insert"; readonly spec: InsertSpec };

/** A block definition: its base point (`null` when the base is malformed) and its entities. */
interface BlockDef {
  readonly base: Point | null;
  readonly children: readonly Raw[];
}

/** A block being read, between its `BLOCK` and `ENDBLK` records. */
interface OpenBlock {
  readonly name: string;
  readonly base: Point | null;
  readonly children: Raw[];
}

/** A polyline being read, between its `POLYLINE` record and `SEQEND`. */
interface PolylineState {
  readonly layer: string;
  readonly closed: boolean;
  readonly mesh: boolean;
  readonly points: Point[];
  count: number;
  bulges: number;
  invalid: boolean;
}

/** Placement of a block insertion: the block base is removed, then the entity is scaled, rotated and moved. */
interface Placement {
  readonly base: Point;
  readonly sx: number;
  readonly sy: number;
  readonly rotationDeg: number;
  readonly at: Point;
}

/**
 * Groups the pairs of a file into records. A record starts at a group 0 pair and holds the pairs after it.
 *
 * @param pairs - The pairs in file order.
 * @yields Each record in file order, the last one being `EOF` when the file has it.
 */
function* groupRecords(pairs: Iterable<DxfPair>): Generator<RecordItem> {
  let type: string | null = null;
  let body: DxfPair[] = [];
  for (const pair of pairs) {
    if (pair[0] === 0) {
      if (type !== null) {
        yield { type, body };
      }
      type = pair[1];
      body = [];
    } else if (type !== null) {
      body.push(pair);
    }
  }
  if (type !== null) {
    yield { type, body };
  }
}

/**
 * Converts the text of a number. Anything that is not a bounded decimal, or that is not finite, is `null`.
 *
 * @param text - The value text.
 * @returns The number, or `null`.
 */
function toNumber(text: string): number | null {
  if (text.length > NUMBER_TEXT_MAX) {
    return null;
  }
  if (!PLAIN_NUMBER_PATTERN.test(text) && !EXPONENT_NUMBER_PATTERN.test(text)) {
    return null;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads the first value of a group code in a record.
 *
 * @param body - The pairs of the record.
 * @param code - The group code.
 * @returns The value text, or `undefined` when the code is absent.
 */
function field(body: readonly DxfPair[], code: number): string | undefined {
  for (const pair of body) {
    if (pair[0] === code) {
      return pair[1];
    }
  }
  return undefined;
}

/**
 * Reads a required number. Absent or invalid is `null`.
 *
 * @param body - The pairs of the record.
 * @param code - The group code.
 * @returns The number, or `null`.
 */
function requiredNumber(body: readonly DxfPair[], code: number): number | null {
  const text = field(body, code);
  return text === undefined ? null : toNumber(text);
}

/**
 * Reads an optional number. Absent gives the fallback; present but invalid gives `null`.
 *
 * @param body - The pairs of the record.
 * @param code - The group code.
 * @param fallback - Value used when the code is absent.
 * @returns The number, the fallback, or `null` when present and invalid.
 */
function optionalNumber(body: readonly DxfPair[], code: number, fallback: number): number | null {
  const text = field(body, code);
  return text === undefined ? fallback : toNumber(text);
}

/**
 * Reads an integer flag word. Absent or invalid reads as zero.
 *
 * @param body - The pairs of the record.
 * @param code - The group code.
 * @returns The integer value.
 */
function flagWord(body: readonly DxfPair[], code: number): number {
  const text = field(body, code);
  const value = text === undefined ? null : toNumber(text);
  return value === null ? 0 : Math.trunc(value);
}

/**
 * Cuts a text to a number of code points. A code point is at most two UTF-16 units, so twice the limit is read
 * first, which bounds the work on a very long name before it is split.
 *
 * @param value - The text.
 * @param limit - Maximum number of code points.
 * @returns The cut text.
 */
function cutCodePoints(value: string, limit: number): string {
  return Array.from(value.slice(0, limit * 2))
    .slice(0, limit)
    .join("");
}

/**
 * Makes a layer name safe to use as a key: control characters removed, cut to the DXF name length. The cut is
 * at the DXF limit, not at the display limit, so two distinct names that differ late do not merge into one layer.
 *
 * @param value - The raw layer name.
 * @returns The sanitised key, or `"0"` when nothing printable remains.
 */
function sanitizeLayer(value: string): string {
  const printable = value.replace(/\p{Cc}/gu, "").trim();
  const key = cutCodePoints(printable, DXF_LIMITS.maxLayerKeyLength);
  return key === "" ? DEFAULT_LAYER : key;
}

/**
 * Shortens a layer key for the mapping table. The key itself is unchanged; only the display is cut.
 *
 * @param name - The layer key.
 * @returns The text to show.
 */
function displayLabel(name: string): string {
  return cutCodePoints(name, DXF_LIMITS.maxLayerNameLength);
}

/**
 * Reads the layer of a record.
 *
 * @param body - The pairs of the record.
 * @returns The sanitised layer name.
 */
function layerOf(body: readonly DxfPair[]): string {
  return sanitizeLayer(field(body, 8) ?? DEFAULT_LAYER);
}

/**
 * Turns an entity type into a counting key. A type that does not look like a DXF name is counted as one
 * generic key, so a crafted file cannot choose the keys of the output.
 *
 * @param type - The type text from the file.
 * @returns The key.
 */
function typeKey(type: string): string {
  return TYPE_PATTERN.test(type) ? type : OTHER_KEY;
}

/**
 * Tells whether a coordinate is finite and within the limit. `NaN` fails the comparison, so it is refused.
 *
 * @param value - The coordinate.
 * @returns `true` when it is usable.
 */
function isCoordinate(value: number): boolean {
  return Math.abs(value) <= COORDINATE_LIMIT;
}

/**
 * Tells whether a point is usable.
 *
 * @param point - The point.
 * @returns `true` when both coordinates are usable.
 */
function isPoint(point: Point): boolean {
  return isCoordinate(point[0]) && isCoordinate(point[1]);
}

/**
 * Tells whether a radius is positive and within the limit.
 *
 * @param radius - The radius.
 * @returns `true` when it is usable.
 */
function isRadius(radius: number): boolean {
  return radius > 0 && radius <= COORDINATE_LIMIT;
}

/**
 * Tells whether an entity is safe to draw: every coordinate, radius and angle is finite and bounded.
 *
 * @param entity - The entity, with block placement already applied.
 * @returns `true` when the entity can be drawn.
 */
function isValidEntity(entity: DxfEntity): boolean {
  switch (entity.kind) {
    case "line":
      return isPoint(entity.a) && isPoint(entity.b);
    case "polyline":
      return entity.points.every(isPoint);
    case "circle":
      return isPoint(entity.center) && isRadius(entity.radius);
    case "arc":
      return (
        isPoint(entity.center) &&
        isRadius(entity.radius) &&
        isCoordinate(entity.startDeg) &&
        isCoordinate(entity.endDeg)
      );
  }
}

/**
 * Number of positions an entity produces once drawn. Used as the vertex budget of block expansion.
 *
 * @param entity - The entity.
 * @returns An upper bound of its positions.
 */
function positionCount(entity: DxfEntity): number {
  switch (entity.kind) {
    case "line":
      return 2;
    case "polyline":
      return entity.points.length;
    case "circle":
      return CIRCLE_POSITIONS;
    case "arc":
      return ARC_POSITIONS;
  }
}

/**
 * Builds a record that is counted and drawn nothing.
 *
 * @param layer - Layer of the record.
 * @param note - Key to count.
 * @returns The raw record.
 */
function counted(layer: string, note: string): Raw {
  return { entity: null, layer, notes: [note], bulges: 0 };
}

/**
 * Builds a record that carries an entity.
 *
 * @param entity - The entity.
 * @param bulges - Number of polyline vertices with a bulge, which are counted and not drawn.
 * @returns The raw record.
 */
function drawn(entity: DxfEntity, bulges = 0): Raw {
  return { entity, layer: entity.layer, notes: [], bulges };
}

/**
 * Reads a LINE.
 *
 * @param body - The pairs of the record.
 * @param layer - Its layer.
 * @returns The raw record.
 */
function parseLine(body: readonly DxfPair[], layer: string): Raw {
  const ax = requiredNumber(body, 10);
  const ay = requiredNumber(body, 20);
  const bx = requiredNumber(body, 11);
  const by = requiredNumber(body, 21);
  if (ax === null || ay === null || bx === null || by === null) {
    return counted(layer, "invalid");
  }
  return drawn({ kind: "line", layer, a: [ax, ay], b: [bx, by] });
}

/**
 * Reads a CIRCLE.
 *
 * @param body - The pairs of the record.
 * @param layer - Its layer.
 * @returns The raw record.
 */
function parseCircle(body: readonly DxfPair[], layer: string): Raw {
  const cx = requiredNumber(body, 10);
  const cy = requiredNumber(body, 20);
  const radius = requiredNumber(body, 40);
  if (cx === null || cy === null || radius === null) {
    return counted(layer, "invalid");
  }
  return drawn({ kind: "circle", layer, center: [cx, cy], radius });
}

/**
 * Reads an ARC. Angles are degrees, counter-clockwise, as DXF stores them.
 *
 * @param body - The pairs of the record.
 * @param layer - Its layer.
 * @returns The raw record.
 */
function parseArc(body: readonly DxfPair[], layer: string): Raw {
  const cx = requiredNumber(body, 10);
  const cy = requiredNumber(body, 20);
  const radius = requiredNumber(body, 40);
  const startDeg = requiredNumber(body, 50);
  const endDeg = requiredNumber(body, 51);
  if (cx === null || cy === null || radius === null || startDeg === null || endDeg === null) {
    return counted(layer, "invalid");
  }
  return drawn({ kind: "arc", layer, center: [cx, cy], radius, startDeg, endDeg });
}

/**
 * Reads an LWPOLYLINE. Its vertices are the `10`/`20` pairs; a `42` after a vertex is its bulge, which is
 * counted and not drawn.
 *
 * @param body - The pairs of the record.
 * @param layer - Its layer.
 * @returns The raw record.
 * @throws {DxfError} `too-complex` when the polyline has more vertices than allowed.
 */
function parseLwPolyline(body: readonly DxfPair[], layer: string): Raw {
  const vertices: { x: number | null; y: number | null; bulge: number }[] = [];
  for (const [code, text] of body) {
    if (code === 10) {
      if (vertices.length >= DXF_LIMITS.maxVerticesPerPolyline) {
        throw new DxfError("too-complex");
      }
      vertices.push({ x: toNumber(text), y: null, bulge: 0 });
    } else if (code === 20) {
      const last = vertices.at(-1);
      if (last !== undefined) {
        last.y = toNumber(text);
      }
    } else if (code === 42) {
      const last = vertices.at(-1);
      if (last !== undefined) {
        last.bulge = toNumber(text) ?? 0;
      }
    }
  }
  if (vertices.length === 0) {
    return counted(layer, "invalid");
  }
  const points: Point[] = [];
  for (const vertex of vertices) {
    if (vertex.x === null || vertex.y === null) {
      return counted(layer, "invalid");
    }
    points.push([vertex.x, vertex.y]);
  }
  const bulges = vertices.filter((vertex) => vertex.bulge !== 0).length;
  const closed = (flagWord(body, 70) & 1) === 1;
  return drawn({ kind: "polyline", layer, points, closed }, bulges);
}

/**
 * Starts a POLYLINE. Its vertices follow in `VERTEX` records, up to `SEQEND`.
 *
 * Polygon meshes and polyface meshes (flag bits 16 and 64) are not drawable as outlines, so they are counted.
 *
 * @param body - The pairs of the header record.
 * @returns The state that collects its vertices.
 */
function startPolyline(body: readonly DxfPair[]): PolylineState {
  const flags = flagWord(body, 70);
  return {
    layer: layerOf(body),
    closed: (flags & 1) === 1,
    mesh: (flags & 80) !== 0,
    points: [],
    count: 0,
    bulges: 0,
    invalid: false,
  };
}

/**
 * Turns a finished POLYLINE into a raw record.
 *
 * @param state - The collected polyline.
 * @returns The raw record.
 */
function finishPolyline(state: PolylineState): Raw {
  if (state.mesh) {
    return counted(state.layer, "POLYLINE-mesh");
  }
  if (state.invalid || state.points.length === 0) {
    return counted(state.layer, "invalid");
  }
  return drawn(
    { kind: "polyline", layer: state.layer, points: state.points, closed: state.closed },
    state.bulges,
  );
}

/**
 * Reads an INSERT. Its scale and rotation are optional and default to 1 and 0.
 *
 * @param body - The pairs of the record.
 * @param layer - Its layer.
 * @returns The insertion, or a counted record when a value is malformed.
 */
function parseInsert(body: readonly DxfPair[], layer: string): Parsed {
  const x = requiredNumber(body, 10);
  const y = requiredNumber(body, 20);
  const sx = optionalNumber(body, 41, 1);
  const sy = optionalNumber(body, 42, 1);
  const rotationDeg = optionalNumber(body, 50, 0);
  if (x === null || y === null || sx === null || sy === null || rotationDeg === null) {
    return { kind: "raw", raw: counted(layer, "invalid") };
  }
  const block = field(body, 2) ?? "";
  return {
    kind: "insert",
    spec: { layer, block, at: [x, y], sx, sy, rotationDeg },
  };
}

/**
 * Reads one entity record by its type.
 *
 * @param type - The entity type.
 * @param body - The pairs of the record.
 * @returns The parsed entity, or the counted record of an unsupported type.
 */
function parseEntity(type: string, body: readonly DxfPair[]): Parsed {
  const layer = layerOf(body);
  switch (type) {
    case "LINE":
      return { kind: "raw", raw: parseLine(body, layer) };
    case "LWPOLYLINE":
      return { kind: "raw", raw: parseLwPolyline(body, layer) };
    case "CIRCLE":
      return { kind: "raw", raw: parseCircle(body, layer) };
    case "ARC":
      return { kind: "raw", raw: parseArc(body, layer) };
    case "INSERT":
      return parseInsert(body, layer);
    default:
      return { kind: "raw", raw: counted(layer, typeKey(type)) };
  }
}

/**
 * Reads the `$INSUNITS` value from the header section.
 *
 * @param body - The pairs of the `HEADER` section.
 * @returns The unit code, or `null` when absent or not an integer.
 */
function readInsUnits(body: readonly DxfPair[]): number | null {
  const header = body.findIndex((pair) => pair[0] === 9 && pair[1] === "$INSUNITS");
  const next = header === -1 ? undefined : body[header + 1];
  if (next === undefined || next[0] !== 70) {
    return null;
  }
  const value = toNumber(next[1]);
  return value !== null && Number.isInteger(value) ? value : null;
}

/**
 * Applies a block placement to a point: the base is removed, the point is scaled, rotated about the origin
 * and moved to the insertion point.
 *
 * @param point - The point in block coordinates.
 * @param placement - The placement of the insertion.
 * @returns The point in drawing coordinates.
 */
function placePoint(point: Point, placement: Placement): Point {
  const radians = (placement.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const x = (point[0] - placement.base[0]) * placement.sx;
  const y = (point[1] - placement.base[1]) * placement.sy;
  return [x * cos - y * sin + placement.at[0], x * sin + y * cos + placement.at[1]];
}

/**
 * Maps an angle through a placement. The angle is mapped as a direction, so a mirrored insertion reverses
 * the sense of an arc correctly.
 *
 * @param degrees - The angle in block coordinates.
 * @param placement - The placement of the insertion.
 * @returns The angle in drawing coordinates, in degrees.
 */
function placeAngle(degrees: number, placement: Placement): number {
  const radians = (degrees * Math.PI) / 180;
  const x = Math.cos(radians) * placement.sx;
  const y = Math.sin(radians) * placement.sy;
  return (Math.atan2(y, x) * 180) / Math.PI + placement.rotationDeg;
}

/**
 * Applies a placement to an entity.
 *
 * A circle or an arc under a non-uniform scale would be an ellipse, which the drawing does not model, so it
 * is refused and counted rather than drawn wrong.
 *
 * @param entity - The entity in block coordinates, with its layer already set.
 * @param placement - The placement of the insertion.
 * @returns The placed entity, or `"non-uniform-scale"`.
 */
function placeEntity(entity: DxfEntity, placement: Placement): DxfEntity | "non-uniform-scale" {
  const mirrored = placement.sx * placement.sy < 0;
  const uniform = Math.abs(placement.sx) === Math.abs(placement.sy);
  const scale = Math.abs(placement.sx);
  switch (entity.kind) {
    case "line":
      return {
        kind: "line",
        layer: entity.layer,
        a: placePoint(entity.a, placement),
        b: placePoint(entity.b, placement),
      };
    case "polyline":
      return {
        kind: "polyline",
        layer: entity.layer,
        points: entity.points.map((point) => placePoint(point, placement)),
        closed: entity.closed,
      };
    case "circle":
      if (!uniform) {
        return "non-uniform-scale";
      }
      return {
        kind: "circle",
        layer: entity.layer,
        center: placePoint(entity.center, placement),
        radius: entity.radius * scale,
      };
    case "arc":
      if (!uniform) {
        return "non-uniform-scale";
      }
      // A mirror reverses the sense of the arc, so its end becomes the start.
      return {
        kind: "arc",
        layer: entity.layer,
        center: placePoint(entity.center, placement),
        radius: entity.radius * scale,
        startDeg: mirrored
          ? placeAngle(entity.endDeg, placement)
          : placeAngle(entity.startDeg, placement),
        endDeg: mirrored
          ? placeAngle(entity.startDeg, placement)
          : placeAngle(entity.endDeg, placement),
      };
  }
}

/**
 * Returns an entity with another layer.
 *
 * @param entity - The entity.
 * @param layer - The layer to give it.
 * @returns A copy with the layer set.
 */
function withLayer(entity: DxfEntity, layer: string): DxfEntity {
  return { ...entity, layer };
}

/**
 * Builds the parse state of one file and turns the records into a document.
 *
 * The state is single-use: {@link DxfBuilder.consume} is called for every record in order, then
 * {@link DxfBuilder.finish} resolves the insertions and builds the document.
 */
class DxfBuilder {
  private insUnits: number | null = null;
  private section: string | null = null;
  private sawSection = false;
  private openBlock: OpenBlock | null = null;
  private polyline: PolylineState | null = null;
  private readonly blocks = new Map<string, BlockDef>();
  private readonly entities: DxfEntity[] = [];
  private readonly ignored = new Map<string, number>();
  private readonly layers = new Map<string, number>();
  private readonly inserts: InsertSpec[] = [];
  private stored = 0;
  private emitted = 0;
  private emittedPositions = 0;

  /**
   * Reads one record.
   *
   * @param item - The record.
   * @returns `false` after the `EOF` record, `true` otherwise.
   */
  consume(item: RecordItem): boolean {
    switch (item.type) {
      case "SECTION":
        this.startSection(item.body);
        return true;
      case "ENDSEC":
        this.endSection();
        return true;
      case "EOF":
        this.endSection();
        return false;
      case "BLOCK":
        if (this.section === "BLOCKS") {
          this.startBlock(item.body);
        }
        return true;
      case "ENDBLK":
        this.endBlock();
        return true;
      default:
        if (this.section === "ENTITIES" || (this.section === "BLOCKS" && this.openBlock !== null)) {
          this.entityRecord(item);
        }
        return true;
    }
  }

  /**
   * Resolves the block insertions and builds the document.
   *
   * @returns The document.
   * @throws {DxfError} `not-dxf` when the file has no section; `empty` when nothing is drawable.
   */
  finish(): DxfDocument {
    if (!this.sawSection) {
      throw new DxfError("not-dxf");
    }
    this.endSection();
    for (const insert of this.inserts) {
      this.expand(insert);
    }
    if (this.entities.length === 0) {
      throw new DxfError("empty");
    }
    return {
      insUnits: this.insUnits,
      layers: [...this.layers].map(([name, entityCount]) => ({
        name,
        label: displayLabel(name),
        entityCount,
      })),
      entities: this.entities,
      ignored: Object.fromEntries(this.ignored),
    };
  }

  /**
   * Starts a section and reads the header when it is the header.
   *
   * @param body - The pairs of the `SECTION` record.
   */
  private startSection(body: readonly DxfPair[]): void {
    this.endSection();
    this.section = field(body, 2) ?? null;
    this.sawSection = true;
    if (this.section === "HEADER") {
      this.insUnits = readInsUnits(body);
    }
  }

  /** Ends the current section, closing any block or polyline still open. */
  private endSection(): void {
    this.flushPolyline();
    this.endBlock();
    this.section = null;
  }

  /**
   * Starts a block definition.
   *
   * @param body - The pairs of the `BLOCK` record.
   */
  private startBlock(body: readonly DxfPair[]): void {
    this.endBlock();
    const x = optionalNumber(body, 10, 0);
    const y = optionalNumber(body, 20, 0);
    this.openBlock = {
      name: field(body, 2) ?? "",
      base: x === null || y === null ? null : [x, y],
      children: [],
    };
  }

  /** Closes the open block and keeps its definition, unless a block of the same name came first. */
  private endBlock(): void {
    this.flushPolyline();
    const block = this.openBlock;
    if (block === null) {
      return;
    }
    if (!this.blocks.has(block.name)) {
      this.blocks.set(block.name, { base: block.base, children: block.children });
    }
    this.openBlock = null;
  }

  /**
   * Reads one record of an entity section or of an open block.
   *
   * @param item - The record.
   */
  private entityRecord(item: RecordItem): void {
    if (item.type === "VERTEX" && this.polyline !== null) {
      this.addVertex(this.polyline, item.body);
      return;
    }
    if (item.type === "SEQEND") {
      this.flushPolyline();
      return;
    }
    this.flushPolyline();
    this.stored += 1;
    if (this.stored > DXF_LIMITS.maxEntities) {
      throw new DxfError("too-complex");
    }
    if (item.type === "POLYLINE") {
      this.polyline = startPolyline(item.body);
      return;
    }
    this.accept(parseEntity(item.type, item.body));
  }

  /**
   * Adds one vertex to the polyline being read.
   *
   * @param state - The polyline.
   * @param body - The pairs of the `VERTEX` record.
   * @throws {DxfError} `too-complex` when the polyline is longer than allowed.
   */
  private addVertex(state: PolylineState, body: readonly DxfPair[]): void {
    state.count += 1;
    if (state.count > DXF_LIMITS.maxVerticesPerPolyline) {
      throw new DxfError("too-complex");
    }
    const x = requiredNumber(body, 10);
    const y = requiredNumber(body, 20);
    if (x === null || y === null) {
      state.invalid = true;
    } else {
      state.points.push([x, y]);
    }
    const bulge = optionalNumber(body, 42, 0);
    if (bulge !== null && bulge !== 0) {
      state.bulges += 1;
    }
  }

  /** Finishes the polyline being read, if any, and routes it like any other entity. */
  private flushPolyline(): void {
    const state = this.polyline;
    if (state === null) {
      return;
    }
    this.polyline = null;
    this.accept({ kind: "raw", raw: finishPolyline(state) });
  }

  /**
   * Routes a parsed entity: into the open block, or into the drawing. An insertion in the drawing is
   * expanded later; inside a block it is counted, since expansion is one level deep.
   *
   * @param parsed - The parsed entity.
   */
  private accept(parsed: Parsed): void {
    const block = this.openBlock;
    if (block !== null) {
      block.children.push(
        parsed.kind === "raw"
          ? parsed.raw
          : { entity: null, layer: parsed.spec.layer, notes: ["INSERT-nested"], bulges: 0 },
      );
      return;
    }
    if (parsed.kind === "insert") {
      this.inserts.push(parsed.spec);
      return;
    }
    this.emit(parsed.raw, null, null);
  }

  /**
   * Expands one insertion: every entity of its block is placed and emitted.
   *
   * @param insert - The insertion.
   */
  private expand(insert: InsertSpec): void {
    const block = this.blocks.get(insert.block);
    if (block === undefined) {
      this.bump("INSERT-missing", 1);
      return;
    }
    if (block.base === null) {
      this.bump("invalid", 1);
      return;
    }
    const placement: Placement = {
      base: block.base,
      sx: insert.sx,
      sy: insert.sy,
      rotationDeg: insert.rotationDeg,
      at: insert.at,
    };
    for (const child of block.children) {
      const layer = child.layer === DEFAULT_LAYER ? insert.layer : child.layer;
      this.emit(child, placement, layer);
    }
  }

  /**
   * Emits one record: counts its layer and notes, and keeps its entity if it is drawable.
   *
   * @param raw - The record.
   * @param placement - Placement of a block expansion, or `null` for the drawing itself.
   * @param layer - Layer to report, or `null` to keep the record's own layer.
   * @throws {DxfError} `too-complex` when the drawing exceeds the expansion or layer limits.
   */
  private emit(raw: Raw, placement: Placement | null, layer: string | null): void {
    this.emitted += 1;
    if (this.emitted > DXF_LIMITS.maxExpandedEntities) {
      throw new DxfError("too-complex");
    }
    const target = layer ?? raw.layer;
    this.countLayer(target);
    for (const note of raw.notes) {
      this.bump(note, 1);
    }
    if (raw.bulges > 0) {
      this.bump("bulge", raw.bulges);
    }
    if (raw.entity === null) {
      return;
    }

    const named = withLayer(raw.entity, target);
    this.emittedPositions += positionCount(named);
    if (this.emittedPositions > DXF_LIMITS.maxExpandedVertices) {
      throw new DxfError("too-complex");
    }
    const placed = placement === null ? named : placeEntity(named, placement);
    if (placed === "non-uniform-scale") {
      this.bump("non-uniform-scale", 1);
      return;
    }
    if (!isValidEntity(placed)) {
      this.bump("invalid", 1);
      return;
    }
    this.entities.push(placed);
  }

  /**
   * Counts one entity on a layer, refusing a drawing with too many layers.
   *
   * @param name - Layer name.
   * @throws {DxfError} `too-complex` when the layer limit would be exceeded.
   */
  private countLayer(name: string): void {
    const current = this.layers.get(name);
    if (current === undefined && this.layers.size >= DXF_LIMITS.maxLayers) {
      throw new DxfError("too-complex");
    }
    this.layers.set(name, (current ?? 0) + 1);
  }

  /**
   * Adds to an ignored count, bounding the number of distinct keys.
   *
   * @param key - The key.
   * @param amount - How much to add.
   */
  private bump(key: string, amount: number): void {
    const known = this.ignored.has(key) || this.ignored.size < MAX_IGNORED_KEYS;
    const target = known ? key : OTHER_KEY;
    this.ignored.set(target, (this.ignored.get(target) ?? 0) + amount);
  }
}

/**
 * Parses the text of a DXF file into the drawing the import works on.
 *
 * The caller checks the file size before reading the text; the text length is checked again here, since a
 * string is never larger than its byte count.
 *
 * @param text - The DXF text.
 * @returns The parsed drawing.
 * @throws {DxfError} `too-large`, `binary`, `not-dxf`, `too-complex` or `empty`, as described in
 *   {@link DXF_LIMITS}.
 */
export function parseDxf(text: string): DxfDocument {
  if (text.length > DXF_LIMITS.maxBytes) {
    throw new DxfError("too-large");
  }
  if (text.startsWith(BINARY_SIGNATURE)) {
    throw new DxfError("binary");
  }
  const builder = new DxfBuilder();
  for (const item of groupRecords(readPairs(text))) {
    if (!builder.consume(item)) {
      break;
    }
  }
  return builder.finish();
}
