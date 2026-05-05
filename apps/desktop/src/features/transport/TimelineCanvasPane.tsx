import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, MutableRefObject, RefObject } from "react";
import { useTranslation } from "react-i18next";

import { TimelineRulerCanvas, TimelineTrackCanvas } from "./CanvasTimeline";
import type {
  ActiveVampSummary,
  ClipSummary,
  PendingJumpSummary,
  SongRegionSummary,
  SongView,
  TimeSignatureMarkerSummary,
  WaveformSummaryDto,
} from "./desktopApi";
import type { TimelineClipSummary, TimelineTrackSummary } from "./pendingAudioImports";
import {
  formatTransposeSemitones,
} from "./desktopApi";
import { PlayheadOverlay } from "./PlayheadOverlay";
import {
  LANE_REGIONS,
  LANE_SECTIONS,
  LANE_TEMPO_METRIC,
} from "./Renderer/drawBackground";
import {
  BASE_PIXELS_PER_SECOND,
  snapToTimelineGrid,
  type TimelineGrid,
} from "./timelineMath";
import {
  classifyDroppedFiles,
  getDroppedFiles,
  isExternalFileDrag,
  type DroppedFileClassification,
  type ExternalDropKind,
  type ExternalDropPreview,
} from "./dragDrop";

const RULER_HEIGHT = 132;

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
  visibleTracks: TimelineTrackSummary[];
  renderedClipsByTrack: Record<string, TimelineClipSummary[]>;
  clipsByTrack: Record<string, ClipSummary[]>;
  waveformCache: Record<string, WaveformSummaryDto>;
  cameraXRef: MutableRefObject<number>;
  pixelsPerSecond: number;
  livePixelsPerSecondRef: MutableRefObject<number>;
  timelineGrid: TimelineGrid;
  selectedTimelineRange: { startSeconds: number; endSeconds: number } | null;
  selectedClipId: string | null;
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string) => void;
  selectedSectionId: string | null;
  pendingMarkerJump: PendingJumpSummary | null;
  activeVamp: ActiveVampSummary | null;
  displayPositionSecondsRef: MutableRefObject<number>;
  playheadDragRef: MutableRefObject<{ pointerId: number; currentSeconds: number } | null>;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  rulerTrackRef: RefObject<HTMLDivElement | null>;
  horizontalScrollbarRef: RefObject<HTMLDivElement | null>;
  laneAreaRef: RefObject<HTMLDivElement | null>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  libraryClipPreview: LibraryClipPreviewState[];
  libraryPreviewRows: LibraryPreviewRow[];
  externalDropPreview: ExternalDropPreview | null;
  shouldShowEmptyArrangementHint: boolean;
  normalizePositionSeconds: (positionSeconds: number) => number;
  resolveLibraryGhostLeft: (seconds: number) => number;
  onRulerMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRulerContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMarkerPrimaryAction: (sectionId: string) => void;
  onMarkerContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, sectionId: string) => void;
  onTempoMarkerContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, markerId: string) => void;
  onTimeSignatureMarkerContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    markerId: string,
  ) => void;
  onRegionContextMenu: (event: ReactMouseEvent<HTMLButtonElement>, regionId: string) => void;
  midiLearnMode: string | null;
  onMidiLearnTarget: (controlKey: string) => boolean;
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
  onTrackLaneMouseDown: (
    event: ReactMouseEvent<HTMLDivElement>,
    track: TimelineTrackSummary,
    trackClips: ClipSummary[],
  ) => void;
  onTrackLaneContextMenu: (
    event: ReactMouseEvent<HTMLDivElement>,
    track: TimelineTrackSummary,
    trackClips: ClipSummary[],
  ) => void;
  onResolveTimelineDropFromClientPoint: (clientX: number, clientY: number) => {
    isOverTimeline: boolean;
    dropSeconds: number;
    targetTrackId: string | null;
  };
  nativeDropKindRef: MutableRefObject<ExternalDropKind | null>;
  onExternalDropPreviewChange: (preview: ExternalDropPreview | null) => void;
  onExternalDrop: (classification: DroppedFileClassification, seconds: number) => void;
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
  onSelectRegion,
  selectedSectionId,
  pendingMarkerJump,
  activeVamp,
  displayPositionSecondsRef,
  playheadDragRef,
  clipPreviewSecondsRef,
  rulerTrackRef,
  horizontalScrollbarRef,
  laneAreaRef,
  scrollViewportRef,
  libraryClipPreview,
  libraryPreviewRows,
  externalDropPreview,
  shouldShowEmptyArrangementHint,
  normalizePositionSeconds,
  resolveLibraryGhostLeft,
  onRulerMouseDown,
  onRulerContextMenu,
  onMarkerPrimaryAction,
  onMarkerContextMenu,
  onTempoMarkerContextMenu,
  onTimeSignatureMarkerContextMenu,
  onRegionContextMenu,
  midiLearnMode,
  onMidiLearnTarget,
  canNativeZoom,
  onNativeCameraXPreview,
  onNativeCameraXCommit,
  onNativeZoomPreview,
  onNativeZoomCommit,
  onNativeTrackHeightChange,
  onPreviewPositionChange,
  onPlayheadSeekCommit,
  onTrackListContextMenu,
  onTrackLaneMouseDown,
  onTrackLaneContextMenu,
  onResolveTimelineDropFromClientPoint,
  nativeDropKindRef,
  onExternalDropPreviewChange,
  onExternalDrop,
}: TimelineCanvasPaneProps) {
  const { t } = useTranslation();

  const handleTimelineDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleExternalDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";

    const hit = onResolveTimelineDropFromClientPoint(event.clientX, event.clientY);
    if (!hit.isOverTimeline) {
      onExternalDropPreviewChange(null);
      return;
    }

    const fallbackClassification = classifyDroppedFiles(getDroppedFiles(event.dataTransfer));
    const effectiveKind =
      nativeDropKindRef.current && nativeDropKindRef.current !== "unknown"
        ? nativeDropKindRef.current
        : fallbackClassification.kind;

    onExternalDropPreviewChange({
      kind: effectiveKind,
      seconds: hit.dropSeconds,
    });
  };

  const handleExternalDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event.dataTransfer)) {
      return;
    }

    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }

    onExternalDropPreviewChange(null);
    nativeDropKindRef.current = null;
  };

  const handleExternalDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event.dataTransfer)) {
      return;
    }

    const classification = classifyDroppedFiles(getDroppedFiles(event.dataTransfer));
    const hit = onResolveTimelineDropFromClientPoint(event.clientX, event.clientY);
    if (!hit.isOverTimeline) {
      onExternalDropPreviewChange(null);
      nativeDropKindRef.current = null;
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onExternalDropPreviewChange(null);
    nativeDropKindRef.current = null;
    onExternalDrop(classification, hit.dropSeconds);
  };

  return (
    <div
      className="lt-timeline-canvas-pane"
      onDragOver={handleExternalDragOver}
      onDragLeave={handleExternalDragLeave}
      onDrop={handleExternalDrop}
    >
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
            timeSignatureMarkers={song?.timeSignatureMarkers ?? []}
            selectedRegionId={selectedRegionId}
            selectedMarkerId={selectedSectionId}
            pendingMarkerJump={pendingMarkerJump}
            activeVamp={activeVamp}
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
                aria-label={`Carril superior: región ${region.name}${region.transposeSemitones !== 0 ? `, ${formatTransposeSemitones(region.transposeSemitones)} semitonos` : ""}`}
                title={`Carril superior: región ${region.name}${region.transposeSemitones !== 0 ? `, ${formatTransposeSemitones(region.transposeSemitones)} semitonos` : ""}`}
                style={{
                  left: region.startSeconds * pixelsPerSecond,
                  top: LANE_REGIONS.top,
                  height: LANE_REGIONS.height,
                  width: Math.max(24, (region.endSeconds - region.startSeconds) * pixelsPerSecond),
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (midiLearnMode !== null) {
                    const chronologicalRegions = [...(song?.regions ?? [])].sort((left, right) => (
                      left.startSeconds - right.startSeconds
                    ));
                    const regionIndex = chronologicalRegions.findIndex((candidate) => candidate.id === region.id);
                    if (regionIndex >= 0) {
                      onMidiLearnTarget(`action:jump_song_${regionIndex + 1}`);
                    }
                    return;
                  }

                  onSelectRegion(region.id);
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
                aria-label={`${section.name} - carril central`}
                title={`Carril central: ${section.name}`}
                style={{
                  left: section.startSeconds * pixelsPerSecond,
                  top: LANE_SECTIONS.top,
                  height: LANE_SECTIONS.height,
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (midiLearnMode !== null) {
                    const chronologicalMarkers = [...(song?.sectionMarkers ?? [])].sort((left, right) => (
                      left.startSeconds - right.startSeconds
                    ));
                    const markerIndex = chronologicalMarkers.findIndex((candidate) => candidate.id === section.id);
                    if (markerIndex >= 0) {
                      onMidiLearnTarget(`action:jump_marker_${markerIndex + 1}`);
                    }
                    return;
                  }
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
                aria-label={`Carril inferior: tempo ${marker.bpm.toFixed(2)} BPM`}
                title={`Carril inferior: tempo ${marker.bpm.toFixed(2)} BPM`}
                style={{
                  left: marker.startSeconds * pixelsPerSecond,
                  top: LANE_TEMPO_METRIC.top,
                  height: LANE_TEMPO_METRIC.height,
                }}
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

            {song?.timeSignatureMarkers.map((marker) => (
              <button
                key={marker.id}
                type="button"
                className="lt-tempo-hotspot lt-time-signature-hotspot"
                aria-label={`Carril inferior: compás ${marker.signature}`}
                title={`Carril inferior: compás ${marker.signature}`}
                style={{
                  left: marker.startSeconds * pixelsPerSecond,
                  top: LANE_TEMPO_METRIC.top,
                  height: LANE_TEMPO_METRIC.height,
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                }}
                onContextMenu={(event) => {
                  event.stopPropagation();
                  onTimeSignatureMarkerContextMenu(event, marker.id);
                }}
              >
                <span className="lt-sr-only">{marker.signature}</span>
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
        onDragEnter={handleTimelineDragEnter}
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

          {externalDropPreview !== null ? (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: resolveLibraryGhostLeft(externalDropPreview.seconds),
                width: 2,
                background:
                  externalDropPreview.kind === "audio"
                    ? "#7ae582"
                    : externalDropPreview.kind === "package"
                      ? "#ffb86b"
                      : externalDropPreview.kind === "unknown"
                        ? "#76b8ff"
                      : "#ff6b6b",
                boxShadow:
                  externalDropPreview.kind === "audio"
                    ? "0 0 0 1px rgba(122,229,130,0.24), 0 0 18px rgba(122,229,130,0.44)"
                    : externalDropPreview.kind === "package"
                      ? "0 0 0 1px rgba(255,184,107,0.22), 0 0 18px rgba(255,184,107,0.42)"
                      : externalDropPreview.kind === "unknown"
                        ? "0 0 0 1px rgba(118,184,255,0.22), 0 0 18px rgba(118,184,255,0.42)"
                      : "0 0 0 1px rgba(255,107,107,0.22), 0 0 18px rgba(255,107,107,0.42)",
                pointerEvents: "none",
              }}
            />
          ) : null}

          {externalDropPreview !== null ? (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 16,
                bottom: 16,
                zIndex: 12,
                pointerEvents: "none",
                maxWidth: "calc(100% - 32px)",
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  minHeight: 28,
                  padding: "6px 10px",
                  borderRadius: 999,
                  background:
                    externalDropPreview.kind === "audio"
                      ? "rgba(122,229,130,0.18)"
                      : externalDropPreview.kind === "package"
                        ? "rgba(255,184,107,0.18)"
                        : externalDropPreview.kind === "unknown"
                          ? "rgba(118,184,255,0.16)"
                        : "rgba(255,107,107,0.18)",
                  border:
                    externalDropPreview.kind === "audio"
                      ? "1px solid rgba(122,229,130,0.34)"
                      : externalDropPreview.kind === "package"
                        ? "1px solid rgba(255,184,107,0.34)"
                        : externalDropPreview.kind === "unknown"
                          ? "1px solid rgba(118,184,255,0.34)"
                        : "1px solid rgba(255,107,107,0.34)",
                  color: "#f4f3ee",
                  font: '600 11px "Space Grotesk", sans-serif',
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                  pointerEvents: "none",
                  maxWidth: "100%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {externalDropPreview.kind === "audio"
                  ? "Audio"
                  : externalDropPreview.kind === "package"
                    ? "Package"
                    : externalDropPreview.kind === "unknown"
                      ? "Drop"
                    : externalDropPreview.kind === "mixed"
                      ? "Mixed"
                      : "Unsupported"}
              </div>
            </div>
          ) : null}

          {shouldShowEmptyArrangementHint ? (
            <div
              className="lt-empty-arrangement-dropzone"
              aria-label={t("transport.shell.emptyArrangementDropzone")}
              onDragEnter={handleTimelineDragEnter}
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
            const isPendingTrack = Boolean(track.isPending);

            return (
              <div
                key={track.id}
                className="lt-track-lane-row"
                data-track-id={track.id}
                style={{ height: trackHeight }}
              >
                <div
                  className={`lt-track-lane ${track.kind === "folder" ? "is-folder" : ""} ${isPendingTrack ? "is-pending" : ""}`}
                  style={{ height: trackHeight }}
                  aria-label={`Lane ${track.name}`}
                  onDragEnter={handleTimelineDragEnter}
                  onMouseDown={(event) => {
                    if (!isPendingTrack) {
                      onTrackLaneMouseDown(event, track, trackClips);
                    }
                  }}
                  onContextMenu={(event) => {
                    if (!isPendingTrack) {
                      onTrackLaneContextMenu(event, track, trackClips);
                    }
                  }}
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
                    onDragEnter={handleTimelineDragEnter}
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
              onDragEnter={handleTimelineDragEnter}
            />
          ) : null}
        </div>
      </div>

    </div>
  );
}
