import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type MutableRefObject,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";

import { TimelineRulerCanvas, TimelineTrackCanvas } from "./CanvasTimeline";
import type { TimelineNavigationScheme } from "../Renderer/InputManager";
import type {
  ActiveVampSummary,
  AutomationCueSummary,
  ClipSummary,
  MidiClipSummary,
  PendingAutomationCueSummary,
  PendingJumpSummary,
  SongRegionSummary,
  SongView,
  TimeSignatureMarkerSummary,
  WaveformSummaryDto,
} from "../desktopApi";
import type {
  TimelineClipSummary,
  TimelineTrackSummary,
} from "../library/pendingAudioImports";
import {
  formatBpm,
  formatTransposeSemitones,
  isMobileApp,
} from "../desktopApi";
import {
  buildSongTempoRegions,
  type MarkerCategory,
} from "@libretracks/shared/models";
import { formatGainDb } from "@libretracks/shared/faderScale";
import { useRenderCounter } from "../perf/useRenderCounter";
import { PlayheadOverlay } from "./PlayheadOverlay";
import { useAutomationCueHotspots } from "./useAutomationCueHotspots";
import { useFollowerX } from "./useFollowerX";
import { regionHotspotBounds } from "./regionHotspotBounds";
import { useRegionDrag } from "./useRegionDrag";
import { MidiClipHotspots, MidiDropGuide } from "../midi/MidiClipHotspots";
import { useMidiLane } from "../midi/useMidiLane";
import { useMarkerMoveDrag } from "./useMarkerMoveDrag";
import {
  LANE_CUES,
  LANE_REGIONS,
  LANE_SECTIONS,
  LANE_TEMPO_METRIC,
} from "../Renderer/drawBackground";
import { markerCategory } from "../markerKinds";
import {
  BASE_PIXELS_PER_SECOND,
  getElementScaleX,
  getTimelineWorkspaceEndSeconds,
  screenXToSeconds,
  secondsToScreenX,
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
} from "../library/dragDrop";

// Must stay in sync with the lane layout in Renderer/drawBackground.ts and
// the ruler heights in styles.css: 94px is the mobile lanes' bottom edge (87)
// plus breathing room; 134px is the desktop lanes' bottom edge (126, the tempo
// lane's 92 + 34) plus the same. The desktop value grew from 122 so the cue
// lane could move below the two-line bar/timecode labels instead of sharing
// their band. Changing it here alone misaligns the ruler with the track
// headers — the CSS row heights below must move with it.
const RULER_HEIGHT = isMobileApp ? 94 : 134;
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
  /** Segundos del imán de clips, leídos por ref: la guía se mueve fuera de
   *  React (ver ./useClipSnapIndicator). */
  clipDragSnapIndicatorSecondsRef: MutableRefObject<number | null>;
  onRulerPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
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
   *
   * `category` is passed ONLY when the drag also crossed into the other ruler
   * row, which changes how the marker is announced (count-in vs one-shot);
   * omitted on a plain horizontal move so the backend keeps what it had.
   * Keep this signature in sync with `useMarkerMoveDrag` — dropping the third
   * parameter here silently discards the lane change (TypeScript accepts a
   * narrower callback), and the marker moves on screen but not in the engine.
   */
  onMarkerMoveCommit?: (
    markerId: string,
    startSeconds: number,
    category?: MarkerCategory,
  ) => void;
  /**
   * Commit an automation-cue drag: the cue's new position in timeline seconds
   * (already snapped + clamped). Same optimistic-preview contract as
   * `onMarkerMoveCommit`; only fires on release, after a real move.
   */
  onAutomationCueMoveCommit?: (cueId: string, atSeconds: number) => void;
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
  /** MIDI clip callbacks (edit, context menu, drag commit), grouped. */
  midiClips?: {
    onEdit?: (clip: MidiClipSummary) => void;
    onContextMenu?: (
      event: ReactMouseEvent<HTMLElement>,
      clip: MidiClipSummary,
    ) => void;
    onMoveClip?: (clipId: string, timelineStartSeconds: number) => void;
  };
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
  clipDragSnapIndicatorSecondsRef,
  onRulerPointerDown,
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
  onAutomationCueMoveCommit,
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
  midiClips,
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
  // Los tres elementos que siguen al puntero durante un arrastre. Todos leen
  // refs y se mueven fuera de React; ver ./useFollowerX.
  const clipSnapIndicatorRef = useFollowerX(() => {
    const seconds = clipDragSnapIndicatorSecondsRef.current;
    return seconds === null ? null : resolveLibraryGhostLeft(seconds);
  });
  // Guía dentro del ruler: coordenadas de CONTENIDO (el envoltorio ya aplica
  // la cámara), igual que las banderas.
  const markerDropGuideRulerRef = useFollowerX(() => {
    const preview = markerMovePreviewRef.current;
    return preview ? preview.startSeconds * pixelsPerSecond : null;
  });
  // Guía sobre las pistas: ahí no hay envoltorio de cámara, así que la
  // posición se resuelve a pantalla.
  const markerDropGuideTracksRef = useFollowerX(() => {
    const preview = markerMovePreviewRef.current;
    return preview ? resolveLibraryGhostLeft(preview.startSeconds) : null;
  });

  // Arrastre y redimensionado de las bandas de canción. Ver ./useRegionDrag:
  // el preview en vuelo se escribe sobre el elemento, no por `setState`.
  const {
    registerRegionHotspot,
    restoreRegionHotspot,
    regionMoveDragRef,
    beginRegionResize,
    updateRegionResize,
    endRegionResize,
    beginRegionMove,
    updateRegionMove,
    endRegionMove,
  } = useRegionDrag({
    song,
    pixelsPerSecond,
    livePixelsPerSecondRef,
    clipsByTrack,
    snapEnabled,
    onRegionResizeCommit,
    onRegionMoveCommit,
  });

  // ── Section-marker / automation-cue move drag ───────────────────────────
  // See ./useMarkerMoveDrag for why the two marker kinds resolve the pointer
  // in different coordinate spaces.
  const {
    markerMovePreviewLane,
    markerMovePreviewRef,
    markerDidDragRef,
    beginMarkerMove,
    updateMarkerMove,
    endMarkerMove,
  } = useMarkerMoveDrag({
    song,
    snapEnabled,
    cameraXRef,
    rulerRef: rulerTrackRef,
    livePixelsPerSecondRef,
    pixelsPerSecond,
    onMarkerMoveCommit,
    onAutomationCueMoveCommit,
  });

  // The canvas paints the flags, so a marker being dragged across lanes has to
  // reach it with the previewed category — otherwise the drag looks inert: the
  // flag stays in its old row until the drop lands. Only the dragged marker is
  // rewritten, and with no drag in flight the original array passes through
  // untouched, so the common case allocates nothing and keeps its identity.
  // El preview del arrastre ya NO se aplica aquí: lo aplica el bucle de
  // dibujo del ruler leyendo `markerMovePreviewRef`, igual que ya hacía con
  // `playheadDragRef`. Así la bandera sigue al puntero sin un render por píxel.

  // Keeps the cue hit targets glued to the diamonds the canvas paints.
  const midiLane = useMidiLane({
    song,
    camera: { cameraXRef, livePixelsPerSecondRef, pixelsPerSecond },
    snapEnabled,
    callbacks: midiClips,
  });
  const { registerHotspot: registerAutomationHotspot } =
    useAutomationCueHotspots({
      cues: song?.automationCues,
      cameraXRef,
      livePixelsPerSecondRef,
      pixelsPerSecond,
      markerMovePreviewRef,
    });

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
        onPointerDown={onRulerPointerDown}
        onMouseDown={(event) => onRulerPointerDown(event as unknown as ReactPointerEvent<HTMLDivElement>)}
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
            markerMovePreviewRef={markerMovePreviewRef}
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
              // React pinta la posición de REPOSO. La posición en vuelo la
              // escribe el arrastre directamente sobre el elemento (ver
              // `applyRegionHotspotBounds`), sin pasar por aquí: un `setState`
              // por `pointermove` costaba un render completo de este panel por
              // frame.
              const { leftPx, widthPx } = regionHotspotBounds(
                region.startSeconds,
                region.endSeconds,
                pixelsPerSecond,
              );
              const regionDescription = `Carril superior: región ${region.name}${region.warpEnabled && region.warpSourceBpm ? `, BPM original ${formatBpm(region.warpSourceBpm)}` : ""}${region.transposeSemitones !== 0 ? `, ${formatTransposeSemitones(region.transposeSemitones)} semitonos` : ""}`;
              return (
                <button
                  key={region.id}
                  data-region-id={region.id}
                  type="button"
                  className={[
                    "lt-region-hotspot",
                    selectedRegionId === region.id ? "is-selected" : "",
                    region.warpEnabled ? "is-warped" : "",
                  ].filter(Boolean).join(" ")}
                  aria-label={regionDescription}
                  title={regionDescription}
                  ref={(element) => registerRegionHotspot(region.id, element)}
                  style={{
                    left: leftPx,
                    top: LANE_REGIONS.top,
                    height: LANE_REGIONS.height,
                    width: widthPx,
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
                    if (isMobileApp) {
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
                            restoreRegionHotspot(regionId);
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
              // El carril previsualizado SÍ pasa por React: cambia una o dos
              // veces por gesto, no por píxel. La posición no: la escribe el
              // bucle de hotspots leyendo el ref.
              const isDraggingMarker =
                markerMovePreviewLane?.markerId === section.id;
              const renderStartSeconds = section.startSeconds;
              // Cue markers live in their own lane above the section lane so a
              // cue and a section sharing a position don't stack on one pixel.
              // Mid-drag the hotspot follows the pointer across lanes, so the
              // flag previews the category the drop would apply.
              const renderCategory = isDraggingMarker
                ? markerMovePreviewLane.category
                : markerCategory(section);
              const lane = renderCategory === "cue" ? LANE_CUES : LANE_SECTIONS;
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
                  ...(isMobileApp
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
                        (candidate) => markerCategory(candidate) === "section",
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
            <div
              aria-hidden="true"
              className="lt-marker-drop-guide"
              ref={markerDropGuideRulerRef}
              style={{ left: 0, display: "none", height: RULER_HEIGHT }}
            />

          </TimelineRulerCanvas>

          {/* Names both ruler rows and highlights the one the drop would land
              in, so a vertical drag shows what releasing here does to the
              marker's category (the flag hotspot itself is transparent).

              Sits OUTSIDE TimelineRulerCanvas on purpose: that wrapper is
              transformed by `translateX(-cameraX)` and is as wide as the whole
              timeline, so a full-width band inside it would start at the
              scrolled content's origin and slide off screen. This band is
              viewport-space — it spans the visible ruler at a fixed Y — so it
              belongs to .lt-ruler-content, which is the viewport-sized
              positioned ancestor. (The vertical drop guide above is the
              opposite case: it IS content-space, hence its `left` in seconds.)
              See docs/REDESIGN_transport_refs_to_stores.md on the two spaces. */}
          {markerMovePreviewLane !== null
            ? (
                [
                  {
                    category: "cue" as const,
                    lane: LANE_CUES,
                    label: t("transport.menu.markerKindCuesGroup"),
                  },
                  {
                    category: "section" as const,
                    lane: LANE_SECTIONS,
                    label: t("transport.menu.markerKindSectionsGroup"),
                  },
                ] satisfies {
                  category: MarkerCategory;
                  lane: { top: number; height: number };
                  label: string;
                }[]
              ).map(({ category, lane, label }) => {
                const isTarget = markerMovePreviewLane.category === category;
                return (
                  <div
                    key={category}
                    aria-hidden="true"
                    className={`lt-marker-lane-drop-target${isTarget ? " is-target" : ""}`}
                    style={{ top: lane.top, height: lane.height }}
                  >
                    {/* Naming both rows (not just the target) is what makes the
                        drag self-explanatory: the user sees which row means
                        "count-in" and which means "one-shot" while choosing,
                        rather than having to drop and find out. */}
                    <span className="lt-marker-lane-drop-target-label">
                      {label}
                    </span>
                  </div>
                );
              })
            : null}

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

          <div
            aria-hidden="true"
            className="lt-marker-drop-guide is-over-tracks"
            ref={markerDropGuideTracksRef}
            style={{ left: 0, display: "none" }}
          />

          <MidiDropGuide {...midiLane.guide(resolveLibraryGhostLeft)} />

          {/* Siempre montada, oculta con `display`. El bucle rAF de
              useClipSnapIndicator la muestra y la mueve; montarla y
              desmontarla costaría un render por gesto, que es justo lo que
              este cambio viene a quitar. */}
          <div
            aria-hidden="true"
            className="lt-clip-snap-indicator"
            ref={clipSnapIndicatorRef}
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              display: "none",
              width: 1,
              background: "#ffd166",
              boxShadow: "0 0 6px 1px rgba(255, 209, 102, 0.65)",
              pointerEvents: "none",
              zIndex: 35,
            }}
          />

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
                        // Optimistic drag preview: the diamond follows the
                        // pointer while dragging (same contract as section flags).
                        const isDraggingCue =
                          markerMovePreviewLane?.markerId === cue.id;
                        // La posición la lleva el bucle rAF de hotspots desde
                        // el ref; aquí sólo se siembra el reposo.
                        const renderAtSeconds = cue.atSeconds;
                        return (
                          <button
                            key={cue.id}
                            ref={(element) =>
                              registerAutomationHotspot(cue.id, element)
                            }
                            type="button"
                            className={`lt-automation-hotspot ${isPending ? "is-pending" : ""} ${isOff ? "is-disabled" : ""}${isDraggingCue ? " is-dragging" : ""}`}
                            aria-label={cueDescription}
                            title={cueDescription}
                            style={{
                              // Centre a tight hit target on the diamond. The
                              // lane's own onMouseDown handles seek everywhere
                              // else, so the hotspot must not cover the row.
                              // La posición horizontal la posee el bucle rAF de
                              // arriba (tiene que seguir a cameraX y al zoom
                              // vivo igual que el canvas pinta el diamante), y
                              // la escribe como `transform` para no invalidar
                              // layout en cada frame. Aquí se siembra para que
                              // el botón esté colocado en su primer frame.
                              transform: `translateX(${secondsToScreenX(
                                renderAtSeconds,
                                cameraXRef.current,
                                livePixelsPerSecondRef.current ??
                                  pixelsPerSecond,
                              )}px)`,
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
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              if (
                                event.altKey ||
                                event.ctrlKey ||
                                event.metaKey
                              )
                                return;
                              beginMarkerMove(
                                event,
                                cue.id,
                                cue.atSeconds,
                                "cue",
                              );
                            }}
                            onPointerMove={updateMarkerMove}
                            onPointerUp={endMarkerMove}
                            onPointerCancel={endMarkerMove}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              // A drag just finished — swallow the synthetic
                              // click so releasing the diamond doesn't also
                              // open the editor.
                              if (markerDidDragRef.current) {
                                markerDidDragRef.current = false;
                                return;
                              }
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
                    className={`lt-track-lane ${track.kind === "folder" ? "is-folder" : ""} ${track.kind === "midi" ? "is-midi" : ""} ${isPendingTrack ? "is-pending" : ""}`}
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
                    {track.kind === "midi" ? (
                      <MidiClipHotspots {...midiLane.lane(track.id, trackHeight)} />
                    ) : null}
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
