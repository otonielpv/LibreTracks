import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";

import { useDismissOnBack } from "../mobile/backNavigation";
import { PopoverShell } from "../panels/PopoverShell";
import {
  CHART_FONT_FAMILIES,
  CHART_FONTS,
  CHORD_COLOR_SWATCHES,
  chartStyleVars,
  DEFAULT_CHART_STYLE,
  isDefaultChartStyle,
  parseChartStyle,
  chartFontFamily,
  systemFamilyOf,
  systemFont,
  type ChartFont,
  type ChartStyle,
  type ChordColor,
} from "./chartStyle";
import { listSystemFonts } from "../desktopApi";

/** Installed families, asked for once per run (the scan is cached in Rust). */
let systemFontsRequest: Promise<string[]> | null = null;
function loadSystemFonts(): Promise<string[]> {
  systemFontsRequest ??= listSystemFonts().catch(() => []);
  return systemFontsRequest;
}

/** Only for tests: forget the cached list. */
export function resetSystemFontsCache() {
  systemFontsRequest = null;
}

const MAX_LISTED_FONTS = 300;

/** Phone or tablet. There the list opens as a full-screen sheet: inside the
 * popover it got ~180 px in landscape on an iPhone, and the keyboard covered
 * all of it. The search also waits to be tapped instead of popping the
 * keyboard on open. */
function touchFirst(): boolean {
  try {
    return window.matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** The part of the screen above the keyboard. Neither Android's WebView nor
 * WKWebView shrink the window for it, only `visualViewport`. */
function useVisibleArea(enabled: boolean): { top: number; height: number } | null {
  const [area, setArea] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!enabled || !viewport) return;
    const update = () => setArea({ top: viewport.offsetTop, height: viewport.height });
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
    };
  }, [enabled]);
  return enabled ? area : null;
}

function dismissKeyboard() {
  const active = document.activeElement;
  if (active instanceof HTMLInputElement) active.blur();
}

/** "Font installed on this device": a button showing the chosen one, which
 * opens a searchable list, each name drawn in its own font. */
function SystemFontPicker({
  label,
  value,
  onPick,
}: {
  label: string;
  value: ChartFont;
  onPick: (font: ChartFont) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [asSheet] = useState(touchFirst);
  const close = useCallback(() => setOpen(false), []);
  const chosen = systemFamilyOf(value);
  const listLabel = `${label}: ${t("chartStyle.systemFonts")}`;
  return (
    <div className="lt-chart-style-system">
      <button
        type="button"
        className={`lt-chart-style-system-toggle${chosen ? " is-active" : ""}`}
        aria-expanded={open}
        aria-label={listLabel}
        onClick={() => setOpen((current) => !current)}
        style={chosen ? { fontFamily: chartFontFamily(value) } : undefined}
      >
        <span className="material-symbols-outlined" aria-hidden="true">font_download</span>
        <span className="lt-chart-style-system-name">{chosen ?? t("chartStyle.systemFonts")}</span>
        <span className="material-symbols-outlined" aria-hidden="true">{open ? "expand_less" : "expand_more"}</span>
      </button>
      {open ? (
        asSheet ? (
          <SystemFontSheet listLabel={listLabel} chosen={chosen} onPick={onPick} onClose={close} />
        ) : (
          <div className="lt-chart-style-system-panel">
            <SystemFontList listLabel={listLabel} chosen={chosen} onPick={onPick} onClose={close} autoFocus />
          </div>
        )
      ) : null}
    </div>
  );
}

type FontListProps = {
  listLabel: string;
  chosen: string | null;
  onPick: (font: ChartFont) => void;
  onClose: () => void;
};

/** Touch: the list over the whole screen above the keyboard (in landscape
 * that leaves ~190 px, so search and close share one row). Fixed inside the
 * popover so its taps still count as inside it. */
function SystemFontSheet({ listLabel, chosen, onPick, onClose }: FontListProps) {
  const { t } = useTranslation();
  useDismissOnBack(onClose);
  const area = useVisibleArea(true);
  return (
    <div
      className="lt-chart-style-system-panel is-sheet"
      style={area ? { top: `${area.top}px`, height: `${area.height}px` } : undefined}
    >
      <SystemFontList
        listLabel={listLabel}
        chosen={chosen}
        onPick={onPick}
        onClose={onClose}
        searchAside={
          <button
            type="button"
            className="lt-icon-button"
            aria-label={t("common.close")}
            title={t("common.close")}
            onClick={onClose}
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        }
      />
    </div>
  );
}

function SystemFontList({
  listLabel,
  chosen,
  onPick,
  onClose,
  autoFocus = false,
  searchAside,
}: FontListProps & { autoFocus?: boolean; searchAside?: ReactNode }) {
  const { t } = useTranslation();
  const [fonts, setFonts] = useState<string[] | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    void loadSystemFonts().then((names) => {
      if (alive) setFonts(names);
    });
    return () => {
      alive = false;
    };
  }, []);
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = fonts ?? [];
    return (needle ? all.filter((name) => name.toLowerCase().includes(needle)) : all).slice(0, MAX_LISTED_FONTS);
  }, [fonts, query]);
  return (
    <>
      <div className="lt-chart-style-system-search-row">
        <input
          type="search"
          className="lt-chart-style-system-search"
          placeholder={t("chartStyle.searchFonts")}
          aria-label={t("chartStyle.searchFonts")}
          value={query}
          autoFocus={autoFocus}
          onChange={(event) => setQuery(event.target.value)}
        />
        {searchAside}
      </div>
      {fonts === null ? (
        <p className="lt-chart-style-system-note">{t("chartStyle.loadingFonts")}</p>
      ) : fonts.length === 0 ? (
        <p className="lt-chart-style-system-note">{t("chartStyle.noSystemFonts")}</p>
      ) : matches.length === 0 ? (
        <p className="lt-chart-style-system-note">{t("chartStyle.noFontMatch")}</p>
      ) : (
        <ul
          className="lt-chart-style-system-list"
          role="listbox"
          aria-label={listLabel}
          // Scrolling the list means the search is done: drop the keyboard
          // so the list gets the screen back.
          onTouchStart={dismissKeyboard}
        >
          {matches.map((name) => (
            <li key={name} role="option" aria-selected={name === chosen}>
              <button
                type="button"
                className={name === chosen ? "is-active" : undefined}
                style={{ fontFamily: chartFontFamily(systemFont(name)) }}
                onClick={() => {
                  onPick(systemFont(name));
                  onClose();
                }}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

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
    <>
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
    <SystemFontPicker label={label} value={value} onPick={onPick} />
    </>
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
