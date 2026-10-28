import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  analyzeSong,
  applySongAnalysis,
  cancelAnalyzeSong,
  downloadSpeechModel,
  listenToSongAnalysisProgress,
  listenToSpeechModelProgress,
  speechModelStatus,
  type SongAnalysisProgress,
  type SpeechModelStatus,
  seekTransport,
  SONG_KEY_OPTIONS,
  transposeKey,
  type AnalyzeSongResult,
  type SongView,
  type TransportSnapshot,
} from "../desktopApi";
import {
  CUE_KINDS,
  MARKER_KINDS,
  markerCategory,
  markerKindLabel,
  markerKindVariants,
} from "../markerKinds";
import { useDismissOnBack } from "../mobile/backNavigation";
import { formatTransportError } from "../errors/formatTransportError";
import { useSongStore } from "../songStore";
import { useTransportStore } from "../store";
import {
  bpmFromNames,
  DEFAULT_TEMPO_DETAIL,
  buildApplyPayload,
  clickTrackOptions,
  formatSongPosition,
  guideTrackOptions,
  isUnrecognised,
  keyTrackOptions,
  markersForLabels,
  keyStretchesAreNew,
  placeGuideSections,
  snapKeyChangesToSections,
  type GroupMarkers,
  musicTempoTrackIds,
  offersTempoDetail,
  reviewRows,
  rowIsValid,
  scaleTempoRows,
  startsOnEighths,
  tempoInView,
  tempoLevel,
  viewSeconds,
  type ReviewRow,
  type TempoDetail,
} from "./songAnalysisPlan";
import { useSongAnalysisStore } from "./songAnalysisStore";
import { recordProductEvent } from "../../telemetry/telemetry";

type Phase =
  | { kind: "setup"; notice: string | null }
  | {
      kind: "analyzing";
      fraction: number;
      stage: SongAnalysisProgress["stage"];
      done: number | null;
      total: number | null;
    }
  | { kind: "review"; result: AnalyzeSongResult }
  | { kind: "applied" }
  | { kind: "error"; message: string; raw: string; review: AnalyzeSongResult | null };

type Props = {
  /** Hands the snapshot the apply (or a seek) returns to the transport. */
  onApplied: (snapshot: TransportSnapshot) => void;
};

/** Below this the band counts as tuned to 440 Hz. */
const TUNING_NOTICE_CENTS = 15;
/** The click select's "no click: estimate it from the music" option. */
const FROM_MUSIC = "__music__";

/**
 * "Analizar canción": read the song's click track (tempo and meter markers)
 * and its harmonic tracks (key), let the user review and edit the proposal,
 * apply as one undoable edit. See docs/plans/song-analysis/.
 */
export function SongAnalysisModal({ onApplied }: Props) {
  const target = useSongAnalysisStore((state) => state.target);
  const close = useSongAnalysisStore((state) => state.close);
  const song = useSongStore((state) => state.song);
  if (!target || !song || !song.regions.some((region) => region.id === target.regionId)) {
    return null;
  }
  return (
    <SongAnalysisDialog
      key={target.regionId}
      song={song}
      regionId={target.regionId}
      regionName={target.regionName}
      onClose={close}
      onApplied={onApplied}
    />
  );
}

type DialogProps = {
  song: SongView;
  regionId: string;
  regionName: string;
  onClose: () => void;
  onApplied: (snapshot: TransportSnapshot) => void;
};

function SongAnalysisDialog({ song, regionId, regionName, onClose, onApplied }: DialogProps) {
  const { t } = useTranslation();
  // Captured once: the lists must not reshuffle under the user.
  const [{ options: clickOptions, preselected }] = useState(() =>
    clickTrackOptions(song, regionId),
  );
  const [keyOptions] = useState(() => keyTrackOptions(song, regionId));
  const [musicTrackIds] = useState(() => musicTempoTrackIds(song, regionId));
  const [{ options: guideOptions, preselected: guidePreselected }] = useState(() =>
    guideTrackOptions(song, regionId),
  );
  const [guideTrackId, setGuideTrackId] = useState<string>(guidePreselected ?? "");
  const [groupMarkers, setGroupMarkers] = useState<GroupMarkers[]>([]);
  const [guideLeadBars, setGuideLeadBars] = useState(1);
  const playing = useTransportStore((state) => state.playback?.playbackState === "playing");
  const [speechModel, setSpeechModel] = useState<SpeechModelStatus | null>(null);
  const [modelDownload, setModelDownload] = useState<
    { kind: "idle" } | { kind: "downloading"; fraction: number } | { kind: "failed"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    let alive = true;
    speechModelStatus()
      .then((status) => {
        if (alive) setSpeechModel(status);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const downloadModel = async () => {
    setModelDownload({ kind: "downloading", fraction: 0 });
    const unlisten = await listenToSpeechModelProgress((event) =>
      setModelDownload({ kind: "downloading", fraction: event.fraction }),
    );
    try {
      setSpeechModel(await downloadSpeechModel());
      setModelDownload({ kind: "idle" });
    } catch (error) {
      setModelDownload({
        kind: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      unlisten();
    }
  };
  // No click-named track: estimating from the music is the useful default.
  const [clickTrackId, setClickTrackId] = useState<string>(
    preselected ?? (musicTrackIds.length > 0 ? FROM_MUSIC : ""),
  );
  const [keyTrackIds, setKeyTrackIds] = useState<Set<string>>(
    () => new Set(keyOptions.filter((option) => option.preselected).map((option) => option.id)),
  );
  const [analyzeKeyToo, setAnalyzeKeyToo] = useState(keyOptions.length > 0);
  const [phase, setPhase] = useState<Phase>({ kind: "setup", notice: null });
  const [rows, setRows] = useState<ReviewRow[]>([]);
  /** The click (without accent) read as eighths: its ÷2 reading. */
  const [eighths, setEighths] = useState(false);
  const [detail, setDetail] = useState<TempoDetail>(DEFAULT_TEMPO_DETAIL);
  const [include, setInclude] = useState({
    tempo: true,
    signature: true,
    key: true,
    keyChanges: true,
    sections: true,
  });
  const [keyChoice, setKeyChoice] = useState<string>("");
  /** The key stretches found (the song modulates when there are 2+), editable
   * one by one; the first is the key the song starts in. */
  const [keySections, setKeySections] = useState<KeySection[]>([]);
  const [applying, setApplying] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  useEffect(
    () => () => {
      unlistenRef.current?.();
    },
    [],
  );

  const analyzing = phase.kind === "analyzing";
  const dismiss = () => {
    if (analyzing) {
      void cancelAnalyzeSong();
      return;
    }
    onClose();
  };
  useDismissOnBack(dismiss);

  const wantsKey = analyzeKeyToo && keyTrackIds.size > 0;
  const canAnalyze = clickTrackId !== "" || wantsKey || guideTrackId !== "";

  const analyze = async () => {
    if (!canAnalyze || analyzing) return;
    setPhase({ kind: "analyzing", fraction: 0, stage: "render", done: null, total: null });
    unlistenRef.current?.();
    try {
      unlistenRef.current = await listenToSongAnalysisProgress((event) => {
        setPhase((current) =>
          current.kind === "analyzing"
            ? {
                kind: "analyzing",
                fraction: event.fraction,
                stage: event.stage ?? current.stage,
                done: event.done ?? null,
                total: event.total ?? null,
              }
            : current,
        );
      });
      const fromMusic = clickTrackId === FROM_MUSIC;
      const result = await analyzeSong({
        regionId,
        clickTrackIds: clickTrackId && !fromMusic ? [clickTrackId] : [],
        musicTempoTrackIds: fromMusic ? musicTrackIds : [],
        // Session order, whatever order they were ticked in.
        keyTrackIds: wantsKey
          ? keyOptions.filter((option) => keyTrackIds.has(option.id)).map((option) => option.id)
          : [],
        guideTrackIds: guideTrackId ? [guideTrackId] : [],
      });
      if (result.cancelled) {
        setPhase({ kind: "setup", notice: t("transport.songAnalysis.cancelled") });
        return;
      }
      recordProductEvent("feature_song_analysis");
      const onEighths = startsOnEighths(
        clickTrackId && !fromMusic ? bpmFromNames(song, regionId, clickTrackId) : null,
        result.tempo?.analysis.segments[0]?.bpm,
        result.tempo?.asEighths?.analysis.segments[0]?.bpm,
      );
      setEighths(onEighths);
      setDetail(DEFAULT_TEMPO_DETAIL);
      const reading = tempoReading(result, onEighths);
      const proposalRows = reading ? reviewRows(tempoLevel(reading, DEFAULT_TEMPO_DETAIL).proposal) : [];
      const detectedKey = result.key?.analysis.key ?? null;
      const estimated =
        result.tempo?.analysis.warnings.some((w) => w.kind === "estimatedWithoutClick") ?? false;
      setRows(proposalRows);
      setKeyChoice(detectedKey ?? "");
      setKeySections(result.key?.analysis.sections ?? []);
      const groups = result.guide?.analysis.groups ?? [];
      setGroupMarkers(groups.map((group) => markersForLabels(group.labels, group.countedIn)));
      setInclude({
        tempo: proposalRows.some((row) => row.kind === "tempo"),
        // Without a click the meter is a guess: the user opts in.
        signature: !estimated && proposalRows.some((row) => row.kind === "signature"),
        // A song already in its key can still be missing its key changes.
        key:
          detectedKey !== null &&
          (detectedKey !== result.key?.currentKey ||
            keyStretchesAreNew(
              song.regions.find((r) => r.id === regionId),
              result.key?.analysis.sections ?? [],
            )),
        keyChanges: true,
        sections: groups.length > 0,
      });
      setPhase({ kind: "review", result });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const lower = raw.toLowerCase();
      const message = lower.includes("an analysis is already running")
        ? t("transport.songAnalysis.analysisAlreadyRunning")
        : lower.includes("nothing to analyze")
          ? t("transport.songAnalysis.nothingToAnalyze")
          : formatTransportError(error, t, song);
      setPhase({ kind: "error", message, raw, review: null });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const hasTempoRows = rows.some((row) => row.kind === "tempo");
  const hasSignatureRows = rows.some((row) => row.kind === "signature");
  const touchesTempo =
    (include.tempo && hasTempoRows) || (include.signature && hasSignatureRows);
  const tempoPayload = useMemo(
    () =>
      phase.kind === "review" && touchesTempo
        ? buildApplyPayload(song, regionId, rows, include, phase.result)
        : null,
    [phase.kind, touchesTempo, song, regionId, rows, include],
  );
  const appliesKey =
    phase.kind === "review" && phase.result.key !== null && include.key && keyChoice !== "";
  // A song that modulates: its first stretch is the starting key, the rest are
  // key changes at the song's own times.
  const appliesKeyChanges = appliesKey && include.keyChanges && keySections.length > 1;
  const regionStart = song.regions.find((r) => r.id === regionId)?.startSeconds ?? 0;
  // Where the guide's markers land, on the grid the tempo review writes.
  const sections = useMemo(() => {
    if (phase.kind !== "review" || !phase.result.guide) return [];
    return placeGuideSections(
      song,
      regionId,
      phase.result.renderStartSeconds,
      phase.result.guide.analysis,
      groupMarkers,
      touchesTempo && tempoPayload ? tempoInView(tempoPayload, phase.result) : null,
      guideLeadBars,
    );
  }, [phase, song, regionId, groupMarkers, touchesTempo, tempoPayload, guideLeadBars]);
  const appliesSections =
    phase.kind === "review" && phase.result.guide !== null && include.sections;
  const canApply =
    !applying &&
    (!touchesTempo || tempoPayload !== null) &&
    (touchesTempo || appliesKey || appliesSections);

  const apply = async () => {
    if (!canApply || phase.kind !== "review") return;
    setApplying(true);
    try {
      const snapshot = await applySongAnalysis(
        regionId,
        touchesTempo ? tempoPayload : null,
        appliesKeyChanges ? keySections[0].key : appliesKey ? keyChoice : null,
        appliesSections
          ? sections.map((section) => ({
              ...section,
              name: section.variant
                ? `${markerKindLabel(section.kind, t)} ${section.variant}`
                : markerKindLabel(section.kind, t),
            }))
          : null,
        appliesKeyChanges
          ? snapKeyChangesToSections(
              keySections.slice(1).map((section) => ({
                startSeconds: regionStart + section.startSeconds,
                key: section.key,
              })),
              // The sections being written, or the song's own.
              appliesSections
                ? sections
                    .filter((section) => markerCategory(section) === "section")
                    .map((section) => section.startSeconds)
                : song.sectionMarkers
                    .filter((marker) => markerCategory(marker) === "section")
                    .map((marker) => marker.startSeconds),
            )
          : null,
      );
      onApplied(snapshot);
      setPhase({ kind: "applied" });
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const lower = raw.toLowerCase();
      setPhase({
        kind: "error",
        message:
          lower.includes("markers are out of order") &&
          !lower.includes("time signature markers are out of order")
            ? t("transport.songAnalysis.sectionMarkersConflict")
            : formatTransportError(error, t, song),
        raw,
        review: phase.result,
      });
    } finally {
      setApplying(false);
    }
  };

  const seekTo = async (absoluteSeconds: number) => {
    try {
      onApplied(await seekTransport(absoluteSeconds));
    } catch {
      // A failed seek leaves the playhead where it was; nothing to report.
    }
  };

  const editRow = (changed: ReviewRow, text: string) =>
    setRows((previous) =>
      previous.map((row) =>
        row.kind === changed.kind && row.index === changed.index ? { ...row, text } : row,
      ),
    );

  // ÷2 / ×2. Between the click's two readings it swaps them, so bars and
  // markers come out of the click again (scaling a 142 map to 71 would keep a
  // bar every 4 eighths); past them it scales the BPMs.
  const scaleTempo = (factor: number) => {
    if (phase.kind !== "review") return;
    const swaps = phase.result.tempo?.asEighths && (factor < 1 ? !eighths : eighths);
    if (!swaps) {
      setRows((previous) => scaleTempoRows(previous, factor));
      return;
    }
    const reading = tempoReading(phase.result, !eighths);
    setEighths(!eighths);
    setRows(reading ? reviewRows(tempoLevel(reading, detail).proposal) : []);
  };

  // Another level of detail: its markers replace the rows (edits included,
  // as ÷2 / ×2 between readings does).
  const changeDetail = (next: TempoDetail) => {
    if (phase.kind !== "review") return;
    const reading = tempoReading(phase.result, eighths);
    setDetail(next);
    const nextRows = reading ? reviewRows(tempoLevel(reading, next).proposal) : [];
    setRows(nextRows);
    setInclude((current) => ({
      ...current,
      tempo: nextRows.some((row) => row.kind === "tempo"),
      signature: current.signature && nextRows.some((row) => row.kind === "signature"),
    }));
  };

  const toggleKeyTrack = (id: string) =>
    setKeyTrackIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const percent = phase.kind === "analyzing" ? Math.round(phase.fraction * 100) : 0;

  return (
    <div className="lt-modal-backdrop" onClick={analyzing ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-export-modal lt-render-modal lt-song-analysis-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-song-analysis-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">{regionName}</span>
            <h2 id="lt-song-analysis-title">{t("transport.songAnalysis.title")}</h2>
            <p>{t("transport.songAnalysis.intro")}</p>
          </div>
        </header>

        {phase.kind === "setup" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            {phase.notice ? <p className="lt-render-notice">{phase.notice}</p> : null}
            <p className={playing ? "lt-render-warning" : "lt-render-hint"}>
              {t(playing ? "transport.songAnalysis.cpuWhilePlaying" : "transport.songAnalysis.cpuNotice")}
            </p>
            {clickOptions.length === 0 ? (
              <p className="lt-render-hint">{t("transport.songAnalysis.noTracks")}</p>
            ) : (
              <>
                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">
                    {t("transport.songAnalysis.clickTrack")}
                  </span>
                  <select
                    aria-label={t("transport.songAnalysis.clickTrack")}
                    value={clickTrackId}
                    onChange={(event) => setClickTrackId(event.target.value)}
                  >
                    <option value="">{t("transport.songAnalysis.noTempo")}</option>
                    {musicTrackIds.length > 0 ? (
                      <option value={FROM_MUSIC}>{t("transport.songAnalysis.fromMusic")}</option>
                    ) : null}
                    {clickOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <span className="lt-render-hint">
                    {clickTrackId === FROM_MUSIC
                      ? t("transport.songAnalysis.fromMusicHint")
                      : preselected
                        ? t("transport.songAnalysis.clickTrackHint")
                        : t("transport.songAnalysis.clickTrackNotFound")}
                  </span>
                </label>

                <fieldset className="lt-render-section">
                  <legend className="lt-settings-field-label">
                    <label>
                      <input
                        type="checkbox"
                        checked={analyzeKeyToo}
                        onChange={(event) => setAnalyzeKeyToo(event.target.checked)}
                      />{" "}
                      {t("transport.songAnalysis.analyzeKey")}
                    </label>
                  </legend>
                  <p className="lt-render-hint">{t("transport.songAnalysis.keyTracksHint")}</p>
                  {analyzeKeyToo ? (
                    <ul className="lt-song-analysis-tracks">
                      {keyOptions.map((option) => (
                        <li key={option.id}>
                          <label>
                            <input
                              type="checkbox"
                              checked={keyTrackIds.has(option.id)}
                              onChange={() => toggleKeyTrack(option.id)}
                            />{" "}
                            {option.name}
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </fieldset>

                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">
                    {t("transport.songAnalysis.guideTrack")}
                  </span>
                  <select
                    aria-label={t("transport.songAnalysis.guideTrack")}
                    value={guideTrackId}
                    onChange={(event) => setGuideTrackId(event.target.value)}
                  >
                    <option value="">{t("transport.songAnalysis.noGuide")}</option>
                    {guideOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.name}
                      </option>
                    ))}
                  </select>
                  <span className="lt-render-hint">{t("transport.songAnalysis.guideTrackHint")}</span>
                </label>
                {guideTrackId && speechModel?.supported ? (
                  <SpeechModelNotice
                    status={speechModel}
                    download={modelDownload}
                    onDownload={() => void downloadModel()}
                  />
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {phase.kind === "analyzing" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status lt-song-analysis-status">
              <span className="lt-library-progress-spinner" aria-hidden="true" />
              {phase.stage === "guide" && phase.total
                ? t("transport.songAnalysis.stageGuideCount", {
                    done: phase.done ?? 0,
                    total: phase.total,
                  })
                : t(
                    phase.stage === "tempo"
                      ? clickTrackId === FROM_MUSIC
                        ? "transport.songAnalysis.stageTempoMusic"
                        : "transport.songAnalysis.stageTempo"
                      : phase.stage === "key"
                        ? "transport.songAnalysis.stageKey"
                        : phase.stage === "guide"
                          ? "transport.songAnalysis.stageGuide"
                          : "transport.songAnalysis.stageRender",
                  )}
            </p>
            <div
              className="lt-render-progress lt-song-analysis-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="lt-render-progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}

        {phase.kind === "review" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            {phase.result.tempo ? (
              <TempoReview
                result={phase.result}
                rows={rows}
                include={include}
                onInclude={(tempo, signature) => setInclude({ ...include, tempo, signature })}
                onEdit={editRow}
                eighths={eighths}
                detail={detail}
                onDetail={changeDetail}
                onScale={scaleTempo}
                onSeek={(seconds) => void seekTo(seconds)}
              />
            ) : null}
            {phase.result.key ? (
              <KeyReview
                result={phase.result.key}
                choice={keyChoice}
                onChoice={setKeyChoice}
                included={include.key}
                onInclude={(key) => setInclude({ ...include, key })}
                keySections={keySections}
                onKeySections={setKeySections}
                changesIncluded={include.keyChanges}
                onChangesIncluded={(keyChanges) => setInclude({ ...include, keyChanges })}
              />
            ) : null}
            {phase.result.guide ? (
              <GuideReview
                result={phase.result}
                markers={groupMarkers}
                onChange={(group, markers) =>
                  setGroupMarkers((previous) =>
                    previous.map((current, index) => (index === group ? markers : current)),
                  )
                }
                offerSpeech={speechModel?.supported === true && !speechModel.downloaded}
                leadBars={guideLeadBars}
                onLeadBars={setGuideLeadBars}
                placedCount={sections.length}
                existingCount={
                  song.sectionMarkers.filter((marker) => {
                    const region = song.regions.find((r) => r.id === regionId);
                    return (
                      region !== undefined &&
                      marker.startSeconds >= region.startSeconds &&
                      marker.startSeconds < region.endSeconds
                    );
                  }).length
                }
                included={include.sections}
                onInclude={(sectionsIncluded) =>
                  setInclude({ ...include, sections: sectionsIncluded })
                }
                onSeek={(seconds) => void seekTo(seconds)}
              />
            ) : null}
            {phase.result.missingFiles.length > 0 ? (
              <p className="lt-render-warning">
                {t("transport.songAnalysis.missingFiles", {
                  count: phase.result.missingFiles.length,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {phase.kind === "applied" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status">{t("transport.songAnalysis.applied")}</p>
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-warning">
              {t(phase.review ? "transport.songAnalysis.applyFailed" : "transport.songAnalysis.failed", {
                error: phase.message,
              })}
            </p>
            {!phase.message.includes(phase.raw) && phase.raw ? (
              <details>
                <summary>{t("transport.songAnalysis.errorDetails")}</summary>
                <p>{phase.raw}</p>
              </details>
            ) : null}
          </div>
        ) : null}

        <div className="lt-inline-actions lt-export-modal-actions">
          {phase.kind === "setup" ? (
            <>
              <button type="button" className="lt-secondary-button" onClick={onClose}>
                {t("transport.songAnalysis.cancel")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={!canAnalyze}
                onClick={() => void analyze()}
              >
                {t("transport.songAnalysis.analyze")}
              </button>
            </>
          ) : null}
          {phase.kind === "analyzing" ? (
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => void cancelAnalyzeSong()}
            >
              {t("transport.songAnalysis.stop")}
            </button>
          ) : null}
          {phase.kind === "review" ? (
            <>
              <button
                type="button"
                className="lt-secondary-button"
                onClick={() => setPhase({ kind: "setup", notice: null })}
              >
                {t("transport.songAnalysis.back")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={!canApply}
                onClick={() => void apply()}
              >
                {t("transport.songAnalysis.apply")}
              </button>
            </>
          ) : null}
          {phase.kind === "applied" || phase.kind === "error" ? (
            <>
              {phase.kind === "error" ? (
                <button
                  type="button"
                  className="lt-secondary-button"
                  onClick={() =>
                    setPhase(
                      phase.review
                        ? { kind: "review", result: phase.review }
                        : { kind: "setup", notice: null },
                    )
                  }
                >
                  {t("transport.songAnalysis.back")}
                </button>
              ) : null}
              <button type="button" className="is-primary" onClick={onClose}>
                {t("transport.songAnalysis.close")}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

type SpeechModelNoticeProps = {
  status: SpeechModelStatus;
  download:
    | { kind: "idle" }
    | { kind: "downloading"; fraction: number }
    | { kind: "failed"; message: string };
  onDownload: () => void;
};

/** Speech recognition reads any voice's announcements; it needs a download. */
function SpeechModelNotice({ status, download, onDownload }: SpeechModelNoticeProps) {
  const { t } = useTranslation();
  if (status.downloaded) {
    return <p className="lt-render-hint">{t("transport.songAnalysis.speechReady")}</p>;
  }
  const megabytes = Math.round(status.sizeBytes / 1_000_000);
  return (
    <div className="lt-song-analysis-callout">
      <p className="lt-render-notice">{t("transport.songAnalysis.speechMissing", { megabytes })}</p>
      {download.kind === "downloading" ? (
        <div
          className="lt-render-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(download.fraction * 100)}
        >
          <div
            className="lt-render-progress-fill"
            style={{ width: `${Math.round(download.fraction * 100)}%` }}
          />
        </div>
      ) : (
        <div className="lt-song-analysis-actions">
          <button type="button" className="lt-song-analysis-button" onClick={onDownload}>
            {t("transport.songAnalysis.speechDownload", { megabytes })}
          </button>
        </div>
      )}
      {download.kind === "failed" ? (
        <p className="lt-render-warning">
          {t("transport.songAnalysis.speechFailed", { error: download.message })}
        </p>
      ) : null}
    </div>
  );
}

type GuideReviewProps = {
  result: AnalyzeSongResult;
  markers: GroupMarkers[];
  onChange: (group: number, markers: GroupMarkers) => void;
  offerSpeech: boolean;
  leadBars: number;
  onLeadBars: (bars: number) => void;
  placedCount: number;
  existingCount: number;
  included: boolean;
  onInclude: (included: boolean) => void;
  onSeek: (absoluteSeconds: number) => void;
};

type Translate = (key: string, options?: { defaultValue?: string }) => string;

/** Section kinds with their numbered variants, as select options. */
function sectionOptions(t: Translate) {
  return MARKER_KINDS.filter((kind) => kind !== "custom").flatMap((kind) => {
    const label = markerKindLabel(kind, t);
    return [
      { value: kind, label },
      ...markerKindVariants(kind).map((variant) => ({
        value: `${kind}:${variant}`,
        label: `${label} ${variant}`,
      })),
    ];
  });
}

const onlyCueKinds = () => CUE_KINDS.filter((kind) => !MARKER_KINDS.includes(kind));

/** Section kinds, then cue kinds to put in the section lane, as select
 * options ("Toda la banda" said with a count-in starts a section). */
function sectionSlotOptions(t: Translate) {
  return [
    ...sectionOptions(t),
    ...onlyCueKinds().map((kind) => ({
      value: kind,
      label: (t as (key: string, options: { kind: string }) => string)(
        "transport.songAnalysis.cueAsSection",
        { kind: markerKindLabel(kind, t) },
      ),
    })),
  ];
}

/** Cue kinds, then section kinds to put in the cue lane, as select options
 * ("Verso a capella": a capella rides as a cue next to the verse). */
function cueOptions(t: Translate) {
  return [
    ...onlyCueKinds().map((kind) => ({
      value: kind,
      label: markerKindLabel(kind, t),
    })),
    ...sectionOptions(t).map((option) => ({
      value: option.value,
      label: (t as (key: string, options: { kind: string }) => string)(
        "transport.songAnalysis.sectionAsCue",
        { kind: option.label },
      ),
    })),
  ];
}

function GuideReview({
  result,
  markers,
  onChange,
  offerSpeech,
  leadBars,
  onLeadBars,
  placedCount,
  existingCount,
  included,
  onInclude,
  onSeek,
}: GuideReviewProps) {
  const { t } = useTranslation();
  if (!result.guide) return null;
  const { groups } = result.guide.analysis;
  const sections = sectionSlotOptions(t);
  const cues = cueOptions(t);
  const unrecognised = groups.filter((_, index) => isUnrecognised(markers[index])).length;
  return (
    <section className="lt-song-analysis-part">
      <h3>
        <label>
          <input
            type="checkbox"
            checked={included}
            disabled={groups.length === 0}
            onChange={(event) => onInclude(event.target.checked)}
          />{" "}
          {t("transport.songAnalysis.applySections", { count: placedCount })}
        </label>
      </h3>
      {groups.length === 0 ? (
        <p className="lt-render-notice">{t("transport.songAnalysis.noAnnouncements")}</p>
      ) : (
        <>
          <p className="lt-render-hint">{t("transport.songAnalysis.sectionsHint")}</p>
          {unrecognised > 0 ? (
            <p className="lt-render-warning">
              {t("transport.songAnalysis.unrecognised", { count: unrecognised })}
            </p>
          ) : null}
          {offerSpeech && !result.guide.speechRecognition ? (
            <p className="lt-render-hint">{t("transport.songAnalysis.speechSuggestion")}</p>
          ) : null}
          {existingCount > 0 && included ? (
            <p className="lt-render-hint">
              {t("transport.songAnalysis.replacesMarkers", { count: existingCount })}
            </p>
          ) : null}
          <label className="lt-song-analysis-lead">
            <span className="lt-render-hint">{t("transport.songAnalysis.leadLabel")}</span>
            <select
              aria-label={t("transport.songAnalysis.leadLabel")}
              value={leadBars}
              disabled={!included}
              onChange={(event) => onLeadBars(Number(event.target.value))}
            >
              <option value={1}>{t("transport.songAnalysis.leadOne")}</option>
              <option value={2}>{t("transport.songAnalysis.leadTwo")}</option>
            </select>
          </label>
          <ul className="lt-song-analysis-guide" aria-label={t("transport.songAnalysis.colAnnouncement")}>
            <li className="lt-song-analysis-guide-head" aria-hidden="true">
              <span>{t("transport.songAnalysis.colAnnouncement")}</span>
              <span>{t("transport.songAnalysis.colSection")}</span>
              <span>{t("transport.songAnalysis.colCue")}</span>
            </li>
            {groups.map((group, index) => {
              const current = markers[index] ?? { section: "", cue: "", ignored: false };
              const position = formatSongPosition(group.firstStartSeconds);
              return (
                <li
                  key={index}
                  className={`lt-song-analysis-guide-row${
                    isUnrecognised(current) ? " is-unassigned" : ""
                  }`}
                >
                  <div className="lt-song-analysis-guide-said">
                    <button
                      type="button"
                      className="lt-link-button"
                      aria-label={t("transport.songAnalysis.listen", { position })}
                      onClick={() => onSeek(result.renderStartSeconds + group.firstStartSeconds)}
                    >
                      ▶ {position}
                    </button>
                    {group.occurrences > 1 ? (
                      <span className="lt-render-hint"> ×{group.occurrences}</span>
                    ) : null}
                    {group.transcript ? (
                      <small className="lt-level-songs-note">«{group.transcript}»</small>
                    ) : null}
                  </div>
                  <label className="lt-song-analysis-guide-field">
                    <span className="lt-song-analysis-guide-caption">
                      {t("transport.songAnalysis.colSection")}
                    </span>
                    <select
                      aria-label={t("transport.songAnalysis.sectionFor", { position })}
                      value={current.ignored ? "ignore" : current.section}
                      disabled={!included}
                      onChange={(event) => {
                        const value = event.target.value;
                        onChange(
                          index,
                          value === "ignore"
                            ? { section: "", cue: "", ignored: true }
                            : { ...current, section: value, ignored: false },
                        );
                      }}
                    >
                      <option value="">{t("transport.songAnalysis.none")}</option>
                      <option value="ignore">{t("transport.songAnalysis.ignore")}</option>
                      {sections.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="lt-song-analysis-guide-field">
                    <span className="lt-song-analysis-guide-caption">
                      {t("transport.songAnalysis.colCue")}
                    </span>
                    <select
                      aria-label={t("transport.songAnalysis.cueFor", { position })}
                      value={current.cue}
                      disabled={!included || current.ignored}
                      onChange={(event) =>
                        onChange(index, { ...current, cue: event.target.value, ignored: false })
                      }
                    >
                      <option value="">{t("transport.songAnalysis.none")}</option>
                      {cues.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

type KeySection = { startSeconds: number; key: string };

type KeyReviewProps = {
  result: NonNullable<AnalyzeSongResult["key"]>;
  choice: string;
  onChoice: (key: string) => void;
  included: boolean;
  onInclude: (included: boolean) => void;
  keySections: KeySection[];
  onKeySections: (sections: KeySection[]) => void;
  changesIncluded: boolean;
  onChangesIncluded: (included: boolean) => void;
};

function KeyReview({
  result,
  choice,
  onChoice,
  included,
  onInclude,
  keySections,
  onKeySections,
  changesIncluded,
  onChangesIncluded,
}: KeyReviewProps) {
  const { t } = useTranslation();
  const { analysis, currentKey, transposeSemitones } = result;
  if (!analysis.key) {
    return (
      <section className="lt-song-analysis-part">
        <h3>{t("transport.songAnalysis.key")}</h3>
        <p className="lt-render-notice">{t("transport.songAnalysis.noKey")}</p>
      </section>
    );
  }
  const modulates = keySections.length > 1;
  const perStretch = modulates && changesIncluded;
  const sounding =
    transposeSemitones !== 0 && !perStretch ? transposeKey(choice, transposeSemitones) : null;
  const tuning = Math.round(analysis.tuningCents);
  return (
    <section className="lt-song-analysis-part">
      <h3>
        <label>
          <input
            type="checkbox"
            checked={included}
            onChange={(event) => onInclude(event.target.checked)}
          />{" "}
          {t("transport.songAnalysis.applyKey")}
        </label>
      </h3>
      {modulates ? (
        <label className="lt-song-analysis-key-changes-toggle">
          <input
            type="checkbox"
            checked={changesIncluded}
            disabled={!included}
            onChange={(event) => onChangesIncluded(event.target.checked)}
          />{" "}
          {t("transport.songAnalysis.applyKeyChanges", { count: keySections.length - 1 })}
        </label>
      ) : null}
      {perStretch ? (
        <dl className="lt-song-analysis-summary">
          {keySections.map((section, index) => (
            <div key={section.startSeconds}>
              <dt>
                {index === 0
                  ? t("transport.songAnalysis.keyStart")
                  : formatSongPosition(section.startSeconds)}
              </dt>
              <dd>
                <select
                  aria-label={t("transport.songAnalysis.keyAt", {
                    time: formatSongPosition(section.startSeconds),
                  })}
                  value={section.key}
                  disabled={!included}
                  onChange={(event) =>
                    onKeySections(
                      keySections.map((current, at) =>
                        at === index ? { ...current, key: event.target.value } : current,
                      ),
                    )
                  }
                >
                  {SONG_KEY_OPTIONS.map((key) => (
                    <option key={key} value={key}>
                      {key}
                    </option>
                  ))}
                </select>
                {transposeSemitones !== 0 ? (
                  <span className="lt-render-hint">
                    {" "}
                    ({transposeKey(section.key, transposeSemitones)})
                  </span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <dl className="lt-song-analysis-summary" hidden={perStretch}>
        <div>
          <dt>{t("transport.songAnalysis.key")}</dt>
          <dd>
            {currentKey ?? "—"} →{" "}
            <select
              aria-label={t("transport.songAnalysis.key")}
              value={choice}
              disabled={!included}
              onChange={(event) => onChoice(event.target.value)}
            >
              {SONG_KEY_OPTIONS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
          </dd>
        </div>
      </dl>
      {currentKey === analysis.key && !perStretch ? (
        <p className="lt-render-hint">{t("transport.songAnalysis.keyUnchanged")}</p>
      ) : null}
      {perStretch ? (
        <p className="lt-render-hint">{t("transport.songAnalysis.keyChangesHint")}</p>
      ) : null}
      {modulates && !perStretch ? (
        <p className="lt-render-warning">
          {t("transport.songAnalysis.keyModulates", {
            sections: analysis.sections
              .map((section) => `${section.key} · ${formatSongPosition(section.startSeconds)}`)
              .join(" → "),
          })}
        </p>
      ) : null}
      {analysis.alternative ? (
        <p className="lt-render-warning">
          {t(
            analysis.relativeDoubt
              ? "transport.songAnalysis.keyRelativeDoubt"
              : "transport.songAnalysis.keyDoubt",
            { key: analysis.alternative },
          )}
        </p>
      ) : null}
      {sounding ? (
        <p className="lt-render-hint">
          {t("transport.songAnalysis.keyTransposed", {
            semitones: transposeSemitones > 0 ? `+${transposeSemitones}` : transposeSemitones,
            key: sounding,
          })}
        </p>
      ) : null}
      {Math.abs(tuning) >= TUNING_NOTICE_CENTS ? (
        <p className="lt-render-hint">
          {t(
            tuning < 0
              ? "transport.songAnalysis.tuningFlat"
              : "transport.songAnalysis.tuningSharp",
            { cents: Math.abs(tuning) },
          )}
        </p>
      ) : null}
    </section>
  );
}

type TempoReviewProps = {
  result: AnalyzeSongResult;
  rows: ReviewRow[];
  include: { tempo: boolean; signature: boolean };
  onInclude: (tempo: boolean, signature: boolean) => void;
  onEdit: (row: ReviewRow, text: string) => void;
  /** Showing the click read as eighths (`result.tempo.asEighths`). */
  eighths: boolean;
  detail: TempoDetail;
  onDetail: (detail: TempoDetail) => void;
  onScale: (factor: number) => void;
  onSeek: (absoluteSeconds: number) => void;
};

const TEMPO_DETAILS: TempoDetail[] = ["follow", "simplified", "initial"];

/** The tempo reading on show: the click's, or its eighths (÷2) reading. */
function tempoReading(result: AnalyzeSongResult, eighths: boolean) {
  if (!result.tempo) return null;
  return (eighths ? result.tempo.asEighths : null) ?? result.tempo;
}

function TempoReview({
  result,
  rows,
  include,
  onInclude,
  onEdit,
  eighths,
  detail,
  onDetail,
  onScale,
  onSeek,
}: TempoReviewProps) {
  const { t } = useTranslation();
  const reading = tempoReading(result, eighths);
  if (!reading) return null;
  const { analysis } = reading;
  const { segments, proposal } = tempoLevel(reading, detail);
  const { regionStartSeconds } = result;

  const firstTempo = rows.find((row) => row.kind === "tempo");
  const firstSignature = rows.find((row) => row.kind === "signature");
  const detected = segments[0];
  const hasTempoRows = rows.some((row) => row.kind === "tempo");
  const hasSignatureRows = rows.some((row) => row.kind === "signature");
  const estimated = analysis.warnings.some((w) => w.kind === "estimatedWithoutClick");

  return (
    <section className="lt-song-analysis-part">
      <h3>{t("transport.songAnalysis.tempoAndMeter")}</h3>
      {estimated ? (
        <p className="lt-render-notice">{t("transport.songAnalysis.estimatedNotice")}</p>
      ) : null}
      {analysis.segments.length > 0 && detected ? (
        <dl className="lt-song-analysis-summary">
          <div>
            <dt>{t("transport.songAnalysis.tempo")}</dt>
            <dd>
              {proposal.currentBpm} →{" "}
              <strong>{firstTempo ? firstTempo.text : detected.bpm}</strong>
            </dd>
          </div>
          <div>
            <dt>{t("transport.songAnalysis.signature")}</dt>
            <dd>
              {proposal.currentSignature} →{" "}
              <strong>
                {firstSignature
                  ? firstSignature.text
                  : `${detected.beatsPerBar}/${detected.beatUnit}`}
              </strong>
            </dd>
          </div>
          <div>
            <dt>{t("transport.songAnalysis.changes")}</dt>
            <dd>
              {t("transport.songAnalysis.segmentCount", { count: segments.length })}
            </dd>
          </div>
        </dl>
      ) : null}

      {offersTempoDetail(reading) ? (
        <div className="lt-song-analysis-detail" role="radiogroup">
          <span className="lt-render-hint">{t("transport.songAnalysis.detailLabel")}</span>
          {TEMPO_DETAILS.map((option) => (
            <label key={option}>
              <input
                type="radio"
                name="lt-song-analysis-detail"
                checked={detail === option}
                onChange={() => onDetail(option)}
              />{" "}
              {t(`transport.songAnalysis.detail.${option}`)}
            </label>
          ))}
        </div>
      ) : null}

      {proposal.unchanged && analysis.segments.length > 0 ? (
        <p className="lt-render-notice">{t("transport.songAnalysis.unchanged")}</p>
      ) : null}

      {rows.length > 0 ? (
        <>
          <div className="lt-song-analysis-actions">
            <span className="lt-render-hint">{t("transport.songAnalysis.doubleHalf")}</span>
            <button
              type="button"
              className="lt-song-analysis-button"
              disabled={!include.tempo || !hasTempoRows}
              onClick={() => onScale(2)}
            >
              ×2
            </button>
            <button
              type="button"
              className="lt-song-analysis-button"
              disabled={!include.tempo || !hasTempoRows}
              onClick={() => onScale(0.5)}
            >
              ÷2
            </button>
          </div>
          <div className="lt-render-track-tools">
            <label>
              <input
                type="checkbox"
                checked={include.tempo && hasTempoRows}
                disabled={!hasTempoRows}
                onChange={(event) => onInclude(event.target.checked, include.signature)}
              />{" "}
              {t("transport.songAnalysis.applyTempo")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={include.signature && hasSignatureRows}
                disabled={!hasSignatureRows}
                onChange={(event) => onInclude(include.tempo, event.target.checked)}
              />{" "}
              {t("transport.songAnalysis.applySignature")}
            </label>
          </div>
          <div className="lt-level-songs-table-wrap">
            <table className="lt-level-songs-table lt-song-analysis-table">
              <thead>
                <tr>
                  <th>{t("transport.songAnalysis.colPosition")}</th>
                  <th>{t("transport.songAnalysis.colKind")}</th>
                  <th>{t("transport.songAnalysis.colValue")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const enabled = row.kind === "tempo" ? include.tempo : include.signature;
                  const label =
                    row.kind === "tempo"
                      ? t("transport.songAnalysis.kindTempo")
                      : t("transport.songAnalysis.kindSignature");
                  const position = formatSongPosition(
                    viewSeconds(result, row.startSeconds) - result.renderStartSeconds,
                  );
                  return (
                    <tr
                      key={`${row.kind}-${row.index}`}
                      className={enabled ? undefined : "is-muted"}
                    >
                      <td>
                        <button
                          type="button"
                          className="lt-link-button"
                          onClick={() => onSeek(row.startSeconds)}
                        >
                          {position}
                        </button>
                      </td>
                      <td>
                        {label}
                        {row.kind === "tempo" && row.ramp ? (
                          <small className="lt-level-songs-note">
                            {t("transport.songAnalysis.rampToNext")}
                          </small>
                        ) : null}
                      </td>
                      <td>
                        <input
                          type="text"
                          inputMode={row.kind === "tempo" ? "decimal" : "text"}
                          aria-label={`${label} ${position}`}
                          aria-invalid={!rowIsValid(row)}
                          disabled={!enabled}
                          value={row.text}
                          onChange={(event) => onEdit(row, event.target.value)}
                          size={6}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {analysis.warnings.length > 0 ? (
        <ul className="lt-song-analysis-warnings">
          {analysis.warnings
            .filter((warning) => warning.kind !== "estimatedWithoutClick")
            .map((warning, index) => (
            <li key={`${warning.kind}-${index}`} className="lt-render-warning">
              {warning.kind === "noClick" ? null : (
                <button
                  type="button"
                  className="lt-link-button"
                  onClick={() => onSeek(viewSeconds(result, regionStartSeconds + warning.seconds))}
                >
                  {formatSongPosition(warning.seconds * result.viewScale)}
                </button>
              )}{" "}
              {t(`transport.songAnalysis.warning.${warning.kind}`)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
