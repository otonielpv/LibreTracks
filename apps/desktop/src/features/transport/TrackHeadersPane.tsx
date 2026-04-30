import type { MouseEvent as ReactMouseEvent, WheelEvent as ReactWheelEvent } from "react";

import type { SongView, TrackSummary } from "./desktopApi";
import { TrackHeaderItem } from "./TrackHeaderItem";

type LibraryPreviewRow = {
  rowOffset: number;
  title: string;
  meta: string;
};

type TrackHeadersPaneProps = {
  song: SongView | null;
  visibleTracks: TrackSummary[];
  selectedTrackIds: string[];
  trackHeight: number;
  collapsedFolders: Set<string>;
  previewTrackDensityClass: string;
  libraryPreviewRows: LibraryPreviewRow[];
  shouldShowEmptyArrangementHint: boolean;
  onHeadersWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  getTrackChildCount: (trackId: string) => number;
  onSelectTrack: (trackId: string, trackName: string, event: ReactMouseEvent<HTMLDivElement>) => void;
  onOpenContextMenu: (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => void;
  onStartTrackDrag: (event: ReactMouseEvent<HTMLElement>, trackId: string) => void;
  onToggleFolder: (trackId: string) => void;
  onToggleMute: (trackId: string) => void;
  onToggleSolo: (trackId: string) => void;
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
  shouldShowEmptyArrangementHint,
  onHeadersWheel,
  getTrackChildCount,
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
  audioRoutingOptions,
  onAudioToChange,
}: TrackHeadersPaneProps) {
  return (
    <div className="lt-track-headers-pane">
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
                childCount={childCount}
                trackHeight={trackHeight}
                panValue={track.pan}
                trackMuted={track.muted}
                trackSolo={track.solo}
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
                onVolumeChange={onVolumeChange}
                onCommitVolume={onCommitVolume}
                onPanChange={onPanChange}
                onCommitPan={onCommitPan}
                onAudioToChange={onAudioToChange}
              />
            </div>
          );
        })}

        {!shouldShowEmptyArrangementHint
          ? libraryPreviewRows.map((previewRow) => (
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
            ))
          : null}
      </div>
    </div>
  );
}
