import { useCallback } from "react";
import type { MutableRefObject } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { TFunction } from "i18next";
import {
  type ClipSummary,
  type SongView,
  type TrackKind,
  type TrackSummary,
  type TransportSnapshot,
} from "@libretracks/shared/models";
import {
  createTrack,
  deleteClip,
  deleteTrack,
  duplicateClip,
  moveTrack,
  splitClip,
  updateTrack,
  updateTrackTransposeEnabled,
} from "../desktopApi";
import {
  clamp,
  findPreviousFolderTrack,
  findTrack,
  isInteractiveTimelineTarget,
  lanePointerToClip,
  rulerPointerToSeconds,
} from "../helpers";
import { DRAG_THRESHOLD_PX } from "../constants";
import { useTimelineUIStore } from "../uiStore";
import type {
  ClipDragState,
  ContextMenuAction,
  ContextMenuState,
  TimelinePanState,
  TrackDragState,
} from "../types";
import type { TimelineTrackSummary } from "../pendingAudioImports";
import type { OptimisticMixState } from "../store";

type UseArrangementActionsProps = {
  t: TFunction;
  songRef: MutableRefObject<SongView | null>;
  displayPositionSecondsRef: MutableRefObject<number>;
  suppressTrackClickRef: MutableRefObject<boolean>;
  trackDragRef: MutableRefObject<TrackDragState>;
  clipDragRef: MutableRefObject<ClipDragState>;
  clipPreviewSecondsRef: MutableRefObject<Record<string, number>>;
  timelinePanRef: MutableRefObject<TimelinePanState>;
  livePixelsPerSecondRef: MutableRefObject<number>;
  visibleTracks: TimelineTrackSummary[];
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot) => void;
  setStatus: (status: string) => void;
  formatClock: (seconds: number) => string;
  setContextMenu: (menu: ContextMenuState) => void;
  clearLibraryDragPreview: () => void;
  selectTrack: (ids: string[]) => void;
  selectClip: (clipId: string, trackId: string) => void;
  setSelectedClipId: (id: string | null) => void;
  clearSelection: () => void;
  setSelectedRegionId: (id: string | null) => void;
  setCollapsedFolders: (
    updater: (current: Set<string>) => Set<string>,
  ) => void;
  patchTrackOptimisticMix: (trackId: string, patch: OptimisticMixState) => void;
  resolveTrackMix: (
    track: { muted: boolean; solo: boolean; volume: number; pan: number },
    trackId: string,
  ) => { muted: boolean; solo: boolean; volume: number; pan: number };
  queueTrackMixLiveUpdate: (
    trackId: string,
    keys: Array<keyof OptimisticMixState>,
  ) => void;
  persistTrackMix: (
    trackId: string,
    keys: Array<keyof OptimisticMixState>,
  ) => Promise<void>;
  getCameraX: () => number;
  getTimelineScrollContainer: () => HTMLElement | null;
  previewSeek: (seconds: number) => void;
  performSeek: (seconds: number) => Promise<void>;
  restoreConfirmedTransportVisual: () => void;
  updateCameraX: (x: number, options?: { commitToStore?: boolean }) => number;
  normalizeSeek: (seconds: number, durationSeconds: number) => number;
  refreshSongView: () => Promise<unknown>;
};

export function useArrangementActions({
  t,
  songRef,
  displayPositionSecondsRef,
  suppressTrackClickRef,
  trackDragRef,
  clipDragRef,
  clipPreviewSecondsRef,
  timelinePanRef,
  livePixelsPerSecondRef,
  visibleTracks,
  runAction,
  applyPlaybackSnapshot,
  setStatus,
  formatClock,
  setContextMenu,
  clearLibraryDragPreview,
  refreshSongView,
  selectTrack,
  selectClip,
  setSelectedClipId,
  clearSelection,
  setSelectedRegionId,
  setCollapsedFolders,
  patchTrackOptimisticMix,
  resolveTrackMix,
  queueTrackMixLiveUpdate,
  persistTrackMix,
  getCameraX,
  getTimelineScrollContainer,
  previewSeek,
  performSeek,
  restoreConfirmedTransportVisual,
  updateCameraX,
  normalizeSeek,
}: UseArrangementActionsProps) {
  const handleCreateTrack = useCallback(
    async (
      kind: TrackKind,
      anchorTrack: TrackSummary | null,
      parentTrackId?: string | null,
    ) => {
      const defaultName =
        kind === "folder"
          ? t("transport.defaults.folderTrackName")
          : t("transport.defaults.audioTrackName");
      const name = window
        .prompt(t("transport.prompt.trackName"), defaultName)
        ?.trim();
      if (!name) {
        return;
      }

      await runAction(async () => {
        const nextSnapshot = await createTrack({
          name,
          kind,
          insertAfterTrackId: anchorTrack?.id ?? null,
          parentTrackId: parentTrackId ?? null,
        });
        applyPlaybackSnapshot(nextSnapshot);
        await refreshSongView();
        setStatus(t("transport.status.trackCreated", { name }));
      });
    },
    [applyPlaybackSnapshot, refreshSongView, runAction, setStatus, t],
  );

  const trackContextMenu = useCallback(
    (track: TrackSummary): ContextMenuAction[] => {
      const currentSong = songRef.current;
      if (!currentSong) {
        return [];
      }

      const previousFolder = findPreviousFolderTrack(currentSong, track.id);
      const parentTrack = findTrack(currentSong, track.parentTrackId ?? null);
      const parentOfParent = parentTrack?.parentTrackId ?? null;

      return [
        {
          label: t("transport.menu.insertTrack"),
          onSelect: () =>
            handleCreateTrack("audio", track, track.parentTrackId ?? null),
        },
        {
          label: t("transport.menu.insertFolderTrack"),
          onSelect: () =>
            handleCreateTrack("folder", track, track.parentTrackId ?? null),
        },
        {
          label: t("common.rename"),
          onSelect: async () => {
            const nextName = window
              .prompt(t("transport.prompt.trackRename"), track.name)
              ?.trim();
            if (!nextName) {
              return;
            }
            await runAction(async () => {
              const nextSnapshot = await updateTrack({
                trackId: track.id,
                name: nextName,
              });
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                t("transport.status.trackRenamed", { name: nextName }),
              );
            });
          },
        },
        {
          label: t("common.delete"),
          onSelect: async () => {
            const clipCount = currentSong.clips.filter(
              (clip) => clip.trackId === track.id,
            ).length;
            if (
              track.kind === "audio" &&
              clipCount > 0 &&
              !window.confirm(t("transport.confirm.deleteTrackWithClips"))
            ) {
              return;
            }

            await runAction(async () => {
              const nextSnapshot = await deleteTrack(track.id);
              applyPlaybackSnapshot(nextSnapshot);
              clearLibraryDragPreview();
              await refreshSongView();
              setStatus(
                t("transport.status.trackDeleted", { name: track.name }),
              );
            });
          },
        },
        {
          label: t("transport.menu.indentIntoPreviousFolder"),
          disabled: !previousFolder,
          onSelect: async () => {
            if (!previousFolder) {
              return;
            }
            await runAction(async () => {
              const nextSnapshot = await moveTrack({
                trackId: track.id,
                parentTrackId: previousFolder.id,
              });
              applyPlaybackSnapshot(nextSnapshot);
              await refreshSongView();
              setStatus(
                t("transport.status.trackMovedIntoFolder", {
                  name: previousFolder.name,
                }),
              );
            });
          },
        },
        {
          label: t("transport.menu.removeFromFolder"),
          disabled: !track.parentTrackId,
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await moveTrack({
                trackId: track.id,
                insertAfterTrackId: track.parentTrackId ?? null,
                parentTrackId: parentOfParent,
              });
              applyPlaybackSnapshot(nextSnapshot);
              await refreshSongView();
              setStatus(
                t("transport.status.trackRemovedFromFolder", {
                  name: track.name,
                }),
              );
            });
          },
        },
      ];
    },
    [
      applyPlaybackSnapshot,
      clearLibraryDragPreview,
      handleCreateTrack,
      refreshSongView,
      runAction,
      setStatus,
      songRef,
      t,
    ],
  );

  const globalTrackListContextMenu = useCallback(
    (): ContextMenuAction[] => [
      {
        label: t("transport.menu.addAudioTrack"),
        onSelect: () => handleCreateTrack("audio", null, null),
      },
      {
        label: t("transport.menu.addFolderTrack"),
        onSelect: () => handleCreateTrack("folder", null, null),
      },
    ],
    [handleCreateTrack, t],
  );

  const clipContextMenu = useCallback(
    (clip: ClipSummary): ContextMenuAction[] => {
      const currentCursorSeconds = displayPositionSecondsRef.current;
      const canSplit =
        currentCursorSeconds > clip.timelineStartSeconds &&
        currentCursorSeconds <
          clip.timelineStartSeconds + clip.durationSeconds;

      return [
        {
          label: t("transport.menu.splitClipAtCursor"),
          disabled: !canSplit,
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await splitClip(
                clip.id,
                currentCursorSeconds,
              );
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                t("transport.status.clipSplitAt", {
                  time: formatClock(currentCursorSeconds),
                }),
              );
            });
          },
        },
        {
          label: t("transport.menu.duplicateClip"),
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await duplicateClip(
                clip.id,
                clip.timelineStartSeconds + clip.durationSeconds + 1,
              );
              applyPlaybackSnapshot(nextSnapshot);
              setStatus(
                t("transport.status.clipDuplicated", {
                  name: clip.trackName,
                }),
              );
            });
          },
        },
        {
          label: t("common.delete"),
          onSelect: async () => {
            await runAction(async () => {
              const nextSnapshot = await deleteClip(clip.id);
              applyPlaybackSnapshot(nextSnapshot);
              setSelectedClipId(null);
              setStatus(
                t("transport.status.clipDeleted", { name: clip.trackName }),
              );
            });
          },
        },
      ];
    },
    [
      applyPlaybackSnapshot,
      displayPositionSecondsRef,
      formatClock,
      runAction,
      setSelectedClipId,
      setStatus,
      t,
    ],
  );

  const handleTrackHeaderContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>, trackId: string) => {
      const track = findTrack(songRef.current, trackId);
      if (!track) {
        return;
      }

      selectTrack([track.id]);
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        title: track.name,
        actions: trackContextMenu(track),
      });
    },
    [selectTrack, setContextMenu, songRef, trackContextMenu],
  );

  const handleTrackHeaderDragStart = useCallback(
    (event: ReactMouseEvent<HTMLElement>, trackId: string) => {
      if (event.button !== 0) {
        return;
      }

      event.stopPropagation();
      setContextMenu(null);
      const headerElement = event.currentTarget.closest(
        ".lt-track-header",
      ) as HTMLDivElement | null;
      trackDragRef.current = {
        trackId,
        pointerId: 1,
        startClientX: event.clientX,
        startClientY: event.clientY,
        currentClientY: event.clientY,
        isDragging: false,
        rowElement: event.currentTarget.closest(
          ".lt-track-header-row",
        ) as HTMLDivElement | null,
        headerElement,
      };
    },
    [setContextMenu, trackDragRef],
  );

  const handleTrackHeaderFolderToggle = useCallback(
    (trackId: string) => {
      setCollapsedFolders((current) => {
        const next = new Set(current);
        if (next.has(trackId)) {
          next.delete(trackId);
        } else {
          next.add(trackId);
        }
        return next;
      });
    },
    [setCollapsedFolders],
  );

  const handleTrackHeaderMuteToggle = useCallback(
    (trackId: string) => {
      const track = findTrack(songRef.current, trackId);
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
    },
    [
      patchTrackOptimisticMix,
      persistTrackMix,
      queueTrackMixLiveUpdate,
      resolveTrackMix,
      runAction,
      songRef,
    ],
  );

  const handleTrackHeaderSoloToggle = useCallback(
    (trackId: string) => {
      const track = findTrack(songRef.current, trackId);
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
    },
    [
      patchTrackOptimisticMix,
      persistTrackMix,
      queueTrackMixLiveUpdate,
      resolveTrackMix,
      runAction,
      songRef,
    ],
  );

  const handleTrackHeaderVolumeChange = useCallback(
    (trackId: string, nextVolume: number) => {
      patchTrackOptimisticMix(trackId, {
        volume: clamp(nextVolume, 0, 1),
      });
      queueTrackMixLiveUpdate(trackId, ["volume"]);
    },
    [patchTrackOptimisticMix, queueTrackMixLiveUpdate],
  );

  const handleTrackHeaderVolumeCommit = useCallback(
    (trackId: string) => {
      void runAction(async () => {
        await persistTrackMix(trackId, ["volume"]);
      });
    },
    [persistTrackMix, runAction],
  );

  const handleTrackHeaderPanChange = useCallback(
    (trackId: string, nextPan: number) => {
      patchTrackOptimisticMix(trackId, {
        pan: clamp(nextPan, -1, 1),
      });
      queueTrackMixLiveUpdate(trackId, ["pan"]);
    },
    [patchTrackOptimisticMix, queueTrackMixLiveUpdate],
  );

  const handleTrackHeaderPanCommit = useCallback(
    (trackId: string) => {
      void runAction(async () => {
        await persistTrackMix(trackId, ["pan"]);
      });
    },
    [persistTrackMix, runAction],
  );

  const handleTrackHeaderTransposeToggle = useCallback(
    (trackId: string) => {
      const track = findTrack(songRef.current, trackId);
      if (!track) {
        return;
      }

      void runAction(async () => {
        const nextSnapshot = await updateTrackTransposeEnabled({
          trackId,
          transposeEnabled: !track.transposeEnabled,
        });
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          t("transport.status.trackTransposeUpdated", { name: track.name }),
        );
      });
    },
    [applyPlaybackSnapshot, runAction, setStatus, songRef, t],
  );

  const handleTrackHeaderSelect = useCallback(
    (
      trackId: string,
      trackName: string,
      event: ReactMouseEvent<HTMLDivElement>,
    ) => {
      if (suppressTrackClickRef.current) {
        suppressTrackClickRef.current = false;
        return;
      }

      const currentSelection = useTimelineUIStore.getState().selectedTrackIds;
      let nextSelection = [trackId];

      if (event.ctrlKey || event.metaKey) {
        nextSelection = currentSelection.includes(trackId)
          ? currentSelection.filter((id) => id !== trackId)
          : [...currentSelection, trackId];
      } else if (event.shiftKey && currentSelection.length > 0) {
        const visibleTrackIds = visibleTracks.map((track) => track.id);
        const lastSelectedIdx = visibleTrackIds.indexOf(
          currentSelection[currentSelection.length - 1],
        );
        const currentIdx = visibleTrackIds.indexOf(trackId);

        if (lastSelectedIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(lastSelectedIdx, currentIdx);
          const end = Math.max(lastSelectedIdx, currentIdx);
          const range = visibleTrackIds.slice(start, end + 1);
          nextSelection = [...new Set([...currentSelection, ...range])];
        }
      }

      selectTrack(nextSelection);
      setStatus(
        nextSelection.length > 1
          ? t("transport.status.tracksSelected", {
              count: nextSelection.length,
            })
          : t("transport.status.trackSelected", { name: trackName }),
      );
    },
    [selectTrack, setStatus, suppressTrackClickRef, t, visibleTracks],
  );

  const handleTrackLaneMouseDown = useCallback(
    (
      event: ReactMouseEvent<HTMLDivElement>,
      track: TrackSummary,
      trackClips: ClipSummary[],
    ) => {
      if (event.button !== 0 || isInteractiveTimelineTarget(event.target)) {
        return;
      }

      const hitClip = lanePointerToClip(
        trackClips,
        event.currentTarget,
        event.clientX,
        getCameraX(),
        livePixelsPerSecondRef.current,
      );

      if (hitClip) {
        event.preventDefault();
        const clickSeekSeconds = normalizeSeek(
          rulerPointerToSeconds(
            event,
            event.currentTarget,
            getTimelineScrollContainer(),
            songRef.current?.durationSeconds ?? 0,
            livePixelsPerSecondRef.current,
          ),
          songRef.current?.durationSeconds ?? 0,
        );
        previewSeek(clickSeekSeconds);
        selectClip(hitClip.id, track.id);
        setContextMenu(null);
        clipDragRef.current = {
          clipId: hitClip.id,
          pointerId: 1,
          originSeconds: hitClip.timelineStartSeconds,
          previewSeconds: hitClip.timelineStartSeconds,
          clickSeekSeconds,
          startClientX: event.clientX,
          hasMoved: false,
        };
        clipPreviewSecondsRef.current = {
          [hitClip.id]: hitClip.timelineStartSeconds,
        };
        return;
      }

      event.preventDefault();
      setContextMenu(null);
      const previewSeconds = normalizeSeek(
        rulerPointerToSeconds(
          event,
          event.currentTarget,
          getTimelineScrollContainer(),
          songRef.current?.durationSeconds ?? 0,
          livePixelsPerSecondRef.current,
        ),
        songRef.current?.durationSeconds ?? 0,
      );
      previewSeek(previewSeconds);

      const activePan: NonNullable<TimelinePanState> = {
        pointerId: 1,
        startClientX: event.clientX,
        originCameraX: getCameraX(),
        previewSeconds,
        hasMoved: false,
      };
      timelinePanRef.current = activePan;

      const onMouseMove = (windowEvent: MouseEvent) => {
        const deltaX = activePan.startClientX - windowEvent.clientX;
        const exceededThreshold = Math.abs(deltaX) > DRAG_THRESHOLD_PX;
        if (!activePan.hasMoved && !exceededThreshold) {
          return;
        }

        if (!activePan.hasMoved) {
          activePan.hasMoved = true;
          restoreConfirmedTransportVisual();
        }

        updateCameraX(activePan.originCameraX + deltaX, {
          commitToStore: false,
        });
      };

      const onMouseUp = (windowEvent: MouseEvent) => {
        if (windowEvent.button !== 0) {
          return;
        }

        timelinePanRef.current = null;
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);

        if (!activePan.hasMoved) {
          void runAction(async () => {
            await performSeek(activePan.previewSeconds);
          });
        }
      };

      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [
      clipDragRef,
      clipPreviewSecondsRef,
      getCameraX,
      getTimelineScrollContainer,
      livePixelsPerSecondRef,
      normalizeSeek,
      performSeek,
      previewSeek,
      restoreConfirmedTransportVisual,
      runAction,
      selectClip,
      setContextMenu,
      songRef,
      timelinePanRef,
      updateCameraX,
    ],
  );

  const handleTrackLaneContextMenu = useCallback(
    (
      event: ReactMouseEvent<HTMLDivElement>,
      track: TrackSummary,
      trackClips: ClipSummary[],
    ) => {
      const hitClip = lanePointerToClip(
        trackClips,
        event.currentTarget,
        event.clientX,
        getCameraX(),
        livePixelsPerSecondRef.current,
      );

      if (hitClip) {
        selectClip(hitClip.id, track.id);
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          title: hitClip.trackName,
          actions: clipContextMenu(hitClip),
        });
        return;
      }

      selectTrack([track.id]);
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        title: track.name,
        actions: trackContextMenu(track),
      });
    },
    [
      clipContextMenu,
      getCameraX,
      livePixelsPerSecondRef,
      selectClip,
      selectTrack,
      setContextMenu,
      trackContextMenu,
    ],
  );

  const handleTrackListContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!songRef.current) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target?.closest(".lt-track-lane-row")) {
        return;
      }

      clearSelection();
      setSelectedRegionId(null);
      event.preventDefault();
      event.stopPropagation();
      setContextMenu({
        x: event.clientX,
        y: event.clientY,
        title: "Tracks",
        actions: globalTrackListContextMenu(),
      });
    },
    [
      clearSelection,
      globalTrackListContextMenu,
      setContextMenu,
      setSelectedRegionId,
      songRef,
    ],
  );

  return {
    handleCreateTrack,
    trackContextMenu,
    globalTrackListContextMenu,
    clipContextMenu,
    handleTrackHeaderContextMenu,
    handleTrackHeaderDragStart,
    handleTrackHeaderFolderToggle,
    handleTrackHeaderMuteToggle,
    handleTrackHeaderSoloToggle,
    handleTrackHeaderVolumeChange,
    handleTrackHeaderVolumeCommit,
    handleTrackHeaderPanChange,
    handleTrackHeaderPanCommit,
    handleTrackHeaderTransposeToggle,
    handleTrackHeaderSelect,
    handleTrackLaneMouseDown,
    handleTrackLaneContextMenu,
    handleTrackListContextMenu,
  };
}
