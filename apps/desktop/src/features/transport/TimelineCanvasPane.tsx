import {
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

import { TimelineRulerCanvas, TimelineTrackCanvas } from "./CanvasTimeline";
import type { TimelineNavigationScheme } from "./Renderer/InputManager";
import type {
  ActiveVampSummary,
  ClipSummary,
  PendingJumpSummary,
  SongRegionSummary,
  SongView,
  TimeSignatureMarkerSummary,
  WaveformSummaryDto,
} from "./desktopApi";
import type {
  TimelineClipSummary,
  TimelineTrackSummary,
} from "./pendingAudioImports";
import { formatTransposeSemitones } from "./desktopApi";
import { useRenderCounter } from "./perf/useRenderCounter";
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
  resolveExternalDropGuideLeft,
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
  selectedClipIds: string[];
  selectedRegionId: string | null;
  onSelectRegion: (regionId: string) => void;
  selectedSectionId: string | null;
  pendingMarkerJump: PendingJumpSummary | null;
  activeVamp: ActiveVampSummary | null;
  displayPositionSecondsRef: MutableRefObject<number>;
  playheadDragRef: MutableRefObject<{
    pointerId: number;
    currentSeconds: number;
  } | null>;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  rulerTrackRef: RefObject<HTMLDivElement | null>;
  horizontalScrollbarRef: RefObject<HTMLDivElement | null>;
  laneAreaRef: RefObject<HTMLDivElement | null>;
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  libraryClipPreview: LibraryClipPreviewState[];
  libraryPreviewRows: LibraryPreviewRow[];
  externalDropPreview: ExternalDropPreview | null;
  normalizePositionSeconds: (
    positionSeconds: number,
    options?: { allowSnap?: boolean },
  ) => number;
  resolveLibraryGhostLeft: (seconds: number) => number;
  clipDragSnapIndicatorSeconds: number | null;
  onRulerMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onRulerContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMarkerPrimaryAction: (sectionId: string) => void;
  onMarkerContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    sectionId: string,
  ) => void;
  onTempoMarkerContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    markerId: string,
  ) => void;
  onTimeSignatureMarkerContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    markerId: string,
  ) => void;
  onRegionContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    regionId: string,
  ) => void;
  /**
   * Commit a region resize. Called once on pointer-up with the final
   * start/end seconds after snap + clamp have already been applied. The
   * component drives the optimistic UI locally during the drag and only
   * fires this once when the user releases the mouse, so consumers can
   * forward straight to updateSongRegion without throttling.
   */
  onRegionResizeCommit?: (
    regionId: string,
    startSeconds: number,
    endSeconds: number,
  ) => void;
  /**
   * Snap state used during resize drag (matches the snap behaviour of
   * clip drag). Holding Alt during the drag temporarily disables snap.
   */
  snapEnabled?: boolean;
  midiLearnMode: string | null;
  onMidiLearnTarget: (controlKey: string) => boolean;
  canNativeZoom: boolean;
  navigationScheme: TimelineNavigationScheme;
  onNativeCameraXPreview: (cameraX: number) => number;
  onNativeCameraXCommit: (cameraX: number) => void;
  onNativeZoomPreview: (
    nextZoomLevel: number,
    anchorViewportX: number,
  ) => {
    cameraX: number;
    zoomLevel: number;
  } | null;
  onNativeZoomCommit: (view: { cameraX: number; zoomLevel: number }) => void;
  onNativeTrackHeightChange: (trackHeight: number) => void;
  onPreviewPositionChange: (positionSeconds: number) => void;
  onSeekIntent: (positionSeconds: number) => void;
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
  onResolveTimelineDropFromClientPoint: (
    clientX: number,
    clientY: number,
  ) => {
    isOverTimeline: boolean;
    dropSeconds: number;
    targetTrackId: string | null;
    previewLeftPx: number | null;
    previewClientX: number | null;
    rawSeconds: number | null;
    snappedSeconds: number | null;
    snapApplied: boolean;
  };
  nativeDropKindRef: MutableRefObject<ExternalDropKind | null>;
  onExternalDropPreviewChange: (preview: ExternalDropPreview | null) => void;
  onExternalDrop: (
    classification: DroppedFileClassification,
    seconds: number,
  ) => void;
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
  selectedClipIds,
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
  normalizePositionSeconds,
  resolveLibraryGhostLeft,
  clipDragSnapIndicatorSeconds,
  onRulerMouseDown,
  onRulerContextMenu,
  onMarkerPrimaryAction,
  onMarkerContextMenu,
  onTempoMarkerContextMenu,
  onTimeSignatureMarkerContextMenu,
  onRegionContextMenu,
  onRegionResizeCommit,
  snapEnabled,
  midiLearnMode,
  onMidiLearnTarget,
  canNativeZoom,
  navigationScheme,
  onNativeCameraXPreview,
  onNativeCameraXCommit,
  onNativeZoomPreview,
  onNativeZoomCommit,
  onNativeTrackHeightChange,
  onPreviewPositionChange,
  onSeekIntent,
  onPlayheadSeekCommit,
  onTrackListContextMenu,
  onTrackLaneMouseDown,
  onTrackLaneContextMenu,
  onResolveTimelineDropFromClientPoint,
  nativeDropKindRef,
  onExternalDropPreviewChange,
  onExternalDrop,
}: TimelineCanvasPaneProps) {
  useRenderCounter("TimelineCanvasPane");
  const trackLayersRef = useRef<HTMLDivElement | null>(null);

  // ── Region resize drag ──────────────────────────────────────────────────
  // Local-only state for the in-flight resize. Backend is touched once on
  // pointer-up via onRegionResizeCommit; everything else is optimistic. Kept
  // in useRef + useState pair because the rAF-style move handler needs the
  // stable initial values via ref while React still has to re-render to
  // reflect the live preview width.
  type RegionResizeDrag = {
    regionId: string;
    edge: "start" | "end";
    pointerId: number;
    pointerStartClientX: number;
    initialStartSeconds: number;
    initialEndSeconds: number;
    minStartSeconds: number; // lower clamp for the moving edge (left neighbour end or 0)
    maxEndSeconds: number; // upper clamp for the moving edge (right neighbour start or duration)
    previewStartSeconds: number;
    previewEndSeconds: number;
  };
  const regionResizeDragRef = useRef<RegionResizeDrag | null>(null);
  const [regionResizePreview, setRegionResizePreview] = useState<{
    regionId: string;
    startSeconds: number;
    endSeconds: number;
  } | null>(null);

  const MIN_REGION_DURATION_SECONDS = 0.1;

  function beginRegionResize(
    event: ReactPointerEvent<HTMLDivElement>,
    region: SongRegionSummary,
    edge: "start" | "end",
  ) {
    if (!song) return;
    event.preventDefault();
    event.stopPropagation();

    // Build sorted neighbours to compute clamp bounds. Neighbour-end is the
    // lower bound for our start edge; neighbour-start is the upper bound
    // for our end edge.
    const sorted = [...song.regions].sort(
      (left, right) => left.startSeconds - right.startSeconds,
    );
    const idx = sorted.findIndex((entry) => entry.id === region.id);
    const leftNeighbour = idx > 0 ? sorted[idx - 1] : null;
    const rightNeighbour =
      idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
    const minStart = leftNeighbour ? leftNeighbour.endSeconds : 0;
    const maxEnd = rightNeighbour
      ? rightNeighbour.startSeconds
      : Math.max(song.durationSeconds, region.endSeconds);

    regionResizeDragRef.current = {
      regionId: region.id,
      edge,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      initialStartSeconds: region.startSeconds,
      initialEndSeconds: region.endSeconds,
      minStartSeconds: minStart,
      maxEndSeconds: maxEnd,
      previewStartSeconds: region.startSeconds,
      previewEndSeconds: region.endSeconds,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-active");
    setRegionResizePreview({
      regionId: region.id,
      startSeconds: region.startSeconds,
      endSeconds: region.endSeconds,
    });
  }

  function updateRegionResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = regionResizeDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !song) return;

    const effectivePixelsPerSecond =
      livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (effectivePixelsPerSecond <= 0) return;

    const deltaSeconds =
      (event.clientX - drag.pointerStartClientX) / effectivePixelsPerSecond;

    let nextStart = drag.initialStartSeconds;
    let nextEnd = drag.initialEndSeconds;
    if (drag.edge === "start") {
      nextStart = drag.initialStartSeconds + deltaSeconds;
    } else {
      nextEnd = drag.initialEndSeconds + deltaSeconds;
    }

    // Snap (respects Alt to temporarily disable).
    const shouldSnap = Boolean(snapEnabled) && !event.altKey;
    if (shouldSnap) {
      const songBpm = song.bpm;
      const songTs = song.timeSignature;
      const zoom = 1;
      if (drag.edge === "start") {
        nextStart = snapToTimelineGrid(
          nextStart,
          songBpm,
          songTs,
          zoom,
          effectivePixelsPerSecond,
        );
      } else {
        nextEnd = snapToTimelineGrid(
          nextEnd,
          songBpm,
          songTs,
          zoom,
          effectivePixelsPerSecond,
        );
      }
    }

    // Clamp to neighbours and minimum duration.
    if (drag.edge === "start") {
      nextStart = Math.max(
        drag.minStartSeconds,
        Math.min(
          nextStart,
          drag.initialEndSeconds - MIN_REGION_DURATION_SECONDS,
        ),
      );
    } else {
      nextEnd = Math.min(
        drag.maxEndSeconds,
        Math.max(
          nextEnd,
          drag.initialStartSeconds + MIN_REGION_DURATION_SECONDS,
        ),
      );
    }

    drag.previewStartSeconds = nextStart;
    drag.previewEndSeconds = nextEnd;
    setRegionResizePreview({
      regionId: drag.regionId,
      startSeconds: nextStart,
      endSeconds: nextEnd,
    });
  }

  function endRegionResize(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = regionResizeDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    event.currentTarget.classList.remove("is-active");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer was already released by the browser; ignore.
    }

    const finalStart = drag.previewStartSeconds;
    const finalEnd = drag.previewEndSeconds;
    const changed =
      finalStart !== drag.initialStartSeconds ||
      finalEnd !== drag.initialEndSeconds;

    regionResizeDragRef.current = null;
    setRegionResizePreview(null);

    if (changed && onRegionResizeCommit) {
      onRegionResizeCommit(drag.regionId, finalStart, finalEnd);
    }
  }

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

    const hit = onResolveTimelineDropFromClientPoint(
      event.clientX,
      event.clientY,
    );
    if (!hit.isOverTimeline) {
      onExternalDropPreviewChange(null);
      return;
    }

    const fallbackClassification = classifyDroppedFiles(
      getDroppedFiles(event.dataTransfer),
    );
    const effectiveKind =
      nativeDropKindRef.current && nativeDropKindRef.current !== "unknown"
        ? nativeDropKindRef.current
        : fallbackClassification.kind;

    onExternalDropPreviewChange({
      kind: effectiveKind,
      seconds: hit.dropSeconds,
      previewLeftPx: hit.previewLeftPx ?? undefined,
      previewClientX: hit.previewClientX ?? undefined,
      rawSeconds: hit.rawSeconds ?? undefined,
      snappedSeconds: hit.snappedSeconds ?? undefined,
      snapApplied: hit.snapApplied,
    });
  };

  const handleExternalDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event.dataTransfer)) {
      return;
    }

    const nextTarget = event.relatedTarget;
    if (
      nextTarget instanceof Node &&
      event.currentTarget.contains(nextTarget)
    ) {
      return;
    }

    onExternalDropPreviewChange(null);
    nativeDropKindRef.current = null;
  };

  const handleExternalDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!isExternalFileDrag(event.dataTransfer)) {
      return;
    }

    const classification = classifyDroppedFiles(
      getDroppedFiles(event.dataTransfer),
    );
    const hit = onResolveTimelineDropFromClientPoint(
      event.clientX,
      event.clientY,
    );
    if (!hit.isOverTimeline) {
      onExternalDropPreviewChange(null);
      nativeDropKindRef.current = null;
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onExternalDropPreviewChange(null);
    nativeDropKindRef.current = null;
    onExternalDrop(
      classification,
      externalDropPreview?.seconds ?? hit.dropSeconds,
    );
  };

  const externalDropGuideLeft = (() => {
    if (!externalDropPreview) {
      return 0;
    }

    return resolveExternalDropGuideLeft(
      externalDropPreview,
      trackLayersRef.current?.getBoundingClientRect() ?? null,
      resolveLibraryGhostLeft(externalDropPreview.seconds),
    );
  })();

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
            navigationScheme={navigationScheme}
            onNativeCameraXPreview={onNativeCameraXPreview}
            onNativeCameraXCommit={onNativeCameraXCommit}
            onNativeZoomPreview={onNativeZoomPreview}
            onNativeZoomCommit={onNativeZoomCommit}
            onNativeTrackHeightChange={onNativeTrackHeightChange}
          >
            {song?.regions.map((region) => {
              // Live preview during resize: drag updates this single in-flight
              // region's bounds optimistically; everyone else renders as-is.
              const isResizing = regionResizePreview?.regionId === region.id;
              const renderStart = isResizing
                ? regionResizePreview.startSeconds
                : region.startSeconds;
              const renderEnd = isResizing
                ? regionResizePreview.endSeconds
                : region.endSeconds;
              const regionDescription = `Carril superior: región ${region.name}${region.warpEnabled && region.warpSourceBpm ? `, BPM original ${region.warpSourceBpm.toFixed(0)}` : ""}${region.transposeSemitones !== 0 ? `, ${formatTransposeSemitones(region.transposeSemitones)} semitonos` : ""}`;
              return (
                <button
                  key={region.id}
                  type="button"
                  className={[
                    "lt-region-hotspot",
                    selectedRegionId === region.id ? "is-selected" : "",
                    region.warpEnabled ? "is-warped" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  aria-label={regionDescription}
                  title={regionDescription}
                  style={{
                    left: renderStart * pixelsPerSecond,
                    top: LANE_REGIONS.top,
                    height: LANE_REGIONS.height,
                    width: Math.max(
                      24,
                      (renderEnd - renderStart) * pixelsPerSecond,
                    ),
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (midiLearnMode !== null) {
                      const chronologicalRegions = [
                        ...(song?.regions ?? []),
                      ].sort(
                        (left, right) => left.startSeconds - right.startSeconds,
                      );
                      const regionIndex = chronologicalRegions.findIndex(
                        (candidate) => candidate.id === region.id,
                      );
                      if (regionIndex >= 0) {
                        onMidiLearnTarget(
                          `action:jump_song_${regionIndex + 1}`,
                        );
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
                  {region.warpEnabled ? (
                    <span className="lt-region-warp-indicator" aria-hidden="true">
                      warped
                    </span>
                  ) : null}
                  <div
                    className="lt-region-resize-handle is-start"
                    role="presentation"
                    onPointerDown={(event) =>
                      beginRegionResize(event, region, "start")
                    }
                    onPointerMove={updateRegionResize}
                    onPointerUp={endRegionResize}
                    onPointerCancel={endRegionResize}
                  />
                  <div
                    className="lt-region-resize-handle is-end"
                    role="presentation"
                    onPointerDown={(event) =>
                      beginRegionResize(event, region, "end")
                    }
                    onPointerMove={updateRegionResize}
                    onPointerUp={endRegionResize}
                    onPointerCancel={endRegionResize}
                  />
                </button>
              );
            })}

            {selectedTimelineRange ? (
              <div
                className="lt-ruler-range-selection"
                style={{
                  left: selectedTimelineRange.startSeconds * pixelsPerSecond,
                  width: Math.max(
                    2,
                    (selectedTimelineRange.endSeconds -
                      selectedTimelineRange.startSeconds) *
                      pixelsPerSecond,
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
                    const chronologicalMarkers = [
                      ...(song?.sectionMarkers ?? []),
                    ].sort(
                      (left, right) => left.startSeconds - right.startSeconds,
                    );
                    const markerIndex = chronologicalMarkers.findIndex(
                      (candidate) => candidate.id === section.id,
                    );
                    if (markerIndex >= 0) {
                      onMidiLearnTarget(
                        `action:jump_marker_${markerIndex + 1}`,
                      );
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
            onSeekIntent={onSeekIntent}
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
        <div
          ref={trackLayersRef}
          className="lt-track-layers"
          style={{ width: laneViewportWidth }}
        >
          {song ? (
            <TimelineTrackCanvas
              width={laneViewportWidth}
              height={Math.max(
                scrollViewportRef.current?.clientHeight ?? 500,
                visibleTracks.length * trackHeight,
              )}
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
              selectedClipIds={selectedClipIds}
              clipPreviewSecondsRef={clipPreviewSecondsRef}
              trackHeightForInput={trackHeight}
              canNativeZoom={canNativeZoom}
              navigationScheme={navigationScheme}
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

          {clipDragSnapIndicatorSeconds !== null ? (
            <div
              aria-hidden="true"
              className="lt-clip-snap-indicator"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: resolveLibraryGhostLeft(clipDragSnapIndicatorSeconds),
                width: 1,
                background: "#ffd166",
                boxShadow: "0 0 6px 1px rgba(255, 209, 102, 0.65)",
                pointerEvents: "none",
                zIndex: 35,
              }}
            />
          ) : null}

          {externalDropPreview !== null ? (
            <div
              aria-hidden="true"
              style={{
                position: "absolute",
                top: 0,
                bottom: 0,
                left: externalDropGuideLeft,
                width: 1,
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

          {song?.tracks &&
            visibleTracks.map((track) => {
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
                            left: resolveLibraryGhostLeft(
                              preview.timelineStartSeconds,
                            ),
                            width: Math.max(
                              preview.durationSeconds * pixelsPerSecond,
                              36,
                            ),
                          }}
                        >
                          <span>{preview.label}</span>
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}

          {libraryPreviewRows.map((previewRow) => (
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
                      left: resolveLibraryGhostLeft(
                        preview.timelineStartSeconds,
                      ),
                      width: Math.max(
                        preview.durationSeconds * pixelsPerSecond,
                        36,
                      ),
                    }}
                  >
                    <span>{preview.label}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <div
            className="lt-track-list-dropzone"
            aria-label="Dropzone para nuevas pistas"
            onDragEnter={handleTimelineDragEnter}
          />
        </div>
      </div>
    </div>
  );
}
