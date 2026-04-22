import { memo, type MouseEvent as ReactMouseEvent } from "react";

import type { TrackKind } from "./desktopApi";
import { TrackMeter } from "./TrackMeter";
import { useTransportStore } from "./store";

const PAN_DISPLAY_CENTER_EPSILON = 0.005;
const PAN_SNAP_TO_CENTER_EPSILON = 0.05;

function formatPanValue(pan: number): string {
  const clampedPan = Math.max(-1, Math.min(1, pan));
  if (Math.abs(clampedPan) <= PAN_DISPLAY_CENTER_EPSILON) {
    return "C";
  }

  if (clampedPan < 0) {
    return `L ${Math.round(Math.abs(clampedPan) * 100)}`;
  }

  return `R ${Math.round(clampedPan * 100)}`;
}

type TrackHeaderItemProps = {
  trackId: string;
  trackName: string;
  trackKind: TrackKind;
  trackDepth: number;
  childCount: number;
  trackHeight: number;
  panValue: number;
  trackMuted: boolean;
  trackSolo: boolean;
  volumeValue: number;
  isCollapsed: boolean;
  isSelected: boolean;
  isDropTarget: boolean;
  dropMode: "before" | "after" | "inside-folder" | null;
  isDragging: boolean;
  densityClass: string;
  onSelectTrack: (trackId: string, trackName: string) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => void;
  onStartTrackDrag: (
    event: ReactMouseEvent<HTMLElement>,
    trackId: string,
  ) => void;
  onToggleFolder: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onVolumeChange: (trackId: string, nextVolume: number) => void;
  onCommitVolume: (trackId: string) => void;
  onPanChange: (trackId: string, nextPan: number) => void;
  onCommitPan: (trackId: string) => void;
};

function TrackHeaderItemComponent({
  trackId,
  trackName,
  trackKind,
  trackDepth,
  childCount,
  trackHeight,
  panValue,
  trackMuted,
  trackSolo,
  volumeValue,
  isCollapsed,
  isSelected,
  isDropTarget,
  dropMode,
  isDragging,
  densityClass,
  onSelectTrack,
  onOpenContextMenu,
  onStartTrackDrag,
  onToggleFolder,
  onToggleMute,
  onToggleSolo,
  onVolumeChange,
  onCommitVolume,
  onPanChange,
  onCommitPan,
}: TrackHeaderItemProps) {
  const optimisticMix = useTransportStore((state) => state.optimisticMix[trackId] ?? null);
  const effectivePanValue = optimisticMix?.pan ?? panValue;
  const effectiveTrackMuted = optimisticMix?.muted ?? trackMuted;
  const effectiveTrackSolo = optimisticMix?.solo ?? trackSolo;
  const effectiveVolumeValue = optimisticMix?.volume ?? volumeValue;
  const volumeFill = `${(effectiveVolumeValue * 100).toFixed(2)}%`;
  const panFill = `${(((effectivePanValue + 1) * 0.5) * 100).toFixed(2)}%`;
  const handleMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target instanceof Element &&
      target.closest(
        'button, input, label, textarea, select, .lt-track-toggle-group, .lt-folder-toggle, .lt-track-volume, .lt-track-pan',
      )
    ) {
      return;
    }

    onStartTrackDrag(event, trackId);
  };

  const metaLabel = trackKind === "folder" ? `${childCount} hijos` : null;

  return (
    <div
      className={`lt-track-header ${densityClass} ${isSelected ? "is-selected" : ""} ${effectiveTrackSolo ? "is-solo" : ""} ${trackKind === "folder" ? "is-folder" : ""} ${isDropTarget ? "is-drop-target" : ""} ${isDragging ? "is-dragging" : ""}`}
      style={{ height: trackHeight, paddingLeft: 16 + trackDepth * 22 }}
      role="button"
      tabIndex={0}
      onMouseDown={handleMouseDown}
      onClick={() => onSelectTrack(trackId, trackName)}
      onContextMenu={(event) => onOpenContextMenu(event, trackId)}
    >
      <div className="lt-track-header-body">
        <div className="lt-track-header-content">
          <div className="lt-track-header-summary">
            <div className="lt-track-header-main">
              <div className="lt-track-title-row">
                <button
                  type="button"
                  className="lt-track-drag-handle"
                  aria-label={`Mover ${trackName}`}
                  title={`Mover ${trackName}`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onStartTrackDrag(event, trackId);
                  }}
                >
                  <span aria-hidden="true">::</span>
                </button>
                {trackKind === "folder" ? (
                  <button
                    type="button"
                    className="lt-folder-toggle"
                    aria-label={isCollapsed ? `Expandir ${trackName}` : `Colapsar ${trackName}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onToggleFolder(trackId);
                    }}
                  >
                    {isCollapsed ? "+" : "-"}
                  </button>
                ) : null}
                <strong>{trackName}</strong>
              </div>
              {metaLabel ? <span className="lt-track-meta">{metaLabel}</span> : null}
            </div>
          </div>

          <div className="lt-track-control-row">
            <div className="lt-track-toggle-group">
              <button
                type="button"
                className={effectiveTrackMuted ? "is-active" : ""}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleMute(trackId);
                }}
              >
                M
              </button>
              <button
                type="button"
                className={effectiveTrackSolo ? "is-active" : ""}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleSolo(trackId);
                }}
              >
                S
              </button>
            </div>
            <div className="lt-track-mix-controls">
              <label className="lt-track-volume">
                <span>Vol</span>
                <input
                  aria-label={`Volumen de ${trackName}`}
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={effectiveVolumeValue}
                  style={{
                    background: `linear-gradient(to right, #3cddc7 ${volumeFill}, #0e0e0e ${volumeFill})`,
                  }}
                  onChange={(event) => {
                    onVolumeChange(trackId, Number(event.target.value));
                  }}
                  onMouseUp={() => {
                    onCommitVolume(trackId);
                  }}
                  onTouchEnd={() => {
                    onCommitVolume(trackId);
                  }}
                  onKeyUp={(event) => {
                    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                      onCommitVolume(trackId);
                    }
                  }}
                  onBlur={() => {
                    onCommitVolume(trackId);
                  }}
                />
              </label>
              <label className="lt-track-pan">
                <span>{formatPanValue(effectivePanValue)}</span>
                <input
                  aria-label={`Paneo de ${trackName}`}
                  type="range"
                  min={-1}
                  max={1}
                  step={0.01}
                  value={effectivePanValue}
                  style={{
                    background: `linear-gradient(to right, #4d79d8 0%, #74b8ff ${panFill}, #0e0e0e ${panFill}, #0e0e0e 100%)`,
                  }}
                  onChange={(event) => {
                    const rawPanValue = Number(event.target.value);
                    onPanChange(
                      trackId,
                      Math.abs(rawPanValue) <= PAN_SNAP_TO_CENTER_EPSILON ? 0 : rawPanValue,
                    );
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onPanChange(trackId, 0);
                    onCommitPan(trackId);
                  }}
                  onMouseUp={() => {
                    onCommitPan(trackId);
                  }}
                  onTouchEnd={() => {
                    onCommitPan(trackId);
                  }}
                  onKeyUp={(event) => {
                    if (event.key.startsWith("Arrow") || event.key === "Home" || event.key === "End") {
                      onCommitPan(trackId);
                    }
                  }}
                  onBlur={() => {
                    onCommitPan(trackId);
                  }}
                />
              </label>
            </div>
          </div>
        </div>

        <TrackMeter trackId={trackId} />
      </div>
    </div>
  );
}

function areTrackHeaderPropsEqual(previous: TrackHeaderItemProps, next: TrackHeaderItemProps) {
  return (
    previous.trackId === next.trackId &&
    previous.trackName === next.trackName &&
    previous.trackKind === next.trackKind &&
    previous.trackDepth === next.trackDepth &&
    previous.childCount === next.childCount &&
    previous.trackHeight === next.trackHeight &&
    previous.panValue === next.panValue &&
    previous.trackMuted === next.trackMuted &&
    previous.trackSolo === next.trackSolo &&
    previous.volumeValue === next.volumeValue &&
    previous.isCollapsed === next.isCollapsed &&
    previous.isSelected === next.isSelected &&
    previous.isDropTarget === next.isDropTarget &&
    previous.dropMode === next.dropMode &&
    previous.isDragging === next.isDragging &&
    previous.densityClass === next.densityClass
  );
}

export const TrackHeaderItem = memo(TrackHeaderItemComponent, areTrackHeaderPropsEqual);
