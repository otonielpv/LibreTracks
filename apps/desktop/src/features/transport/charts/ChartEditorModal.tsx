import { useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import type {
  ChartLink,
  ChartSource,
  SectionMarkerSummary,
  SongChart,
  SongRegionSummary,
} from "@libretracks/shared/models";

import { useDismissOnBack } from "../mobile/backNavigation";
import { usePortraitWhileOpen } from "../mobile/usePortraitWhileOpen";
import { useVisibleViewportHeight } from "./useVisibleViewportHeight";
import { parseChordPro } from "@libretracks/shared/charts/chordChart";
import { autoLinkChart, chartLinkFor, remapChartLinks, withChartLinkPasses } from "@libretracks/shared/charts/chartSync";
import { chartTextHash } from "@libretracks/shared/charts/importedChart";
import {
  addChartTimes,
  applyChartTimes,
  chartLineTimeFor,
  lineTimeKey,
  takeChartTimes,
  type ChartTiming,
} from "@libretracks/shared/charts/chartTimes";
import { CHART_FILE_ACCEPT, chordProFromFile } from "./importChart";
import { useChartImportStore, type AdjustInput } from "../../chartSources/chartImportStore";
import { ChartAdjustDialog } from "../../chartSources/ChartAdjustDialog";
import { SaveToPlanningCenterDialog } from "../../chartSources/SaveToPlanningCenterDialog";
import { useChartSourcesAvailable } from "../../chartSources/useChartSourcesAvailable";
import { FEATURE_FLAGS } from "@libretracks/shared/featureFlags";
import { SimpleLyricsEditor } from "./simple/SimpleLyricsEditor";
import { SectionPeek } from "./SectionPeek";
import { readEditorMode, storeEditorMode, type ChartEditorMode } from "./simple/editorMode";

type ChartEditorModalProps = {
  region: SongRegionSummary;
  /** The song's section markers, in order (repeats included). */
  markers: readonly SectionMarkerSummary[];
  chart: SongChart | null;
  /** Seconds per beat at a song position: line times are stored in beats. */
  secondsPerBeatAt: (seconds: number) => number;
  onSave: (chart: SongChart | null) => Promise<void>;
  onClose: () => void;
  /** A sheet just brought in as it comes (Planning Center from the song
   * menu): shown, and "Adjust to the sequence" opens on it. */
  initialImport?: AdjustInput;
  /** Simple or Advanced; without it, the last one used on this device. */
  initialMode?: ChartEditorMode;
};

/**
 * Lyrics and chords of one song: the ChordPro text (imported from a file or
 * pasted, and fixable by hand) and which section each marker shows.
 *
 * Each lyric line carries, on its left, the song time it changes at —
 * `[0:31.4] [C]Quien rompe…` — so moving a line is editing text. The times
 * are added when the editor opens and taken out on save: the stored ChordPro
 * stays clean and the times go to the marker links, in beats.
 */
export function ChartEditorModal({
  region,
  markers,
  chart,
  secondsPerBeatAt,
  onSave,
  onClose,
  initialImport,
  initialMode,
}: ChartEditorModalProps) {
  const { t } = useTranslation();
  const sourcesAvailable = useChartSourcesAvailable();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const timing = useMemo<ChartTiming>(
    () => ({
      markers,
      songStartSeconds: region.startSeconds,
      songEndSeconds: region.endSeconds,
      secondsPerBeatAt,
    }),
    [markers, region.startSeconds, region.endSeconds, secondsPerBeatAt],
  );
  const withTimes = (source: string, sourceLinks: readonly ChartLink[]) =>
    addChartTimes(source, chartLineTimeFor(parseChordPro(source), sourceLinks, timing));

  const [text, setText] = useState(() =>
    initialImport ? initialImport.imported.text : chart ? withTimes(chart.text, chart.links) : "",
  );
  const [links, setLinks] = useState<ChartLink[]>(initialImport ? [] : (chart?.links ?? []));
  /** Where the sheet came from: kept on save ("Update from Planning Center"),
   * dropped when another file replaces it. Its fingerprint is the text as it
   * came or as it was adjusted, so editing it afterwards shows. */
  const [source, setSource] = useState<ChartSource | undefined>(() =>
    initialImport?.imported.source
      ? { ...initialImport.imported.source, importedHash: chartTextHash(initialImport.imported.text) }
      : chart?.source,
  );
  /** A sheet brought in as it comes and its source's hints (sequence, key),
   * waiting for "Adjust to the sequence". */
  const [pending, setPending] = useState<AdjustInput | null>(initialImport ?? null);
  const [adjustOpen, setAdjustOpen] = useState(Boolean(initialImport));
  const [pcoSaveOpen, setPcoSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Simple (parts) or Advanced (ChordPro, links, times): both edit the same
  // text and links. Without the flag there is only Advanced, as before.
  const [mode, setModeState] = useState<ChartEditorMode>(() =>
    FEATURE_FLAGS.simpleLyricsEditor ? (initialMode ?? readEditorMode()) : "advanced",
  );
  const setMode = (next: ChartEditorMode) => {
    setModeState(next);
    storeEditorMode(next);
  };
  // Teléfono: escribir en vertical (plan portrait-text-modals).
  const close = usePortraitWhileOpen(onClose);
  // Teléfono en vertical: el marco mide lo que queda sobre el teclado.
  const visibleHeight = useVisibleViewportHeight();
  useDismissOnBack(close);

  const taken = useMemo(() => takeChartTimes(text), [text]);
  const doc = useMemo(() => parseChordPro(taken.text), [taken.text]);
  const originals = useMemo(() => markers.filter((marker) => !marker.id.includes("~")), [markers]);

  /** Typing or pasting: links follow their section when sections are added
   * or removed (they point at sections by position). */
  const updateText = (next: string) => {
    const after = parseChordPro(takeChartTimes(next).text);
    setLinks((current) => remapChartLinks(doc, after, current));
    setText(next);
  };

  /** The textarea grows with its text instead of scrolling inside the body:
   * one scroller per surface. Two nested ones made iOS throw the text to the
   * top while dragging a selection handle. */
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    const fit = () => {
      // Collapsing to "auto" to measure shrinks the body for a moment, which
      // clamps its scroll and throws the edited line to the top: put it back.
      const scroller = element.closest<HTMLElement>(".lt-chart-editor-body");
      const scrollTop = scroller?.scrollTop ?? 0;
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight + 2}px`;
      if (scroller && scroller.scrollTop !== scrollTop) scroller.scrollTop = scrollTop;
    };
    fit();
    // A narrower box wraps more lines (the phone turns to portrait right
    // after the editor opens): measured at the old width, the text below
    // was cut off and, the box not scrolling itself, out of reach.
    if (typeof ResizeObserver === "undefined") return;
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
    // Also when Advanced is shown again: the box mounts then and must be measured.
  }, [text, mode]);

  const setLink = (markerId: string, value: string) => {
    setLinks((current) => {
      const rest = current.filter((link) => link.markerId !== markerId);
      if (value === "") return rest;
      const section = Number(value);
      const previous = current.find((link) => link.markerId === markerId);
      // Recorded times were for the old section's lines.
      const same = previous?.section === section;
      return [
        ...rest,
        {
          markerId,
          section,
          ...(same && previous.lineBeats ? { lineBeats: previous.lineBeats } : {}),
          ...(same && previous.repeat ? { repeat: previous.repeat } : {}),
        },
      ];
    });
  };

  /** Times the section plays inside the marker (a long chorus sung twice):
   * its lines run once per pass. */
  const setPasses = (markerId: string, passes: number) => {
    setLinks((current) => withChartLinkPasses(current, markerId, passes));
  };

  /** Back to the even spread: the section's links lose their times and the
   * text shows the spread times for it (what is typed elsewhere stays). */
  const resetTimes = (markerId: string) => {
    const link = links.find((candidate) => candidate.markerId === markerId);
    if (!link) return;
    const next = links.map((candidate) =>
      candidate.section === link.section
        ? { markerId: candidate.markerId, section: candidate.section, ...(candidate.repeat ? { repeat: candidate.repeat } : {}) }
        : candidate,
    );
    const spread = chartLineTimeFor(doc, next, timing);
    setLinks(next);
    setText(
      addChartTimes(taken.text, (section, line) =>
        section === link.section ? spread(section, line) : (taken.times.get(lineTimeKey(section, line)) ?? null),
      ),
    );
  };

  /** A sheet replaces the text as it comes; "Adjust to the sequence" opens. */
  const bringIn = (input: AdjustInput, nextSource: ChartSource | undefined) => {
    setText(input.imported.text);
    setLinks([]);
    setSource(nextSource);
    setPending(input);
    setAdjustOpen(true);
  };

  /** What the adjust starts from: the text now in the editor (with any typing
   * done since it came in) and the hints of where it came from. */
  const adjustInput = (): AdjustInput => {
    // A sheet already in the editor: its key is the one it says ({key: D}),
    // not the source's (it may have been transposed already). Without one,
    // no transposition is offered. The passes set on its markers stay.
    const base = pending ?? {
      imported: { title: region.name, text: taken.text, key: doc.key ?? null, source },
      passOverrides: Object.fromEntries(
        validLinks.flatMap((link) => (link.repeat && link.repeat > 1 ? [[link.markerId, link.repeat]] : [])),
      ),
    };
    return { ...base, imported: { ...base.imported, text: taken.text } };
  };

  const applyAdjust = (adjusted: SongChart) => {
    setLinks(adjusted.links);
    setText(withTimes(adjusted.text, adjusted.links));
    if (adjusted.source) setSource(adjusted.source);
    setPending(null);
    setAdjustOpen(false);
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
      // As it comes (only turned into ChordPro): the adjust shows what it
      // would change, and nothing changes until it is applied.
      bringIn({ imported: { title: region.name, text: converted } }, undefined);
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
  /** The links as the text has them now: times typed or pasted count as
   * recorded right away, without saving and reopening. */
  const liveLinks = useMemo(
    () => applyChartTimes(doc, validLinks, timing, taken.times),
    // validLinks is derived from links and doc on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, links, timing, taken.times],
  );
  /** What gets saved: a chart typed from scratch has no links yet, and the
   * times written in it need markers to belong to. */
  const linksToSave = () => {
    const base = validLinks.length === 0 && originals.length > 0 ? autoLinkChart(doc, markers) : validLinks;
    return applyChartTimes(doc, base, timing, taken.times);
  };

  /** The draft as a chart, for the simple editor. */
  const draftChart = useMemo<SongChart | null>(
    () => (taken.text.trim() ? { text: taken.text, links: liveLinks, ...(source ? { source } : {}) } : null),
    [taken.text, liveLinks, source],
  );
  const applySimple = (next: SongChart | null) => {
    setText(next ? withTimes(next.text, next.links) : "");
    setLinks(next ? next.links : []);
  };
  const openPlanningCenter = () =>
    useChartImportStore.getState().open({
      region,
      markers: [...markers],
      chart,
      onPicked: (input) =>
        bringIn(
          input,
          input.imported.source ? { ...input.imported.source, importedHash: chartTextHash(input.imported.text) } : undefined,
        ),
    });
  const saveDraft = () => {
    if (saving || !taken.text.trim()) return;
    void save({
      text: taken.text,
      links: linksToSave(),
      // Keeps "Update from Planning Center": an edited text no
      // longer matches `importedHash`, and that is how it shows.
      ...(source ? { source } : {}),
      // The song's own lyrics follow is not the editor's business: kept.
      ...(chart?.follow ? { follow: chart.follow } : {}),
    });
  };

  /** The times that do not fit their section (a chorus copied with its
   * times) back to the spread; the ones that fit stay. */
  const recalcTimes = () => {
    const next = linksToSave();
    setLinks(next);
    setText(addChartTimes(taken.text, chartLineTimeFor(doc, next, timing)));
  };

  return (
    <div
      className="lt-modal-backdrop lt-chart-editor-backdrop"
      style={visibleHeight ? ({ "--lt-chart-editor-visible-height": `${visibleHeight}px` } as CSSProperties) : undefined}
      onClick={saving ? undefined : close}
    >
      <section
        className={`lt-settings-modal lt-chart-editor${FEATURE_FLAGS.simpleLyricsEditor ? " has-modes" : ""}${mode === "simple" ? " is-simple" : ""}`}
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
            {FEATURE_FLAGS.simpleLyricsEditor ? (
              <div className="lt-chart-editor-modes" role="tablist" aria-label={t("simpleLyrics.modeLabel")}>
                {(["simple", "advanced"] as const).map((option) => (
                  <button key={option} type="button" role="tab" aria-selected={mode === option} onClick={() => setMode(option)}>
                    {t(`simpleLyrics.${option}`)}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </header>

        <div className="lt-settings-modal-body lt-chart-editor-body">
          {mode === "simple" ? (
            <SimpleLyricsEditor
              chart={draftChart}
              markers={markers}
              onChange={applySimple}
              onSave={saveDraft}
              onImportFile={() => fileInputRef.current?.click()}
              onImportPlanningCenter={sourcesAvailable ? openPlanningCenter : null}
              onSaveToPlanningCenter={
                sourcesAvailable && taken.text.trim() && (!source || source.provider === "planningCenter") ? () => setPcoSaveOpen(true) : null
              }
            />
          ) : (
          <>
          <div className="lt-chart-editor-text">
            <div className="lt-chart-editor-row">
              <span className="lt-settings-field-label">{t("liveChart.textLabel")}</span>
              <div className="lt-chart-editor-row-actions">
                <button
                  type="button"
                  className="lt-chart-editor-button"
                  disabled={doc.sections.length === 0 || originals.length === 0}
                  onClick={recalcTimes}
                  title={t("liveChart.recalcTimesHint")}
                >
                  <span className="material-symbols-outlined" aria-hidden="true">schedule</span>
                  {t("liveChart.recalcTimes")}
                </button>
                <button type="button" className="lt-chart-editor-button" onClick={() => fileInputRef.current?.click()}>
                  <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
                  {t("liveChart.importFile")}
                </button>
                {sourcesAvailable ? (
                  <button
                    type="button"
                    className="lt-chart-editor-button"
                    onClick={openPlanningCenter}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">library_music</span>
                    {t("chartSources.import.open")}
                  </button>
                ) : null}
                {/* Also for lyrics not from Planning Center: the song is picked there first. */}
                {sourcesAvailable && (!source || source.provider === "planningCenter") ? (
                  <button
                    type="button"
                    className="lt-chart-editor-button"
                    disabled={!taken.text.trim()}
                    onClick={() => setPcoSaveOpen(true)}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">cloud_upload</span>
                    {t("chartSources.save.open")}
                  </button>
                ) : null}
                {sourcesAvailable && chart?.source?.provider === "planningCenter" ? (
                  <button
                    type="button"
                    className="lt-chart-editor-button"
                    onClick={() =>
                      useChartImportStore.getState().open({
                        region,
                        markers: [...markers],
                        chart: chart ? { ...chart, text: taken.text, links: validLinks, ...(source ? { source } : {}) } : chart,
                        mode: "refresh",
                        onPicked: (input) =>
                          bringIn(
                            input,
                            input.imported.source
                              ? { ...input.imported.source, importedHash: chartTextHash(input.imported.text) }
                              : source,
                          ),
                      })
                    }
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">sync</span>
                    {t("chartSources.refresh.open")}
                  </button>
                ) : null}
              </div>
            </div>
            <textarea
              ref={textareaRef}
              value={text}
              spellCheck={false}
              onChange={(event) => updateText(event.target.value)}
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
                onClick={() => setAdjustOpen(true)}
                title={t("chartSources.adjust.help")}
              >
                <span className="material-symbols-outlined" aria-hidden="true">auto_fix_high</span>
                {t("chartSources.adjust.open")}
              </button>
            </div>
            {originals.length === 0 ? (
              <p className="lt-chart-editor-hint">{t("liveChart.noMarkers")}</p>
            ) : (
              <>
              <div className="lt-chart-editor-links-head" aria-hidden="true">
                <span>{t("liveChart.columnMarker")}</span>
                <span>{t("liveChart.columnSection")}</span>
                <span>{t("liveChart.columnTimes")}</span>
              </div>
              <ul>
                {originals.map((marker) => {
                  const link = chartLinkFor(liveLinks, marker.id);
                  const recorded = (link?.lineBeats?.length ?? 0) > 1;
                  return (
                    <li key={marker.id}>
                      <span className="lt-chart-editor-marker">{marker.name}</span>
                      <span className="lt-chart-editor-section">
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
                        {link && doc.sections[link.section] ? (
                          <SectionPeek
                            section={doc.sections[link.section]}
                            name={doc.sections[link.section].label || t("liveChart.untitledSection", { number: link.section + 1 })}
                          />
                        ) : null}
                      </span>
                      {link ? (
                        <span className="lt-chart-editor-extra">
                        {!recorded ? (
                          <select
                            className="lt-chart-editor-passes"
                            value={link.repeat ?? 1}
                            aria-label={t("liveChart.passesFor", { marker: marker.name })}
                            title={t("liveChart.passesHelp")}
                            onChange={(event) => setPasses(marker.id, Number(event.target.value))}
                          >
                            {[1, 2, 3, 4].map((count) => (
                              <option key={count} value={count}>
                                ×{count}
                              </option>
                            ))}
                          </select>
                        ) : null}
                        {recorded ? (
                          <button type="button" className="lt-chart-editor-times" onClick={() => resetTimes(marker.id)} title={t("liveChart.resetTimes")}>
                            {t("liveChart.recordedTimes")}
                            <span className="material-symbols-outlined" aria-hidden="true">restart_alt</span>
                          </button>
                        ) : (
                          <span className="lt-chart-editor-times is-auto">{t("liveChart.autoTimes")}</span>
                        )}
                        </span>
                      ) : (
                        // Keeps the third column on rows without lyrics.
                        <span aria-hidden="true" />
                      )}
                    </li>
                  );
                })}
              </ul>
              </>
            )}
          </div>
          </>
          )}
          {error ? <p className="lt-render-warning" role="alert">{error}</p> : null}
        </div>

        <div className="lt-inline-actions lt-chart-editor-actions">
          {chart ? (
            <button type="button" className="lt-secondary-button lt-chart-editor-remove" disabled={saving} onClick={() => void save(null)}>
              {t("liveChart.remove")}
            </button>
          ) : null}
          <button type="button" className="lt-secondary-button" disabled={saving} onClick={close}>
            {t("liveChart.cancel")}
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={saving || !taken.text.trim()}
            onClick={saveDraft}
          >
            {t("liveChart.save")}
          </button>
        </div>

        {pcoSaveOpen ? (
          <SaveToPlanningCenterDialog
            region={region}
            markers={markers}
            text={taken.text}
            links={validLinks}
            source={source}
            onSaved={setSource}
            onClose={() => setPcoSaveOpen(false)}
          />
        ) : null}
        {adjustOpen ? (
          <ChartAdjustDialog
            region={region}
            markers={markers}
            input={adjustInput()}
            onApply={applyAdjust}
            onClose={() => setAdjustOpen(false)}
          />
        ) : null}
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
