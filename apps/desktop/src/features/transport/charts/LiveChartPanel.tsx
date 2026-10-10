import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";

import {
  getEffectiveBpmAt,
  regionEffectiveKey,
  type SongChart,
  type SongRegionSummary,
  type SongView,
} from "@libretracks/shared/models";

import { ChartEditorModal } from "./ChartEditorModal";
import { parseChordPro, transposeChart, type ChartLine } from "@libretracks/shared/charts/chordChart";
import { keyPrefersFlats, parseNoteRun } from "@libretracks/shared/charts/chordNotation";
import {
  personalPrefersFlats,
  type AccidentalPreference,
} from "@libretracks/shared/charts/personalChords";
import {
  advancePlayHistory,
  applyLineRecording,
  autoLinkChart,
  buildPerformanceBlocks,
  chartLinkMarkerId,
  type PlayHistory,
  chartMarkersForRegion,
  recordLineTap,
  type LineRecording,
} from "@libretracks/shared/charts/chartSync";
import { CHART_FILE_ACCEPT, chordProFromFile } from "./importChart";
import { useChartPlayback } from "./useChartPlayback";
import "./LiveChartPanel.css";

const FONT_SCALE_KEY = "lt.liveChart.fontScale";
const SHOW_CHORDS_KEY = "lt.liveChart.showChords";
const FONT_SCALES = [0.8, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
/** After the user scrolls by hand the lyrics stop following for this long. */
const MANUAL_SCROLL_HOLD_MS = 4000;

function readStored<T>(key: string, fallback: T, parse: (value: string) => T | null): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    return parse(raw) ?? fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: the preference just does not stick.
  }
}

type LiveChartPanelProps = {
  song: SongView;
  /** The song whose lyrics are shown (the one selected in the live view). */
  region: SongRegionSummary | null;
  positionSecondsRef: { readonly current: number };
  /** A scheduled jump (marker or song id): its target shows next. */
  pendingMarkerId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** Hide the lyrics panel (the header button shows it again). */
  onClose: () => void;
  onChartChange: (regionId: string, chart: SongChart | null) => Promise<void>;
  /** False hides every way to change the chart (edit, import, record line
   * times): a network-session guest without the edit role only reads. */
  canEdit?: boolean;
  /** This device's own shift on top of the song's (capo, personal
   * transpose). Only how the chords are drawn; the song is not touched. */
  extraSemitones?: number;
  accidentals?: AccidentalPreference;
};

function ChartLineView({
  line,
  showChords,
  state,
  lineKey,
}: {
  line: ChartLine;
  showChords: boolean;
  state: "current" | "past" | "upcoming";
  lineKey: string;
}) {
  if (line.kind === "comment") {
    return (
      <p className={`lt-chart-comment is-${state}`} data-line-key={lineKey}>
        {line.text}
      </p>
    );
  }
  if (line.kind === "tab") {
    const notes = parseNoteRun(line.text);
    if (notes) {
      return (
        <p className={`lt-chart-line lt-chart-notes is-${state}`} data-line-key={lineKey}>
          {notes.map((group, index) =>
            group[0] === "‖" ? (
              <span key={index} className="lt-chart-notes-bar" aria-hidden="true">‖</span>
            ) : (
              <span key={index} className="lt-chart-chord">{group.join(" ")}</span>
            ),
          )}
        </p>
      );
    }
    return (
      <pre className={`lt-chart-tab is-${state}`} data-line-key={lineKey}>
        {line.text}
      </pre>
    );
  }
  const hasChords = showChords && line.segments.some((segment) => segment.chord);
  const hasText = line.segments.some((segment) => segment.text.trim());
  return (
    <p className={`lt-chart-line is-${state}${hasText ? "" : " is-chords-only"}`} data-line-key={lineKey}>
      {line.segments.map((segment, index) => (
        <span className="lt-chart-segment" key={index}>
          {hasChords ? <span className="lt-chart-chord">{segment.chord ?? " "}</span> : null}
          {hasText || !hasChords ? <span className="lt-chart-lyric">{segment.text || " "}</span> : null}
        </span>
      ))}
    </p>
  );
}

export const LiveChartPanel = memo(function LiveChartPanel({
  song,
  region,
  positionSecondsRef,
  pendingMarkerId,
  expanded,
  onToggleExpanded,
  onClose,
  onChartChange,
  canEdit = true,
  extraSemitones = 0,
  accidentals = "auto",
}: LiveChartPanelProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const manualScrollAtRef = useRef(Number.NEGATIVE_INFINITY);
  const [fontScale, setFontScale] = useState(() =>
    readStored(FONT_SCALE_KEY, 1, (value) => {
      const parsed = Number(value);
      return FONT_SCALES.includes(parsed) ? parsed : null;
    }),
  );
  const [showChords, setShowChords] = useState(() =>
    readStored(SHOW_CHORDS_KEY, true, (value) => value === "true"),
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [recording, setRecording] = useState<LineRecording | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chart = region?.chart ?? null;
  const markers = useMemo(
    () => chartMarkersForRegion(song.sectionMarkers, region),
    [song.sectionMarkers, region],
  );
  const doc = useMemo(() => {
    if (!chart || !region) return null;
    const effectiveKey = regionEffectiveKey(region);
    const flats =
      extraSemitones === 0 && accidentals === "auto"
        ? keyPrefersFlats(effectiveKey)
        : personalPrefersFlats(effectiveKey, extraSemitones, accidentals);
    return transposeChart(
      parseChordPro(chart.text),
      region.transposeSemitones + extraSemitones,
      flats,
    );
  }, [chart, region, extraSemitones, accidentals]);
  const links = useMemo(
    () => (chart ? (recording ? applyLineRecording(chart.links, recording) : chart.links) : []),
    [chart, recording],
  );
  const { playback } = useChartPlayback(
    song,
    doc,
    links,
    markers,
    region?.endSeconds ?? 0,
    positionSecondsRef,
  );

  // While recording, the line moves only with the taps: the time-based spread
  // would advance on its own and fight the person tapping.
  const currentLine = useMemo(() => {
    if (!recording || playback.line === null || playback.markerId === null || playback.section === null || !doc) {
      return playback.line;
    }
    const taps = recording.get(chartLinkMarkerId(playback.markerId))?.length ?? 1;
    return Math.min(taps - 1, doc.sections[playback.section].lines.length - 1);
  }, [recording, playback.line, playback.markerId, playback.section, doc]);

  // What has played in this song, in the order it played: after a jump the
  // lyrics go on below it instead of scrolling back up the timeline.
  const historyRef = useRef<{ regionId: string | null; history: PlayHistory }>({ regionId: null, history: [] });
  const history = useMemo(() => {
    const kept = historyRef.current.regionId === (region?.id ?? null) ? historyRef.current.history : [];
    const next = advancePlayHistory(kept, playback.markerId);
    historyRef.current = { regionId: region?.id ?? null, history: next };
    return next;
  }, [region?.id, playback.markerId]);
  const { blocks, current: currentBlock } = useMemo(
    () =>
      doc
        ? buildPerformanceBlocks(doc, links, markers, history, pendingMarkerId)
        : { blocks: [], current: -1 },
    [doc, links, markers, history, pendingMarkerId],
  );

  // A new song: whatever was being recorded belonged to the previous one.
  useEffect(() => {
    setRecording(null);
    setError(null);
  }, [region?.id]);

  // Follow the current line, unless the user is reading elsewhere.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || currentBlock < 0) return;
    if (performance.now() - manualScrollAtRef.current < MANUAL_SCROLL_HOLD_MS) return;
    const key = currentLine === null ? `${currentBlock}-head` : `${currentBlock}-${currentLine}`;
    const target = scroller.querySelector<HTMLElement>(`[data-line-key="${key}"]`);
    if (!target) return;
    // From the on-screen positions, not offsetTop: offsetTop is measured
    // from the nearest positioned ancestor, which is not the scroller, and on
    // iOS that put the current line out of view.
    const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    const top = Math.max(0, scroller.scrollTop + offset - scroller.clientHeight * 0.18);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (typeof scroller.scrollTo === "function") {
      scroller.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    } else {
      scroller.scrollTop = top;
    }
  }, [currentBlock, currentLine, fontScale, showChords]);

  const markManualScroll = () => {
    manualScrollAtRef.current = performance.now();
  };

  const changeFont = (step: 1 | -1) => {
    const index = FONT_SCALES.indexOf(fontScale);
    const next = FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, index + step))];
    setFontScale(next);
    store(FONT_SCALE_KEY, String(next));
  };

  const toggleChords = () => {
    setShowChords((current) => {
      store(SHOW_CHORDS_KEY, String(!current));
      return !current;
    });
  };

  const save = useCallback(
    async (next: SongChart | null) => {
      if (!region) return;
      setBusy(true);
      try {
        await onChartChange(region.id, next);
      } finally {
        setBusy(false);
      }
    },
    [onChartChange, region],
  );

  const secondsPerBeatAt = useCallback(
    (seconds: number) => 60 / Math.max(1, getEffectiveBpmAt(song, seconds)),
    [song],
  );

  // Stable: useDismissOnBack re-registers on every new callback and that
  // reorders the back stack.
  const closeEditor = useCallback(() => setEditorOpen(false), []);
  const saveFromEditor = useCallback(
    async (next: SongChart | null) => {
      await save(next);
      setEditorOpen(false);
    },
    [save],
  );

  const errorMessage = (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (message === "chart-pdf-no-text") return t("liveChart.pdfNoText");
    if (message.startsWith("chart-file-too-large:")) {
      return t("liveChart.fileTooLarge", { size: message.split(":")[1] });
    }
    return t("liveChart.importFailed", { error: message });
  };

  const importFile = async (file: File) => {
    if (!region) return;
    setError(null);
    setBusy(true);
    try {
      const text = await chordProFromFile(file);
      const parsed = parseChordPro(text);
      await onChartChange(region.id, { text, links: autoLinkChart(parsed, markers) });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    // Cleared once read, so picking the same file again still fires `change`.
    void importFile(file).finally(() => {
      input.value = "";
    });
  };

  const startRecording = () => setRecording(new Map());
  const stopRecording = () => {
    const recorded = recording;
    setRecording(null);
    if (!chart || !recorded || recorded.size === 0) return;
    void save({ ...chart, links: applyLineRecording(chart.links, recorded) });
  };
  const tapNextLine = () => {
    if (!recording || !doc || playback.markerId === null || playback.markerStartSeconds === null) return;
    if (playback.section === null || playback.line === null) return;
    const secondsPerBeat = 60 / Math.max(1, getEffectiveBpmAt(song, playback.markerStartSeconds));
    const beat = (positionSecondsRef.current - playback.markerStartSeconds) / secondsPerBeat;
    setRecording(
      recordLineTap(recording, playback.markerId, beat, doc.sections[playback.section].lines.length),
    );
  };


  return (
    <section
      className={`lt-live-chart${expanded ? " is-expanded" : ""}`}
      aria-label={t("liveChart.title")}
      style={{ "--lt-chart-font-scale": fontScale } as CSSProperties}
    >
      <div className="lt-live-chart-toolbar">
        <div className="lt-live-chart-heading">
          <small>{t("liveChart.title")}</small>
          <strong>{doc?.title || region?.name || "—"}</strong>
        </div>
        <div className="lt-live-chart-tools lt-bottom-controls">
          {doc ? (
            <>
              <button type="button" className="lt-icon-button" onClick={() => changeFont(-1)} aria-label={t("liveChart.smaller")} title={t("liveChart.smaller")}>
                <span className="material-symbols-outlined" aria-hidden="true">text_decrease</span>
              </button>
              <button type="button" className="lt-icon-button" onClick={() => changeFont(1)} aria-label={t("liveChart.bigger")} title={t("liveChart.bigger")}>
                <span className="material-symbols-outlined" aria-hidden="true">text_increase</span>
              </button>
              <button
                type="button"
                className={`lt-icon-button${showChords ? " is-active" : ""}`}
                aria-pressed={showChords}
                onClick={toggleChords}
                aria-label={t("liveChart.showChords")}
                title={t("liveChart.showChords")}
              >
                <span className="material-symbols-outlined" aria-hidden="true">music_note</span>
              </button>
              {canEdit ? (
              <button
                type="button"
                className={`lt-icon-button${recording ? " is-recording" : ""}`}
                aria-pressed={recording !== null}
                onClick={recording ? stopRecording : startRecording}
                aria-label={recording ? t("liveChart.stopRecording") : t("liveChart.recordTimes")}
                title={recording ? t("liveChart.stopRecording") : t("liveChart.recordTimes")}
              >
                <span className="material-symbols-outlined" aria-hidden="true">
                  {recording ? "stop_circle" : "radio_button_checked"}
                </span>
              </button>
              ) : null}
            </>
          ) : null}
          {region && canEdit ? (
            <button
              type="button"
              className="lt-icon-button"
              onClick={() => setEditorOpen(true)}
              aria-label={t("liveChart.edit")}
              title={t("liveChart.edit")}
            >
              <span className="material-symbols-outlined" aria-hidden="true">edit_note</span>
            </button>
          ) : null}
          <button
            type="button"
            className={`lt-icon-button${expanded ? " is-active" : ""}`}
            aria-pressed={expanded}
            onClick={onToggleExpanded}
            aria-label={expanded ? t("liveChart.collapse") : t("liveChart.expand")}
            title={expanded ? t("liveChart.collapse") : t("liveChart.expand")}
          >
            <span className="material-symbols-outlined" aria-hidden="true">
              {expanded ? "close_fullscreen" : "open_in_full"}
            </span>
          </button>
          <button
            type="button"
            className="lt-icon-button"
            onClick={onClose}
            aria-label={t("liveChart.hide")}
            title={t("liveChart.hide")}
          >
            <span className="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
      </div>

      {recording ? (
        <div className="lt-live-chart-recorder">
          <span>{t("liveChart.recordingHint")}</span>
          <button
            type="button"
            className="lt-live-chart-tap"
            onClick={tapNextLine}
            disabled={currentLine === null}
          >
            <span className="material-symbols-outlined" aria-hidden="true">keyboard_double_arrow_down</span>
            {t("liveChart.nextLine")}
          </button>
        </div>
      ) : null}

      {error ? <p className="lt-live-chart-error" role="alert">{error}</p> : null}

      {!region ? (
        <div className="lt-live-chart-empty">
          <p>{t("liveChart.noSong")}</p>
        </div>
      ) : !doc ? (
        <div className="lt-live-chart-empty">
          <span className="material-symbols-outlined" aria-hidden="true">lyrics</span>
          <p>{t("liveChart.empty", { song: region.name })}</p>
          {canEdit ? (
          <>
          <div className="lt-live-chart-empty-actions">
            <button type="button" className="lt-live-chart-action is-primary" disabled={busy} onClick={() => fileInputRef.current?.click()}>
              <span className="material-symbols-outlined" aria-hidden="true">upload_file</span>
              {t("liveChart.importFile")}
            </button>
            <button type="button" className="lt-live-chart-action" disabled={busy} onClick={() => setEditorOpen(true)}>
              <span className="material-symbols-outlined" aria-hidden="true">edit_note</span>
              {t("liveChart.pasteText")}
            </button>
          </div>
          <small>{t("liveChart.formats")}</small>
          </>
          ) : null}
        </div>
      ) : (
        <div
          ref={scrollerRef}
          className="lt-live-chart-scroller"
          onWheel={markManualScroll}
          onTouchStart={markManualScroll}
          onPointerDown={markManualScroll}
          data-testid="live-chart-scroller"
        >
          {blocks.map((block, blockIndex) => {
            const isCurrent = blockIndex === currentBlock;
            const section = block.section === null ? null : doc.sections[block.section];
            const sheetLabel = section?.label && section.label.toLowerCase() !== block.label.toLowerCase() ? section.label : null;
            return (
              <div
                key={block.key}
                className={`lt-chart-section${isCurrent ? " is-current" : ""}${blockIndex < currentBlock ? " is-past" : ""}${block.queued ? " is-queued" : ""}${section ? "" : " is-unlinked"}`}
              >
                <h3 className="lt-chart-section-label" data-line-key={`${blockIndex}-head`}>
                  {block.queued && blockIndex > 0 && !blocks[blockIndex - 1].queued ? (
                    <em className="lt-chart-jump-badge">{t("liveChart.jump")}</em>
                  ) : null}
                  {block.label}
                  {sheetLabel ? <small>{sheetLabel}</small> : null}
                </h3>
                {section?.lines.map((line, lineIndex) => (
                  <ChartLineView
                    key={lineIndex}
                    line={line}
                    showChords={showChords}
                    lineKey={`${blockIndex}-${lineIndex}`}
                    state={
                      !isCurrent || currentLine === null
                        ? blockIndex < currentBlock ? "past" : "upcoming"
                        : lineIndex === currentLine
                          ? "current"
                          : lineIndex < currentLine
                            ? "past"
                            : "upcoming"
                    }
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={CHART_FILE_ACCEPT}
        hidden
        onChange={handleFile}
        data-testid="live-chart-file-input"
      />

      {editorOpen && region && canEdit ? (
        <ChartEditorModal
          region={region}
          markers={markers}
          chart={chart}
          secondsPerBeatAt={secondsPerBeatAt}
          onSave={saveFromEditor}
          onClose={closeEditor}
        />
      ) : null}
    </section>
  );
});
