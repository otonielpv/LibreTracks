import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SectionMarkerSummary, SongChart } from "@libretracks/shared/models";
import { chartParts } from "@libretracks/shared/charts/chartParts";
import {
  applyPaste,
  proposePasteAssignment,
  splitPastedSong,
  type PasteAssignment,
  type PastedBlock,
} from "@libretracks/shared/charts/pasteSong";

type PasteSongDialogProps = {
  chart: SongChart | null;
  markers: readonly SectionMarkerSummary[];
  language: "es" | "en";
  onApply: (chart: SongChart | null, clearedTimes: boolean) => void;
  onClose: () => void;
};

/**
 * "Paste whole song": the text is cut into blocks and each one comes with
 * its part already chosen; nothing is applied before the user reviews it.
 */
export function PasteSongDialog({ chart, markers, language, onApply, onClose }: PasteSongDialogProps) {
  const { t } = useTranslation();
  const [text, setText] = useState("");
  const [review, setReview] = useState<{ blocks: PastedBlock[]; assignments: PasteAssignment[] } | null>(null);
  const parts = useMemo(() => chartParts(chart, markers), [chart, markers]);

  const startReview = () => {
    const blocks = splitPastedSong(text);
    setReview({ blocks, assignments: proposePasteAssignment(blocks, parts, markers) });
  };
  // Picking a section by hand sends the block there only.
  const assign = (block: number, partKey: string | null) =>
    setReview((current) =>
      current
        ? {
            ...current,
            assignments: current.assignments.map((entry) =>
              entry.block === block ? { ...entry, partKeys: partKey ? [partKey] : [], confidence: "high" } : entry,
            ),
          }
        : current,
    );
  const position = (key: string) => parts.findIndex((part) => part.key === key) + 1;
  const partName = (key: string) => {
    const part = parts.find((candidate) => candidate.key === key);
    return part ? `${String(position(key)).padStart(2, "0")} ${part.label}` : key;
  };
  const apply = () => {
    if (!review) return;
    const result = applyPaste(chart, markers, review.blocks, review.assignments, language);
    onApply(result.chart, result.clearedTimes);
  };
  const confidence = { high: t("simpleLyrics.confidenceHigh"), medium: t("simpleLyrics.confidenceMedium"), low: t("simpleLyrics.confidenceLow") };

  return (
    <div className="lt-modal-backdrop" onClick={onClose}>
      <section
        className="lt-settings-modal lt-simple-lyrics-paste"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-simple-lyrics-paste-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <h2 id="lt-simple-lyrics-paste-title">{t("simpleLyrics.pasteTitle")}</h2>
            <p>{t("simpleLyrics.pasteHelp")}</p>
          </div>
        </header>
        <div className="lt-settings-modal-body">
          {review === null ? (
            <textarea
              className="lt-simple-lyrics-textarea"
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              aria-label={t("simpleLyrics.pasteLabel")}
              autoFocus
            />
          ) : (
            <ol className="lt-simple-lyrics-blocks">
              {review.blocks.map((block, index) => {
                const assignment = review.assignments[index];
                return (
                  <li key={index}>
                    <div className="lt-simple-lyrics-block-head">
                      <select
                        value={assignment.partKeys[0] ?? ""}
                        aria-label={t("simpleLyrics.blockFor", { number: index + 1 })}
                        onChange={(event) => assign(index, event.target.value || null)}
                      >
                        <option value="">{t("simpleLyrics.newPart")}{block.label ? `: ${block.label}` : ""}</option>
                        {parts.map((part) => (
                          <option key={part.key} value={part.key}>
                            {partName(part.key)}
                          </option>
                        ))}
                      </select>
                      <span className={`lt-simple-lyrics-confidence is-${assignment.confidence}`}>{confidence[assignment.confidence]}</span>
                    </div>
                    {assignment.partKeys.length > 1 ? (
                      <p className="lt-simple-lyrics-also">
                        {t("simpleLyrics.pasteAlso", { list: assignment.partKeys.slice(1).map(partName).join(", ") })}
                      </p>
                    ) : null}
                    <pre>{block.plain}</pre>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
        <div className="lt-inline-actions">
          <button type="button" className="lt-secondary-button" onClick={review ? () => setReview(null) : onClose}>
            {review ? t("simpleLyrics.back") : t("simpleLyrics.cancel")}
          </button>
          {review ? (
            <button type="button" className="is-primary" disabled={review.blocks.length === 0} onClick={apply}>
              {t("simpleLyrics.apply")}
            </button>
          ) : (
            <button type="button" className="is-primary" disabled={!text.trim()} onClick={startReview}>
              {t("simpleLyrics.review")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
