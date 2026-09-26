import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  cancelRenderSongAudio,
  listenToRenderAudioProgress,
  renderSongAudio,
  type RenderSampleFormat,
  type RenderSongAudioResult,
} from "../desktopApi";
import { useDismissOnBack } from "../mobile/backNavigation";
import { useSongStore } from "../songStore";
import {
  defaultRenderFileName,
  loadRenderPreferences,
  RENDER_SAMPLE_RATES,
  renderableTracks,
  saveRenderPreferences,
  type RenderPreferences,
  type RenderableTrack,
} from "./renderSelection";
import { useRenderStore } from "./renderStore";

type Phase =
  | { kind: "form"; notice: string | null }
  | { kind: "running"; fraction: number | null; stage: string }
  | { kind: "done"; result: RenderSongAudioResult }
  | { kind: "error"; message: string };

const FORMATS: RenderSampleFormat[] = ["pcm16", "pcm24", "float32"];

/**
 * "Render audio" for one song: pick the tracks that go in, the file format,
 * and get a WAV (or a zip of stems) — the rehearsal mix without your own
 * instrument. Opened from the song's context menu in every view.
 */
export function RenderSongModal() {
  const target = useRenderStore((state) => state.target);
  const close = useRenderStore((state) => state.close);
  const song = useSongStore((state) => state.song);
  if (!target) {
    return null;
  }
  return (
    <RenderSongDialog
      key={target.regionId}
      regionId={target.regionId}
      regionName={target.regionName}
      tracks={renderableTracks(song, target.regionId)}
      onClose={close}
    />
  );
}

type DialogProps = {
  regionId: string;
  regionName: string;
  tracks: RenderableTrack[];
  onClose: () => void;
};

function RenderSongDialog({ regionId, regionName, tracks, onClose }: DialogProps) {
  const { t } = useTranslation();
  const [preferences, setPreferences] = useState<RenderPreferences>(loadRenderPreferences);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(tracks.map((track) => track.id)),
  );
  const [phase, setPhase] = useState<Phase>({ kind: "form", notice: null });
  const [fileNameDraft, setFileNameDraft] = useState<string | null>(null);
  const unlistenRef = useRef<(() => void) | null>(null);

  const running = phase.kind === "running";
  const suggestedFileName = defaultRenderFileName(
    t,
    regionName,
    tracks,
    selected,
    preferences.mode,
  );
  // The name follows the selection until the user types their own.
  const fileName = fileNameDraft ?? suggestedFileName;

  useEffect(
    () => () => {
      unlistenRef.current?.();
    },
    [],
  );

  const dismiss = () => {
    if (running) {
      void cancelRenderSongAudio();
      return;
    }
    onClose();
  };
  useDismissOnBack(dismiss);

  const update = (patch: Partial<RenderPreferences>) =>
    setPreferences((previous) => ({ ...previous, ...patch }));

  const toggleTrack = (id: string) =>
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const setMany = (ids: string[], on: boolean) =>
    setSelected((previous) => {
      const next = new Set(previous);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  // Consecutive tracks under the same folder path form a group with its own
  // checkbox, so "everything but the guitars" is one click.
  const groups = useMemo(() => {
    const result: { key: string; label: string; tracks: RenderableTrack[] }[] = [];
    for (const track of tracks) {
      const key = track.folderNames.join(" / ");
      const last = result[result.length - 1];
      if (last && last.key === key) {
        last.tracks.push(track);
      } else {
        result.push({ key, label: key, tracks: [track] });
      }
    }
    return result;
  }, [tracks]);

  const selectedCount = tracks.filter((track) => selected.has(track.id)).length;
  const hasSomethingToRender =
    selectedCount > 0 || preferences.includeMetronome || preferences.includeVoiceGuide;

  const start = async () => {
    if (!hasSomethingToRender || running) {
      return;
    }
    saveRenderPreferences(preferences);
    setPhase({ kind: "running", fraction: null, stage: "choosing" });
    unlistenRef.current?.();
    unlistenRef.current = await listenToRenderAudioProgress((event) => {
      setPhase((current) =>
        current.kind === "running"
          ? { kind: "running", fraction: event.fraction, stage: event.stage }
          : current,
      );
    });
    try {
      const result = await renderSongAudio({
        regionId,
        trackIds: tracks.filter((track) => selected.has(track.id)).map((track) => track.id),
        mode: preferences.mode,
        format: preferences.format,
        sampleRate: preferences.sampleRate,
        channels: preferences.channels,
        normalize: preferences.normalize,
        applyMixer: preferences.applyMixer,
        includeMetronome: preferences.includeMetronome,
        includeVoiceGuide: preferences.includeVoiceGuide,
        fileName,
        metronomeLabel: t("transport.renderModal.metronomeStem"),
        voiceGuideLabel: t("transport.renderModal.voiceGuideStem"),
      });
      if (result.saved) {
        setPhase({ kind: "done", result });
      } else {
        setPhase({
          kind: "form",
          notice: result.cancelled ? t("transport.renderModal.cancelled") : null,
        });
      }
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

  const percent =
    phase.kind === "running" && phase.fraction !== null
      ? Math.round(phase.fraction * 100)
      : null;

  return (
    <div className="lt-modal-backdrop" onClick={running ? undefined : onClose}>
      <section
        className="lt-settings-modal lt-export-modal lt-render-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="lt-render-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="lt-settings-modal-header">
          <div>
            <span className="lt-settings-modal-eyebrow">
              {t("transport.renderModal.eyebrow")}
            </span>
            <h2 id="lt-render-modal-title">{t("transport.renderModal.title")}</h2>
            <p>{regionName}</p>
          </div>
        </header>

        {phase.kind === "form" ? (
          <div className="lt-settings-modal-body lt-render-modal-body">
            {phase.notice ? <p className="lt-render-notice">{phase.notice}</p> : null}

            <fieldset className="lt-render-section">
              <legend className="lt-settings-field-label">
                {t("transport.renderModal.tracks")}
              </legend>
              {tracks.length === 0 ? (
                <p className="lt-render-hint">{t("transport.renderModal.noTracks")}</p>
              ) : (
                <>
                  <div className="lt-render-track-tools">
                    <span className="lt-render-hint">
                      {t("transport.renderModal.selectedCount", {
                        count: selectedCount,
                        total: tracks.length,
                      })}
                    </span>
                    <button
                      type="button"
                      className="lt-secondary-button"
                      onClick={() => setMany(tracks.map((track) => track.id), true)}
                    >
                      {t("transport.renderModal.selectAll")}
                    </button>
                    <button
                      type="button"
                      className="lt-secondary-button"
                      onClick={() => setMany(tracks.map((track) => track.id), false)}
                    >
                      {t("transport.renderModal.selectNone")}
                    </button>
                  </div>
                  <ul className="lt-render-track-list">
                    {groups.map((group) => {
                      const ids = group.tracks.map((track) => track.id);
                      const on = ids.filter((id) => selected.has(id)).length;
                      return (
                        <li key={`${group.key}:${ids[0]}`}>
                          {group.label ? (
                            <label className="lt-render-track is-folder">
                              <input
                                type="checkbox"
                                checked={on === ids.length}
                                ref={(input) => {
                                  if (input) input.indeterminate = on > 0 && on < ids.length;
                                }}
                                onChange={() => setMany(ids, on !== ids.length)}
                              />
                              <span>{group.label}</span>
                            </label>
                          ) : null}
                          <ul className="lt-render-track-grid">
                            {group.tracks.map((track) => (
                              <li key={track.id}>
                                <label className="lt-render-track">
                                  <input
                                    type="checkbox"
                                    checked={selected.has(track.id)}
                                    onChange={() => toggleTrack(track.id)}
                                  />
                                  <span
                                    className="lt-render-track-swatch"
                                    style={{ background: track.color ?? "#57f1db" }}
                                    aria-hidden="true"
                                  />
                                  <span className="lt-render-track-name">{track.name}</span>
                                </label>
                              </li>
                            ))}
                          </ul>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </fieldset>

            <fieldset className="lt-render-section">
              <legend className="lt-settings-field-label">
                {t("transport.renderModal.output")}
              </legend>
              <label className="lt-export-option">
                <input
                  type="radio"
                  name="lt-render-mode"
                  checked={preferences.mode === "mix"}
                  onChange={() => update({ mode: "mix" })}
                />
                <span className="lt-export-option-copy">
                  <strong>{t("transport.renderModal.mixTitle")}</strong>
                  <small>{t("transport.renderModal.mixDescription")}</small>
                </span>
              </label>
              <label className="lt-export-option">
                <input
                  type="radio"
                  name="lt-render-mode"
                  checked={preferences.mode === "stems"}
                  onChange={() => update({ mode: "stems" })}
                />
                <span className="lt-export-option-copy">
                  <strong>{t("transport.renderModal.stemsTitle")}</strong>
                  <small>{t("transport.renderModal.stemsDescription")}</small>
                </span>
              </label>

              <div className="lt-render-grid">
                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">
                    {t("transport.renderModal.format")}
                  </span>
                  <select
                    value={preferences.format}
                    onChange={(event) =>
                      update({ format: event.target.value as RenderSampleFormat })
                    }
                  >
                    {FORMATS.map((format) => (
                      <option key={format} value={format}>
                        {t(`transport.renderModal.formats.${format}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">
                    {t("transport.renderModal.sampleRate")}
                  </span>
                  <select
                    value={preferences.sampleRate ?? ""}
                    onChange={(event) =>
                      update({
                        sampleRate: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                  >
                    <option value="">{t("transport.renderModal.sampleRateProject")}</option>
                    {RENDER_SAMPLE_RATES.map((rate) => (
                      <option key={rate} value={rate}>
                        {`${rate.toLocaleString()} Hz`}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="lt-settings-field">
                  <span className="lt-settings-field-label">
                    {t("transport.renderModal.channels")}
                  </span>
                  <select
                    value={preferences.channels}
                    onChange={(event) =>
                      update({ channels: event.target.value === "1" ? 1 : 2 })
                    }
                  >
                    <option value={2}>{t("transport.renderModal.stereo")}</option>
                    <option value={1}>{t("transport.renderModal.mono")}</option>
                  </select>
                </label>
              </div>

              <label className="lt-render-check">
                <input
                  type="checkbox"
                  checked={preferences.applyMixer}
                  onChange={(event) => update({ applyMixer: event.target.checked })}
                />
                <span className="lt-export-option-copy">
                  <strong>{t("transport.renderModal.applyMixer")}</strong>
                  <small>{t("transport.renderModal.applyMixerHint")}</small>
                </span>
              </label>
              <label className="lt-render-check">
                <input
                  type="checkbox"
                  checked={preferences.normalize}
                  onChange={(event) => update({ normalize: event.target.checked })}
                />
                <span className="lt-export-option-copy">
                  <strong>{t("transport.renderModal.normalize")}</strong>
                  <small>{t("transport.renderModal.normalizeHint")}</small>
                </span>
              </label>
              <label className="lt-render-check">
                <input
                  type="checkbox"
                  checked={preferences.includeMetronome}
                  onChange={(event) => update({ includeMetronome: event.target.checked })}
                />
                <span className="lt-export-option-copy">
                  <strong>{t("transport.renderModal.includeMetronome")}</strong>
                </span>
              </label>
              <label className="lt-render-check">
                <input
                  type="checkbox"
                  checked={preferences.includeVoiceGuide}
                  onChange={(event) => update({ includeVoiceGuide: event.target.checked })}
                />
                <span className="lt-export-option-copy">
                  <strong>{t("transport.renderModal.includeVoiceGuide")}</strong>
                </span>
              </label>

              <label className="lt-settings-field">
                <span className="lt-settings-field-label">
                  {t("transport.renderModal.fileName")}
                </span>
                <input
                  type="text"
                  className="lt-render-file-name"
                  value={fileName}
                  onChange={(event) => setFileNameDraft(event.target.value)}
                />
              </label>
            </fieldset>
          </div>
        ) : null}

        {phase.kind === "running" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status">
              {phase.stage === "choosing"
                ? t("transport.renderModal.choosingDestination")
                : phase.stage === "packing"
                  ? t("transport.renderModal.packing")
                  : t("transport.renderModal.rendering", { percent: percent ?? 0 })}
            </p>
            <div
              className="lt-render-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent ?? undefined}
            >
              <div
                className="lt-render-progress-fill"
                style={{ width: `${percent ?? 0}%` }}
              />
            </div>
          </div>
        ) : null}

        {phase.kind === "done" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-status">
              {t("transport.renderModal.saved", { file: phase.result.fileName ?? "" })}
            </p>
            {phase.result.missingFiles.length > 0 ? (
              <p className="lt-render-warning">
                {t("transport.renderModal.missingFiles", {
                  count: phase.result.missingFiles.length,
                })}
              </p>
            ) : null}
          </div>
        ) : null}

        {phase.kind === "error" ? (
          <div className="lt-settings-modal-body lt-render-modal-body" aria-live="polite">
            <p className="lt-render-warning">
              {t("transport.renderModal.failed", { error: phase.message })}
            </p>
          </div>
        ) : null}

        <div className="lt-inline-actions lt-export-modal-actions">
          {phase.kind === "form" ? (
            <>
              <button type="button" className="lt-secondary-button" onClick={onClose}>
                {t("transport.renderModal.cancel")}
              </button>
              <button
                type="button"
                className="is-primary"
                disabled={!hasSomethingToRender}
                onClick={() => void start()}
              >
                {t("transport.renderModal.confirm")}
              </button>
            </>
          ) : null}
          {phase.kind === "running" ? (
            <button
              type="button"
              className="lt-secondary-button"
              onClick={() => void cancelRenderSongAudio()}
            >
              {t("transport.renderModal.stop")}
            </button>
          ) : null}
          {phase.kind === "done" || phase.kind === "error" ? (
            <>
              <button
                type="button"
                className="lt-secondary-button"
                onClick={() => setPhase({ kind: "form", notice: null })}
              >
                {t("transport.renderModal.again")}
              </button>
              <button type="button" className="is-primary" onClick={onClose}>
                {t("transport.renderModal.close")}
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
