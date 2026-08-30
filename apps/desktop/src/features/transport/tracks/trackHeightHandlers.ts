import type { SongView, TransportSnapshot } from "@libretracks/shared/models";
import type { PointerEvent as ReactPointerEvent } from "react";

import { TRACK_HEIGHT_MAX, TRACK_HEIGHT_MIN, TRACK_HEIGHT_ROW_MAX } from "../constants";
import { trackHeightOffsetFor, type TrackRowLayout } from "./trackLayout";

/**
 * Per-track row height: the drag on a header's bottom edge, and Alt + wheel
 * over a lane.
 *
 * The global height (Ctrl + wheel, the toolbar buttons) stays where it was and
 * is untouched by this module. What a track carries is an OFFSET over that
 * global height — see trackLayout.ts — so raising the global still lifts every
 * row by the same amount and keeps whatever differences the user set.
 *
 * Live values are read through getters so the factory is instantiated once and
 * still sees the current song, layout and selection.
 */
export type TrackHeightHandlerDeps = {
  /** The global row height every track starts from. */
  getBaseHeight: () => number;
  /** Where the rows currently are; rebuilt by the caller on every change. */
  getRowLayout: () => TrackRowLayout;
  /** Visible rows in draw order, synthetic lanes included. */
  getVisibleTrackIds: () => string[];
  getSelectedTrackIds: () => string[];
  /** The loaded song, or null. Rows with no track in it cannot be resized. */
  getSong: () => SongView | null;
  setSong: (update: (previous: SongView | null) => SongView | null) => void;
  /** Global height setter, for the Alt-drag "resize every row" gesture. */
  setBaseHeight: (trackHeight: number) => void;
  updateTrackHeightOffset: (args: {
    trackId: string;
    heightOffset: number | null;
  }) => Promise<TransportSnapshot>;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
};

/** How long after the last wheel notch the offset is written to the song. */
const WHEEL_PERSIST_DEBOUNCE_MS = 400;

export function createTrackHeightHandlers(deps: TrackHeightHandlerDeps) {
  const {
    getBaseHeight,
    getRowLayout,
    getVisibleTrackIds,
    getSelectedTrackIds,
    getSong,
    setSong,
    setBaseHeight,
    updateTrackHeightOffset,
    runAction,
    applyPlaybackSnapshot,
    optimisticallyAppliedRevisionsRef,
  } = deps;

  /** Offsets changed since the last write, awaiting persistence. */
  const dirtyOffsets = new Map<string, number | null>();
  let persistTimer: number | null = null;

  const isResizableTrack = (trackId: string) =>
    getSong()?.tracks.some((track) => track.id === trackId) === true;

  /** Write the pending offsets into the song so they survive the session. */
  const flushOffsets = () => {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (dirtyOffsets.size === 0) {
      return;
    }

    const pending = [...dirtyOffsets.entries()];
    dirtyOffsets.clear();

    void runAction(async () => {
      let lastSnapshot: TransportSnapshot | null = null;
      for (const [trackId, heightOffset] of pending) {
        lastSnapshot = await updateTrackHeightOffset({ trackId, heightOffset });
      }
      if (lastSnapshot) {
        // Claim the revision the backend just reported so the incoming
        // snapshot doesn't refetch the song as if this were someone else's
        // edit — the heights are already on screen. Same bookkeeping as the
        // folder toggle and the colour handlers.
        const { projectRevision } = lastSnapshot;
        optimisticallyAppliedRevisionsRef.current.add(projectRevision);
        setSong((previous) =>
          previous ? { ...previous, projectRevision } : previous,
        );
      }
      applyPlaybackSnapshot(lastSnapshot);
    });
  };

  const schedulePersist = () => {
    if (persistTimer !== null) {
      window.clearTimeout(persistTimer);
    }
    persistTimer = window.setTimeout(flushOffsets, WHEEL_PERSIST_DEBOUNCE_MS);
  };

  /**
   * Apply row heights locally, right now.
   *
   * The arrangement reads heights off the song, so writing them here is what
   * makes the drag follow the pointer — the same optimistic-then-persist shape
   * the folder toggle uses.
   */
  const applyHeights = (heights: Map<string, number>) => {
    if (heights.size === 0) {
      return;
    }
    const baseHeight = getBaseHeight();
    const offsets = new Map<string, number | null>();
    for (const [trackId, height] of heights) {
      offsets.set(trackId, trackHeightOffsetFor(baseHeight, height));
    }

    setSong((previous) => {
      if (!previous) return previous;
      return {
        ...previous,
        tracks: previous.tracks.map((track) =>
          offsets.has(track.id)
            ? { ...track, heightOffset: offsets.get(track.id) ?? null }
            : track,
        ),
      };
    });

    for (const [trackId, offset] of offsets) {
      dirtyOffsets.set(trackId, offset);
    }
  };

  /** The rows an edit on `trackId` fans out to: the whole selection when the
   * track is part of it, the track alone otherwise. Mirrors how the mix
   * controls treat a multi-selection. */
  const resizeTargets = (trackId: string) => {
    const selected = getSelectedTrackIds();
    const targets = selected.includes(trackId) ? selected : [trackId];
    return targets.filter(isResizableTrack);
  };

  /** Grow (or shrink) one row by `deltaPx`, clamped to a single row's range. */
  const stepRowHeight = (trackId: string, deltaPx: number) => {
    const targets = resizeTargets(trackId);
    if (targets.length === 0) {
      return;
    }

    const layout = getRowLayout();
    const heights = new Map<string, number>();
    for (const id of targets) {
      heights.set(id, layout.heightOf(id) + deltaPx);
    }
    applyHeights(heights);
    schedulePersist();
  };

  /** Alt + wheel over the lanes: resize the row the pointer is on. */
  const stepRowHeightAtY = (localY: number, deltaPx: number) => {
    const visibleTrackIds = getVisibleTrackIds();
    if (visibleTrackIds.length === 0) {
      return;
    }
    const layout = getRowLayout();
    if (localY < 0 || localY >= layout.totalHeight) {
      return;
    }
    const trackId = visibleTrackIds[layout.rowAt(localY)];
    if (!trackId || !isResizableTrack(trackId)) {
      return;
    }
    stepRowHeight(trackId, deltaPx);
  };

  /** Put a row back on the global height (double-click on the resize handle). */
  const resetRowHeight = (trackId: string) => {
    const targets = resizeTargets(trackId);
    if (targets.length === 0) {
      return;
    }
    const baseHeight = getBaseHeight();
    applyHeights(new Map(targets.map((id) => [id, baseHeight])));
    flushOffsets();
  };

  /**
   * Drag on a header's bottom edge.
   *
   * Alt (Option) resizes every row at once by moving the GLOBAL height, which
   * is Ableton's behaviour and the reason the gesture doesn't need a modifier
   * to mean "just this track": that is the common case.
   */
  const handleRowResizeStart = (
    trackId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }
    const resizeAllRows = event.altKey;
    const targets = resizeAllRows ? [] : resizeTargets(trackId);
    if (!resizeAllRows && targets.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startClientY = event.clientY;
    const baseHeightAtStart = getBaseHeight();
    const layout = getRowLayout();
    const startHeights = new Map(
      targets.map((id) => [id, layout.heightOf(id)] as const),
    );

    // One update per frame: the pointer fires far more often than the
    // arrangement can usefully redraw, and every update re-renders the rows.
    let pendingDeltaY: number | null = null;
    let frameId: number | null = null;

    const applyPendingDelta = () => {
      frameId = null;
      const deltaY = pendingDeltaY;
      pendingDeltaY = null;
      if (deltaY === null) {
        return;
      }

      if (resizeAllRows) {
        setBaseHeight(
          Math.min(
            TRACK_HEIGHT_MAX,
            Math.max(TRACK_HEIGHT_MIN, Math.round(baseHeightAtStart + deltaY)),
          ),
        );
        return;
      }

      const heights = new Map<string, number>();
      for (const [id, startHeight] of startHeights) {
        heights.set(
          id,
          Math.min(
            TRACK_HEIGHT_ROW_MAX,
            Math.max(TRACK_HEIGHT_MIN, Math.round(startHeight + deltaY)),
          ),
        );
      }
      applyHeights(heights);
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      pendingDeltaY = moveEvent.clientY - startClientY;
      if (frameId === null) {
        frameId = window.requestAnimationFrame(applyPendingDelta);
      }
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
        applyPendingDelta();
      }
      flushOffsets();
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerUp);
  };

  return {
    handleRowResizeStart,
    resetRowHeight,
    stepRowHeight,
    stepRowHeightAtY,
  };
}

export type TrackHeightHandlers = ReturnType<typeof createTrackHeightHandlers>;
