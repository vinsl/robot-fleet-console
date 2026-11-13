/**
 * Design tokens of the console: style "Graphite", layout "Plan".
 *
 * This file is the single source of truth for colours, fonts, sizes, radii, spacing and motion.
 * `tokens.css` mirrors these values as CSS custom properties for Tailwind and shadcn/ui; keep both in
 * sync in the same commit. Design rationale and usage rules: `docs/design/DESIGN.md`.
 *
 * Contrast (WCAG 2.2 AA) was checked for every text pair (>= 4.5:1) and every marker or icon colour
 * (>= 3:1) against `bg.base`, `bg.raised` and the glass fill.
 *
 * @module theme/tokens
 */

/** Neutral surfaces, text and accent. The accent is deliberately white: colour is reserved for states. */
export const color = {
  bg: {
    base: "#050608",
    raised: "#16181C",
  },
  glass: {
    fill: "rgba(22, 24, 28, 0.55)",
    /** Opaque fallback when backdrop-filter is unsupported or transparency is reduced. */
    fallback: "#141619",
    edge: "rgba(255, 255, 255, 0.12)",
    highlight: "rgba(255, 255, 255, 0.10)",
  },
  text: {
    primary: "#F2F3F5",
    secondary: "#A3A5A8",
    tertiary: "#8E9093",
  },
  accent: {
    fill: "#F2F3F5",
    ink: "#0A0B0D",
  },
  /** Near-black used for icons and text drawn on a filled colour. */
  ink: "#0A0B0D",
  focus: {
    ring: "#F2F3F5",
  },
  scrim: {
    soft: "rgba(0, 0, 0, 0.45)",
    strong: "rgba(5, 6, 8, 0.72)",
  },
  /** Semantic robot-state colours, validated on 2026-10-30. Mapping per state: `robot-state-visuals.ts`. */
  state: {
    nominal: "#F2F3F5",
    idle: "#8E949C",
    charging: "#5BD69A",
    human: "#7FB0FF",
    blocked: "#F2B84B",
    estop: "#FF5F57",
    offline: "#6B7078",
  },
  alert: {
    critical: "#FF5F57",
    major: "#F2B84B",
    minor: "#F2F3F5",
    info: "#7FB0FF",
    resolved: "#8E949C",
  },
  estop: {
    /** White text on this fill is 4.8:1. Used only by the e-stop button. */
    fill: "#D7322B",
    text: "#FFFFFF",
  },
  map: {
    wall: "rgba(255, 255, 255, 0.50)",
    rack: "rgba(255, 255, 255, 0.05)",
    rackLine: "rgba(255, 255, 255, 0.20)",
    grid: "rgba(255, 255, 255, 0.045)",
    station: "rgba(255, 255, 255, 0.60)",
    nogoFill: "rgba(255, 95, 87, 0.08)",
    nogoLine: "rgba(255, 95, 87, 0.55)",
  },
} as const;

/** Fonts are self-hosted (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`) to keep the CSP strict. */
export const font = {
  sans: '"Geist Variable", "Geist", system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", ui-monospace, "SFMono-Regular", Menlo, monospace',
  weight: { thin: 300, regular: 400, medium: 500, semibold: 600 },
  /** Pixel sizes of the type scale (compact HUD). */
  size: { xs: 11, sm: 12, base: 13, md: 15, lg: 18, xl: 22, num: 30, numLg: 40 },
  tracking: { number: "-0.02em", label: "0.12em", estop: "0.08em" },
} as const;

/** 4 px spacing scale. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 24, 6: 32, 7: 40 } as const;

/** Corner radii in pixels. */
export const radius = {
  surface: 20,
  inner: 12,
  pill: 9999,
} as const;

/** Compact HUD sizes, in pixels unless stated. */
export const size = {
  control: 40,
  /** Used when `(pointer: coarse)` matches. */
  controlCoarse: 44,
  marker: 24,
  badge: 15,
  focusRing: 2,
  /** Width of glass edges and input borders. */
  hairline: 1,
  panel: 400,
  panelFocus: 560,
  sheetMax: 960,
  dockGap: 4,
} as const;

/** Glass panel blur, saturation and shadow. */
export const glass = {
  blur: 26,
  saturate: 1.5,
  shadow: "inset 0 1px 0 rgba(255, 255, 255, 0.10), 0 20px 50px rgba(0, 0, 0, 0.35)",
} as const;

/** Tilted map plane of the "Plan" layout. Marker projection in JS must use the same values. */
export const map = {
  tiltDeg: 42,
  tiltCompactDeg: 30,
  perspectivePx: 1100,
  /** Below this zoom level markers drop their icon but keep shape, fill style, ring and heading. */
  markerDetailMinZoom: 1,
  staleOpacity: 0.55,
  staleAfterMs: 5_000,
  offlineAfterMs: 15_000,
  /** Zoom bounds and steps of the map viewport. */
  zoomMin: 0.6,
  zoomMax: 8,
  zoomStep: 1.25,
  wheelZoomPerPixel: 0.0015,
  /** Marker interpolation between two samples, clamped to this window. */
  interpolationMinMs: 250,
  interpolationMaxMs: 2_500,
  /** A jump larger than this snaps the marker instead of interpolating it. */
  snapDistanceM: 5,
  /** Distance probed to read the on-screen heading of a robot. */
  headingProbeM: 0.5,
} as const;

/** Alert sound: a repeated critical pattern and a single major tone. Web Audio parameters, not CSS. */
export const alertSound = {
  repeatMs: 4_000,
  toneMs: 180,
  gapMs: 120,
  criticalHz: 880,
  majorHz: 660,
  gain: 0.08,
  /** Fade in and out of each tone, so that it starts and stops without a click. */
  rampMs: 10,
} as const;

/** Realtime timers: keep-alive, clocks, refetch cadences and KPI windows. Not CSS. */
export const live = {
  pingIntervalMs: 300_000,
  nowTickMs: 1_000,
  sessionWindowMs: 3_600_000,
  kpiWarmupMs: 300_000,
  alertsRefetchMs: 60_000,
  historyRefetchMs: 300_000,
  historyWindowMs: 86_400_000,
} as const;

/**
 * Opacity of controls that cannot be used right now. Disabled controls are exempt from the contrast rule (WCAG 1.4.3),
 * so the dimming is what tells the operator that a control is off, next to its disabled state.
 */
export const opacity = {
  disabled: 0.5,
} as const;

/** Durations in milliseconds and the shared easing curve. */
export const motion = {
  easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  panelMs: 220,
  flyToMs: 400,
  pulseMs: 1_800,
  none: 0,
} as const;

/** Viewport sizes in pixels where the layout changes. */
export const breakpoint = {
  phone: 640,
  desktop: 1024,
  /** Height at or below which the layout is compact, so that a phone in landscape gets the phone layout (ADR 0075). */
  compactHeight: 500,
} as const;

/** Stacking order of the floating layers, lowest first. */
export const zIndex = { panel: 5, scrim: 10, sheet: 11, overlay: 20 } as const;

/** Every token group, for consumers that need the whole set. */
export const tokens = {
  color,
  font,
  space,
  radius,
  size,
  glass,
  map,
  motion,
  breakpoint,
  zIndex,
  opacity,
  alertSound,
  live,
} as const;

export type Tokens = typeof tokens;
