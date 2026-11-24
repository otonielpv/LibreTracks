import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ChartLine } from "@libretracks/shared/charts/chordChart";
import { chordsByIndex, setChordAt, usedChords, usesLatinNotation } from "@libretracks/shared/charts/plainChart";

const AMERICAN = ["C", "C#", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const LATIN = ["Do", "Do#", "Reb", "Re", "Mib", "Mi", "Fa", "Fa#", "Sol", "Lab", "La", "Sib", "Si"];
const QUALITIES = ["", "m", "7", "m7", "maj7", "sus4", "sus2", "add9", "dim"];

type Target = { line: number; index: number; chord: string | null };

type ChordViewProps = {
  lines: readonly ChartLine[];
  /** All the song's chords, for "already used" first. */
  songLines: readonly ChartLine[];
  onChange: (lines: ChartLine[]) => void;
};

/**
 * Chords by touch: the part's lyrics as words; tapping a word puts a chord
 * on its first letter, tapping a chord changes or removes it. The result is
 * the same as typing the chord line by hand (`setChordAt`).
 */
export function ChordView({ lines, songLines, onChange }: ChordViewProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Target | null>(null);
  const latin = usesLatinNotation(songLines);

  const apply = (chord: string | null) => {
    if (!target) return;
    const next = lines.map((line, index) =>
      index === target.line && line.kind === "lyrics" ? setChordAt(line.segments, target.index, chord) : line,
    );
    onChange(next);
    setTarget(null);
  };

  return (
    <div className="lt-simple-chords">
      {lines.map((line, lineIndex) => {
        if (line.kind !== "lyrics") return null;
        const text = line.segments.map((segment) => segment.text).join("");
        const chords = chordsByIndex(line.segments);
        const words = [...text.matchAll(/\S+/g)].map((match) => ({ start: match.index ?? 0, word: match[0] }));
        if (words.length === 0) words.push({ start: 0, word: "" });
        return (
          <div className="lt-simple-chords-line" key={lineIndex}>
            {words.map(({ start, word }, wordIndex) => {
              const end = words[wordIndex + 1]?.start ?? Number.POSITIVE_INFINITY;
              const own = [...chords.entries()].filter(([at]) => (wordIndex === 0 ? at < end : at >= start && at < end));
              return (
                <span className="lt-simple-chords-word" key={start}>
                  <span className="lt-simple-chords-marks">
                    {own.map(([at, chord]) => (
                      <button key={at} type="button" className="lt-simple-chords-chord" onClick={() => setTarget({ line: lineIndex, index: at, chord })}>
                        {chord}
                      </button>
                    ))}
                  </span>
                  <button
                    type="button"
                    className="lt-simple-chords-syllable"
                    onClick={() => setTarget({ line: lineIndex, index: start, chord: chords.get(start) ?? null })}
                  >
                    {word || "♪"}
                  </button>
                </span>
              );
            })}
          </div>
        );
      })}
      {target ? (
        <ChordPicker
          latin={latin}
          used={usedChords(songLines)}
          current={target.chord}
          onPick={apply}
          onRemove={target.chord ? () => apply(null) : null}
          onClose={() => setTarget(null)}
          title={t("simpleLyrics.chordFor")}
        />
      ) : null}
    </div>
  );
}

type ChordPickerProps = {
  latin: boolean;
  used: readonly string[];
  current: string | null;
  onPick: (chord: string) => void;
  onRemove: (() => void) | null;
  onClose: () => void;
  title: string;
};

/** Root + kind + bass, with the chords the song already uses first. */
export function ChordPicker({ latin, used, current, onPick, onRemove, onClose, title }: ChordPickerProps) {
  const { t } = useTranslation();
  const roots = latin ? LATIN : AMERICAN;
  const [root, setRoot] = useState<string | null>(null);
  const [quality, setQuality] = useState("");
  const [bass, setBass] = useState("");
  const built = root ? `${root}${quality}${bass ? `/${bass}` : ""}` : null;
  return (
    <div className="lt-modal-backdrop" onClick={onClose}>
      <section className="lt-settings-modal lt-simple-chord-picker" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="lt-settings-modal-header">
          <div>
            <h2>{title}</h2>
            {current ? <p>{current}</p> : null}
          </div>
        </header>
        <div className="lt-settings-modal-body">
          {used.length > 0 ? (
            <>
              <span className="lt-settings-field-label">{t("simpleLyrics.usedChords")}</span>
              <div className="lt-simple-chord-grid">
                {used.map((chord) => (
                  <button key={chord} type="button" className="lt-chart-editor-button" onClick={() => onPick(chord)}>
                    {chord}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          <span className="lt-settings-field-label">{t("simpleLyrics.chordRoot")}</span>
          <div className="lt-simple-chord-grid">
            {roots.map((name) => (
              <button key={name} type="button" className={`lt-chart-editor-button${root === name ? " is-active" : ""}`} aria-pressed={root === name} onClick={() => setRoot(name)}>
                {name}
              </button>
            ))}
          </div>
          <span className="lt-settings-field-label">{t("simpleLyrics.chordKind")}</span>
          <div className="lt-simple-chord-grid">
            {QUALITIES.map((name) => (
              <button key={name || "maj"} type="button" className={`lt-chart-editor-button${quality === name ? " is-active" : ""}`} aria-pressed={quality === name} onClick={() => setQuality(name)}>
                {name || t("simpleLyrics.chordMajor")}
              </button>
            ))}
          </div>
          <span className="lt-settings-field-label">{t("simpleLyrics.chordBass")}</span>
          <div className="lt-simple-chord-grid">
            <button type="button" className={`lt-chart-editor-button${bass === "" ? " is-active" : ""}`} aria-pressed={bass === ""} onClick={() => setBass("")}>
              {t("simpleLyrics.chordNoBass")}
            </button>
            {roots.map((name) => (
              <button key={name} type="button" className={`lt-chart-editor-button${bass === name ? " is-active" : ""}`} aria-pressed={bass === name} onClick={() => setBass(name)}>
                /{name}
              </button>
            ))}
          </div>
        </div>
        <div className="lt-inline-actions">
          {onRemove ? (
            <button type="button" className="lt-secondary-button" onClick={onRemove}>
              {t("simpleLyrics.chordRemove")}
            </button>
          ) : null}
          <button type="button" className="lt-secondary-button" onClick={onClose}>
            {t("simpleLyrics.cancel")}
          </button>
          <button type="button" className="is-primary" disabled={!built} onClick={() => built && onPick(built)}>
            {built ? t("simpleLyrics.chordPut", { chord: built }) : t("simpleLyrics.chordPutEmpty")}
          </button>
        </div>
      </section>
    </div>
  );
}
