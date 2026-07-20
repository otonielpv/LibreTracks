import type { TrackSummary, TransportSnapshot } from "@libretracks/shared/models";
import type { MouseEvent as ReactMouseEvent } from "react";

import type { OptimisticMixState } from "../store";
import type { TrackDragState } from "../types";

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
    setCollapsedFolders((current) => {
      const next = new Set(current);
      if (next.has(trackId)) {
        next.delete(trackId);
      } else {
        next.add(trackId);
      }
      return next;
    });
  };

  const handleTrackHeaderMuteToggle = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) {
      return;
    }

    patchTrackOptimisticMix(trackId, {
      muted: !resolveTrackMix(track, trackId).muted,
    });
    queueTrackMixLiveUpdate(trackId, ["muted"]);

    void runAction(async () => {
      await persistTrackMix(trackId, ["muted"]);
    });
  };

  const handleTrackHeaderSoloToggle = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) {
      return;
    }

    patchTrackOptimisticMix(trackId, {
      solo: !resolveTrackMix(track, trackId).solo,
    });
    queueTrackMixLiveUpdate(trackId, ["solo"]);

    void runAction(async () => {
      await persistTrackMix(trackId, ["solo"]);
    });
  };

  const handleTrackHeaderVolumeChange = (
    trackId: string,
    nextVolume: number,
  ) => {
    patchTrackOptimisticMix(trackId, {
      volume: clamp(nextVolume, 0, maxTrackGain),
    });
    queueTrackMixLiveUpdate(trackId, ["volume"]);
  };

  const handleTrackHeaderVolumeCommit = (trackId: string) => {
    void runAction(async () => {
      await persistTrackMix(trackId, ["volume"]);
    });
  };

  const handleTrackHeaderPanChange = (trackId: string, nextPan: number) => {
    patchTrackOptimisticMix(trackId, {
      pan: clamp(nextPan, -1, 1),
    });
    queueTrackMixLiveUpdate(trackId, ["pan"]);
  };

  const handleTrackHeaderPanCommit = (trackId: string) => {
    void runAction(async () => {
      await persistTrackMix(trackId, ["pan"]);
    });
  };

  const handleTrackHeaderTransposeToggle = (trackId: string) => {
    const track = findTrack(trackId);
    if (!track) {
      return;
    }

    const nextTransposeEnabled = !track.transposeEnabled;
    void runAction(async () => {
      setPitchPrepareUiState({
        active: true,
        message: "Aplicando cambio de tono...",
        startedAt: Date.now(),
      });
      const nextSnapshot = await updateTrackTransposeEnabled({
        trackId,
        transposeEnabled: nextTransposeEnabled,
      });
      // Optimistic local mutation: see handleSelectedRegionTransposeChange.
      optimisticallyAppliedRevisionsRef.current.add(
        nextSnapshot.projectRevision,
      );
      setSong((previous) => {
        if (!previous) return previous;
        return {
          ...previous,
          projectRevision: nextSnapshot.projectRevision,
          tracks: previous.tracks.map((t) =>
            t.id === trackId
              ? { ...t, transposeEnabled: nextTransposeEnabled }
              : t,
          ),
        };
      });
      applyPlaybackSnapshot(nextSnapshot);
      setStatus(
        t("transport.status.trackTransposeUpdated", { name: track.name }),
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
  };
}

export type TrackHeaderHandlers = ReturnType<typeof createTrackHeaderHandlers>;
