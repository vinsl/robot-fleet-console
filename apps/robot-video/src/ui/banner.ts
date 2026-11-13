/**
 * The control banner across the top of the page: e-stop and teleoperation.
 *
 * The banner is drawn from a plain mapping of shape and token name, because the page is plain
 * TypeScript without the console's React components (ADR 0037). The colours are CSS custom properties
 * resolved from the console tokens, so the page never names a colour itself. A test checks this
 * mapping against the console's robot-state table, so the two cannot drift apart.
 */
import type { VideoStatus } from "@mfc/protocol";
import type { MessageKey } from "../i18n";
import { t } from "../i18n";

/** Shapes the banner icon can take. Each one differs by outline, so no colour is needed to tell them apart. */
export type BannerShape = "octagon" | "dashed-circle";

/** How one banner kind is drawn. Colours are named by token, never by value. */
export interface BannerVisual {
  readonly shape: BannerShape;
  /** Name of the console token (without `--`) that colours the banner. */
  readonly tokenName: string;
  readonly role: "alert" | "status";
  readonly textKey: MessageKey;
}

/** The two banner kinds that can be shown. `NONE` has no visual: the banner is hidden. */
export const BANNER_VISUALS = {
  ESTOP: { shape: "octagon", tokenName: "state-estop", role: "alert", textKey: "banner.estop" },
  TELEOP: {
    shape: "dashed-circle",
    tokenName: "state-human",
    role: "status",
    textKey: "banner.teleop",
  },
} as const satisfies Record<"ESTOP" | "TELEOP", BannerVisual>;

/** A banner that is on screen, with its visual. */
export interface BannerView {
  readonly kind: keyof typeof BANNER_VISUALS;
  readonly visual: BannerVisual;
}

/** SVG namespace, required to create the icon with the DOM API. */
const SVG_NS = "http://www.w3.org/2000/svg";

/** Geometry of the icons on a 24 by 24 grid. These numbers are shapes, not sizes of the UI. */
const OCTAGON_POINTS = "7.5,2 16.5,2 22,7.5 22,16.5 16.5,22 7.5,22 2,16.5 2,7.5";

/**
 * Returns what the banner shows for a status.
 *
 * @param status - The latest status, or null before the first one arrives.
 * @returns The banner to show, or null when none is shown.
 */
export function bannerFor(status: VideoStatus | null): BannerView | null {
  if (status === null || status.banner === "NONE") {
    return null;
  }
  return { kind: status.banner, visual: BANNER_VISUALS[status.banner] };
}

/**
 * Builds the icon of a banner shape with the DOM API.
 *
 * @param shape - The shape to draw.
 * @returns An SVG element that takes its colour from `currentColor`.
 */
function iconFor(shape: BannerShape): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add("banner-icon");
  if (shape === "octagon") {
    const polygon = document.createElementNS(SVG_NS, "polygon");
    polygon.setAttribute("points", OCTAGON_POINTS);
    polygon.setAttribute("fill", "currentColor");
    svg.append(polygon);
  } else {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "9");
    circle.setAttribute("fill", "none");
    circle.setAttribute("stroke", "currentColor");
    circle.setAttribute("stroke-width", "3");
    circle.setAttribute("stroke-dasharray", "4 3");
    svg.append(circle);
  }
  return svg;
}

/**
 * Draws the banner for a status. A hidden banner has no content, so a screen reader does not read it.
 *
 * @param element - The banner container.
 * @param status - The latest status, or null before the first one arrives.
 */
export function renderBanner(element: HTMLElement, status: VideoStatus | null): void {
  const view = bannerFor(status);
  element.replaceChildren();
  if (view === null) {
    element.hidden = true;
    element.removeAttribute("data-kind");
    return;
  }
  element.hidden = false;
  element.dataset.kind = view.kind;
  element.setAttribute("role", view.visual.role);
  element.style.setProperty("--banner-accent", `var(--${view.visual.tokenName})`);
  const text = document.createElement("span");
  text.textContent = t(view.visual.textKey);
  element.append(iconFor(view.visual.shape), text);
}
