import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { TimelineRulerCanvas, TimelineTrackCanvas } from "./CanvasTimeline";
import type { TimelineNavigationScheme } from "./Renderer/InputManager";
import type {
  ActiveVampSummary,
  AutomationCueSummary,
  ClipSummary,
  PendingAutomationCueSummary,
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
import { formatTransposeSemitones, isAndroidApp } from "./desktopApi";
import { buildSongTempoRegions } from "@libretracks/shared/models";
import { formatGainDb } from "@libretracks/shared/faderScale";
import { useRenderCounter } from "./perf/useRenderCounter";
import { PlayheadOverlay } from "./PlayheadOverlay";
import {
  LANE_CUES,
  LANE_REGIONS,
  LANE_SECTIONS,
  LANE_TEMPO_METRIC,
} from "./Renderer/drawBackground";
import { markerKindCategory } from "./markerKinds";
import {
  BASE_PIXELS_PER_SECOND,
  getElementScaleX,
  getTimelineWorkspaceEndSeconds,
  snapToTimelineBar,
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

// Must stay in sync with the lane layout in Renderer/drawBackground.ts and
// the .lt-android ruler heights in styles.css: 94px is the mobile lanes'
// bottom edge (87) plus breathing room.
const RULER_HEIGHT = isAndroidApp ? 94 : 122;
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Human-readable, multi-line summary of a cue's job for the hover tooltip. */
function describeAutomationCue(
  cue: AutomationCueSummary,
  song: SongView | null,
  t: Translate,
): string {
  const trackName = (id: string) =>
    song?.tracks.find((t) => t.id === id)?.name ?? id;
  const sceneName = (id: string) =>
    song?.mixScenes?.find((s) => s.id === id)?.name ?? id;
  const targetName = (target: AutomationCueSummary["actions"][number]) => {
    if (target.type !== "jump") return "";
    const jumpTarget = target.target;
    if (jumpTarget.kind === "region") {
      return (
        song?.regions.find((r) => r.id === jumpTarget.regionId)?.name ??
        t("transport.automation.defaultRegionTarget")
      );
    }
    if (jumpTarget.kind === "marker") {
      return (
        song?.sectionMarkers.find((m) => m.id === jumpTarget.markerId)?.name ??
        t("transport.automation.defaultMarkerTarget")
      );
    }
    return `${jumpTarget.seconds.toFixed(2)}s`;
  };

  const lines = (cue.actions ?? []).map((action) => {
    switch (action.type) {
      case "jump": {
        const fade =
          action.transition.mode === "fade_out" &&
          (action.transition.durationSeconds ?? 0) > 0
            ? t("transport.automation.cueFadeSuffix", {
                seconds: (action.transition.durationSeconds ?? 0).toFixed(1),
              })
            : "";
        return t("transport.automation.cueJumpLine", {
          target: targetName(action),
          fade,
        });
      }
      case "setTrackMute":
        return `${t(
          action.muted
            ? "transport.automation.cueMute"
            : "transport.automation.cueUnmute",
        )} ${trackName(action.trackId)}`;
      case "setTrackSolo":
        return `${t(
          action.solo
            ? "transport.automation.cueSolo"
            : "transport.automation.cueUnsolo",
        )} ${trackName(action.trackId)}`;
      case "setTrackMix": {
        const parts: string[] = [];
        if (action.volume != null)
          parts.push(`vol ${Math.round(action.volume * 100)}`);
        if (action.pan != null)
          parts.push(`pan ${Math.round(action.pan * 100)}`);
        return `${trackName(action.trackId)}: ${parts.join(", ") || t("transport.automation.cueMixFallback")}`;
      }
      case "applyScene":
        return t("transport.automation.cueScene", {
          name: sceneName(action.sceneId),
        });
      case "setPad":
        return t(action.enabled
          ? "transport.automation.cuePadOn"
          : "transport.automation.cuePadOff", {
          pack: action.padId,
          key: ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][action.padKey] ?? "C",
          volume: formatGainDb(action.volume),
          output: action.output,
        });
      case "wait":
        return t("transport.automation.cueWait", {
          seconds: action.durationSeconds,
        });
    }
  });

  const runs =
    cue.maxRuns != null
      ? t("transport.automation.cueRuns", { count: cue.maxRuns })
      : "";
  const header = `${cue.name} - ${cue.atSeconds.toFixed(2)}s${runs}${cue.enabled ? "" : t("transport.automation.cueDisabled")}`;
  return lines.length ? `${header}\n${lines.join("\n")}` : header;
}

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
  /**
   * Visible height of the scroll viewport (reactive, observed upstream).
   * Used as the floor for the track canvas pixel height so the painted
   * background grid always reaches the bottom of the viewport — otherwise,
   * with few tracks, a black unpainted gap shows below the last lane.
   */
  viewportHeight: number;
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
  pendingAutomationCue: PendingAutomationCueSummary | null;
  /** Cue ids that used up their per-session run limit (shown greyed/off). */
  exhaustedCueIds: Set<string>;
  activeVamp: ActiveVampSummary | null;
  displayPositionSecondsRef: MutableRefObject<number>;
  playheadDragRef: MutableRefObject<{
    pointerId: number;
    currentSeconds: number;
  } | null>;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  clipPreviewTrackIdRef: MutableRefObject<Record<string, string>>;
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
  onAutomationCueContextMenu: (
    event: ReactMouseEvent<HTMLButtonElement>,
    cueId: string,
  ) => void;
  /** Left-click the cue diamond opens the cue editor directly. */
  onAutomationCueEdit: (cueId: string) => void;
  /**
   * Right-click on empty space of the automation lane. The parent resolves the
   * cursor X to timeline seconds and offers "create automation cue here".
   */
  onAutomationLaneContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
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
   * Fires once when the user releases the song-move drag (dragging the
   * coloured band of a region horizontally). The pair `(deltaSeconds)`
   * describes how far the song should translate; consumers are
   * responsible for moving the region + every clip / tempo marker /
   * section marker / time-signature marker that lived inside it by
   * that delta in a single backend transaction. The component drives
   * the optimistic preview during the drag and only fires this on
   * release.
   */
  onRegionMoveCommit?: (regionId: string, deltaSeconds: number) => void;
  /**
   * Fires once when the user finishes dragging a section/cue marker flag
   * along the ruler. Delivers the marker id and its new absolute start in
   * seconds (already snapped + clamped). The component drives the optimistic
   * preview during the drag and only fires this on release.
   */
  onMarkerMoveCommit?: (markerId: string, startSeconds: number) => void;
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
  /** Pan the camera by `deltaPx` when the playhead is dragged to the viewport
   * edge; returns the clamped camera offset. */
  onPlayheadEdgeAutoScroll: (deltaPx: number) => number;
  onTrackListContextMenu: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onTrackLaneMouseDown: (
    event: ReactMouseEvent<HTMLDivElement>,
    track: TimelineTrackSummary,
    trackClips: ClipSummary[],
  ) => void;
  onTimelineBackgroundMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => void;
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
  viewportHeight,
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
  pendingAutomationCue,
  exhaustedCueIds,
  activeVamp,
  displayPositionSecondsRef,
  playheadDragRef,
  clipPreviewSecondsRef,
  clipPreviewTrackIdRef,
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
  onAutomationCueContextMenu,
  onAutomationCueEdit,
  onAutomationLaneContextMenu,
  onRegionResizeCommit,
  onRegionMoveCommit,
  onMarkerMoveCommit,
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
  onPlayheadEdgeAutoScroll,
  onTrackListContextMenu,
  onTrackLaneMouseDown,
  onTimelineBackgroundMouseDown,
  onTrackLaneContextMenu,
  onResolveTimelineDropFromClientPoint,
  nativeDropKindRef,
  onExternalDropPreviewChange,
  onExternalDrop,
}: TimelineCanvasPaneProps) {
  useRenderCounter("TimelineCanvasPane");
  const { t } = useTranslation();
  const trackLayersRef = useRef<HTMLDivElement | null>(null);

  // Measured pixel height of the track-list cell (.lt-track-list). This cell is
  // CSS-stretched to fill its grid row, so its clientHeight is the exact area
  // the track canvas must cover. We observe it directly instead of deriving the
  // floor from the upstream viewportHeight state, which can lag behind layout
  // changes (panel toggles, splitter drags) that don't re-run the parent's
  // ResizeObserver effect — that lag is what leaves the black gap at the bottom.
  const [measuredTrackAreaHeight, setMeasuredTrackAreaHeight] = useState(0);
  useEffect(() => {
    const cell = laneAreaRef.current;
    if (!cell || typeof ResizeObserver === "undefined") {
      return;
    }

    const measure = () => {
      const next = cell.clientHeight;
      // Ignore transient 0 measurements (mid-layout / detached) so we never
      // shrink the canvas to a stale-short height and expose the gap.
      if (next > 0) {
        setMeasuredTrackAreaHeight((prev) => (prev === next ? prev : next));
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    return () => observer.disconnect();
  }, [laneAreaRef]);

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
    pointerScaleX: number;
    initialStartSeconds: number;
    initialEndSeconds: number;
    minStartSeconds: number; // lower clamp for the moving edge (left neighbour end or 0)
    maxEndSeconds: number; // upper clamp for the moving edge (right neighbour start or duration)
    // Magnet bounds from the clips INSIDE the region: the region must not be
    // shrunk past the audio it contains, or the backend rejects it. End edge
    // can't go below the last clip's end; start edge can't go above the first
    // clip's start. null = no clips in the region (no clip constraint).
    clipFloorEndSeconds: number | null; // hard floor for the END edge
    clipCeilStartSeconds: number | null; // hard ceiling for the START edge
    previewStartSeconds: number;
    previewEndSeconds: number;
  };
  const regionResizeDragRef = useRef<RegionResizeDrag | null>(null);
  const [regionResizePreview, setRegionResizePreview] = useState<{
    regionId: string;
    startSeconds: number;
    endSeconds: number;
  } | null>(null);

  // Move drag (translate the entire song — region + clips + markers).
  // The math here is simpler than resize because the region's WIDTH
  // doesn't change; only its start moves and we just translate
  // everything inside by the same delta. The clamp comes from the
  // neighbour regions on either side: the moved song can't slide
  // into another song's range.
  type RegionMoveDrag = {
    regionId: string;
    pointerId: number;
    pointerStartClientX: number;
    pointerScaleX: number;
    initialStartSeconds: number;
    initialEndSeconds: number;
    // Clamps for the moving START seconds (so neighbour-end ≤ start
    // and start + duration ≤ next neighbour's start).
    minStartSeconds: number;
    maxStartSeconds: number;
    previewStartSeconds: number;
    previewEndSeconds: number;
  };
  const regionMoveDragRef = useRef<RegionMoveDrag | null>(null);
  // Touch long-press → region context menu (Android). The WebView doesn't fire
  // oncontextmenu on a finger long-press (only right-click does), so we time
  // the press and synthesize the same call. Cancelled if the finger moves
  // (that's a region move) or lifts early (a tap = select).
  const regionLongPressRef = useRef<{
    timerId: number;
    regionId: string;
    startClientX: number;
    startClientY: number;
    fired: boolean;
  } | null>(null);
  const cancelRegionLongPress = () => {
    if (regionLongPressRef.current) {
      window.clearTimeout(regionLongPressRef.current.timerId);
      regionLongPressRef.current = null;
    }
  };
  const [regionMovePreview, setRegionMovePreview] = useState<{
    regionId: string;
    startSeconds: number;
    endSeconds: number;
    deltaSeconds: number;
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
    // With a right neighbour, that neighbour's start is the hard wall — the
    // region must not overlap it. Without one, the region is free to grow past
    // the end of the song into the empty workspace tail; growing it does not
    // move the song end or any clips (the user moves those separately if they
    // want to). The 1-hour workspace tail is the practical upper bound.
    const maxEnd = rightNeighbour
      ? rightNeighbour.startSeconds
      : getTimelineWorkspaceEndSeconds(song.durationSeconds);

    // Magnet to the clips the region contains: a region can't be shrunk past
    // its own audio (the backend rejects clips falling outside the region). A
    // clip counts as "inside" if its timeline span overlaps the region's
    // current span. The END edge can't shrink below the furthest clip end; the
    // START edge can't grow past the earliest clip start.
    let clipFloorEndSeconds: number | null = null;
    let clipCeilStartSeconds: number | null = null;
    for (const clips of Object.values(clipsByTrack)) {
      for (const clip of clips) {
        const clipStart = clip.timelineStartSeconds;
        const clipEnd = clip.timelineStartSeconds + clip.durationSeconds;
        const overlapsRegion =
          clipStart < region.endSeconds && clipEnd > region.startSeconds;
        if (!overlapsRegion) continue;
        clipFloorEndSeconds =
          clipFloorEndSeconds === null
            ? clipEnd
            : Math.max(clipFloorEndSeconds, clipEnd);
        clipCeilStartSeconds =
          clipCeilStartSeconds === null
            ? clipStart
            : Math.min(clipCeilStartSeconds, clipStart);
      }
    }

    regionResizeDragRef.current = {
      regionId: region.id,
      edge,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialStartSeconds: region.startSeconds,
      initialEndSeconds: region.endSeconds,
      minStartSeconds: minStart,
      maxEndSeconds: maxEnd,
      clipFloorEndSeconds,
      clipCeilStartSeconds,
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
      (event.clientX - drag.pointerStartClientX) /
      drag.pointerScaleX /
      effectivePixelsPerSecond;

    let nextStart = drag.initialStartSeconds;
    let nextEnd = drag.initialEndSeconds;
    if (drag.edge === "start") {
      nextStart = drag.initialStartSeconds + deltaSeconds;
    } else {
      nextEnd = drag.initialEndSeconds + deltaSeconds;
    }

    // Snap to BAR grid (downbeat). Song boundaries are bar-aligned;
    // snapping mid-bar would produce off-grid edges. Alt bypasses
    // snap for ad-hoc resizing.
    const shouldSnap = Boolean(snapEnabled) && !event.altKey;
    if (shouldSnap) {
      const songBpm = song.bpm;
      const songTs = song.timeSignature;
      const tempoRegions = buildSongTempoRegions(song);
      if (drag.edge === "start") {
        nextStart = snapToTimelineBar(nextStart, songBpm, songTs, tempoRegions);
      } else {
        nextEnd = snapToTimelineBar(nextEnd, songBpm, songTs, tempoRegions);
      }
    }

    // Clamp to neighbours and minimum duration.
    if (drag.edge === "start") {
      // Magnet: the start edge can't grow past the first clip's start (would
      // leave audio outside the region → backend error). Hard-stop there.
      const startCeil =
        drag.clipCeilStartSeconds === null
          ? drag.initialEndSeconds - MIN_REGION_DURATION_SECONDS
          : Math.min(
              drag.clipCeilStartSeconds,
              drag.initialEndSeconds - MIN_REGION_DURATION_SECONDS,
            );
      nextStart = Math.max(drag.minStartSeconds, Math.min(nextStart, startCeil));
    } else {
      // Magnet: the end edge can't shrink below the last clip's end. Hard-stop
      // there so the region stays "imantado" at the clip boundary.
      const endFloor =
        drag.clipFloorEndSeconds === null
          ? drag.initialStartSeconds + MIN_REGION_DURATION_SECONDS
          : Math.max(
              drag.clipFloorEndSeconds,
              drag.initialStartSeconds + MIN_REGION_DURATION_SECONDS,
            );
      nextEnd = Math.min(drag.maxEndSeconds, Math.max(nextEnd, endFloor));
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

  function beginRegionMove(
    event: ReactPointerEvent<HTMLElement>,
    region: SongRegionSummary,
  ) {
    if (!song) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const sorted = [...song.regions].sort(
      (left, right) => left.startSeconds - right.startSeconds,
    );
    const idx = sorted.findIndex((entry) => entry.id === region.id);
    const leftNeighbour = idx > 0 ? sorted[idx - 1] : null;
    const rightNeighbour =
      idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : null;
    const duration = region.endSeconds - region.startSeconds;
    const minStart = leftNeighbour ? leftNeighbour.endSeconds : 0;
    // No upper bound: moving right is always allowed. The backend
    // cascade-pushes any region that would overlap, and the user is
    // free to extend the project past its current end.
    const maxStart = Number.POSITIVE_INFINITY;

    regionMoveDragRef.current = {
      regionId: region.id,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialStartSeconds: region.startSeconds,
      initialEndSeconds: region.endSeconds,
      minStartSeconds: minStart,
      maxStartSeconds: Math.max(minStart, maxStart),
      previewStartSeconds: region.startSeconds,
      previewEndSeconds: region.endSeconds,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.classList.add("is-moving");
    setRegionMovePreview({
      regionId: region.id,
      startSeconds: region.startSeconds,
      endSeconds: region.endSeconds,
      deltaSeconds: 0,
    });
  }

  function updateRegionMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = regionMoveDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !song) return;

    const effectivePixelsPerSecond =
      livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (effectivePixelsPerSecond <= 0) return;

    const rawDelta =
      (event.clientX - drag.pointerStartClientX) /
      drag.pointerScaleX /
      effectivePixelsPerSecond;
    let nextStart = drag.initialStartSeconds + rawDelta;

    // Visual snap during the drag uses the FULL song grid (the moved
    // region's own tempo markers included). This makes the preview
    // land on the SAME visible grid lines the user sees on screen.
    // The commit-time logic in endRegionMove re-snaps using the
    // previous region's grid, which is what actually matters for
    // the final landing position. Holding Shift bypasses snap.
    const shouldSnap = Boolean(snapEnabled) && !event.shiftKey;
    if (shouldSnap) {
      nextStart = snapToTimelineGrid(
        nextStart,
        song.bpm,
        song.timeSignature,
        1,
        effectivePixelsPerSecond,
        buildSongTempoRegions(song),
      );
    }

    // Clamp to neighbour bounds — no overlap with adjacent songs.
    nextStart = Math.max(
      drag.minStartSeconds,
      Math.min(nextStart, drag.maxStartSeconds),
    );

    const duration = drag.initialEndSeconds - drag.initialStartSeconds;
    const nextEnd = nextStart + duration;

    drag.previewStartSeconds = nextStart;
    drag.previewEndSeconds = nextEnd;
    setRegionMovePreview({
      regionId: drag.regionId,
      startSeconds: nextStart,
      endSeconds: nextEnd,
      deltaSeconds: nextStart - drag.initialStartSeconds,
    });
  }

  function endRegionMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = regionMoveDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    event.currentTarget.classList.remove("is-moving");
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer was already released — ignore.
    }

    // On commit, re-snap using the PREVIOUS region's grid (with the
    // moved region's tempo markers filtered out, since they travel
    // with the region and would otherwise grid the destination zone
    // with the moved region's own BPM). This is what makes the
    // final landing align with the destination's bars/beats. Shift
    // bypasses snap entirely.
    let finalStart = drag.previewStartSeconds;
    if (snapEnabled && !event.shiftKey && song) {
      const oldStart = drag.initialStartSeconds;
      const oldEnd = drag.initialEndSeconds;
      const insideMoved = (pos: number) =>
        pos >= oldStart - 0.001 && pos < oldEnd;
      const songWithoutMovedInternals: SongView = {
        ...song,
        tempoMarkers: song.tempoMarkers.filter(
          (m) => !insideMoved(m.startSeconds),
        ),
        timeSignatureMarkers: song.timeSignatureMarkers.filter(
          (m) => !insideMoved(m.startSeconds),
        ),
      };
      const livePps =
        livePixelsPerSecondRef.current ?? pixelsPerSecond ?? 1;
      finalStart = snapToTimelineGrid(
        finalStart,
        song.bpm,
        song.timeSignature,
        1,
        livePps,
        buildSongTempoRegions(songWithoutMovedInternals),
      );
      finalStart = Math.max(
        drag.minStartSeconds,
        Math.min(finalStart, drag.maxStartSeconds),
      );
    }
    const finalDelta = finalStart - drag.initialStartSeconds;
    regionMoveDragRef.current = null;
    setRegionMovePreview(null);

    if (Math.abs(finalDelta) > 1e-6 && onRegionMoveCommit) {
      onRegionMoveCommit(drag.regionId, finalDelta);
    }
  }

  // ── Section-marker move drag ────────────────────────────────────────────
  // Drag a section/cue flag along the ruler to reposition it. Optimistic:
  // the flag's hotspot `left` follows the pointer during the drag and the
  // backend is touched once on release via onMarkerMoveCommit. Pointer
  // events cover both mouse (desktop) and touch (Android). A press that
  // doesn't move past DRAG_THRESHOLD_PX is treated as a plain click
  // (primary action / select), so tapping a marker still works.
  type MarkerMoveDrag = {
    markerId: string;
    pointerId: number;
    pointerStartClientX: number;
    pointerScaleX: number;
    initialStartSeconds: number;
    previewStartSeconds: number;
    moved: boolean;
  };
  const markerMoveDragRef = useRef<MarkerMoveDrag | null>(null);
  // Set true the instant a marker drag actually moves; consumed by the
  // marker's onClick to swallow the synthetic click that follows pointer-up
  // (the drag ref is already nulled by then). Reset on the next pointerdown.
  const markerDidDragRef = useRef(false);
  const [markerMovePreview, setMarkerMovePreview] = useState<{
    markerId: string;
    startSeconds: number;
  } | null>(null);
  const MARKER_DRAG_THRESHOLD_PX = 4;

  function beginMarkerMove(
    event: ReactPointerEvent<HTMLButtonElement>,
    markerId: string,
    startSeconds: number,
  ) {
    if (event.button !== 0) return;
    markerDidDragRef.current = false;
    markerMoveDragRef.current = {
      markerId,
      pointerId: event.pointerId,
      pointerStartClientX: event.clientX,
      pointerScaleX: getElementScaleX(
        event.currentTarget.getBoundingClientRect(),
        event.currentTarget.offsetWidth,
      ),
      initialStartSeconds: startSeconds,
      previewStartSeconds: startSeconds,
      moved: false,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some engines refuse capture on a not-yet-hovered element; ignore.
    }
  }

  function updateMarkerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = markerMoveDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId || !song) return;

    const effectivePixelsPerSecond =
      livePixelsPerSecondRef.current ?? pixelsPerSecond;
    if (effectivePixelsPerSecond <= 0) return;

    const rawDelta =
      (event.clientX - drag.pointerStartClientX) /
      drag.pointerScaleX /
      effectivePixelsPerSecond;

    // Only start treating this as a drag once the pointer clears the
    // threshold, so a stationary tap/click still fires the primary action.
    if (
      !drag.moved &&
      Math.abs(event.clientX - drag.pointerStartClientX) <
        MARKER_DRAG_THRESHOLD_PX
    ) {
      return;
    }
    drag.moved = true;
    markerDidDragRef.current = true;

    let nextStart = drag.initialStartSeconds + rawDelta;

    // Snap to the song grid (same grid the user sees). Holding Shift bypasses.
    const shouldSnap = Boolean(snapEnabled) && !event.shiftKey;
    if (shouldSnap) {
      nextStart = snapToTimelineGrid(
        nextStart,
        song.bpm,
        song.timeSignature,
        1,
        effectivePixelsPerSecond,
        buildSongTempoRegions(song),
      );
    }

    // A marker can't sit before the timeline start.
    nextStart = Math.max(0, nextStart);

    drag.previewStartSeconds = nextStart;
    setMarkerMovePreview({ markerId: drag.markerId, startSeconds: nextStart });
  }

  function endMarkerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = markerMoveDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;

    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Already released — ignore.
    }

    const finalStart = drag.previewStartSeconds;
    const moved =
      drag.moved &&
      Math.abs(finalStart - drag.initialStartSeconds) > 1e-6;

    markerMoveDragRef.current = null;
    setMarkerMovePreview(null);

    if (moved && onMarkerMoveCommit) {
      onMarkerMoveCommit(drag.markerId, finalStart);
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

  // Track canvas pixel height. We floor the canvas at the visible track area
  // (so the painted grid always reaches the bottom with few tracks) and let it
  // grow past it when there are enough tracks to scroll.
  //
  // Preferred floor is the directly-measured track-list cell height, which is
  // exactly the area the canvas must fill and stays in sync via this component's
  // own ResizeObserver. We fall back to deriving it from the upstream viewport
  // height (minus the ruler row, which shares the scroll viewport) only until
  // that measurement lands, so a stale/short viewportHeight can never re-open
  // the bottom gap.
  const derivedTrackAreaHeight =
    (viewportHeight || scrollViewportRef.current?.clientHeight || 500) -
    RULER_HEIGHT;
  // The measured cell is the source of truth once it lands; only fall back to
  // the derived value while it is still 0 (first paint, before the observer
  // fires). Maxing the two would let a stale-large derived value overshoot the
  // real cell and add phantom scroll.
  const visibleTrackAreaHeight =
    measuredTrackAreaHeight > 0
      ? measuredTrackAreaHeight
      : derivedTrackAreaHeight;
  const trackCanvasHeight = Math.max(
    visibleTrackAreaHeight,
    visibleTracks.length * trackHeight,
  );

  // The canvas draws cue diamonds from song.automationCues. Exhausted cues come
  // from the live snapshot, not the song, so patch their `enabled` to false here
  // so the diamond greys out without re-fetching the whole song.
  const songForCanvas = useMemo(() => {
    if (!song || exhaustedCueIds.size === 0 || !song.automationCues?.length) {
      return song;
    }
    return {
      ...song,
      automationCues: song.automationCues.map((cue) =>
        exhaustedCueIds.has(cue.id) ? { ...cue, enabled: false } : cue,
      ),
    };
  }, [song, exhaustedCueIds]);

  const externalDropGuideLeft = (() => {
    if (!externalDropPreview) {
      return 0;
    }

    return resolveExternalDropGuideLeft(
      externalDropPreview,
      trackLayersRef.current
        ? (() => {
            const bounds = trackLayersRef.current.getBoundingClientRect();
            return {
              left: bounds.left,
              width: bounds.width,
              layoutWidth: trackLayersRef.current.offsetWidth,
            };
          })()
        : null,
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
            pendingAutomationCue={pendingAutomationCue}
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
              // Live preview during resize or move: drag updates the
              // in-flight region's bounds optimistically; everyone else
              // renders as-is.
              const isResizing = regionResizePreview?.regionId === region.id;
              const isMoving = regionMovePreview?.regionId === region.id;
              const renderStart = isResizing
                ? regionResizePreview.startSeconds
                : isMoving
                ? regionMovePreview.startSeconds
                : region.startSeconds;
              const renderEnd = isResizing
                ? regionResizePreview.endSeconds
                : isMoving
                ? regionMovePreview.endSeconds
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
                  onPointerDown={(event) => {
                    // Only the central body initiates the move drag.
                    // The two resize handles at the edges have their
                    // own onPointerDown handlers and stop propagation
                    // before this fires, so primary-button presses on
                    // the body cleanly map to the move gesture.
                    if (event.button !== 0) return;
                    if (event.altKey || event.ctrlKey || event.metaKey) {
                      return;
                    }
                    // Android: arm a long-press that opens this region's
                    // context menu (desktop's right-click equivalent). The
                    // move drag still arms below; the long-press aborts it
                    // when it fires.
                    if (isAndroidApp) {
                      cancelRegionLongPress();
                      const regionId = region.id;
                      const startClientX = event.clientX;
                      const startClientY = event.clientY;
                      regionLongPressRef.current = {
                        regionId,
                        startClientX,
                        startClientY,
                        fired: false,
                        timerId: window.setTimeout(() => {
                          if (
                            regionLongPressRef.current?.regionId !== regionId
                          ) {
                            return;
                          }
                          regionLongPressRef.current.fired = true;
                          if (regionMoveDragRef.current?.regionId === regionId) {
                            regionMoveDragRef.current = null;
                            setRegionMovePreview(null);
                          }
                          onRegionContextMenu(
                            {
                              preventDefault: () => {},
                              stopPropagation: () => {},
                              clientX: startClientX,
                              clientY: startClientY,
                            } as ReactMouseEvent<HTMLButtonElement>,
                            regionId,
                          );
                        }, 500),
                      };
                    }
                    beginRegionMove(event, region);
                  }}
                  onPointerMove={(event) => {
                    if (regionLongPressRef.current) {
                      const dx =
                        event.clientX - regionLongPressRef.current.startClientX;
                      const dy =
                        event.clientY - regionLongPressRef.current.startClientY;
                      if (Math.hypot(dx, dy) > 8) {
                        cancelRegionLongPress();
                      }
                    }
                    updateRegionMove(event);
                  }}
                  onPointerUp={(event) => {
                    cancelRegionLongPress();
                    endRegionMove(event);
                  }}
                  onPointerCancel={(event) => {
                    cancelRegionLongPress();
                    endRegionMove(event);
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    // Swallow the click that follows a long-press menu open.
                    if (regionLongPressRef.current?.fired) {
                      regionLongPressRef.current = null;
                      return;
                    }
                    // Swallow the click that follows a move drag —
                    // dragging is not selecting. We detect it by
                    // checking if the move preview state was set.
                    if (regionMoveDragRef.current !== null) {
                      return;
                    }
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

            {song?.sectionMarkers.map((section) => {
              // Cue markers live in their own lane above the section lane so a
              // cue and a section sharing a position don't stack on one pixel.
              const lane =
                markerKindCategory(section.kind) === "cue"
                  ? LANE_CUES
                  : LANE_SECTIONS;
              // Android: the fixed 68px desktop hotspot swallows neighbouring
              // taps (tapping the next bar still selected this marker). Size
              // the touch zone to the drawn flag instead: digit prefix + name
              // at the canvas' ~7px/char, clamped to a finger-sized minimum.
              const flagLabelLength =
                section.name.length + (section.digit != null ? 3 : 0);
              const androidHotspotWidth = Math.max(
                30,
                Math.min(96, 14 + flagLabelLength * 7),
              );
              // Optimistic drag preview: the flag follows the pointer.
              const isDraggingMarker =
                markerMovePreview?.markerId === section.id;
              const renderStartSeconds = isDraggingMarker
                ? markerMovePreview.startSeconds
                : section.startSeconds;
              return (
              <button
                key={section.id}
                type="button"
                className={`lt-marker-hotspot ${selectedSectionId === section.id ? "is-selected" : ""}${isDraggingMarker ? " is-dragging" : ""}`}
                aria-label={`${section.name} - carril central`}
                title={`Carril central: ${section.name}`}
                style={{
                  left: renderStartSeconds * pixelsPerSecond,
                  top: lane.top,
                  height: lane.height,
                  ...(isAndroidApp
                    ? { width: androidHotspotWidth, marginLeft: -4 }
                    : {}),
                }}
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  if (event.altKey || event.ctrlKey || event.metaKey) return;
                  beginMarkerMove(event, section.id, section.startSeconds);
                }}
                onPointerMove={updateMarkerMove}
                onPointerUp={endMarkerMove}
                onPointerCancel={endMarkerMove}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  // A drag just finished — swallow the synthetic click so the
                  // marker isn't also triggered/seeked. (The drag ref is
                  // already nulled by pointer-up, hence the separate flag.)
                  if (markerDidDragRef.current) {
                    markerDidDragRef.current = false;
                    return;
                  }
                  if (midiLearnMode !== null) {
                    // jump_marker_N indexes only section markers (cues are not
                    // jump targets), so the index must match the section-only,
                    // time-sorted order the jump dispatch uses.
                    const chronologicalMarkers = [
                      ...(song?.sectionMarkers ?? []),
                    ]
                      .filter(
                        (candidate) =>
                          markerKindCategory(candidate.kind) === "section",
                      )
                      .sort(
                        (left, right) =>
                          left.startSeconds - right.startSeconds,
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
              );
            })}

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

            {/* Snap guide showing where the dragged marker will land. Lives
                INSIDE the ruler canvas so it inherits the same
                `left: -cameraX` wrapper the marker hotspots use — placing it
                outside would ignore the camera offset and desync from the
                flags (the "double bar" bug). */}
            {markerMovePreview !== null ? (
              <div
                aria-hidden="true"
                className="lt-marker-drop-guide"
                style={{
                  left: markerMovePreview.startSeconds * pixelsPerSecond,
                  height: RULER_HEIGHT,
                }}
              />
            ) : null}
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
            onEdgeAutoScroll={onPlayheadEdgeAutoScroll}
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
              height={trackCanvasHeight}
              trackHeight={trackHeight}
              song={songForCanvas ?? song}
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
              clipPreviewTrackIdRef={clipPreviewTrackIdRef}
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

          {markerMovePreview !== null ? (
            <div
              aria-hidden="true"
              className="lt-marker-drop-guide is-over-tracks"
              style={{
                left: resolveLibraryGhostLeft(markerMovePreview.startSeconds),
              }}
            />
          ) : null}

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
                      : externalDropPreview.kind === "package" ||
                          externalDropPreview.kind === "external"
                        ? "rgba(255,184,107,0.18)"
                        : externalDropPreview.kind === "unknown"
                          ? "rgba(118,184,255,0.16)"
                          : "rgba(255,107,107,0.18)",
                  border:
                    externalDropPreview.kind === "audio"
                      ? "1px solid rgba(122,229,130,0.34)"
                      : externalDropPreview.kind === "package" ||
                          externalDropPreview.kind === "external"
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
                    : externalDropPreview.kind === "external"
                      ? "Reaper/Ableton"
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
              const isAutomationTrack = Boolean(track.isAutomation);

              if (isAutomationTrack) {
                return (
                  <div
                    key={track.id}
                    className="lt-track-lane-row"
                    data-track-id={track.id}
                    style={{ height: trackHeight }}
                  >
                    <div
                      className="lt-track-lane is-automation"
                      style={{ height: trackHeight }}
                      aria-label={t("transport.automation.laneAria")}
                      onMouseDown={(event) => {
                        // Same seek-on-click as a normal lane: the synthetic
                        // track has no clips, so this falls through to the
                        // playhead seek path. Cue buttons stopPropagation so
                        // clicking a cue doesn't move the playhead.
                        onTrackLaneMouseDown(event, track, []);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onAutomationLaneContextMenu(event);
                      }}
                    >
                      {song?.automationCues?.map((cue: AutomationCueSummary) => {
                        const isPending =
                          pendingAutomationCue?.cueId === cue.id;
                        // Exhausted = hit its run limit this session; show as off.
                        const isOff =
                          !cue.enabled || exhaustedCueIds.has(cue.id);
                        // Rich tooltip: the cue name + a line per action so the
                        // user sees what the job does on hover, even for cues
                        // whose label is hidden because a neighbour is too close.
                        const cueDescription = describeAutomationCue(
                          cue,
                          song,
                          t,
                        );
                        return (
                          <button
                            key={cue.id}
                            type="button"
                            className={`lt-automation-hotspot ${isPending ? "is-pending" : ""} ${isOff ? "is-disabled" : ""}`}
                            aria-label={cueDescription}
                            title={cueDescription}
                            style={{
                              // Centre a tight hit target on the diamond. The
                              // lane's own onMouseDown handles seek everywhere
                              // else, so the hotspot must not cover the row.
                              left: cue.atSeconds * pixelsPerSecond,
                              top: trackHeight / 2,
                            }}
                            onMouseDown={(event) => {
                              // Only swallow the LEFT button (so the diamond
                              // doesn't start a lane seek). Calling
                              // preventDefault on the right button cancels the
                              // contextmenu event, which broke right-click edit.
                              if (event.button === 0) {
                                event.preventDefault();
                                event.stopPropagation();
                              } else {
                                // Still stop the lane from handling it, but let
                                // the native contextmenu fire.
                                event.stopPropagation();
                              }
                            }}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              // Left-click the diamond opens the editor directly
                              // (right-click still opens the full context menu).
                              onAutomationCueEdit(cue.id);
                            }}
                            onContextMenu={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              onAutomationCueContextMenu(event, cue.id);
                            }}
                          >
                            <span className="lt-sr-only">{cue.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              }

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
            aria-label={t("transport.preview.newTracksDropzone")}
            onDragEnter={handleTimelineDragEnter}
            onMouseDown={onTimelineBackgroundMouseDown}
          />
        </div>
      </div>
    </div>
  );
}
