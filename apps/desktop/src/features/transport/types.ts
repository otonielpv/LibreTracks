import type { ClipSummary, MidiBinding } from "@libretracks/shared/models";
import type { OptimisticMixState } from "./store";

export type NativeDropCoordinateMode =
  | "raw"
  | "raw/dpr"
  | "minus-webview"
  | "minus-webview/dpr";

export type NativeClientPointCandidate = {
  label: NativeDropCoordinateMode;
  clientX: number;
  clientY: number;
};

export type NativeDropDebugRect = {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
};

export type TimelineDropGeometry = {
  targetElement: HTMLElement;
  targetTrackId: string | null;
  viewportBounds: DOMRect;
  viewportX: number;
  rawSeconds: number;
  snappedSeconds: number;
  dropSeconds: number;
  rawLeftPx: number;
  rawClientX: number;
  snappedLeftPx: number;
  snappedClientX: number;
  previewLeftPx: number;
  previewClientX: number;
  snapApplied: boolean;
};

export type NativeDropCandidateDebug = {
  label: NativeDropCoordinateMode;
  clientX: number;
  clientY: number;
  elementFromPoint: string | null;
  laneBounds: NativeDropDebugRect | null;
  rulerBounds: NativeDropDebugRect | null;
  dropSeconds: number | null;
  rawSeconds: number | null;
  snappedSeconds: number | null;
  rawLeftPx: number | null;
  rawClientX: number | null;
  snappedLeftPx: number | null;
  snappedClientX: number | null;
  previewLeftPx: number | null;
  previewClientX: number | null;
  rawDeltaPx: number | null;
  snapDeltaPx: number | null;
  snapApplied: boolean;
  score: number;
  isOverTimeline: boolean;
  targetTrackId: string | null;
};

export type ContextMenuAction = {
  label: string;
  disabled?: boolean;
  swatch?: string;
  onSelect: () => void | Promise<void>;
};

export type ContextMenuState = {
  x: number;
  y: number;
  title: string;
  actions: ContextMenuAction[];
} | null;

export type ClipDragMember = {
  clipId: string;
  originSeconds: number;
  previewSeconds: number;
};

export type ClipSnapAnchorKind =
  | "playhead"
  | "section"
  | "region-start"
  | "region-end"
  | "clip-start"
  | "clip-end";

export type ClipSnapAnchor = {
  seconds: number;
  kind: ClipSnapAnchorKind;
};

export type ClipDragState = {
  /**
   * Primary clip the user clicked on — used for the click-seek preview and as
   * the label/anchor in status messages. Always included in `members`.
   */
  clipId: string;
  pointerId: number;
  originSeconds: number;
  previewSeconds: number;
  clickSeekSeconds: number;
  startClientX: number;
  hasMoved: boolean;
  /**
   * All clips that should follow the drag — at least the primary clip. When
   * the user clicks an already-selected clip with other selected siblings,
   * they all travel together using the same delta as the primary.
   */
  members: ClipDragMember[];
  /**
   * Snap targets computed once at drag start: playhead, section markers,
   * region edges, and the edges of any clip that is NOT part of this drag.
   * Used during the drag when the user holds Ctrl/Cmd to magnet onto a
   * fixed point in the timeline.
   */
  snapAnchors: ClipSnapAnchor[];
  /**
   * The anchor the group is currently magneted to (within the snap radius)
   * while Ctrl is held during the drag. Drives the visual indicator.
   */
  activeSnapAnchor: ClipSnapAnchor | null;
} | null;

export type PlayheadDragState = {
  pointerId: number;
  currentSeconds: number;
} | null;

export type SettingsTab =
  | "audio"
  | "metronome"
  | "midi"
  | "general"
  | "midiLearn"
  | "diagnostics";

export type TrackDropState = {
  targetTrackId: string;
  mode: "before" | "after" | "inside-folder";
} | null;

export type TrackDragState = {
  trackId: string;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  currentClientY: number;
  currentClientX: number;
  isDragging: boolean;
  rowElement: HTMLDivElement | null;
  headerElement: HTMLDivElement | null;
  /** Where the drag originated. "daw" routes the visuals through the
   * vertical track-row pipeline (translate3d on Y, drop indicator on
   * lt-track-lane-row/lt-track-header-row). "compact" routes them
   * through the horizontal mixer pipeline (translate3d on X, drop
   * indicator on lt-compact-mixer-strip). */
  originSurface: "daw" | "compact";
} | null;

export type TimelinePanState = {
  pointerId: number;
  startClientX: number;
  originCameraX: number;
  previewSeconds: number;
  hasMoved: boolean;
} | null;

export type TimelineRangeSelection = {
  startSeconds: number;
  endSeconds: number;
};

export type LiveClipMoveState = {
  inFlight: boolean;
  queuedSeconds: number | null;
};

export type LiveTrackMixRequestState = {
  inFlight: boolean;
  queuedKeys: Set<keyof OptimisticMixState>;
  lastSentAt: number;
};

export type SidebarTab = "library";

export type MidiLearnCommand = {
  key: string;
  labelKey: string;
};

export type MidiLearnCommandRow = {
  key: string;
  label: string;
  binding: MidiBinding | null;
};

export type MidiLearnFeedback = {
  key: string;
  binding: MidiBinding;
};

export type LibraryAssetDragPayload = {
  file_path: string;
  durationSeconds: number;
};

export type LibraryDropLayout = "horizontal" | "vertical";

export type LibraryClipPreviewState = {
  trackId: string | null;
  filePath: string;
  label: string;
  timelineStartSeconds: number;
  durationSeconds: number;
  rowOffset: number;
};

export type LibraryDragHoverState = {
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  payload: LibraryAssetDragPayload[];
  targetTrackId: string | null;
};

export type InternalLibraryPointerDrag = {
  id: string;
  payload: LibraryAssetDragPayload[];
  origin: {
    x: number;
    y: number;
  };
  current: {
    x: number;
    y: number;
  };
  isDragging: boolean;
  hover:
    | {
        kind: "timeline";
        dropSeconds: number;
        targetTrackId: string | null;
        layout: LibraryDropLayout;
      }
    | {
        kind: "library-folder";
        folderPath: string | null;
      }
    | null;
};

export type LibraryDragAutoScrollState = {
  frameId: number | null;
  horizontalVelocity: number;
  verticalVelocity: number;
};

export type OptimisticClipOperation = {
  id: string;
  clearAfterProjectRevision: number | null;
  clips: ClipSummary[];
};

export type TransportAnchorMeta = {
  snapshotKey: string;
  anchorPositionSeconds: number;
  emittedAtUnixMs: number;
};

export type NativeDroppedFile = File & {
  path?: string;
};
