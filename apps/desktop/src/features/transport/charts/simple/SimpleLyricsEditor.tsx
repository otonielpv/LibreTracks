import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import type { MarkerKind, SectionMarkerSummary, SongChart } from "@libretracks/shared/models";
import { addPart, applyPartEdit, chartParts, joinPart, QUICK_PART_NAMES, splitPart } from "@libretracks/shared/charts/chartParts";
import { parseChordPro } from "@libretracks/shared/charts/chordChart";
import { plainToSectionLines, sectionToPlain } from "@libretracks/shared/charts/plainChart";

import { ChordView } from "./ChordPicker";

import { PartList } from "./PartList";
import { PasteSongDialog } from "./PasteSongDialog";
import "./SimpleLyricsEditor.css";

type SimpleLyricsEditorProps = {
  /** The editor's draft (the same one Advanced edits). */
  chart: SongChart | null;
  markers: readonly SectionMarkerSummary[];
  onChange: (chart: SongChart | null) => void;
  onSave: () => void;
  onImportFile: () => void;
  onImportPlanningCenter: (() => void) | null;
};

/**
 * The simple lyrics editor: the parts of the song on one side, a box where
 * the selected part is written "like on paper" on the other. Everything it
 * decides comes from `@libretracks/shared/charts/chartParts`; this only shows
 * it. The text box keeps what is typed and each change is written to the
 * draft right away, so saving never misses the last keystroke.
 */
export function SimpleLyricsEditor({ chart, markers, onChange, onSave, onImportFile, onImportPlanningCenter }: SimpleLyricsEditorProps) {
  const { t, i18n } = useTranslation() as ReturnType<typeof useTranslation> & { i18n?: { language?: string } };
  const language: "es" | "en" = i18n?.language?.startsWith("en") ? "en" : "es";
  const parts = useMemo(() => chartParts(chart, markers), [chart, markers]);
  const hasMarkers = useMemo(() => markers.some((marker) => !marker.id.includes("~")), [markers]);
  const [selectedKey, setSelectedKey] = useState<string | null>(() => parts[0]?.key ?? null);
  const selected = parts.find((part) => part.key === selectedKey) ?? null;
  const [draft, setDraft] = useState<{ key: string | null; text: string }>(() => ({ key: selectedKey, text: selected?.plain ?? "" }));
  const [clearedTimes, setClearedTimes] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  /** Write the text, or put chords by touch on the words. */
  const [view, setView] = useState<"text" | "chords">("text");

  /** The text this editor last wrote: another one means the draft was
   * replaced from outside (an import), and the box shows the new lyrics. */
  const writtenRef = useRef(chart?.text ?? "");
  const emit = (next: SongChart | null) => {
    writtenRef.current = next?.text ?? "";
    onChange(next);
  };

  // Another part, or the draft replaced from outside: show it.
  useEffect(() => {
    const replaced = (chart?.text ?? "") !== writtenRef.current;
    if (replaced) writtenRef.current = chart?.text ?? "";
    if (replaced || draft.key !== selectedKey) setDraft({ key: selectedKey, text: selected?.plain ?? "" });
  }, [chart?.text, draft.key, selectedKey, selected?.plain]);
  useEffect(() => {
    if (!parts.some((part) => part.key === selectedKey)) setSelectedKey(parts[0]?.key ?? null);
  }, [parts, selectedKey]);

  const select = (key: string) => {
    setSelectedKey(key);
    setClearedTimes(false);
  };

  const commit = (key: string, text: string) => {
    const result = applyPartEdit(chart, markers, key, text);
    if (result.clearedTimes) setClearedTimes(true);
    if (result.chart !== chart) emit(result.chart);
  };

  const type = (text: string) => {
    setDraft({ key: selectedKey, text });
    // An emptied part loses its section: wait until leaving the box.
    if (selectedKey !== null && text.trim()) commit(selectedKey, text);
  };

  const add = (kind: MarkerKind) => {
    const added = addPart(chart, kind, language);
    emit(added.chart);
    select(added.key);
  };

  const split = (markerId: string) => {
    if (!selected) return;
    const next = splitPart(chart, markers, selected.key, markerId);
    if (next === chart) return;
    emit(next);
    select(`m:${markerId}`);
  };
  const joined = selected ? joinPart(chart, markers, selected.key) : chart;
  const join = () => {
    if (!selected || joined === chart) return;
    const first = selected.markerIds[0];
    emit(joined);
    const target = chartParts(joined, markers).find((part) => part.markerIds.includes(first));
    if (target) select(target.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      onSave();
      return;
    }
    if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && parts.length > 0) {
      event.preventDefault();
      const at = Math.max(0, parts.findIndex((part) => part.key === selectedKey));
      const next = parts[Math.min(parts.length - 1, Math.max(0, at + (event.key === "ArrowUp" ? -1 : 1)))];
      select(next.key);
    }
  };

  return (
    <div className="lt-simple-lyrics" onKeyDown={onKeyDown}>
      <PartList
        parts={parts}
        selectedKey={selectedKey}
        onSelect={select}
        onAdd={hasMarkers ? null : add}
        quickName={(kind) => QUICK_PART_NAMES[language][kind] ?? kind}
      />
      <div className="lt-simple-lyrics-main">
        <div className="lt-chart-editor-row">
          <span className="lt-settings-field-label">
            {selected ? t("simpleLyrics.textFor", { part: selected.label || "…" }) : t("simpleLyrics.choosePart")}
          </span>
          <div className="lt-chart-editor-row-actions">
            <button type="button" className="lt-chart-editor-button" onClick={() => setPasteOpen(true)}>
              <span className="material-symbols-outlined" aria-hidden="true">content_paste</span>
              {t("simpleLyrics.pasteSong")}
            </button>
            <button type="button" className="lt-chart-editor-button" onClick={onImportFile}>
              <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
              {t("simpleLyrics.import")}
            </button>
            {onImportPlanningCenter ? (
              <button type="button" className="lt-chart-editor-button" onClick={onImportPlanningCenter}>
                <span className="material-symbols-outlined" aria-hidden="true">library_music</span>
                {t("chartSources.import.open")}
              </button>
            ) : null}
          </div>
        </div>
        {selected && selected.section !== null && selected.times > 1 ? (
          <div className="lt-simple-lyrics-split">
            {selected.markerIds.slice(1).map((markerId, index) => (
              <button key={markerId} type="button" className="lt-chart-editor-button" onClick={() => split(markerId)}>
                {t("simpleLyrics.split", { number: index + 2 })}
              </button>
            ))}
          </div>
        ) : null}
        {selected && joined !== chart ? (
          <div className="lt-simple-lyrics-split">
            <button type="button" className="lt-chart-editor-button" onClick={join}>
              {t("simpleLyrics.join")}
            </button>
          </div>
        ) : null}
        <div className="lt-chart-editor-modes lt-simple-lyrics-views" role="tablist" aria-label={t("simpleLyrics.viewLabel")}>
          {(["text", "chords"] as const).map((option) => (
            <button key={option} type="button" role="tab" aria-selected={view === option} disabled={!selected} onClick={() => setView(option)}>
              {t(option === "text" ? "simpleLyrics.viewText" : "simpleLyrics.viewChords")}
            </button>
          ))}
        </div>
        {view === "chords" && selected ? (
          <ChordView
            lines={plainToSectionLines(draft.text)}
            songLines={chart ? parseChordPro(chart.text).sections.flatMap((section) => section.lines) : []}
            onChange={(lines) => type(sectionToPlain({ lines }))}
          />
        ) : (
        <textarea
          className="lt-simple-lyrics-textarea"
          value={selected ? draft.text : ""}
          disabled={!selected}
          spellCheck={false}
          placeholder={t("simpleLyrics.placeholder")}
          aria-label={selected ? t("simpleLyrics.textFor", { part: selected.label || "…" }) : t("simpleLyrics.choosePart")}
          onChange={(event) => type(event.target.value)}
          onBlur={() => {
            if (selectedKey !== null && !draft.text.trim()) commit(selectedKey, draft.text);
          }}
        />
        )}
        <small>{t("simpleLyrics.help")}</small>
        {clearedTimes ? (
          <p className="lt-simple-lyrics-notice" role="status">
            {t("simpleLyrics.clearedTimes")}
          </p>
        ) : null}
      </div>
      {pasteOpen ? (
        <PasteSongDialog
          chart={chart}
          markers={markers}
          language={language}
          onApply={(next, cleared) => {
            onChange(next);
            if (cleared) setClearedTimes(true);
            setPasteOpen(false);
          }}
          onClose={() => setPasteOpen(false)}
        />
      ) : null}
    </div>
  );
}
