import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";

import type { SongView } from "./desktopApi";
import type { TimelineTrackSummary } from "./pendingAudioImports";
import { TrackHeaderItem } from "./TrackHeaderItem";

type LibraryPreviewRow = {
  rowOffset: number;
  title: string;
  meta: string;
};

type TrackHeadersPaneProps = {
  song: SongView | null;
  visibleTracks: TimelineTrackSummary[];
  selectedTrackIds: string[];
  trackHeight: number;
  collapsedFolders: Set<string>;
  previewTrackDensityClass: string;
  libraryPreviewRows: LibraryPreviewRow[];
  onHeadersWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  getTrackChildCount: (trackId: string) => number;
  onSelectTrack: (trackId: string, trackName: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => void;
  onEmptyAreaContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onStartTrackDrag: (event: ReactMouseEvent<HTMLElement>, trackId: string) => void;
  onToggleFolder: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
  onToggleTranspose: (trackId: string) => void;
  onVolumeChange: (trackId: string, nextVolume: number) => void;
  onCommitVolume: (trackId: string) => void;
  onPanChange: (trackId: string, nextPan: number) => void;
  onCommitPan: (trackId: string) => void;
  audioRoutingOptions: Array<{ value: string; label: string }>;
  onAudioToChange: (trackId: string, nextAudioTo: string) => void;
};

export function TrackHeadersPane({
  song,
  visibleTracks,
  selectedTrackIds,
  trackHeight,
  collapsedFolders,
  previewTrackDensityClass,
  libraryPreviewRows,
  onHeadersWheel,
  getTrackChildCount,
  onSelectTrack,
  onOpenContextMenu,
  onEmptyAreaContextMenu,
  onStartTrackDrag,
  onToggleFolder,
  onToggleMute,
  onToggleSolo,
  onToggleTranspose,
  onVolumeChange,
  onCommitVolume,
  onPanChange,
  onCommitPan,
  audioRoutingOptions,
  onAudioToChange,
}: TrackHeadersPaneProps) {
  return (
    <div
      className="lt-track-headers-pane"
      onContextMenu={(event) => {
        // Show the global track-list menu when the right-click hits empty
        // space inside the pane (below the last header). Header rows and the
        // ruler header keep their own handling.
        const target = event.target as HTMLElement | null;
        if (
          target?.closest(".lt-track-header-row") ||
          target?.closest(".lt-ruler-header")
        ) {
          return;
        }
        onEmptyAreaContextMenu(event);
      }}
    >
      <div className="lt-ruler-header">
        <span>Tracks</span>
      </div>
      <div
        className="lt-track-headers-list"
        aria-hidden={!song}
        onWheel={onHeadersWheel}
      >
        {song?.tracks && visibleTracks.map((track) => {
          const isTrackSelected = selectedTrackIds.includes(track.id);
          const childCount = getTrackChildCount(track.id);
          const trackDensityClass =
            trackHeight <= 76 ? "is-compact" : trackHeight <= 88 ? "is-condensed" : "";

          if (track.isPending) {
            return (
              <div
                key={track.id}
                className="lt-track-header-row"
                data-track-id={track.id}
                style={{ height: trackHeight }}
              >
                <div
                  className={`lt-track-header ${trackDensityClass} is-library-preview`}
                  style={{ height: trackHeight, paddingLeft: 16 + track.depth * 22 }}
                  aria-hidden="true"
                >
                  <div className="lt-track-header-body">
                    <div className="lt-track-header-content">
                      <div className="lt-track-header-summary">
                        <div className="lt-track-header-main">
                          <div className="lt-track-title-row">
                            <strong>{track.name}</strong>
                          </div>
                          <span className="lt-track-meta">Importing audio...</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          }

          return (
            <div
              key={track.id}
              className="lt-track-header-row"
              data-track-id={track.id}
              style={{ height: trackHeight }}
            >
              <TrackHeaderItem
                trackId={track.id}
                trackName={track.name}
                trackKind={track.kind}
                trackDepth={track.depth}
                trackColor={track.color}
                childCount={childCount}
                trackHeight={trackHeight}
                panValue={track.pan}
                trackMuted={track.muted}
                trackSolo={track.solo}
                trackTransposeEnabled={track.transposeEnabled}
                volumeValue={track.volume}
                audioTo={track.audioTo}
                audioRoutingOptions={audioRoutingOptions}
                isCollapsed={collapsedFolders.has(track.id)}
                isSelected={isTrackSelected}
                isDropTarget={false}
                dropMode={null}
                isDragging={false}
                densityClass={trackDensityClass}
                onSelectTrack={onSelectTrack}
                onOpenContextMenu={onOpenContextMenu}
                onStartTrackDrag={onStartTrackDrag}
                onToggleFolder={onToggleFolder}
                onToggleMute={onToggleMute}
                onToggleSolo={onToggleSolo}
                onToggleTranspose={onToggleTranspose}
                onVolumeChange={onVolumeChange}
                onCommitVolume={onCommitVolume}
                onPanChange={onPanChange}
                onCommitPan={onCommitPan}
                onAudioToChange={onAudioToChange}
              />
            </div>
          );
        })}

        {libraryPreviewRows.map((previewRow) => (
          <div
            key={`library-preview-row-${previewRow.rowOffset}`}
            className="lt-track-header-row"
            style={{ height: trackHeight }}
          >
            <div
              className={`lt-track-header ${previewTrackDensityClass} is-library-preview`}
              style={{ height: trackHeight, paddingLeft: 16 }}
              aria-hidden="true"
            >
              <div className="lt-track-header-body">
                <div className="lt-track-header-content">
                  <div className="lt-track-header-summary">
                    <div className="lt-track-header-main">
                      <div className="lt-track-title-row">
                        <strong>{previewRow.title}</strong>
                      </div>
                      <span className="lt-track-meta">{previewRow.meta}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
