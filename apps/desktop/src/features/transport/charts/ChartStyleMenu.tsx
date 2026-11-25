import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

import { PopoverShell } from "../panels/PopoverShell";
import {
  CHART_FONT_FAMILIES,
  CHART_FONTS,
  CHORD_COLOR_SWATCHES,
  chartStyleVars,
  DEFAULT_CHART_STYLE,
  isDefaultChartStyle,
  parseChartStyle,
  type ChartFont,
  type ChartStyle,
  type ChordColor,
} from "./chartStyle";

export const CHART_STYLE_KEY = "lt.liveChart.style";

function readStyle(): ChartStyle {
  try {
    return parseChartStyle(window.localStorage.getItem(CHART_STYLE_KEY));
  } catch {
    return DEFAULT_CHART_STYLE;
  }
}

/** This device's lyrics look, shared by Live, Setlist and full screen. */
export const useChartStyleStore = create<{
  style: ChartStyle;
  update: (patch: Partial<ChartStyle>) => void;
  reset: () => void;
}>((set, get) => {
  const save = (style: ChartStyle) => {
    try {
      window.localStorage.setItem(CHART_STYLE_KEY, JSON.stringify(style));
    } catch {
      // Private mode: it just does not stick.
    }
    set({ style });
  };
  return {
    style: readStyle(),
    update: (patch) => save({ ...get().style, ...patch }),
    reset: () => save(DEFAULT_CHART_STYLE),
  };
});

/** "Style" in the lyrics toolbar: fonts for lyrics and chords, chord colour. */
export function ChartStyleMenu() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const style = useChartStyleStore((state) => state.style);
  const update = useChartStyleStore((state) => state.update);
  const reset = useChartStyleStore((state) => state.reset);
  const customColor = style.chordColor.startsWith("#") && !CHORD_COLOR_SWATCHES.includes(style.chordColor as `#${string}`);

  const fontPicker = (label: string, value: ChartFont, onPick: (font: ChartFont) => void) => (
    <div className="lt-chart-style-fonts" role="radiogroup" aria-label={label}>
      {CHART_FONTS.map((font) => (
        <button
          key={font}
          type="button"
          role="radio"
          aria-checked={font === value}
          className={font === value ? "is-active" : undefined}
          style={{ fontFamily: CHART_FONT_FAMILIES[font] }}
          onClick={() => onPick(font)}
        >
          {t(`chartStyle.font.${font}`)}
        </button>
      ))}
    </div>
  );

  const swatch = (color: ChordColor, label: string, background: string) => (
    <button
      key={color}
      type="button"
      role="radio"
      aria-checked={style.chordColor === color}
      aria-label={label}
      title={label}
      className={`lt-chart-style-swatch${style.chordColor === color ? " is-active" : ""}`}
      style={{ background }}
      onClick={() => update({ chordColor: color })}
    />
  );

  return (
    <div className="lt-lyrics-follow">
      <button
        ref={anchorRef}
        type="button"
        className={`lt-icon-button${isDefaultChartStyle(style) ? "" : " is-active"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        aria-label={t("chartStyle.title")}
        title={t("chartStyle.title")}
      >
        <span className="material-symbols-outlined" aria-hidden="true">format_color_text</span>
      </button>
      <PopoverShell
        open={open}
        anchorRef={anchorRef}
        ariaLabel={t("chartStyle.title")}
        onClose={close}
        className="lt-pads-popover lt-lyrics-follow-panel lt-chart-style-panel"
      >
        <header className="lt-lyrics-follow-header">
          <span className="material-symbols-outlined" aria-hidden="true">format_color_text</span>
          <strong>{t("chartStyle.title")}</strong>
        </header>
        <section className="lt-lyrics-follow-section">
          <div className="lt-lyrics-follow-row">
            <span className="lt-lyrics-follow-label">{t("chartStyle.lyricFont")}</span>
          </div>
          {fontPicker(t("chartStyle.lyricFont"), style.lyricFont, (lyricFont) => update({ lyricFont }))}
        </section>
        <section className="lt-lyrics-follow-section">
          <div className="lt-lyrics-follow-row">
            <span className="lt-lyrics-follow-label">{t("chartStyle.chordFont")}</span>
            <button
              type="button"
              role="switch"
              aria-checked={style.chordBold}
              className={`lt-lyrics-follow-switch${style.chordBold ? " is-on" : ""}`}
              onClick={() => update({ chordBold: !style.chordBold })}
            >
              <span className="lt-lyrics-follow-switch-track" aria-hidden="true">
                <span className="lt-lyrics-follow-switch-thumb" />
              </span>
              {t("chartStyle.bold")}
            </button>
          </div>
          {fontPicker(t("chartStyle.chordFont"), style.chordFont, (chordFont) => update({ chordFont }))}
        </section>
        <section className="lt-lyrics-follow-section">
          <div className="lt-lyrics-follow-row">
            <span className="lt-lyrics-follow-label">{t("chartStyle.chordColor")}</span>
          </div>
          <div className="lt-chart-style-swatches" role="radiogroup" aria-label={t("chartStyle.chordColor")}>
            {swatch("default", t("chartStyle.color.default"), "rgb(var(--lt-c-f6a14c, 246 161 76))")}
            {swatch("accent", t("chartStyle.color.accent"), "var(--lt-accent)")}
            {CHORD_COLOR_SWATCHES.map((color) => swatch(color, color, color))}
            <label
              className={`lt-chart-style-swatch is-custom${customColor ? " is-active" : ""}`}
              title={t("chartStyle.color.custom")}
              style={customColor ? { background: style.chordColor } : undefined}
            >
              <span className="material-symbols-outlined" aria-hidden="true">colorize</span>
              <input
                type="color"
                aria-label={t("chartStyle.color.custom")}
                value={style.chordColor.startsWith("#") ? style.chordColor : "#f6a14c"}
                onChange={(event) => update({ chordColor: event.target.value.toLowerCase() as ChordColor })}
              />
            </label>
          </div>
        </section>
        <section className="lt-lyrics-follow-section lt-chart-style-preview" aria-hidden="true">
          <ChartStylePreview />
        </section>
        <button
          type="button"
          className="lt-chart-style-reset"
          disabled={isDefaultChartStyle(style)}
          onClick={reset}
        >
          {t("chartStyle.reset")}
        </button>
      </PopoverShell>
    </div>
  );
}

/** A line drawn with the chosen look (same classes as the lyrics). */
function ChartStylePreview() {
  const { t } = useTranslation();
  const style = useChartStyleStore((state) => state.style);
  const segments: Array<[string, string]> = [
    ["G", t("chartStyle.preview.a")],
    ["D/F#", t("chartStyle.preview.b")],
    ["Em", t("chartStyle.preview.c")],
  ];
  return (
    <p className="lt-chart-line" style={chartStyleVars(style)}>
      {segments.map(([chord, text]) => (
        <span className="lt-chart-segment" key={chord}>
          <span className="lt-chart-chord">{chord}</span>
          <span className="lt-chart-lyric">{text}</span>
        </span>
      ))}
    </p>
  );
}
