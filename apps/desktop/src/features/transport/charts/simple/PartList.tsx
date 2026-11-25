import { useTranslation } from "react-i18next";

import type { MarkerKind } from "@libretracks/shared/models";
import type { ChartPartEntry } from "@libretracks/shared/charts/chartParts";

/** The quick buttons of a song without markers, in the order a song goes. */
export const QUICK_PART_KINDS: MarkerKind[] = ["intro", "verse", "pre_chorus", "chorus", "bridge", "ending"];

type PartListProps = {
  entries: readonly ChartPartEntry[];
  selectedKey: string | null;
  /** Times a row sings its part in a row (absent = once). */
  passes?: Readonly<Record<string, number>>;
  onSelect: (key: string) => void;
  /** Songs without markers: add a part of this kind. */
  onAdd: ((kind: MarkerKind) => void) | null;
  quickName: (kind: MarkerKind) => string;
};

/**
 * The song's sections, one row per marker in the order they play (as on the
 * timeline), on the side of the simple editor (chips on a phone). Each one
 * has its own lyrics.
 */
export function PartList({ entries, selectedKey, passes = {}, onSelect, onAdd, quickName }: PartListProps) {
  const { t } = useTranslation();
  return (
    <nav className="lt-simple-lyrics-parts" aria-label={t("simpleLyrics.parts")}>
      <ul>
        {entries.map((entry) => (
          <li key={entry.key}>
            <button
              type="button"
              className={`lt-simple-lyrics-part${entry.key === selectedKey ? " is-selected" : ""}${entry.sung ? "" : " is-instrumental"}`}
              aria-pressed={entry.key === selectedKey}
              title={entry.sung ? undefined : t("simpleLyrics.instrumental")}
              onClick={() => onSelect(entry.key)}
            >
              <span className="lt-simple-lyrics-part-position">{String(entry.position).padStart(2, "0")}</span>
              <span className="lt-simple-lyrics-part-name">{entry.label || "…"}</span>
              {(passes[entry.key] ?? 1) > 1 ? (
                <span className="lt-simple-lyrics-part-passes" title={t("simpleLyrics.passesNote", { count: passes[entry.key] })}>
                  ×{passes[entry.key]}
                </span>
              ) : null}
              {entry.section !== null ? (
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
