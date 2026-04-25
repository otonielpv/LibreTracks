import type {
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  MutableRefObject,
  RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { TimelineRulerCanvas, TimelineTrackCanvas } from "./CanvasTimeline";
import type {
  ClipSummary,
  PendingJumpSummary,
  SongRegionSummary,
  SongView,
  TrackSummary,
  WaveformSummaryDto,
} from "./desktopApi";
import { PlayheadOverlay } from "./PlayheadOverlay";
import type { TimelineGrid } from "./timelineMath";

const RULER_HEIGHT = 92;

type LibraryClipPreviewState = {
  trackId: string | null;
  filePath: string;
  label: string;
  timelineStartSeconds: number;
  durationSeconds: number;
  rowOffset: number;
};

type LibraryPreviewRow = {
  rowOffset: number;
  title: string;
  previews: LibraryClipPreviewState[];
};

type TimelineCanvasPaneProps = {
  laneViewportWidth: number;
  trackHeight: number;
  playheadDurationSeconds: number;
  song: SongView | null;
  visibleTracks: TrackSummary[];
  renderedClipsByTrack: Record<string, ClipSummary[]>;
  clipsByTrack: Record<string, ClipSummary[]>;
  waveformCache: Record<string, WaveformSummaryDto>;
  cameraXRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  livePixelsPerSecondRef: MutableRefObject<number>;
  timelineGrid: TimelineGrid;
  selectedTimelineRange: { startSeconds: number; endSeconds: number } | null;
  selectedClipId: string | null;
  selectedRegionId: string | null;
  selectedSectionId: string | null;
  pendingMarkerJump: PendingJumpSummary | null;
  displayPositionSecondsRef: MutableRefObject<number>;
  playheadDragRef: MutableRefObject<{ pointerId: number; currentSeconds: number } | null>;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  rulerTrackRef: RefObject<HTMLDivElement | null>;
  horizontalScrollbarRef: RefObject<HTMLDivElement | null>;
  laneAreaRef: RefObject<HTMLDivElement | null>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  libraryClipPreview: LibraryClipPreviewState[];
  libraryPreviewRows: LibraryPreviewRow[];
  shouldShowEmptyArrangementHint: boolean;
  normalizePositionSeconds: (positionSeconds: number) => number;
  resolveLibraryGhostLeft: (seconds: number) => number;
  onRulerMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRulerContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMarkerPrimaryAction: (sectionId: string) => void;
  onMarkerContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, sectionId: string) => void;
  onTempoMarkerContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, markerId: string) => void;
  onRegionContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, regionId: string) => void;
  canNativeZoom: boolean;
  onNativeCameraXPreview: (cameraX: number) => number;
  onNativeCameraXCommit: (cameraX: number) => void;
  onNativeZoomPreview: (nextZoomLevel: number, anchorViewportX: number) => {
    cameraX: number;
    zoomLevel: number;
  } | null;
  onNativeZoomCommit: (view: { cameraX: number; zoomLevel: number }) => void;
  onNativeTrackHeightChange: (trackHeight: number) => void;
  onPreviewPositionChange: (positionSeconds: number) => void;
  onPlayheadSeekCommit: (positionSeconds: number) => void;
  onTrackListContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onTrackListLibraryDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onTrackListLibraryDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  onTrackListLibraryDragLeave: (event: ReactDragEvent<HTMLDivElement>) => void;
  onEmptyArrangementLibraryDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onEmptyArrangementLibraryDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
  onTrackLaneMouseDown: (
    event: ReactMouseEvent<HTMLDivElement>,
    track: TrackSummary,
    trackClips: ClipSummary[],
  ) => void;
  onTrackLaneContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    track: TrackSummary,
    trackClips: ClipSummary[],
  ) => void;
  onTrackLaneLibraryDragOver: (event: ReactDragEvent<HTMLDivElement>, track: TrackSummary) => void;
  onTrackLaneLibraryDrop: (event: ReactDragEvent<HTMLDivElement>, track: TrackSummary) => void;
  onLibraryPreviewLaneDragOver: (event: ReactDragEvent<HTMLDivElement>) => void;
  onLibraryPreviewLaneDrop: (event: ReactDragEvent<HTMLDivElement>) => void;
};

export function TimelineCanvasPane({
  laneViewportWidth,
  trackHeight,
  playheadDurationSeconds,
  song,
  visibleTracks,
  renderedClipsByTrack,
  clipsByTrack,
  waveformCache,
  cameraXRef,
  pixelsPerSecond,
  livePixelsPerSecondRef,
  timelineGrid,
  selectedTimelineRange,
  selectedClipId,
  selectedRegionId,
  selectedSectionId,
  pendingMarkerJump,
  displayPositionSecondsRef,
  playheadDragRef,
  clipPreviewSecondsRef,
  rulerTrackRef,
  horizontalScrollbarRef,
  laneAreaRef,
  scrollViewportRef,
  libraryClipPreview,
  libraryPreviewRows,
  shouldShowEmptyArrangementHint,
  normalizePositionSeconds,
  resolveLibraryGhostLeft,
  onRulerMouseDown,
  onRulerContextMenu,
  onMarkerPrimaryAction,
  onMarkerContextMenu,
  onTempoMarkerContextMenu,
  onRegionContextMenu,
  canNativeZoom,
  onNativeCameraXPreview,
  onNativeCameraXCommit,
  onNativeZoomPreview,
  onNativeZoomCommit,
  onNativeTrackHeightChange,
  onPreviewPositionChange,
  onPlayheadSeekCommit,
  onTrackListContextMenu,
  onTrackListLibraryDragOver,
  onTrackListLibraryDrop,
  onTrackListLibraryDragLeave,
  onEmptyArrangementLibraryDragOver,
  onEmptyArrangementLibraryDrop,
  onTrackLaneMouseDown,
  onTrackLaneContextMenu,
  onTrackLaneLibraryDragOver,
  onTrackLaneLibraryDrop,
  onLibraryPreviewLaneDragOver,
  onLibraryPreviewLaneDrop,
}: TimelineCanvasPaneProps) {
  const { t } = useTranslation();

  return (
    <div className="lt-timeline-canvas-pane">
      <div
        className="lt-ruler-track"
        ref={rulerTrackRef}
        onMouseDown={onRulerMouseDown}
        onContextMenu={onRulerContextMenu}
      >
        <div className="lt-ruler-content" style={{ width: laneViewportWidth }}>
          <TimelineRulerCanvas
            width={laneViewportWidth}
            height={RULER_HEIGHT}
            trackHeight={trackHeight}
            cameraXRef={cameraXRef}
            pixelsPerSecond={pixelsPerSecond}
            livePixelsPerSecondRef={livePixelsPerSecondRef}
            timelineGrid={timelineGrid}
            regions={(song?.regions ?? []) as SongRegionSummary[]}
            markers={song?.sectionMarkers ?? []}
            tempoMarkers={song?.tempoMarkers ?? []}
            selectedRegionId={selectedRegionId}
            selectedMarkerId={selectedSectionId}
            pendingMarkerJump={pendingMarkerJump}
            playheadSecondsRef={displayPositionSecondsRef}
            playheadDragRef={playheadDragRef}
            interactionContainerRef={rulerTrackRef}
            canNativeZoom={canNativeZoom}
            onNativeCameraXPreview={onNativeCameraXPreview}
            onNativeCameraXCommit={onNativeCameraXCommit}
            onNativeZoomPreview={onNativeZoomPreview}
            onNativeZoomCommit={onNativeZoomCommit}
            onNativeTrackHeightChange={onNativeTrackHeightChange}
          >
            {song?.regions.map((region) => (
              <button
                key={region.id}
                type="button"
                className={`lt-region-hotspot ${selectedRegionId === region.id ? "is-selected" : ""}`}
                aria-label={region.name}
                title={region.name}
                style={{
                  left: region.startSeconds * pixelsPerSecond,
                  width: Math.max(24, (region.endSeconds - region.startSeconds) * pixelsPerSecond),
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onContextMenu={(event) => {
                  event.stopPropagation();
                  onRegionContextMenu(event, region.id);
                }}
              >
                <span className="lt-sr-only">{region.name}</span>
              </button>
            ))}

            {selectedTimelineRange ? (
              <div
                className="lt-ruler-range-selection"
                style={{
                  left: selectedTimelineRange.startSeconds * pixelsPerSecond,
                  width: Math.max(
                    2,
                    (selectedTimelineRange.endSeconds - selectedTimelineRange.startSeconds) * pixelsPerSecond,
                  ),
                }}
              />
            ) : null}

            {song?.sectionMarkers.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`lt-marker-hotspot ${selectedSectionId === section.id ? "is-selected" : ""}`}
                aria-label={section.name}
                title={section.name}
                style={{ left: section.startSeconds * pixelsPerSecond }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onMarkerPrimaryAction(section.id);
                }}
                onContextMenu={(event) => {
                  event.stopPropagation();
                  onMarkerContextMenu(event, section.id);
                }}
              >
                <span className="lt-sr-only">{section.name}</span>
              </button>
            ))}

            {song?.tempoMarkers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                className="lt-tempo-hotspot"
                aria-label={`Tempo ${marker.bpm.toFixed(2)} BPM`}
                title={`Tempo ${marker.bpm.toFixed(2)} BPM`}
                style={{ left: marker.startSeconds * pixelsPerSecond }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onContextMenu={(event) => {
                  event.stopPropagation();
                  onTempoMarkerContextMenu(event, marker.id);
                }}
              >
                <span className="lt-sr-only">{marker.bpm.toFixed(2)} BPM</span>
              </button>
            ))}
          </TimelineRulerCanvas>

          <PlayheadOverlay
            className="lt-playhead is-handle"
            durationSeconds={playheadDurationSeconds}
            pixelsPerSecond={pixelsPerSecond}
            livePixelsPerSecondRef={livePixelsPerSecondRef}
            cameraXRef={cameraXRef}
            dragStateRef={playheadDragRef}
            positionSecondsRef={displayPositionSecondsRef}
            normalizePositionSeconds={normalizePositionSeconds}
            positionBoundsRef={rulerTrackRef}
            scrollContainerRef={horizontalScrollbarRef}
            onPreviewPositionChange={onPreviewPositionChange}
            onSeekCommit={onPlayheadSeekCommit}
          />
        </div>
      </div>

      <div
        className={`lt-track-list ${libraryClipPreview.length ? "is-library-drag-over" : ""}`}
        ref={laneAreaRef}
        onContextMenu={onTrackListContextMenu}
        onDragOver={onTrackListLibraryDragOver}
        onDrop={onTrackListLibraryDrop}
        onDragLeave={onTrackListLibraryDragLeave}
      >
        <div className="lt-track-layers" style={{ width: laneViewportWidth }}>
          {song ? (
            <TimelineTrackCanvas
              width={laneViewportWidth}
              height={Math.max(scrollViewportRef.current?.clientHeight ?? 500, visibleTracks.length * trackHeight)}
              trackHeight={trackHeight}
              song={song}
              visibleTracks={visibleTracks}
              clipsByTrack={renderedClipsByTrack}
              waveformCache={waveformCache}
              cameraXRef={cameraXRef}
              pixelsPerSecond={pixelsPerSecond}
              livePixelsPerSecondRef={livePixelsPerSecondRef}
              scrollViewportRef={scrollViewportRef}
              interactionContainerRef={laneAreaRef}
              timelineGrid={timelineGrid}
              selectedClipId={selectedClipId}
              clipPreviewSecondsRef={clipPreviewSecondsRef}
              trackHeightForInput={trackHeight}
              canNativeZoom={canNativeZoom}
              onNativeCameraXPreview={onNativeCameraXPreview}
              onNativeCameraXCommit={onNativeCameraXCommit}
              onNativeZoomPreview={onNativeZoomPreview}
              onNativeZoomCommit={onNativeZoomCommit}
              onNativeTrackHeightChange={onNativeTrackHeightChange}
            />
          ) : null}

          <div className="lt-track-playhead-layer" aria-hidden="true">
            <PlayheadOverlay
              className="lt-track-playhead"
              durationSeconds={playheadDurationSeconds}
              pixelsPerSecond={pixelsPerSecond}
              livePixelsPerSecondRef={livePixelsPerSecondRef}
              cameraXRef={cameraXRef}
              dragStateRef={playheadDragRef}
              positionSecondsRef={displayPositionSecondsRef}
            />
          </div>

          {shouldShowEmptyArrangementHint ? (
            <div
              className="lt-empty-arrangement-dropzone"
              aria-label={t("transport.shell.emptyArrangementDropzone")}
              onDragOver={onEmptyArrangementLibraryDragOver}
              onDrop={onEmptyArrangementLibraryDrop}
            >
              <strong>{t("transport.shell.emptyArrangementTitle")}</strong>
              <p>
                {t("transport.shell.emptyArrangementDescription")}
              </p>
              {libraryClipPreview
                .filter((preview) => preview.trackId === null)
                .map((preview) => (
                  <div
                    key={`${preview.filePath}-${preview.rowOffset}-${preview.timelineStartSeconds}`}
                    className="lt-library-clip-ghost is-floating"
                    style={{
                      left: resolveLibraryGhostLeft(preview.timelineStartSeconds),
                      top: 16 + preview.rowOffset * 72,
                      bottom: "auto",
                      height: 56,
                      width: Math.max(preview.durationSeconds * pixelsPerSecond, 36),
                    }}
                  >
                    <span>{preview.label}</span>
                  </div>
                ))}
            </div>
          ) : null}

          {song?.tracks && visibleTracks.map((track) => {
            const trackClips = clipsByTrack[track.id] ?? [];

            return (
              <div
                key={track.id}
                className="lt-track-lane-row"
                data-track-id={track.id}
                style={{ height: trackHeight }}
              >
                <div
                  className={`lt-track-lane ${track.kind === "folder" ? "is-folder" : ""}`}
                  style={{ height: trackHeight }}
                  aria-label={`Lane ${track.name}`}
                  onMouseDown={(event) => onTrackLaneMouseDown(event, track, trackClips)}
                  onContextMenu={(event) => onTrackLaneContextMenu(event, track, trackClips)}
                  onDragOver={(event) => onTrackLaneLibraryDragOver(event, track)}
                  onDrop={(event) => onTrackLaneLibraryDrop(event, track)}
                >
                  {libraryClipPreview
                    .filter((preview) => preview.trackId === track.id)
                    .map((preview) => (
                      <div
                        key={`${preview.filePath}-${preview.rowOffset}-${preview.timelineStartSeconds}`}
                        className="lt-library-clip-ghost"
                        style={{
                          left: resolveLibraryGhostLeft(preview.timelineStartSeconds),
                          width: Math.max(preview.durationSeconds * pixelsPerSecond, 36),
                        }}
                      >
                        <span>{preview.label}</span>
                      </div>
                    ))}
                </div>
              </div>
            );
          })}

          {!shouldShowEmptyArrangementHint
            ? libraryPreviewRows.map((previewRow) => (
                <div
                  key={`library-preview-lane-${previewRow.rowOffset}`}
                  className="lt-track-lane-row is-library-preview"
                  style={{ height: trackHeight }}
                >
                  <div
                    className="lt-track-lane is-library-preview"
                    style={{ height: trackHeight }}
                    aria-label={`Preview lane ${previewRow.title}`}
                    onDragOver={onLibraryPreviewLaneDragOver}
                    onDrop={onLibraryPreviewLaneDrop}
                  >
                    {previewRow.previews.map((preview) => (
                      <div
                        key={`${preview.filePath}-${preview.rowOffset}-${preview.timelineStartSeconds}`}
                        className="lt-library-clip-ghost"
                        style={{
                          left: resolveLibraryGhostLeft(preview.timelineStartSeconds),
                          width: Math.max(preview.durationSeconds * pixelsPerSecond, 36),
                        }}
                      >
                        <span>{preview.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            : null}

          {!shouldShowEmptyArrangementHint ? (
            <div
              className="lt-track-list-dropzone"
              aria-label="Dropzone para nuevas pistas"
              onDragOver={onTrackListLibraryDragOver}
              onDrop={onTrackListLibraryDrop}
              onDragLeave={onTrackListLibraryDragLeave}
            />
          ) : null}
        </div>
      </div>

    </div>
  );
}
