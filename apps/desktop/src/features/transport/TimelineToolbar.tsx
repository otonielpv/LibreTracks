import { useTranslation } from "react-i18next";

import type { GlobalJumpMode } from "./uiStore";

type TimelineToolbarProps = {
  snapEnabled: boolean;
  subdivisionPerBeat: number;
  globalJumpMode: GlobalJumpMode;
  globalJumpBars: number;
  pendingMarkerJumpLabel: string | null;
  isProjectEmpty: boolean;
  trackCount: number;
  clipCount: number;
  markerCount: number;
  onToggleSnap: () => void;
  onGlobalJumpModeChange: (mode: GlobalJumpMode) => void;
  onGlobalJumpBarsChange: (bars: number) => void;
  onCancelPendingJump: () => void;
};

export function TimelineToolbar({
  snapEnabled,
  subdivisionPerBeat,
  globalJumpMode,
  globalJumpBars,
  pendingMarkerJumpLabel,
  isProjectEmpty,
  trackCount,
  clipCount,
  markerCount,
  onToggleSnap,
  onGlobalJumpModeChange,
  onGlobalJumpBarsChange,
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
            <span>{t("timelineToolbar.jumpLabel")}</span>
            <select
              aria-label={t("timelineToolbar.jumpModeAria")}
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
              <span>{t("timelineToolbar.barsLabel")}</span>
              <input
                aria-label={t("timelineToolbar.jumpBarsAria")}
                type="number"
                min={1}
                step={1}
                value={globalJumpBars}
                onChange={(event) => onGlobalJumpBarsChange(Number(event.target.value) || 1)}
              />
            </label>
          ) : null}
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
