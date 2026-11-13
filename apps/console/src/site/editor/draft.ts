/**
 * The editor's draft: the checks the operator sees while placing features, and the layers the canvas draws.
 *
 * The draft can be incomplete (no charger yet), so it is drawn from its parts rather than from a site map, which
 * the protocol only accepts once complete. {@link buildDraftMap} runs the protocol check on a complete draft; the
 * server stays the authority at save time, so these checks only shorten the feedback loop.
 */
import {
  SITE_MAP_NAME_PATTERN,
  WORKSTATION_SIZE_MAX_M,
  WORKSTATION_SIZE_MIN_M,
  type SiteMap,
} from "@mfc/protocol";
import {
  buildSiteMap,
  rectToRing,
  SiteMapBuildError,
  type EditorFeatures,
  type Imported,
  type Size,
} from "../dxf/build-site-map";
import type { Point } from "../dxf/types";
import type { FeatureLayers } from "../render/map-geometry";
import { workstationRect } from "./shapes";

/** A feature of the editor that an issue or a selection refers to. */
export type FeatureRef =
  | { readonly kind: "charger" }
  | { readonly kind: "workstation"; readonly index: number }
  | { readonly kind: "nogo"; readonly index: number };

/** A reason the draft cannot be saved yet. The UI maps each kind to a message. */
export type DraftIssue =
  | { readonly kind: "noCharger" }
  | { readonly kind: "fewWorkstations" }
  | { readonly kind: "badName"; readonly index: number }
  | { readonly kind: "duplicateName"; readonly index: number }
  | { readonly kind: "badNogo"; readonly index: number }
  | { readonly kind: "badSize"; readonly index: number }
  | { readonly kind: "outside"; readonly item: FeatureRef };

/** Features placed by nothing: the starting point of an editor, and of a reset. */
export const EMPTY_FEATURES: EditorFeatures = { charger: null, workstations: [], nogo: [] };

/** Fewest workstations a plan can have. The protocol requires two; a draft says so before the server does. */
const MIN_WORKSTATIONS = 2;

/**
 * Tells whether a point lies inside the imported plan.
 *
 * @param point - The point in metres.
 * @param extent - The far corner of the plan, in metres; the plan starts at the origin.
 * @returns `true` when the point is on or inside the plan.
 */
function insidePlan(point: Point, extent: Point): boolean {
  return point[0] >= 0 && point[0] <= extent[0] && point[1] >= 0 && point[1] <= extent[1];
}

/**
 * Tells whether a workstation footprint side is within the protocol range: finite, and between the minimum and the
 * maximum the schema accepts.
 *
 * @param value - One side of the footprint, in metres.
 * @returns `true` when the side can be saved.
 */
export function usableSide(value: number): boolean {
  return (
    Number.isFinite(value) && value >= WORKSTATION_SIZE_MIN_M && value <= WORKSTATION_SIZE_MAX_M
  );
}

/**
 * Tells whether a workstation footprint has a usable size on both sides.
 *
 * @param size - The footprint size.
 * @returns `true` when both sides can be saved.
 */
function usableSize(size: Size): boolean {
  return usableSide(size.width) && usableSide(size.height);
}

/**
 * Tells whether a rectangle has a usable size: finite, with a positive width and height.
 *
 * @param rect - The rectangle fields.
 * @returns `true` when the rectangle can be drawn.
 */
function usableRect(rect: {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}): boolean {
  return [rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) && rect.w > 0 && rect.h > 0;
}

/**
 * Lists the reasons the draft cannot be saved yet, in the order the operator should fix them.
 *
 * Names follow the protocol grammar and must be unique; a workstation footprint and a no-go zone must have a size;
 * every feature must lie on the plan when the plan is known. A workstation lies on the plan by its whole footprint,
 * so a footprint that crosses the edge is refused even when its centre is inside. A workstation with an unusable size
 * has no footprint to test, so only its size is reported.
 *
 * @param editor - The features placed so far.
 * @param extent - The far corner of the imported plan, or `null` before the import.
 * @returns The issues, empty when the draft is complete.
 */
export function draftIssues(editor: EditorFeatures, extent: Point | null): DraftIssue[] {
  const issues: DraftIssue[] = [];
  if (editor.charger === null) {
    issues.push({ kind: "noCharger" });
  }
  if (editor.workstations.length < MIN_WORKSTATIONS) {
    issues.push({ kind: "fewWorkstations" });
  }

  const seen = new Set<string>();
  editor.workstations.forEach((workstation, index) => {
    if (!SITE_MAP_NAME_PATTERN.test(workstation.name)) {
      issues.push({ kind: "badName", index });
    } else if (seen.has(workstation.name)) {
      issues.push({ kind: "duplicateName", index });
    }
    seen.add(workstation.name);
    if (!usableSize(workstation.size)) {
      issues.push({ kind: "badSize", index });
    }
  });

  editor.nogo.forEach((rect, index) => {
    if (!usableRect(rect)) {
      issues.push({ kind: "badNogo", index });
    }
  });

  if (extent !== null) {
    if (editor.charger !== null && !insidePlan(editor.charger, extent)) {
      issues.push({ kind: "outside", item: { kind: "charger" } });
    }
    editor.workstations.forEach((workstation, index) => {
      if (
        usableSize(workstation.size) &&
        !rectToRing(workstationRect(workstation)).every((corner) => insidePlan(corner, extent))
      ) {
        issues.push({ kind: "outside", item: { kind: "workstation", index } });
      }
    });
    editor.nogo.forEach((rect, index) => {
      if (usableRect(rect) && !rectToRing(rect).every((corner) => insidePlan(corner, extent))) {
        issues.push({ kind: "outside", item: { kind: "nogo", index } });
      }
    });
  }
  return issues;
}

/**
 * The layers the canvas draws for a draft: the imported walls and obstacles, and the features placed so far.
 *
 * @param imported - The imported geometry, or `null` before the import (the canvas then shows only features).
 * @param editor - The features placed so far.
 * @returns The grouped layers.
 */
export function draftLayers(imported: Imported | null, editor: EditorFeatures): FeatureLayers {
  return {
    walls: imported?.walls ?? [],
    obstacles: imported?.obstacles ?? [],
    nogo: editor.nogo.map(rectToRing),
    charger: editor.charger,
    workstations: editor.workstations.map((workstation) => ({
      name: workstation.name,
      at: workstation.at,
      size: workstation.size,
    })),
  };
}

/**
 * Builds the site map of a complete draft, checked against the protocol schema.
 *
 * The version is a placeholder: the server numbers the map when the slot is reserved, so a draft carries 1 until
 * then. The map is only a check of the draft, and nothing is sent from here.
 *
 * @param imported - The imported geometry.
 * @param editor - The features placed so far.
 * @returns The validated map, or `null` when the draft does not satisfy the protocol yet.
 */
export function buildDraftMap(imported: Imported, editor: EditorFeatures): SiteMap | null {
  try {
    return buildSiteMap(imported, editor, 1);
  } catch (error) {
    if (error instanceof SiteMapBuildError) {
      return null;
    }
    throw error;
  }
}
