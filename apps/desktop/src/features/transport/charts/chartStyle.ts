import type { CSSProperties } from "react";

/** How this device draws lyrics and chords (like Planning Center's chart
 * settings). Only the look: the song is not touched. */
export type ChartFont = "inter" | "grotesk" | "system" | "serif" | "mono";

export const CHART_FONTS: readonly ChartFont[] = ["inter", "grotesk", "system", "serif", "mono"];

/** Bundled fonts or system ones every platform has: nothing is downloaded. */
export const CHART_FONT_FAMILIES: Record<ChartFont, string> = {
  inter: "Inter, sans-serif",
  grotesk: '"Space Grotesk", sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif", serif',
  mono: 'ui-monospace, "Cascadia Mono", Menlo, Consolas, "Roboto Mono", monospace',
};

/** `default` = the theme's orange, `accent` = the theme's accent, or a hex. */
export type ChordColor = "default" | "accent" | `#${string}`;

export const CHORD_COLOR_SWATCHES: readonly `#${string}`[] = [
  "#ff5c5c",
  "#ffd23f",
  "#5fd35f",
  "#3fd0e0",
  "#5c9dff",
  "#b07cff",
  "#ff7ac6",
  "#ffffff",
];

export type ChartStyle = {
  lyricFont: ChartFont;
  chordFont: ChartFont;
  chordColor: ChordColor;
  chordBold: boolean;
};

export const DEFAULT_CHART_STYLE: ChartStyle = {
  lyricFont: "inter",
  chordFont: "inter",
  chordColor: "default",
  chordBold: true,
};

const HEX = /^#[0-9a-f]{6}$/i;

function parseFont(value: unknown): ChartFont | null {
  return typeof value === "string" && (CHART_FONTS as readonly string[]).includes(value) ? (value as ChartFont) : null;
}

function parseColor(value: unknown): ChordColor | null {
  if (value === "default" || value === "accent") return value;
  return typeof value === "string" && HEX.test(value) ? (value.toLowerCase() as ChordColor) : null;
}

/** Whatever is stored, read leniently: an unknown field keeps its default. */
export function parseChartStyle(raw: string | null): ChartStyle {
  if (!raw) return DEFAULT_CHART_STYLE;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_CHART_STYLE;
    value = parsed as Record<string, unknown>;
  } catch {
    return DEFAULT_CHART_STYLE;
  }
  return {
    lyricFont: parseFont(value.lyricFont) ?? DEFAULT_CHART_STYLE.lyricFont,
    chordFont: parseFont(value.chordFont) ?? DEFAULT_CHART_STYLE.chordFont,
    chordColor: parseColor(value.chordColor) ?? DEFAULT_CHART_STYLE.chordColor,
    chordBold: typeof value.chordBold === "boolean" ? value.chordBold : DEFAULT_CHART_STYLE.chordBold,
  };
}

export function isDefaultChartStyle(style: ChartStyle): boolean {
  return (
    style.lyricFont === DEFAULT_CHART_STYLE.lyricFont &&
    style.chordFont === DEFAULT_CHART_STYLE.chordFont &&
    style.chordColor === DEFAULT_CHART_STYLE.chordColor &&
    style.chordBold === DEFAULT_CHART_STYLE.chordBold
  );
}

/** The CSS custom properties LiveChartPanel.css reads. The default style sets
 * none, so the stylesheet's own values (themed) apply. */
export function chartStyleVars(style: ChartStyle): CSSProperties {
  const vars: Record<string, string> = {};
  if (style.lyricFont !== DEFAULT_CHART_STYLE.lyricFont) {
    vars["--lt-chart-lyric-font"] = CHART_FONT_FAMILIES[style.lyricFont];
  }
  if (style.chordFont !== DEFAULT_CHART_STYLE.chordFont) {
    vars["--lt-chart-chord-font"] = CHART_FONT_FAMILIES[style.chordFont];
  }
  if (style.chordColor === "accent") vars["--lt-chart-chord-color"] = "var(--lt-accent)";
  else if (style.chordColor !== "default") vars["--lt-chart-chord-color"] = style.chordColor;
  if (!style.chordBold) vars["--lt-chart-chord-weight"] = "500";
  return vars as CSSProperties;
}
