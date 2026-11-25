import { useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type { ChartLine, ChartSection } from "@libretracks/shared/charts/chordChart";

/** The words of a line as sung (chords left out), or its comment. */
function lineText(line: ChartLine): string {
  if (line.kind === "lyrics") return line.segments.map((segment) => segment.text).join("").trim();
  return line.text.trim();
}

/** The lines a section sings: what a pass spreads over. */
export function sungLines(section: ChartSection): string[] {
  return section.lines.filter((line) => line.kind === "lyrics").map(lineText).filter(Boolean);
}

/**
 * A small eye next to the section a marker shows: hover (or tap) it and the
 * whole section appears in a little box, with how many lines it has, so the
 * passes (×2, ×3) can be set without scrolling the text.
 */
export function SectionPeek({ section, name }: { section: ChartSection; name: string }) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [place, setPlace] = useState<CSSProperties | null>(null);
  const [pinned, setPinned] = useState(false);
  const lines = sungLines(section);

  const show = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Fixed so the modal's scroller never cuts it; opens upward near the bottom.
    const below = rect.bottom < window.innerHeight * 0.6;
    setPlace({
      position: "fixed",
      right: Math.max(8, window.innerWidth - rect.right),
      ...(below ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
    });
  };
  const hide = () => {
    setPlace(null);
    setPinned(false);
  };

  return (
    <span className="lt-section-peek" onMouseEnter={show} onMouseLeave={() => (pinned ? null : setPlace(null))}>
      <button
        ref={buttonRef}
        type="button"
        className="lt-section-peek-button"
        aria-label={t("liveChart.peekSection", { section: name })}
        aria-expanded={place !== null}
        onClick={() => {
          if (pinned) hide();
          else {
            show();
            setPinned(true);
          }
        }}
        onBlur={hide}
      >
        <span className="material-symbols-outlined" aria-hidden="true">visibility</span>
      </button>
      {place ? (
        <span className="lt-section-peek-box" role="tooltip" style={place}>
          <span className="lt-section-peek-head">
            {name} · {t("liveChart.peekLines", { count: lines.length })}
          </span>
          {lines.length === 0 ? (
            <span className="lt-section-peek-empty">{t("liveChart.peekEmpty")}</span>
          ) : (
            // Not <li>: the links list styles its own rows as a grid.
            <span className="lt-section-peek-lines" role="list">
              {lines.map((text, index) => (
                <span key={index} className="lt-section-peek-line" role="listitem">
                  {text}
                </span>
              ))}
            </span>
          )}
        </span>
      ) : null}
    </span>
  );
}
