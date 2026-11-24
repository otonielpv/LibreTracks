import { useTranslation } from "react-i18next";

import type { MarkerKind } from "@libretracks/shared/models";
import type { ChartPart } from "@libretracks/shared/charts/chartParts";

/** The quick buttons of a song without markers, in the order a song goes. */
export const QUICK_PART_KINDS: MarkerKind[] = ["intro", "verse", "pre_chorus", "chorus", "bridge", "ending"];

type PartListProps = {
  parts: readonly ChartPart[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  /** Songs without markers: add a part of this kind. */
  onAdd: ((kind: MarkerKind) => void) | null;
  quickName: (kind: MarkerKind) => string;
};

/** The parts of the song, on the side of the simple editor (chips on a phone). */
export function PartList({ parts, selectedKey, onSelect, onAdd, quickName }: PartListProps) {
  const { t } = useTranslation();
  return (
    <nav className="lt-simple-lyrics-parts" aria-label={t("simpleLyrics.parts")}>
      <ul>
        {parts.map((part) => (
          <li key={part.key}>
            <button
              type="button"
              className={`lt-simple-lyrics-part${part.key === selectedKey ? " is-selected" : ""}${part.sung ? "" : " is-instrumental"}`}
              aria-pressed={part.key === selectedKey}
              title={part.sung ? undefined : t("simpleLyrics.instrumental")}
              onClick={() => onSelect(part.key)}
            >
              <span className="lt-simple-lyrics-part-name">{part.label || "…"}</span>
              {part.times > 1 ? (
                <span className="lt-simple-lyrics-part-times" title={t("simpleLyrics.timesSung", { count: part.times })}>
                  ×{part.times}
                </span>
              ) : null}
              {part.section !== null ? (
                <span className="material-symbols-outlined lt-simple-lyrics-part-done" aria-label={t("simpleLyrics.hasLyrics")}>
                  check
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {onAdd ? (
        <div className="lt-simple-lyrics-quick">
          <p>{t("simpleLyrics.noMarkers")}</p>
          {QUICK_PART_KINDS.map((kind) => (
            <button key={kind} type="button" className="lt-chart-editor-button" onClick={() => onAdd(kind)}>
              <span className="material-symbols-outlined" aria-hidden="true">add</span>
              {t("simpleLyrics.addPart", { part: quickName(kind) })}
            </button>
          ))}
        </div>
      ) : null}
    </nav>
  );
}
