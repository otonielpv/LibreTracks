import { useMemo, useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";

import type {
  ChartLink,
  SectionMarkerSummary,
  SongChart,
  SongRegionSummary,
} from "@libretracks/shared/models";

import { useDismissOnBack } from "../mobile/backNavigation";
import { parseChordPro } from "@libretracks/shared/charts/chordChart";
import { autoLinkChart, chartLinkFor } from "@libretracks/shared/charts/chartSync";
import { CHART_FILE_ACCEPT, chordProFromFile } from "./importChart";

type ChartEditorModalProps = {
  region: SongRegionSummary;
  /** The song's section markers, in order (repeats included). */
  markers: readonly SectionMarkerSummary[];
  chart: SongChart | null;
  onSave: (chart: SongChart | null) => Promise<void>;
  onClose: () => void;
};

/**
 * Lyrics and chords of one song: the ChordPro text (imported from a file or
 * pasted, and fixable by hand) and which section each marker shows.
 */
export function ChartEditorModal({ region, markers, chart, onSave, onClose }: ChartEditorModalProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState(chart?.text ?? "");
  const [links, setLinks] = useState<ChartLink[]>(chart?.links ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useDismissOnBack(onClose);

  const doc = useMemo(() => parseChordPro(text), [text]);
  const originals = useMemo(() => markers.filter((marker) => !marker.id.includes("~")), [markers]);

  const setLink = (markerId: string, value: string) => {
    setLinks((current) => {
      const rest = current.filter((link) => link.markerId !== markerId);
      if (value === "") return rest;
      const section = Number(value);
      const previous = current.find((link) => link.markerId === markerId);
      // Recorded times were for the old section's lines.
      return [...rest, { markerId, section, ...(previous?.section === section && previous.lineBeats ? { lineBeats: previous.lineBeats } : {}) }];
    });
  };

  const resetTimes = (markerId: string) => {
    setLinks((current) =>
      current.map((link) => (link.markerId === markerId ? { markerId: link.markerId, section: link.section } : link)),
    );
  };

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    setError(null);
    try {
      // Cleared once read, so the same file can be picked again.
      const converted = await chordProFromFile(file).finally(() => {
        input.value = "";
      });
      setText(converted);
      setLinks(autoLinkChart(parseChordPro(converted), markers));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(
        message === "chart-pdf-no-text"
          ? t("liveChart.pdfNoText")
          : message.startsWith("chart-file-too-large:")
            ? t("liveChart.fileTooLarge", { size: message.split(":")[1] })
            : t("liveChart.importFailed", { error: message }),
      );
    }
  };

  const save = async (next: SongChart | null) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  const validLinks = links.filter((link) => link.section < doc.sections.length);

  return (
    <div className="lt-modal-backdrop" onClick={saving ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-chart-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-chart-editor-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{t("liveChart.editorEyebrow")}</span>
            <h2 id="lt-chart-editor-title">{t("liveChart.editorTitle")}</h2>
            <p>{region.name}</p>
          </div>
        </header>

        <div className="lt-settings-modal-body lt-chart-editor-body">
          <div className="lt-chart-editor-text">
            <div className="lt-chart-editor-row">
              <span className="lt-settings-field-label">{t("liveChart.textLabel")}</span>
              <button type="button" className="lt-chart-editor-button" onClick={() => fileInputRef.current?.click()}>
                <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
                {t("liveChart.importFile")}
              </button>
            </div>
            <textarea
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              placeholder={t("liveChart.textPlaceholder")}
              aria-label={t("liveChart.textLabel")}
            />
            <small>{t("liveChart.textHelp")}</small>
          </div>

          <div className="lt-chart-editor-links">
            <div className="lt-chart-editor-row">
              <span className="lt-settings-field-label">{t("liveChart.syncLabel")}</span>
              <button
                type="button"
                className="lt-chart-editor-button"
                disabled={doc.sections.length === 0 || originals.length === 0}
                onClick={() => setLinks(autoLinkChart(doc, markers))}
              >
                <span className="material-symbols-outlined" aria-hidden="true">auto_fix_high</span>
                {t("liveChart.autoLink")}
              </button>
            </div>
            {originals.length === 0 ? (
              <p className="lt-chart-editor-hint">{t("liveChart.noMarkers")}</p>
            ) : (
              <ul>
                {originals.map((marker) => {
                  const link = chartLinkFor(validLinks, marker.id);
                  const recorded = (link?.lineBeats?.length ?? 0) > 1;
                  return (
                    <li key={marker.id}>
                      <span className="lt-chart-editor-marker">{marker.name}</span>
                      <select
                        value={link ? String(link.section) : ""}
                        onChange={(event) => setLink(marker.id, event.target.value)}
                        aria-label={t("liveChart.sectionFor", { marker: marker.name })}
                      >
                        <option value="">{t("liveChart.noLyrics")}</option>
                        {doc.sections.map((section, index) => (
                          <option key={index} value={index}>
                            {section.label || t("liveChart.untitledSection", { number: index + 1 })}
                          </option>
                        ))}
                      </select>
                      {link ? (
                        recorded ? (
                          <button type="button" className="lt-chart-editor-times" onClick={() => resetTimes(marker.id)} title={t("liveChart.resetTimes")}>
                            {t("liveChart.recordedTimes")}
                            <span className="material-symbols-outlined" aria-hidden="true">restart_alt</span>
                          </button>
                        ) : (
                          <span className="lt-chart-editor-times is-auto">{t("liveChart.autoTimes")}</span>
                        )
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {error ? <p className="lt-render-warning" role="alert">{error}</p> : null}
        </div>

        <div className="lt-inline-actions lt-chart-editor-actions">
          {chart ? (
            <button type="button" className="lt-secondary-button lt-chart-editor-remove" disabled={saving} onClick={() => void save(null)}>
              {t("liveChart.remove")}
            </button>
          ) : null}
          <button type="button" className="lt-secondary-button" disabled={saving} onClick={onClose}>
            {t("liveChart.cancel")}
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={saving || !text.trim()}
            onClick={() => void save({ text, links: validLinks })}
          >
            {t("liveChart.save")}
          </button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept={CHART_FILE_ACCEPT}
          hidden
          onChange={(event) => void handleFile(event)}
          data-testid="chart-editor-file-input"
        />
      </section>
    </div>
  );
}
