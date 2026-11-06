import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  analyzeSong,
  applySongAnalysis,
  cancelAnalyzeSong,
  downloadSpeechModel,
  getSongView,
  listenToSongAnalysisProgress,
  listenToSpeechModelProgress,
  speechModelStatus,
  type AnalyzeSongResult,
  type SongAnalysisProgress,
  type SongView,
  type SpeechModelStatus,
  type TransportSnapshot,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useSongStore } from "../songStore";
import { useTransportStore } from "../store";
import { recordProductEvent } from "../../telemetry/telemetry";
import {
  SongAnalysisDialog,
  analysisErrorMessage,
  applyErrorMessage,
  sectionMarkerName,
} from "./SongAnalysisModal";
import {
  analysisRequest,
  applyArguments,
  applyPlan,
  batchReview,
  defaultSetup,
  markersInSong,
  rebaseResult,
  setupHasWork,
  type AnalysisSetup,
} from "./songAnalysisReview";
import { useBatchSongAnalysisStore } from "./songAnalysisStore";

type ItemStatus = "pending" | "ready" | "applied" | "failed";

type Item = {
  regionId: string;
  name: string;
  setup: AnalysisSetup;
  status: ItemStatus;
  result: AnalyzeSongResult | null;
  error: string | null;
};

type Stage =
  | { kind: "setup" }
  | {
      kind: "running";
      index: number;
      total: number;
      name: string;
      fraction: number;
      stage: SongAnalysisProgress["stage"];
    }
  | { kind: "results"; stopped: boolean }
  | { kind: "applying"; done: number; total: number }
  | { kind: "reviewing"; regionId: string };

type Props = {
  onApplied: (snapshot: TransportSnapshot) => void;
};

/**
 * "Analizar todas las canciones" (File menu): analyse every song of the
 * session one after another with what each song's own setup would
 * preselect, then review them one by one (in the single-song dialog) or apply
 * them all as proposed. Each song applies as its own undo step.
 */
export function BatchSongAnalysisModal({ onApplied }: Props) {
  const open = useBatchSongAnalysisStore((state) => state.open);
  const close = useBatchSongAnalysisStore((state) => state.close);
  const song = useSongStore((state) => state.song);
  if (!open || !song) return null;
  return <BatchDialog song={song} onClose={close} onApplied={onApplied} />;
}

function BatchDialog({
  song,
  onClose,
  onApplied,
}: {
  song: SongView;
  onClose: () => void;
  onApplied: (snapshot: TransportSnapshot) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<Item[]>(() =>
    song.regions.map((region) => ({
      regionId: region.id,
      name: region.name,
      setup: defaultSetup(song, region.id),
      status: "pending",
      result: null,
      error: null,
    })),
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(items.filter((item) => setupHasWork(item.setup)).map((item) => item.regionId)),
  );
  const [stage, setStage] = useState<Stage>({ kind: "setup" });
  const [applyError, setApplyError] = useState<string | null>(null);
  const stopRef = useRef(false);
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

  const running = stage.kind === "running";
  const busy = running || stage.kind === "applying";
  const stop = () => {
    stopRef.current = true;
    void cancelAnalyzeSong();
  };
  const dismiss = () => {
    if (running) {
      stop();
      return;
    }
    if (stage.kind === "applying") return;
    onClose();
  };
  useDismissOnBack(dismiss);

  const patchItem = (regionId: string, patch: Partial<Item>) =>
    setItems((current) =>
      current.map((item) => (item.regionId === regionId ? { ...item, ...patch } : item)),
    );

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

  const queue = items.filter((item) => selected.has(item.regionId) && setupHasWork(item.setup));
  const anyGuide = queue.some((item) => item.setup.guideTrackId !== "");

  const run = async () => {
    if (queue.length === 0 || busy) return;
    stopRef.current = false;
    setApplyError(null);
    const todo = queue.map((item) => ({ ...item }));
    // A fresh run forgets what an earlier one found for these songs.
    setItems((current) =>
      current.map((item) =>
        selected.has(item.regionId) ? { ...item, status: "pending", result: null, error: null } : item,
      ),
    );
    let index = 0;
    const unlisten = await listenToSongAnalysisProgress((event) =>
      setStage((current) =>
        current.kind === "running"
          ? { ...current, fraction: event.fraction, stage: event.stage ?? current.stage }
          : current,
      ),
    );
    let stopped = false;
    try {
      for (; index < todo.length; index += 1) {
        if (stopRef.current) {
          stopped = true;
          break;
        }
        const item = todo[index];
        const current = useSongStore.getState().song ?? song;
        if (!current.regions.some((region) => region.id === item.regionId)) continue;
        setStage({
          kind: "running",
          index,
          total: todo.length,
          name: item.name,
          fraction: 0,
          stage: "render",
        });
        try {
          const result = await analyzeSong(analysisRequest(current, item.regionId, item.setup));
          if (result.cancelled) {
            stopped = true;
            break;
          }
          patchItem(item.regionId, { status: "ready", result, error: null });
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          patchItem(item.regionId, {
            status: "failed",
            error: analysisErrorMessage(raw, error, t, current),
          });
        }
      }
      recordProductEvent("feature_song_analysis");
    } finally {
      unlisten();
    }
    setStage({ kind: "results", stopped });
  };

  const applyAll = async () => {
    if (busy) return;
    const ready = items.filter((item) => item.status === "ready" && item.result);
    setApplyError(null);
    setStage({ kind: "applying", done: 0, total: ready.length });
    let done = 0;
    // The song store refreshes from the backend asynchronously after an
    // apply, so right after one it still holds the session before it: the
    // next song is planned against the song as the backend has it now.
    let fresh: SongView | null = null;
    for (const item of ready) {
      const current = fresh ?? useSongStore.getState().song;
      if (!current || !item.result || !current.regions.some((r) => r.id === item.regionId)) continue;
      // The songs applied before this one may have moved it.
      const result = rebaseResult(current, item.result);
      const review = batchReview(current, item.regionId, item.setup, result);
      const plan = applyPlan(current, item.regionId, result, review);
      if (!plan.canApply) continue;
      try {
        const args = applyArguments(current, item.regionId, review, plan, (section) =>
          sectionMarkerName(section, t),
        );
        onApplied(
          await applySongAnalysis(item.regionId, args.tempo, args.key, args.sections, args.keyChanges),
        );
        patchItem(item.regionId, { status: "applied" });
        fresh = await getSongView({ includeWaveforms: false }).catch(() => null);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        const message = applyErrorMessage(raw, error, t, current);
        patchItem(item.regionId, { status: "failed", error: message });
        setApplyError(t("transport.songAnalysis.batch.applyFailed", { song: item.name, error: message }));
      }
      done += 1;
      setStage({ kind: "applying", done, total: ready.length });
    }
    setStage({ kind: "results", stopped: false });
  };

  const reviewing = stage.kind === "reviewing" ? items.find((i) => i.regionId === stage.regionId) : null;
  if (reviewing?.result && song.regions.some((region) => region.id === reviewing.regionId)) {
    const leave = (applied: boolean) => {
      if (applied) patchItem(reviewing.regionId, { status: "applied" });
      setStage({ kind: "results", stopped: false });
    };
    return (
      <SongAnalysisDialog
        key={reviewing.regionId}
        song={song}
        regionId={reviewing.regionId}
        regionName={reviewing.name}
        initial={{ setup: reviewing.setup, result: rebaseResult(song, reviewing.result) }}
        onLeaveReview={leave}
        onClose={() => leave(false)}
        onApplied={onApplied}
      />
    );
  }

  const toggle = (regionId: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(regionId)) next.delete(regionId);
      else next.add(regionId);
      return next;
    });
  const selectable = items.filter((item) => setupHasWork(item.setup));
  const allSelected = selectable.length > 0 && selectable.every((item) => selected.has(item.regionId));

  const readyToApply = items.filter((item) => {
    if (item.status !== "ready" || !item.result) return false;
    const result = rebaseResult(song, item.result);
    return applyPlan(song, item.regionId, result, batchReview(song, item.regionId, item.setup, result))
      .canApply;
  }).length;

  const overall =
    stage.kind === "running"
      ? Math.round(((stage.index + stage.fraction) / Math.max(stage.total, 1)) * 100)
      : stage.kind === "applying"
        ? Math.round((stage.done / Math.max(stage.total, 1)) * 100)
        : 0;

  return (
    <div className="lt-modal-backdrop" onClick={busy ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-export-modal lt-render-modal lt-song-analysis-modal lt-batch-analysis-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-batch-analysis-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <h2 id="lt-batch-analysis-title">{t("transport.songAnalysis.batch.title")}</h2>
            <p>{t("transport.songAnalysis.batch.intro")}</p>
          </div>
        </header>

        {stage.kind === "setup" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            <p className={playing ? "lt-render-warning" : "lt-render-hint"}>
              {t(playing ? "transport.songAnalysis.cpuWhilePlaying" : "transport.songAnalysis.batch.cpuNotice")}
            </p>
            {items.length === 0 ? (
              <p className="lt-render-hint">{t("transport.songAnalysis.batch.noSongs")}</p>
            ) : (
              <>
                <label className="lt-batch-analysis-all">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    disabled={selectable.length === 0}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? new Set(selectable.map((item) => item.regionId))
                          : new Set(),
                      )
                    }
                  />{" "}
                  {t("transport.songAnalysis.batch.selectAll")}
                </label>
                <ul className="lt-batch-analysis-list">
                  {items.map((item) => {
                    const works = setupHasWork(item.setup);
                    return (
                      <li key={item.regionId} className="lt-batch-analysis-row">
                        <label className="lt-batch-analysis-name">
                          <input
                            type="checkbox"
                            aria-label={item.name}
                            checked={works && selected.has(item.regionId)}
                            disabled={!works}
                            onChange={() => toggle(item.regionId)}
                          />{" "}
                          <span>{item.name}</span>
                        </label>
                        <span className="lt-batch-analysis-reads">
                          {works ? setupSummary(item.setup, t) : t("transport.songAnalysis.batch.nothing")}
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="lt-render-hint">{t("transport.songAnalysis.batch.setupHint")}</p>
                {anyGuide && speechModel?.supported && !speechModel.downloaded ? (
                  <div className="lt-song-analysis-callout">
                    <p className="lt-render-notice">
                      {t("transport.songAnalysis.speechMissing", {
                        megabytes: Math.round(speechModel.sizeBytes / 1_000_000),
                      })}
                    </p>
                    {modelDownload.kind === "downloading" ? (
                      <div
                        className="lt-render-progress"
                        role="progressbar"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(modelDownload.fraction * 100)}
                      >
                        <div
                          className="lt-render-progress-fill"
                          style={{ width: `${Math.round(modelDownload.fraction * 100)}%` }}
                        />
                      </div>
                    ) : (
                      <div className="lt-song-analysis-actions">
                        <button
                          type="button"
                          className="lt-song-analysis-button"
                          onClick={() => void downloadModel()}
                        >
                          {t("transport.songAnalysis.speechDownload", {
                            megabytes: Math.round(speechModel.sizeBytes / 1_000_000),
                          })}
                        </button>
                      </div>
                    )}
                    {modelDownload.kind === "failed" ? (
                      <p className="lt-render-warning">
                        {t("transport.songAnalysis.speechFailed", { error: modelDownload.message })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        {stage.kind === "running" || stage.kind === "applying" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status lt-song-analysis-status">
              <span className="lt-library-progress-spinner" aria-hidden="true" />
              {stage.kind === "running"
                ? t("transport.songAnalysis.batch.progress", {
                    current: stage.index + 1,
                    total: stage.total,
                    song: stage.name,
                  })
                : t("transport.songAnalysis.batch.applying", {
                    done: stage.done,
                    total: stage.total,
                  })}
            </p>
            {stage.kind === "running" ? (
              <p className="lt-render-hint">{t(stageKey(stage.stage))}</p>
            ) : null}
            <div
              className="lt-render-progress lt-song-analysis-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={overall}
            >
              <div className="lt-render-progress-fill" style={{ width: `${overall}%` }} />
            </div>
          </div>
        ) : null}

        {stage.kind === "results" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            {stage.stopped ? (
              <p className="lt-render-notice">{t("transport.songAnalysis.batch.stopped")}</p>
            ) : null}
            {applyError ? <p className="lt-render-warning">{applyError}</p> : null}
            {readyToApply === 0 && items.some((item) => item.status === "applied") ? (
              <p className="lt-render-status">{t("transport.songAnalysis.batch.allApplied")}</p>
            ) : (
              <p className="lt-render-hint">{t("transport.songAnalysis.batch.resultsHint")}</p>
            )}
            <ul className="lt-batch-analysis-list" aria-label={t("transport.songAnalysis.batch.title")}>
              {items
                .filter((item) => item.status !== "pending" || selected.has(item.regionId))
                .map((item) => (
                  <ResultRow
                    key={item.regionId}
                    item={item}
                    song={song}
                    onReview={() => setStage({ kind: "reviewing", regionId: item.regionId })}
                  />
                ))}
            </ul>
            <p className="lt-render-hint">{t("transport.songAnalysis.batch.undoHint")}</p>
          </div>
        ) : null}

        <div className="lt-inline-actions lt-export-modal-actions">
          {stage.kind === "setup" ? (
            <>
              <button type="button" className="lt-secondary-button" onClick={onClose}>
                {t("transport.songAnalysis.cancel")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={queue.length === 0 || modelDownload.kind === "downloading"}
                onClick={() => void run()}
              >
                {t("transport.songAnalysis.batch.analyze", { count: queue.length })}
              </button>
            </>
          ) : null}
          {stage.kind === "running" ? (
            <button type="button" className="lt-secondary-button" onClick={stop}>
              {t("transport.songAnalysis.stop")}
            </button>
          ) : null}
          {stage.kind === "results" ? (
            <>
              <button
                type="button"
                className="lt-secondary-button"
                onClick={() => setStage({ kind: "setup" })}
              >
                {t("transport.songAnalysis.back")}
              </button>
              {/* Nothing left to apply (all applied, or nothing changes): no
                  "Aplicar todas (0)" button; closing is the way on. */}
              <button
                type="button"
                className={readyToApply > 0 ? "lt-secondary-button" : "is-primary"}
                onClick={onClose}
              >
                {t("transport.songAnalysis.close")}
              </button>
              {readyToApply > 0 ? (
                <button type="button" className="is-primary" onClick={() => void applyAll()}>
                  {t("transport.songAnalysis.batch.applyAll", { count: readyToApply })}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

type TranslateFn = ReturnType<typeof useTranslation>["t"];

function stageKey(stage: SongAnalysisProgress["stage"]): string {
  switch (stage) {
    case "tempo":
      return "transport.songAnalysis.stageTempo";
    case "key":
      return "transport.songAnalysis.stageKey";
    case "guide":
      return "transport.songAnalysis.stageGuide";
    default:
      return "transport.songAnalysis.stageRender";
  }
}

/** What one song's analysis will read: "Click · Nota · Guía". */
function setupSummary(setup: AnalysisSetup, t: TranslateFn): string {
  const parts: string[] = [];
  if (setup.clickTrackId === "__music__") parts.push(t("transport.songAnalysis.batch.readsMusic"));
  else if (setup.clickTrackId) parts.push(t("transport.songAnalysis.batch.readsClick"));
  if (setup.keyTrackIds.length > 0) parts.push(t("transport.songAnalysis.batch.readsKey"));
  if (setup.guideTrackId) parts.push(t("transport.songAnalysis.batch.readsGuide"));
  return parts.join(" · ");
}

function ResultRow({ item, song, onReview }: { item: Item; song: SongView; onReview: () => void }) {
  const { t } = useTranslation();
  const result = item.result;
  let summary: string[] = [];
  let canApply = false;
  let keptMarkers = 0;
  if (result && song.regions.some((region) => region.id === item.regionId)) {
    const review = batchReview(song, item.regionId, item.setup, result);
    const plan = applyPlan(song, item.regionId, result, review);
    canApply = plan.canApply;
    summary = resultSummary(review, plan, t);
    if (result.guide && !review.include.sections && plan.sections.length > 0) {
      keptMarkers = markersInSong(song, item.regionId);
    }
  }
  const status =
    item.status === "applied"
      ? t("transport.songAnalysis.batch.statusApplied")
      : item.status === "failed"
        ? t("transport.songAnalysis.batch.statusFailed")
        : item.status === "pending"
          ? t("transport.songAnalysis.batch.statusPending")
          : canApply
            ? null
            : t("transport.songAnalysis.batch.statusUnchanged");
  return (
    <li className={`lt-batch-analysis-row is-${item.status}`}>
      <div className="lt-batch-analysis-name">
        <strong>{item.name}</strong>
        {status ? <span className="lt-batch-analysis-status">{status}</span> : null}
      </div>
      <div className="lt-batch-analysis-reads">
        {item.error ? (
          <span className="lt-render-warning">{item.error}</span>
        ) : summary.length > 0 ? (
          summary.join(" · ")
        ) : null}
        {keptMarkers > 0 ? (
          <small className="lt-level-songs-note">
            {t("transport.songAnalysis.batch.keepsMarkers", { count: keptMarkers })}
          </small>
        ) : null}
      </div>
      {result ? (
        <button type="button" className="lt-song-analysis-button" onClick={onReview}>
          {t("transport.songAnalysis.batch.review")}
        </button>
      ) : null}
    </li>
  );
}

function resultSummary(
  review: ReturnType<typeof batchReview>,
  plan: ReturnType<typeof applyPlan>,
  t: TranslateFn,
): string[] {
  const parts: string[] = [];
  const tempoRows = review.rows.filter((row) => row.kind === "tempo");
  if (review.include.tempo && tempoRows.length > 0) {
    parts.push(
      tempoRows.length > 1
        ? t("transport.songAnalysis.batch.tempoChanges", {
            bpm: tempoRows[0].text,
            count: tempoRows.length - 1,
          })
        : t("transport.songAnalysis.batch.tempo", { bpm: tempoRows[0].text }),
    );
  }
  const signature = review.rows.find((row) => row.kind === "signature");
  if (review.include.signature && signature) parts.push(signature.text);
  if (plan.appliesKey) {
    parts.push(
      plan.appliesKeyChanges
        ? t("transport.songAnalysis.batch.keyChanges", {
            key: review.keySections[0].key,
            count: review.keySections.length - 1,
          })
        : t("transport.songAnalysis.batch.key", { key: review.keyChoice }),
    );
  }
  if (plan.appliesSections && plan.sections.length > 0) {
    parts.push(t("transport.songAnalysis.batch.markers", { count: plan.sections.length }));
  }
  return parts;
}
