import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { gainToDb } from "@libretracks/shared/faderScale";

import {
  cancelMeasureSongLoudness,
  getSettings,
  isMobileApp,
  listenToLevelSongsProgress,
  measureSongLoudness,
  updateSongRegionMasterGains,
  type MeasureSongLoudnessResult,
  type SongView,
  type TransportSnapshot,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useSongStore } from "../songStore";
import {
  defaultSongsToApply,
  groupLevelTracks,
  levelableTracks,
  planLevels,
  type LevelTarget,
  type LevelTrackGroup,
} from "./levelSongsPlan";
import { useLevelSongsStore } from "./levelSongsStore";
import { LevelTrackPicker } from "./LevelTrackPicker";
import { recordProductEvent } from "../../telemetry/telemetry";

type Phase =
  | { kind: "setup"; notice: string | null }
  | { kind: "measuring"; songsDone: number; fraction: number }
  | { kind: "review"; result: MeasureSongLoudnessResult }
  | { kind: "applied"; count: number }
  | { kind: "error"; message: string };

type CueRoutes = { metronomeOutput: string; voiceGuideOutput: string };

const DEFAULT_CUE_ROUTES: CueRoutes = { metronomeOutput: "master", voiceGuideOutput: "monitor" };

type Props = {
  /** Hands the snapshot the apply returns to the transport. */
  onApplied: (snapshot: TransportSnapshot) => void;
};

/**
 * "Nivelar canciones": measure every song as it reaches the desk and set each
 * song master so they all play equally loud. Measure first, review the
 * proposal song by song, then apply as one undoable edit.
 */
export function LevelSongsModal({ onApplied }: Props) {
  const open = useLevelSongsStore((state) => state.open);
  const close = useLevelSongsStore((state) => state.close);
  const song = useSongStore((state) => state.song);
  const [cueRoutes, setCueRoutes] = useState<CueRoutes | null>(null);

  // The click and voice guide outputs say which outputs feed the in-ears.
  useEffect(() => {
    if (!open) {
      setCueRoutes(null);
      return;
    }
    let alive = true;
    getSettings()
      .then((settings) => {
        if (alive) {
          setCueRoutes({
            metronomeOutput: settings.metronomeOutput ?? "master",
            voiceGuideOutput: settings.voiceGuideOutput ?? "monitor",
          });
        }
      })
      .catch(() => {
        if (alive) setCueRoutes(DEFAULT_CUE_ROUTES);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open || !song || !cueRoutes) {
    return null;
  }
  return (
    <LevelSongsDialog song={song} cueRoutes={cueRoutes} onClose={close} onApplied={onApplied} />
  );
}

type DialogProps = {
  song: SongView;
  cueRoutes: CueRoutes;
  onClose: () => void;
  onApplied: (snapshot: TransportSnapshot) => void;
};

function formatDb(db: number): string {
  if (!Number.isFinite(db)) return "−∞ dB";
  const rounded = Math.round(db * 10) / 10;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${Math.abs(rounded).toFixed(1)} dB`;
}

function formatLufs(lufs: number): string {
  return `${lufs < 0 ? "−" : ""}${Math.abs(lufs).toFixed(1)}`;
}

function LevelSongsDialog({ song, cueRoutes, onClose, onApplied }: DialogProps) {
  const { t } = useTranslation();
  // Captured once: the list must not reshuffle while the user ticks boxes.
  const [groups] = useState<LevelTrackGroup[]>(() =>
    groupLevelTracks(song, levelableTracks(song, cueRoutes)),
  );
  const tracks = useMemo(() => groups.flatMap((group) => group.tracks), [groups]);
  const defaultSelection = () =>
    new Set(tracks.filter((track) => track.exclusion === null).map((track) => track.id));
  const [selected, setSelected] = useState<Set<string>>(defaultSelection);
  const [phase, setPhase] = useState<Phase>({ kind: "setup", notice: null });
  const [target, setTarget] = useState<LevelTarget>({ kind: "noClip" });
  const [toApply, setToApply] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);
  const unlistenRef = useRef<(() => void) | null>(null);

  const regions = useMemo(
    () => [...song.regions].sort((a, b) => a.startSeconds - b.startSeconds),
    [song.regions],
  );
  const plan = useMemo(
    () =>
      phase.kind === "review"
        ? planLevels(regions, phase.result.songs, target)
        : null,
    [phase, regions, target],
  );

  useEffect(
    () => () => {
      unlistenRef.current?.();
    },
    [],
  );

  const measuring = phase.kind === "measuring";
  const dismiss = () => {
    if (measuring) {
      void cancelMeasureSongLoudness();
      return;
    }
    onClose();
  };
  useDismissOnBack(dismiss);

  const setMany = (ids: string[], on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const measure = async () => {
    if (selected.size === 0 || measuring) return;
    setPhase({ kind: "measuring", songsDone: 0, fraction: 0 });
    unlistenRef.current?.();
    unlistenRef.current = await listenToLevelSongsProgress((event) => {
      setPhase((current) =>
        current.kind === "measuring"
          ? { kind: "measuring", songsDone: event.songsDone, fraction: event.fraction }
          : current,
      );
    });
    try {
      const result = await measureSongLoudness({
        regionIds: regions.map((region) => region.id),
        trackIds: tracks.filter((track) => selected.has(track.id)).map((track) => track.id),
      });
      if (result.cancelled) {
        setPhase({ kind: "setup", notice: t("transport.levelSongs.cancelled") });
        return;
      }
      recordProductEvent("feature_level_songs");
      setTarget({ kind: "noClip" });
      setToApply(
        defaultSongsToApply(planLevels(regions, result.songs, { kind: "noClip" })),
      );
      setPhase({ kind: "review", result });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      unlistenRef.current?.();
      unlistenRef.current = null;
    }
  };

  const changeTarget = (next: LevelTarget) => {
    setTarget(next);
    if (phase.kind === "review") {
      setToApply(defaultSongsToApply(planLevels(regions, phase.result.songs, next)));
    }
  };

  const apply = async () => {
    if (!plan || applying) return;
    const gains = plan.songs
      .filter((entry) => entry.proposedGain !== null && toApply.has(entry.regionId))
      .map((entry) => ({ regionId: entry.regionId, masterGain: entry.proposedGain as number }));
    if (gains.length === 0) return;
    setApplying(true);
    try {
      const snapshot = await updateSongRegionMasterGains(gains);
      onApplied(snapshot);
      setPhase({ kind: "applied", count: gains.length });
    } catch (error) {
      setPhase({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setApplying(false);
    }
  };

  const applyCount = plan
    ? plan.songs.filter((entry) => entry.proposedGain !== null && toApply.has(entry.regionId))
        .length
    : 0;
  const percent = phase.kind === "measuring" ? Math.round(phase.fraction * 100) : 0;

  return (
    <div className="lt-modal-backdrop" onClick={measuring ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-export-modal lt-render-modal lt-level-songs-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-level-songs-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.levelSongs.eyebrow")}
            </span>
            <h2 id="lt-level-songs-title">{t("transport.levelSongs.title")}</h2>
            <p>{t("transport.levelSongs.intro")}</p>
          </div>
        </header>

        {phase.kind === "setup" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            {phase.notice ? <p className="lt-render-notice">{phase.notice}</p> : null}
            <fieldset className="lt-render-section">
              <legend className="lt-settings-field-label">
                {t("transport.levelSongs.tracks")}
              </legend>
              <p className="lt-render-hint">{t("transport.levelSongs.tracksHint")}</p>
              {tracks.length === 0 ? (
                <p className="lt-render-hint">{t("transport.levelSongs.noTracks")}</p>
              ) : (
                <>
                  <div className="lt-render-track-tools">
                    <span className="lt-render-hint">
                      {t("transport.levelSongs.selectedCount", {
                        count: tracks.filter((track) => selected.has(track.id)).length,
                        total: tracks.length,
                      })}
                    </span>
                    <button
                      type="button"
                      className="lt-secondary-button"
                      onClick={() => setSelected(new Set(tracks.map((track) => track.id)))}
                    >
                      {t("transport.levelSongs.selectAll")}
                    </button>
                    <button
                      type="button"
                      className="lt-secondary-button"
                      onClick={() => setSelected(defaultSelection())}
                    >
                      {t("transport.levelSongs.selectDefault")}
                    </button>
                  </div>
                  <LevelTrackPicker
                    groups={groups}
                    selected={selected}
                    onToggle={(id) => setSelected((prev) => toggle(prev, id))}
                    onSetMany={setMany}
                  />
                </>
              )}
            </fieldset>
            <p className="lt-render-hint">
              {t("transport.levelSongs.songsToMeasure", { count: regions.length })}
            </p>
          </div>
        ) : null}

        {phase.kind === "measuring" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status">
              {t("transport.levelSongs.measuring", {
                done: phase.songsDone,
                count: regions.length,
              })}
            </p>
            <div
              className="lt-render-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
            >
              <div className="lt-render-progress-fill" style={{ width: `${percent}%` }} />
            </div>
          </div>
        ) : null}

        {phase.kind === "review" && plan ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            <label className="lt-settings-field">
              <span className="lt-settings-field-label">{t("transport.levelSongs.target")}</span>
              <select
                value={target.kind === "song" ? target.regionId : target.kind}
                onChange={(event) => {
                  const value = event.target.value;
                  changeTarget(
                    value === "noClip" || value === "median"
                      ? { kind: value }
                      : { kind: "song", regionId: value },
                  );
                }}
              >
                <option value="noClip">{t("transport.levelSongs.targetNoClip")}</option>
                <option value="median">{t("transport.levelSongs.targetMedian")}</option>
                {plan.songs
                  .filter((entry) => entry.measurement?.hasSignal)
                  .map((entry) => (
                    <option key={entry.regionId} value={entry.regionId}>
                      {t("transport.levelSongs.targetSong", { name: entry.name })}
                    </option>
                  ))}
              </select>
              {plan.targetLufs !== null ? (
                <span className="lt-render-hint">
                  {t("transport.levelSongs.targetValue", { lufs: formatLufs(plan.targetLufs) })}
                  {plan.medianLufs !== null && plan.medianLufs - plan.targetLufs >= 0.5
                    ? ` · ${t("transport.levelSongs.belowMedian", {
                        db: (plan.medianLufs - plan.targetLufs).toFixed(1),
                      })}`
                    : ""}
                </span>
              ) : null}
            </label>

            <div className="lt-level-songs-table-wrap">
              <table className="lt-level-songs-table">
                <thead>
                  <tr>
                    <th aria-hidden="true" />
                    <th>{t("transport.levelSongs.colSong")}</th>
                    <th className="is-number">{t("transport.levelSongs.colLoudness")}</th>
                    <th className="is-number">{t("transport.levelSongs.colCurrent")}</th>
                    <th className="is-number">{t("transport.levelSongs.colProposed")}</th>
                    <th className="is-number">{t("transport.levelSongs.colChange")}</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.songs.map((entry) => {
                    const notes: string[] = [];
                    if (entry.limitedByPeak) notes.push(t("transport.levelSongs.limitedByPeak"));
                    if (entry.limitedByFader)
                      notes.push(t("transport.levelSongs.limitedByFader"));
                    const hasProposal = entry.proposedGain !== null;
                    return (
                      <tr key={entry.regionId} className={hasProposal ? undefined : "is-muted"}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={entry.name}
                            disabled={!hasProposal}
                            checked={hasProposal && toApply.has(entry.regionId)}
                            onChange={() => setToApply((prev) => toggle(prev, entry.regionId))}
                          />
                        </td>
                        <td>
                          <span className="lt-level-songs-name">
                            {entry.name}
                          </span>
                          {notes.length > 0 ? (
                            <small className="lt-level-songs-note">{notes.join(" · ")}</small>
                          ) : null}
                        </td>
                        <td className="is-number">
                          {entry.measurement?.hasSignal
                            ? `${formatLufs(entry.measurement.loudLufs)} LUFS`
                            : t("transport.levelSongs.noSignal")}
                        </td>
                        <td className="is-number">{formatDb(gainToDb(entry.currentGain))}</td>
                        <td className="is-number">
                          {hasProposal ? formatDb(gainToDb(entry.proposedGain as number)) : "—"}
                        </td>
                        <td className="is-number lt-level-songs-change">
                          {hasProposal ? formatDb(entry.changeDb) : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {phase.result.missingFiles.length > 0 ? (
              <p className="lt-render-warning">
                {t("transport.levelSongs.missingFiles", {
                  count: phase.result.missingFiles.length,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {phase.kind === "applied" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status">
              {t(
                isMobileApp
                  ? "transport.levelSongs.appliedMobile"
                  : "transport.levelSongs.applied",
                { count: phase.count },
              )}
            </p>
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-warning">
              {t("transport.levelSongs.failed", { error: phase.message })}
            </p>
          </div>
        ) : null}

        <div className="lt-inline-actions lt-export-modal-actions">
          {phase.kind === "setup" ? (
            <>
              <button type="button" className="lt-secondary-button" onClick={onClose}>
                {t("transport.levelSongs.cancel")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={selected.size === 0 || regions.length === 0}
                onClick={() => void measure()}
              >
                {t("transport.levelSongs.measure")}
              </button>
            </>
          ) : null}
          {phase.kind === "measuring" ? (
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => void cancelMeasureSongLoudness()}
            >
              {t("transport.levelSongs.stop")}
            </button>
          ) : null}
          {phase.kind === "review" ? (
            <>
              <button
                type="button"
                className="lt-secondary-button"
                onClick={() => setPhase({ kind: "setup", notice: null })}
              >
                {t("transport.levelSongs.back")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={applyCount === 0 || applying}
                onClick={() => void apply()}
              >
                {t("transport.levelSongs.apply", { count: applyCount })}
              </button>
            </>
          ) : null}
          {phase.kind === "applied" || phase.kind === "error" ? (
            <>
              {phase.kind === "error" ? (
                <button
                  type="button"
                  className="lt-secondary-button"
                  onClick={() => setPhase({ kind: "setup", notice: null })}
                >
                  {t("transport.levelSongs.back")}
                </button>
              ) : null}
              <button type="button" className="is-primary" onClick={onClose}>
                {t("transport.levelSongs.close")}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
