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
  zoomLagDebugLabel?: string | null;
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
  zoomLagDebugLabel,
  onToggleSnap,
  onGlobalJumpModeChange,
  onGlobalJumpBarsChange,
  onCancelPendingJump,
}: TimelineToolbarProps) {
  return (
    <div className="lt-timeline-topline">
      <div className="lt-timeline-meta">
        <div className="lt-bottom-controls lt-timeline-controls">
          <button
            type="button"
            className={`lt-icon-button ${snapEnabled ? "is-active" : ""}`}
            aria-label={snapEnabled ? "Desactivar snap to grid" : "Activar snap to grid"}
            aria-pressed={snapEnabled}
            title={`Snap to Grid (${subdivisionPerBeat}/1)`}
            onClick={onToggleSnap}
          >
            <span className="material-symbols-outlined">{snapEnabled ? "grid_on" : "grid_off"}</span>
          </button>
          <label className="lt-zoom-control lt-jump-mode-control">
            <span>Salto</span>
            <select
              aria-label="Modo global de salto"
              disabled={isProjectEmpty}
              value={globalJumpMode}
              onChange={(event) => onGlobalJumpModeChange(event.target.value as GlobalJumpMode)}
            >
              <option value="immediate">Immediate</option>
              <option value="after_bars">After X bars</option>
              <option value="next_marker">At next marker</option>
            </select>
          </label>
          {globalJumpMode === "after_bars" ? (
            <label className="lt-zoom-control">
              <span>Compases</span>
              <input
                aria-label="Compases para salto global"
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
            aria-label="Cancelar salto"
            title="Cancelar salto"
            disabled={!pendingMarkerJumpLabel}
            onClick={onCancelPendingJump}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="lt-timeline-stats">
          <span>{trackCount} tracks</span>
          <span>{clipCount} clips</span>
          <span>{markerCount} marcas</span>
          {zoomLagDebugLabel ? <span>{zoomLagDebugLabel}</span> : null}
        </div>
      </div>
    </div>
  );
}
