import { useTranslation } from "react-i18next";

import type { GlobalJumpMode, SongJumpTrigger, SongTransitionMode, VampMode } from "./uiStore";

type TimelineToolbarProps = {
  snapEnabled: boolean;
  subdivisionPerBeat: number;
  globalJumpMode: GlobalJumpMode;
  globalJumpBars: number;
  songJumpTrigger: SongJumpTrigger;
  songJumpBars: number;
  songTransitionMode: SongTransitionMode;
  vampMode: VampMode;
  vampBars: number;
  isVampActive: boolean;
  pendingMarkerJumpLabel: string | null;
  isProjectEmpty: boolean;
  trackCount: number;
  clipCount: number;
  markerCount: number;
  onToggleSnap: () => void;
  onGlobalJumpModeChange: (mode: GlobalJumpMode) => void;
  onGlobalJumpBarsChange: (bars: number) => void;
  onSongJumpTriggerChange: (trigger: SongJumpTrigger) => void;
  onSongJumpBarsChange: (bars: number) => void;
  onSongTransitionModeChange: (mode: SongTransitionMode) => void;
  onVampModeChange: (mode: VampMode) => void;
  onVampBarsChange: (bars: number) => void;
  onToggleVamp: () => void;
  onCancelPendingJump: () => void;
};

export function TimelineToolbar({
  snapEnabled,
  subdivisionPerBeat,
  globalJumpMode,
  globalJumpBars,
  songJumpTrigger,
  songJumpBars,
  songTransitionMode,
  vampMode,
  vampBars,
  isVampActive,
  pendingMarkerJumpLabel,
  isProjectEmpty,
  trackCount,
  clipCount,
  markerCount,
  onToggleSnap,
  onGlobalJumpModeChange,
  onGlobalJumpBarsChange,
  onSongJumpTriggerChange,
  onSongJumpBarsChange,
  onSongTransitionModeChange,
  onVampModeChange,
  onVampBarsChange,
  onToggleVamp,
  onCancelPendingJump,
}: TimelineToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="lt-timeline-topline">
      <div className="lt-timeline-meta">
        <div className="lt-bottom-controls lt-timeline-controls">
          <button
            type="button"
            className={`lt-icon-button ${snapEnabled ? "is-active" : ""}`}
            aria-label={snapEnabled ? t("timelineToolbar.disableSnap") : t("timelineToolbar.enableSnap")}
            aria-pressed={snapEnabled}
            title={t("timelineToolbar.snapTitle", { subdivision: subdivisionPerBeat })}
            onClick={onToggleSnap}
          >
            <span className="material-symbols-outlined">{snapEnabled ? "grid_on" : "grid_off"}</span>
          </button>
          <label className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.markerJumpLabel")}</span>
            <select
              aria-label={t("timelineToolbar.markerJumpModeAria")}
              disabled={isProjectEmpty}
              value={globalJumpMode}
              onChange={(event) => onGlobalJumpModeChange(event.target.value as GlobalJumpMode)}
            >
              <option value="immediate">{t("transport.jumpMode.immediate")}</option>
              <option value="after_bars">{t("timelineToolbar.afterBarsOption")}</option>
              <option value="next_marker">{t("transport.jumpMode.nextMarker")}</option>
            </select>
          </label>
          {globalJumpMode === "after_bars" ? (
            <label className="lt-zoom-control">
              <span>{t("timelineToolbar.markerBarsLabel")}</span>
              <input
                aria-label={t("timelineToolbar.markerJumpBarsAria")}
                type="number"
                min={1}
                step={1}
                value={globalJumpBars}
                onChange={(event) => onGlobalJumpBarsChange(Number(event.target.value) || 1)}
              />
            </label>
          ) : null}
          <label className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.vampModeLabel")}</span>
            <select
              aria-label={t("timelineToolbar.vampModeAria")}
              disabled={isProjectEmpty}
              value={vampMode}
              onChange={(event) => onVampModeChange(event.target.value as VampMode)}
            >
              <option value="section">{t("timelineToolbar.vampSectionOption")}</option>
              <option value="bars">{t("timelineToolbar.vampBarsOption")}</option>
            </select>
          </label>
          {vampMode === "bars" ? (
            <label className="lt-zoom-control">
              <span>{t("timelineToolbar.vampBarsLabel")}</span>
              <input
                aria-label={t("timelineToolbar.vampBarsAria")}
                type="number"
                min={1}
                step={1}
                value={vampBars}
                onChange={(event) => onVampBarsChange(Number(event.target.value) || 1)}
              />
            </label>
          ) : null}
          <button
            type="button"
            className={`lt-vamp-button ${isVampActive ? "is-active" : ""}`}
            aria-label={t("timelineToolbar.vampToggle")}
            disabled={isProjectEmpty}
            onClick={onToggleVamp}
          >
            {t("timelineToolbar.vampButton")}
          </button>
          <label className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.songJumpLabel")}</span>
            <select
              aria-label={t("timelineToolbar.songJumpModeAria")}
              disabled={isProjectEmpty}
              value={songJumpTrigger}
              onChange={(event) => onSongJumpTriggerChange(event.target.value as SongJumpTrigger)}
            >
              <option value="immediate">{t("transport.jumpMode.immediate")}</option>
              <option value="region_end">{t("transport.jumpMode.regionEnd")}</option>
              <option value="after_bars">{t("timelineToolbar.afterBarsOption")}</option>
            </select>
          </label>
          {songJumpTrigger === "after_bars" ? (
            <label className="lt-zoom-control">
              <span>{t("timelineToolbar.songBarsLabel")}</span>
              <input
                aria-label={t("timelineToolbar.songJumpBarsAria")}
                type="number"
                min={1}
                step={1}
                value={songJumpBars}
                onChange={(event) => onSongJumpBarsChange(Number(event.target.value) || 1)}
              />
            </label>
          ) : null}
          <label className="lt-zoom-control lt-jump-mode-control">
            <span>{t("timelineToolbar.songTransitionLabel")}</span>
            <select
              aria-label={t("timelineToolbar.songTransitionAria")}
              disabled={isProjectEmpty}
              value={songTransitionMode}
              onChange={(event) =>
                onSongTransitionModeChange(event.target.value as SongTransitionMode)
              }
            >
              <option value="instant">{t("timelineToolbar.songTransitionInstant")}</option>
              <option value="fade_out">{t("timelineToolbar.songTransitionFadeOut")}</option>
            </select>
          </label>
          {pendingMarkerJumpLabel ? <span>{pendingMarkerJumpLabel}</span> : null}
          <button
            type="button"
            className="lt-icon-button"
            aria-label={t("timelineToolbar.cancelJump")}
            title={t("timelineToolbar.cancelJump")}
            disabled={!pendingMarkerJumpLabel}
            onClick={onCancelPendingJump}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="lt-timeline-stats">
          <span>{t("timelineToolbar.tracksCount", { count: trackCount })}</span>
          <span>{t("timelineToolbar.clipsCount", { count: clipCount })}</span>
          <span>{t("timelineToolbar.markersCount", { count: markerCount })}</span>
        </div>
      </div>
    </div>
  );
}
