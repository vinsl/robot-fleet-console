/**
 * DXF parser: refusals of the file, the subset of entities, block insertions, hard limits and header units.
 */
import { describe, expect, it } from "vitest";
import { parseDxf } from "../../../src/site/dxf/parse-dxf";
import { readPairs } from "../../../src/site/dxf/tokenize";
import { DXF_LIMITS, DxfError, type DxfEntity } from "../../../src/site/dxf/types";
import { dxf, header, line, section, type Pair } from "./support";

/**
 * Runs the parser and returns the refusal code, failing the test when it does not refuse.
 *
 * @param text - The DXF text.
 * @returns The refusal code.
 */
function refusalOf(text: string): string {
  try {
    parseDxf(text);
  } catch (error) {
    if (error instanceof DxfError) {
      return error.code;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

/**
 * Parses a file made of one entity section.
 *
 * @param entities - Records of the ENTITIES section.
 * @returns The document.
 */
function parseEntities(...entities: readonly (readonly Pair[])[]) {
  return parseDxf(dxf(header(4), section("ENTITIES", ...entities)));
}

/**
 * The first entity of a document, failing the test when there is none.
 *
 * @param entities - The drawn entities.
 * @returns The first entity.
 */
function first(entities: readonly DxfEntity[]): DxfEntity {
  const entity = entities[0];
  if (entity === undefined) {
    throw new Error("expected an entity");
  }
  return entity;
}

/**
 * A BLOCKS section with one block named `RACK`, its base at (5, 5).
 *
 * @param records - The entities of the block.
 * @returns The pairs of the section.
 */
function block(...records: readonly (readonly Pair[])[]): Pair[] {
  return [
    [0, "SECTION"],
    [2, "BLOCKS"],
    [0, "BLOCK"],
    [2, "RACK"],
    [8, "0"],
    [10, "5"],
    [20, "5"],
    ...records.flat(),
    [0, "ENDBLK"],
    [0, "ENDSEC"],
  ];
}

/**
 * An INSERT of the `RACK` block on the `SHELVES` layer.
 *
 * @param fields - Extra group pairs, such as the insertion point.
 * @returns The pairs of the record.
 */
function insert(...fields: readonly Pair[]): Pair[] {
  return [[0, "INSERT"], [8, "SHELVES"], [2, "RACK"], ...fields];
}

describe("tokenizer", () => {
  it("reads CRLF and LF files as the same pairs", () => {
    const lf = "0\nSECTION\n2\nENTITIES\n0\nEOF\n";
    const crlf = lf.replace(/\n/g, "\r\n");

    expect([...readPairs(crlf)]).toEqual([...readPairs(lf)]);
    expect([...readPairs(lf)]).toEqual([
      [0, "SECTION"],
      [2, "ENTITIES"],
      [0, "EOF"],
    ]);
  });

  it("refuses an odd number of lines, a non-numeric code and a code without a value", () => {
    expect(() => [...readPairs("0\nSECTION\n2")]).toThrow(DxfError);
    expect(() => [...readPairs("abc\nSECTION\n")]).toThrow(DxfError);
    expect(() => [...readPairs("0\n")]).toThrow(DxfError);
  });

  it("refuses more pairs than the limit", () => {
    const text = "0\nX\n".repeat(DXF_LIMITS.maxPairs + 1);

    expect(() => [...readPairs(text)]).toThrow(expect.objectContaining({ code: "too-complex" }));
  });
});

describe("file refusals", () => {
  it("refuses a binary DXF before reading it", () => {
    expect(refusalOf("AutoCAD Binary DXF\r\n\u001a\u0000")).toBe("binary");
  });

  it("refuses a text above the size limit", () => {
    expect(refusalOf("x".repeat(DXF_LIMITS.maxBytes + 1))).toBe("too-large");
  });

  it("refuses plain text and JSON as not DXF", () => {
    expect(refusalOf("hello world")).toBe("not-dxf");
    expect(refusalOf('{"type":"FeatureCollection"}')).toBe("not-dxf");
  });

  it("refuses a file without any drawable entity as empty", () => {
    expect(refusalOf(dxf(header(4), section("ENTITIES")))).toBe("empty");
  });
});

describe("entities", () => {
  it("reads a LINE with its layer", () => {
    const doc = parseEntities(line("WALLS", [0, 0], [1000, 0]));

    expect(doc.insUnits).toBe(4);
    expect(first(doc.entities)).toEqual({
      kind: "line",
      layer: "WALLS",
      a: [0, 0],
      b: [1000, 0],
    });
  });

  it("reads an open and a closed LWPOLYLINE and counts the bulges it does not draw", () => {
    const open = parseEntities([
      [0, "LWPOLYLINE"],
      [8, "A"],
      [70, "0"],
      [10, "0"],
      [20, "0"],
      [10, "10"],
      [20, "0"],
      [42, "0.5"],
      [10, "10"],
      [20, "10"],
    ]);
    const closed = parseEntities([
      [0, "LWPOLYLINE"],
      [8, "A"],
      [70, "1"],
      [10, "0"],
      [20, "0"],
      [10, "10"],
      [20, "0"],
      [10, "10"],
      [20, "10"],
    ]);

    expect(first(open.entities)).toMatchObject({ kind: "polyline", closed: false });
    expect(open.entities[0]).toMatchObject({
      points: [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
    });
    expect(open.ignored).toEqual({ bulge: 1 });
    expect(first(closed.entities)).toMatchObject({ kind: "polyline", closed: true });
  });

  it("reads a POLYLINE with its VERTEX records up to SEQEND", () => {
    const doc = parseEntities(
      [
        [0, "POLYLINE"],
        [8, "RACKS"],
        [70, "1"],
      ],
      [
        [0, "VERTEX"],
        [8, "RACKS"],
        [10, "0"],
        [20, "0"],
      ],
      [
        [0, "VERTEX"],
        [8, "RACKS"],
        [10, "3000"],
        [20, "0"],
      ],
      [
        [0, "VERTEX"],
        [8, "RACKS"],
        [10, "3000"],
        [20, "1000"],
      ],
      [[0, "SEQEND"]],
    );

    expect(first(doc.entities)).toEqual({
      kind: "polyline",
      layer: "RACKS",
      points: [
        [0, 0],
        [3000, 0],
        [3000, 1000],
      ],
      closed: true,
    });
  });

  it("reads a CIRCLE and an ARC in degrees, counter-clockwise", () => {
    const doc = parseEntities(
      [
        [0, "CIRCLE"],
        [8, "PILLARS"],
        [10, "100"],
        [20, "200"],
        [40, "300"],
      ],
      [
        [0, "ARC"],
        [8, "DOOR"],
        [10, "0"],
        [20, "0"],
        [40, "10"],
        [50, "350"],
        [51, "10"],
      ],
    );

    expect(doc.entities).toEqual([
      { kind: "circle", layer: "PILLARS", center: [100, 200], radius: 300 },
      { kind: "arc", layer: "DOOR", center: [0, 0], radius: 10, startDeg: 350, endDeg: 10 },
    ]);
  });

  it("counts the entities it does not draw by type", () => {
    const doc = parseEntities(
      [
        [0, "TEXT"],
        [8, "NOTES"],
        [10, "0"],
        [20, "0"],
      ],
      [
        [0, "HATCH"],
        [8, "0"],
      ],
      [
        [0, "SPLINE"],
        [8, "0"],
      ],
      line("WALLS", [0, 0], [1, 0]),
    );

    expect(doc.ignored).toEqual({ TEXT: 1, HATCH: 1, SPLINE: 1 });
    expect(doc.entities).toHaveLength(1);
  });

  it("counts an entity with a malformed or non-finite coordinate as invalid", () => {
    const doc = parseEntities(
      [
        [0, "LINE"],
        [8, "A"],
        [10, "1e999"],
        [20, "0"],
        [11, "5"],
        [21, "5"],
      ],
      [
        [0, "LINE"],
        [8, "A"],
        [10, "inf"],
        [20, "0"],
        [11, "5"],
        [21, "5"],
      ],
      [
        [0, "LINE"],
        [8, "A"],
        [10, "2e10"],
        [20, "0"],
        [11, "5"],
        [21, "5"],
      ],
      [
        [0, "CIRCLE"],
        [8, "A"],
        [10, "0"],
        [20, "0"],
        [40, "0"],
      ],
      line("A", [0, 0], [5, 5]),
    );

    expect(doc.ignored).toEqual({ invalid: 4 });
    expect(doc.entities).toHaveLength(1);
  });

  it("uses one generic key for a type that is not a DXF name, so the output keys stay controlled", () => {
    const doc = parseEntities(
      [
        [0, "__proto__"],
        [8, "A"],
      ],
      line("A", [0, 0], [1, 0]),
    );

    expect(Object.hasOwn(doc.ignored, "__proto__")).toBe(false);
    expect(doc.ignored).toEqual({ other: 1 });
  });

  it("sanitises and cuts layer names", () => {
    const doc = parseEntities([
      [0, "LINE"],
      [8, "\u0007<b>" + "x".repeat(100)],
      [10, "0"],
      [20, "0"],
      [11, "1"],
      [21, "0"],
    ]);

    const layer = doc.layers[0]?.name ?? "";
    expect(layer.startsWith("<b>")).toBe(true);
    expect(layer.includes(String.fromCharCode(7))).toBe(false);
    expect(Array.from(layer)).toHaveLength(3 + 100);
    expect(Array.from(doc.layers[0]?.label ?? "")).toHaveLength(DXF_LIMITS.maxLayerNameLength);
  });

  it("keeps distinct long layer names apart, and cuts only their display label", () => {
    const shared = "L".repeat(DXF_LIMITS.maxLayerNameLength + 6);
    const doc = parseEntities(
      line(`${shared}A`, [0, 0], [1, 0]),
      line(`${shared}B`, [0, 0], [2, 0]),
    );

    expect(doc.layers.map((layer) => layer.name)).toEqual([`${shared}A`, `${shared}B`]);
    expect(doc.layers.map((layer) => layer.label)).toEqual([
      "L".repeat(DXF_LIMITS.maxLayerNameLength),
      "L".repeat(DXF_LIMITS.maxLayerNameLength),
    ]);
  });

  it("cuts a key that exceeds the DXF name length at that length", () => {
    const doc = parseEntities(line("M".repeat(400), [0, 0], [1, 0]));

    expect(Array.from(doc.layers[0]?.name ?? "")).toHaveLength(DXF_LIMITS.maxLayerKeyLength);
  });

  it("counts entities per layer", () => {
    const doc = parseEntities(
      line("A", [0, 0], [1, 0]),
      line("A", [0, 0], [2, 0]),
      line("B", [0, 0], [3, 0]),
    );

    expect(doc.layers).toEqual([
      { name: "A", label: "A", entityCount: 2 },
      { name: "B", label: "B", entityCount: 1 },
    ]);
  });
});

describe("block insertions", () => {
  it("moves a block to its insertion point, removing the block base", () => {
    const text = dxf(
      header(4),
      block(line("0", [5, 5], [6, 5])),
      section("ENTITIES", insert([10, "100"], [20, "50"])),
    );

    expect(first(parseDxf(text).entities)).toEqual({
      kind: "line",
      layer: "SHELVES",
      a: [100, 50],
      b: [101, 50],
    });
  });

  it("scales and rotates a block", () => {
    const text = dxf(
      header(4),
      block(line("0", [5, 5], [6, 5])),
      section("ENTITIES", insert([10, "0"], [20, "0"], [41, "2"], [42, "2"], [50, "90"])),
    );

    const entity = first(parseDxf(text).entities);
    expect(entity.kind).toBe("line");
    if (entity.kind !== "line") {
      return;
    }
    expect(entity.a[0]).toBeCloseTo(0, 9);
    expect(entity.a[1]).toBeCloseTo(0, 9);
    expect(entity.b[0]).toBeCloseTo(0, 9);
    expect(entity.b[1]).toBeCloseTo(2, 9);
  });

  it("mirrors a block with a negative scale and reverses an arc so it keeps its length", () => {
    const arc = [
      [0, "ARC"],
      [8, "DOOR"],
      [10, "5"],
      [20, "5"],
      [40, "1"],
      [50, "0"],
      [51, "90"],
    ] as const;
    const text = dxf(
      header(4),
      block(line("0", [5, 5], [6, 5]), [...arc]),
      section("ENTITIES", insert([10, "100"], [20, "50"], [41, "-1"])),
    );

    const [mirroredLine, mirroredArc] = parseDxf(text).entities;
    expect(mirroredLine).toMatchObject({ a: [100, 50], b: [99, 50] });
    expect(mirroredArc).toMatchObject({ kind: "arc" });
    if (mirroredArc?.kind !== "arc") {
      throw new Error("expected an arc");
    }
    expect(mirroredArc.startDeg).toBeCloseTo(90, 9);
    expect(mirroredArc.endDeg).toBeCloseTo(180, 9);
  });

  it("counts an insertion inside a block as nested and does not expand it", () => {
    const text = dxf(
      header(4),
      block([
        [0, "INSERT"],
        [8, "A"],
        [2, "OTHER"],
        [10, "0"],
        [20, "0"],
      ]),
      section("ENTITIES", insert([10, "0"], [20, "0"]), line("A", [0, 0], [1, 0])),
    );

    const doc = parseDxf(text);
    expect(doc.ignored).toEqual({ "INSERT-nested": 1 });
    expect(doc.entities).toHaveLength(1);
  });

  it("counts an insertion of a block that does not exist", () => {
    const text = dxf(
      header(4),
      section("ENTITIES", insert([10, "0"], [20, "0"]), line("A", [0, 0], [1, 0])),
    );

    expect(parseDxf(text).ignored).toEqual({ "INSERT-missing": 1 });
  });

  it("refuses a block insertion bomb quickly", () => {
    const entities = Array.from({ length: 1000 }, () => line("0", [5, 5], [6, 5]));
    const inserts = Array.from({ length: 1000 }, () => insert([10, "0"], [20, "0"]));
    const text = dxf(header(4), block(...entities), section("ENTITIES", ...inserts));

    const started = performance.now();
    expect(refusalOf(text)).toBe("too-complex");
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("hard limits", () => {
  it("refuses a drawing with more layers than allowed", () => {
    const layers = Array.from({ length: DXF_LIMITS.maxLayers + 1 }, (_, index) =>
      line(`L${String(index)}`, [0, 0], [1, 0]),
    );

    expect(refusalOf(dxf(header(4), section("ENTITIES", ...layers)))).toBe("too-complex");
  });

  it("refuses a polyline with too many vertices", () => {
    const vertices: Pair[] = [];
    for (let index = 0; index <= DXF_LIMITS.maxVerticesPerPolyline; index += 1) {
      vertices.push([10, String(index)], [20, "0"]);
    }
    const text = dxf(header(4), section("ENTITIES", [[0, "LWPOLYLINE"], [8, "A"], ...vertices]));

    expect(refusalOf(text)).toBe("too-complex");
  });

  it("refuses a POLYLINE with too many VERTEX records", () => {
    const vertexRecord = (): Pair[] => [
      [0, "VERTEX"],
      [8, "A"],
      [10, "0"],
      [20, "0"],
    ];
    const vertices = Array.from({ length: DXF_LIMITS.maxVerticesPerPolyline + 1 }, vertexRecord);
    const text = dxf(
      header(4),
      section(
        "ENTITIES",
        [
          [0, "POLYLINE"],
          [8, "A"],
        ],
        ...vertices,
        [[0, "SEQEND"]],
      ),
    );

    expect(refusalOf(text)).toBe("too-complex");
  });

  it("refuses a file with more entities than allowed", () => {
    const entities = Array.from({ length: DXF_LIMITS.maxEntities + 1 }, () =>
      line("A", [0, 0], [1, 0]),
    );

    // Spread into an array literal, not into a call: 200 000 arguments would overflow the call stack.
    const body: Pair[] = [[0, "SECTION"], [2, "ENTITIES"], ...entities.flat(), [0, "ENDSEC"]];

    expect(refusalOf(dxf(header(4), body))).toBe("too-complex");
  });

  it("refuses a polyline inserted so often that its vertices exceed the budget", () => {
    const vertices: Pair[] = [];
    for (let index = 0; index < 50_000; index += 1) {
      vertices.push([10, String(index % 1000)], [20, "0"]);
    }
    const polyline = [[0, "LWPOLYLINE"], [8, "A"], ...vertices] as const;
    const inserts = Array.from({ length: 60 }, () => insert([10, "0"], [20, "0"]));
    const text = dxf(header(4), block([...polyline]), section("ENTITIES", ...inserts));

    expect(refusalOf(text)).toBe("too-complex");
  });
});

describe("header", () => {
  it("reads the insertion units, and reports none when the header has no value", () => {
    expect(parseDxf(dxf(header(6), section("ENTITIES", line("A", [0, 0], [1, 0])))).insUnits).toBe(
      6,
    );
    expect(
      parseDxf(dxf(section("HEADER"), section("ENTITIES", line("A", [0, 0], [1, 0])))).insUnits,
    ).toBeNull();
  });
});
