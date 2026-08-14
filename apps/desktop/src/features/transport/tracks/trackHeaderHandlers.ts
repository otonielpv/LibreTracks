import type { TrackSummary, TransportSnapshot } from "@libretracks/shared/models";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { OptimisticMixState } from "../store";
import type { TrackDragState } from "../types";
import {
  offsetGainByDb,
  resolveEditTargets,
  volumeDeltaDb,
} from "./multiTrackEdit";

/**
 * Dependencies for the track-header handlers extracted from
 * TransportPanelContent (selection, drag start, folder collapse, and the
 * mute/solo/volume/pan/transpose controls of a track strip).
 *
 * These are the controls that live on both surfaces — the DAW track header and
 * the compact mixer strip — so every handler is written to be surface-agnostic
 * and branches on the DOM ancestry it finds at call time.
 *
 * Reactive state (song, visible tracks, selection) is read through getters so
 * the factory can be instantiated once with stable deps and still observe live
 * values. The mix mutators (`patchTrackOptimisticMix`, `queueTrackMixLiveUpdate`,
 * `persistTrackMix`) stay in the monolith: they are shared with the clip and
 * compact-mixer paths, which are not part of this slice.
 */
export type TrackHeaderHandlerDeps = {
  /** Look up a track in the current song by id (null when it no longer exists). */
  findTrack: (trackId: string) => TrackSummary | null;
  /** Ordered visible track ids, used to resolve shift-click ranges. */
  getVisibleTrackIds: () => string[];
  getSelectedTrackIds: () => string[];
  selectTrack: (trackIds: string[]) => void;
  /** Resolve a track's effective mix, optimistic values taking precedence. */
  resolveTrackMix: (
    track: TrackSummary,
    trackId: string,
  ) => { muted: boolean; solo: boolean; volume: number; pan: number };
  patchTrackOptimisticMix: (
    trackId: string,
    mixPatch: OptimisticMixState,
  ) => void;
  queueTrackMixLiveUpdate: (
    trackId: string,
    keys: Array<keyof OptimisticMixState>,
  ) => void;
  persistTrackMix: (
    trackId: string,
    keys: Array<keyof OptimisticMixState>,
  ) => Promise<void>;
  /** Persists a single track's mix change; used here for the output routing. */
  commitTrackMixChange: (args: {
    trackId: string;
    audioTo?: string;
  }) => Promise<TransportSnapshot>;
  runAction: (action: () => Promise<void>) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  optimisticallyAppliedRevisionsRef: { current: Set<number> };
  setSong: (
    update: (previous: import("@libretracks/shared/models").SongView | null) =>
      | import("@libretracks/shared/models").SongView
      | null,
  ) => void;
  setCollapsedFolders: (update: (current: Set<string>) => Set<string>) => void;
  setContextMenu: (menu: null) => void;
  setPitchPrepareUiState: (state: {
    active: boolean;
    message: string;
    startedAt: number;
  }) => void;
  setStatus: (message: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  updateTrackTransposeEnabled: (args: {
    trackId: string;
    transposeEnabled: boolean;
  }) => Promise<TransportSnapshot>;
  /** Persists a folder's collapsed state so it survives reopening the session. */
  updateTrackCollapsed: (args: {
    trackId: string;
    collapsed: boolean;
  }) => Promise<TransportSnapshot>;
  /** Swallows the click that follows a drag release. */
  suppressTrackClickRef: { current: boolean };
  /** Anchor track for shift-click range selection. */
  trackSelectionAnchorRef: { current: string | null };
  trackDragRef: { current: TrackDragState };
  clamp: (value: number, min: number, max: number) => number;
  getElementScaleX: (bounds: DOMRect, offsetWidth: number) => number;
  getElementScaleY: (bounds: DOMRect, offsetHeight: number) => number;
  /** Max linear gain a fader reaches (+10 dB of headroom, not unity). */
  maxTrackGain: number;
};

export function createTrackHeaderHandlers(deps: TrackHeaderHandlerDeps) {
  const {
    findTrack,
    getVisibleTrackIds,
    getSelectedTrackIds,
    selectTrack,
    resolveTrackMix,
    patchTrackOptimisticMix,
    queueTrackMixLiveUpdate,
    persistTrackMix,
    commitTrackMixChange,
    runAction,
    applyPlaybackSnapshot,
    optimisticallyAppliedRevisionsRef,
    setSong,
    setCollapsedFolders,
    setContextMenu,
    setPitchPrepareUiState,
    setStatus,
    t,
    updateTrackTransposeEnabled,
    updateTrackCollapsed,
    suppressTrackClickRef,
    trackSelectionAnchorRef,
    trackDragRef,
    clamp,
    getElementScaleX,
    getElementScaleY,
    maxTrackGain,
  } = deps;

  const handleTrackHeaderSelect = (
    trackId: string,
    trackName: string,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (suppressTrackClickRef.current) {
      suppressTrackClickRef.current = false;
      return;
    }

    const currentSelection = getSelectedTrackIds();
    let nextSelection = [trackId];

    if (event.ctrlKey || event.metaKey) {
      nextSelection = currentSelection.includes(trackId)
        ? currentSelection.filter((id) => id !== trackId)
        : [...currentSelection, trackId];
      trackSelectionAnchorRef.current = trackId;
    } else if (event.shiftKey) {
      const visibleTrackIds = getVisibleTrackIds();
      const anchor = trackSelectionAnchorRef.current;
      const anchorIdx = anchor ? visibleTrackIds.indexOf(anchor) : -1;
      const currentIdx = visibleTrackIds.indexOf(trackId);

      if (anchorIdx !== -1 && currentIdx !== -1) {
        const start = Math.min(anchorIdx, currentIdx);
        const end = Math.max(anchorIdx, currentIdx);
        nextSelection = visibleTrackIds.slice(start, end + 1);
        // Anchor stays put across range extensions.
      } else {
        // No usable anchor — fall back to single-select and seed anchor.
        nextSelection = [trackId];
        trackSelectionAnchorRef.current = trackId;
      }
    } else {
      trackSelectionAnchorRef.current = trackId;
    }

    selectTrack(nextSelection);
    setStatus(
      nextSelection.length > 1
        ? t("transport.status.tracksSelected", {
            count: nextSelection.length,
          })
        : t("transport.status.trackSelected", { name: trackName }),
    );
  };

  const handleTrackHeaderDragStart = (
    event: ReactMouseEvent<HTMLElement>,
    trackId: string,
  ) => {
    if (event.button !== 0) {
      return;
    }

    event.stopPropagation();
    setContextMenu(null);
    // The track header drag can be initiated from either the DAW
    // header (vertical layout) or the compact mixer strip
    // (horizontal layout). We branch on which DOM ancestor we find
    // so the visual pipeline knows whether to translate on Y or X
    // and which selector to highlight as the drop target.
    const headerElement = event.currentTarget.closest(
      ".lt-track-header",
    ) as HTMLDivElement | null;
    const compactStrip = event.currentTarget.closest(
      ".lt-compact-mixer-strip",
    ) as HTMLDivElement | null;
    const originSurface: "daw" | "compact" = compactStrip ? "compact" : "daw";
    const scaleElement = compactStrip ?? headerElement ?? event.currentTarget;
    const scaleBounds = scaleElement.getBoundingClientRect();
    trackDragRef.current = {
      trackId,
      pointerId: 1,
      startClientX: event.clientX,
      startClientY: event.clientY,
      pointerScaleX: getElementScaleX(scaleBounds, scaleElement.offsetWidth),
      pointerScaleY: getElementScaleY(scaleBounds, scaleElement.offsetHeight),
      currentClientY: event.clientY,
      currentClientX: event.clientX,
      isDragging: false,
      rowElement:
        originSurface === "compact"
          ? compactStrip
          : (event.currentTarget.closest(
              ".lt-track-header-row",
            ) as HTMLDivElement | null),
      headerElement,
      originSurface,
    };
  };

  const handleTrackHeaderFolderToggle = (trackId: string) => {
    // Fold locally first so the arrangement reacts on the same frame as the
    // click; the collapsed flag is view state, so there is nothing to wait for.
    let nextCollapsed = false;
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(trackId)) {
        next.delete(trackId);
        nextCollapsed = false;
      } else {
        next.add(trackId);
        nextCollapsed = true;
      }
      return next;
    });

    // Then write it to the song so it survives reopening the session. Mirrors
    // the transpose toggle's optimistic bookkeeping: claim the revision the
    // backend is about to report so the incoming snapshot doesn't re-render as
    // if it were someone else's edit.
    void runAction(async () => {
      const nextSnapshot = await updateTrackCollapsed({
        trackId,
        collapsed: nextCollapsed,
      });
      optimisticallyAppliedRevisionsRef.current.add(
        nextSnapshot.projectRevision,
      );
      setSong((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          projectRevision: nextSnapshot.projectRevision,
          tracks: previous.tracks.map((track) =>
            track.id === trackId
              ? { ...track, collapsed: nextCollapsed }
              : track,
          ),
        };
      });
      applyPlaybackSnapshot(nextSnapshot);
    });
  };

  /**
   * The tracks an edit on `trackId` fans out to. A track inside a
   * multi-selection edits the whole selection; anything else edits itself only.
   */
  const editTargets = (trackId: string) =>
    resolveEditTargets(trackId, getSelectedTrackIds());

  /**
   * Apply an absolute mix value to every target that still exists, then stream
   * it live and persist it. Used by the toggles, where the whole group takes
   * the same value as the clicked track.
   */
  const applyAbsoluteMix = (
    trackIds: string[],
    key: "muted" | "solo",
    value: boolean,
  ) => {
    const applied = trackIds.filter((id) => findTrack(id) !== null);
    if (!applied.length) {
      return;
    }

    for (const id of applied) {
      patchTrackOptimisticMix(id, { [key]: value });
      queueTrackMixLiveUpdate(id, [key]);
    }

    void runAction(async () => {
      await Promise.all(applied.map((id) => persistTrackMix(id, [key])));
    });
  };

  const handleTrackHeaderMuteToggle = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) {
      return;
    }

    applyAbsoluteMix(
      editTargets(trackId),
      "muted",
      !resolveTrackMix(track, trackId).muted,
    );
  };

  const handleTrackHeaderSoloToggle = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) {
      return;
    }

    applyAbsoluteMix(
      editTargets(trackId),
      "solo",
      !resolveTrackMix(track, trackId).solo,
    );
  };

  const handleTrackHeaderVolumeChange = (
    trackId: string,
    nextVolume: number,
  ) => {
    const clampedVolume = clamp(nextVolume, 0, maxTrackGain);
    const targets = editTargets(trackId);
    const draggedTrack = findTrack(trackId);

    // The dB step the dragged fader just took; null when it started from or
    // landed on silence, where there is no ratio to hand the rest of the group.
    const deltaDb =
      targets.length > 1 && draggedTrack
        ? volumeDeltaDb(
            resolveTrackMix(draggedTrack, trackId).volume,
            clampedVolume,
          )
        : null;

    patchTrackOptimisticMix(trackId, { volume: clampedVolume });
    queueTrackMixLiveUpdate(trackId, ["volume"]);

    if (deltaDb === null) {
      return;
    }

    // Relative move: every other selected track shifts by the same dB, so the
    // balance between them survives the drag.
    for (const id of targets) {
      if (id === trackId) {
        continue;
      }
      const track = findTrack(id);
      if (!track) {
        continue;
      }
      patchTrackOptimisticMix(id, {
        volume: offsetGainByDb(
          resolveTrackMix(track, id).volume,
          deltaDb,
          maxTrackGain,
        ),
      });
      queueTrackMixLiveUpdate(id, ["volume"]);
    }
  };

  const handleTrackHeaderVolumeCommit = (trackId: string) => {
    const targets = editTargets(trackId);
    void runAction(async () => {
      await Promise.all(targets.map((id) => persistTrackMix(id, ["volume"])));
    });
  };

  const handleTrackHeaderPanChange = (trackId: string, nextPan: number) => {
    const clampedPan = clamp(nextPan, -1, 1);
    const targets = editTargets(trackId);
    const draggedTrack = findTrack(trackId);

    // Pan is already linear in its own [-1, 1] space, so the offset is a plain
    // difference — no dB detour.
    const deltaPan =
      targets.length > 1 && draggedTrack
        ? clampedPan - resolveTrackMix(draggedTrack, trackId).pan
        : 0;

    patchTrackOptimisticMix(trackId, { pan: clampedPan });
    queueTrackMixLiveUpdate(trackId, ["pan"]);

    if (deltaPan === 0) {
      return;
    }

    for (const id of targets) {
      if (id === trackId) {
        continue;
      }
      const track = findTrack(id);
      if (!track) {
        continue;
      }
      patchTrackOptimisticMix(id, {
        pan: clamp(resolveTrackMix(track, id).pan + deltaPan, -1, 1),
      });
      queueTrackMixLiveUpdate(id, ["pan"]);
    }
  };

  const handleTrackHeaderPanCommit = (trackId: string) => {
    const targets = editTargets(trackId);
    void runAction(async () => {
      await Promise.all(targets.map((id) => persistTrackMix(id, ["pan"])));
    });
  };

  const handleTrackHeaderTransposeToggle = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) {
      return;
    }

    const nextTransposeEnabled = !track.transposeEnabled;
    // Every target takes the clicked track's new state, and only those that
    // aren't already there need an IPC round-trip.
    const targets = editTargets(trackId).filter((id) => {
      const target = findTrack(id);
      return target !== null && target.transposeEnabled !== nextTransposeEnabled;
    });
    if (!targets.length) {
      return;
    }

    // Returned (not fire-and-forget) so callers can await the whole batch; the
    // UI path ignores it exactly as before.
    return runAction(async () => {
      setPitchPrepareUiState({
        active: true,
        message: "Aplicando cambio de tono...",
        startedAt: Date.now(),
      });
      // Sequential, not parallel: each toggle rebuilds pitch voices in the
      // engine, and overlapping rebuilds is exactly what the prepare overlay
      // exists to avoid.
      let lastSnapshot: TransportSnapshot | null = null;
      for (const id of targets) {
        lastSnapshot = await updateTrackTransposeEnabled({
          trackId: id,
          transposeEnabled: nextTransposeEnabled,
        });
        // Optimistic local mutation: see handleSelectedRegionTransposeChange.
        optimisticallyAppliedRevisionsRef.current.add(
          lastSnapshot.projectRevision,
        );
      }
      if (!lastSnapshot) {
        return;
      }

      const toggled = new Set(targets);
      const snapshotRevision = lastSnapshot.projectRevision;
      setSong((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          projectRevision: snapshotRevision,
          tracks: previous.tracks.map((t) =>
            toggled.has(t.id)
              ? { ...t, transposeEnabled: nextTransposeEnabled }
              : t,
          ),
        };
      });
      applyPlaybackSnapshot(lastSnapshot);
      setStatus(
        targets.length > 1
          ? t("transport.status.tracksTransposeUpdated", {
              count: targets.length,
            })
          : t("transport.status.trackTransposeUpdated", { name: track.name }),
      );
    });
  };

  const handleTrackHeaderAudioToChange = (
    trackId: string,
    nextAudioTo: string,
  ) => {
    // Routing is absolute: a track inside a multi-selection re-routes the whole
    // selection to the same output.
    const targets = editTargets(trackId).filter((id) => {
      // "inherit" only exists for tracks inside a folder; applying it to a
      // top-level track would be rejected, so skip those instead of failing
      // the whole batch.
      if (nextAudioTo !== "inherit") {
        return findTrack(id) !== null;
      }
      return Boolean(findTrack(id)?.parentTrackId);
    });
    if (!targets.length) {
      return;
    }

    return runAction(async () => {
      let lastSnapshot: TransportSnapshot | null = null;
      for (const id of targets) {
        lastSnapshot = await commitTrackMixChange({
          trackId: id,
          audioTo: nextAudioTo,
        });
      }
      applyPlaybackSnapshot(lastSnapshot);
      setStatus(
        targets.length > 1
          ? t("transport.status.tracksRoutingUpdated", {
              count: targets.length,
              defaultValue: "Routing updated on {{count}} tracks.",
            })
          : t("transport.status.trackRoutingUpdated", {
              defaultValue: "Track routing updated.",
            }),
      );
    });
  };

  return {
    handleTrackHeaderSelect,
    handleTrackHeaderDragStart,
    handleTrackHeaderFolderToggle,
    handleTrackHeaderMuteToggle,
    handleTrackHeaderSoloToggle,
    handleTrackHeaderVolumeChange,
    handleTrackHeaderVolumeCommit,
    handleTrackHeaderPanChange,
    handleTrackHeaderPanCommit,
    handleTrackHeaderTransposeToggle,
    handleTrackHeaderAudioToChange,
  };
}

export type TrackHeaderHandlers = ReturnType<typeof createTrackHeaderHandlers>;
