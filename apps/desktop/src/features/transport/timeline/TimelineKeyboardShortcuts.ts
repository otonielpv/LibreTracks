import { useEffect, type MutableRefObject } from "react";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";
import {
  cancelMarkerJump,
  deleteClip,
  deleteTrack,
  pauseTransport,
  playTransport,
  redoAction,
  undoAction,
} from "../desktopApi";
import {
  isTextEntryTarget,
  keyboardDigit,
  resolveMarkerShortcut,
  resolveRegionShortcut,
} from "../helpers";

type TimelineKeyboardShortcutsProps = {
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  snapshotRef: MutableRefObject<TransportSnapshot | null>;
  song: SongView | null;
  selectedClipId: string | null;
  selectedTrackIds: string[];
  openTopMenu: "file" | null;
  setOpenTopMenu: (menu: "file" | null) => void;
  setSelectedClipId: (id: string | null) => void;
  clearSelection: () => void;
  clearSelections: (message: string) => void;
  handleSaveProjectClick: () => void;
  handleSaveProjectAsClick: () => void;
  scheduleMarkerJumpWithGlobalMode: (
    markerId: string,
    markerName: string,
  ) => Promise<TransportSnapshot>;
  scheduleRegionJumpWithOptions: (
    regionId: string,
    regionName: string,
  ) => Promise<TransportSnapshot>;
  setStatus: (status: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
};

export function useTimelineKeyboardShortcuts({
  runAction,
  applyPlaybackSnapshot,
  snapshotRef,
  song,
  selectedClipId,
  selectedTrackIds,
  openTopMenu,
  setOpenTopMenu,
  setSelectedClipId,
  clearSelection,
  clearSelections,
  handleSaveProjectClick,
  handleSaveProjectAsClick,
  scheduleMarkerJumpWithGlobalMode,
  scheduleRegionJumpWithOptions,
  setStatus,
  t,
}: TimelineKeyboardShortcutsProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        if (isTextEntryTarget(event.target)) {
          return;
        }

        event.preventDefault();
        void runAction(async () => {
          if (snapshotRef.current?.playbackState === "playing") {
            const nextSnapshot = await pauseTransport();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.playbackPaused"));
            return;
          }

          const nextSnapshot = await playTransport();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.playbackStarted"));
        });
        return;
      }

      const target = event.target as HTMLElement | null;
      const isTypingTarget =
        isTextEntryTarget(event.target) || target?.tagName === "SELECT";

      if (isTypingTarget) {
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();

        if (event.shiftKey) {
          handleSaveProjectAsClick();
          return;
        }

        handleSaveProjectClick();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = event.shiftKey
            ? await redoAction()
            : await undoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(
            event.shiftKey
              ? t("transport.status.actionRedone")
              : t("transport.status.actionUndone"),
          );
        });
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await redoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.actionRedone"));
        });
        return;
      }

      const keyDigit = keyboardDigit(event.code);
      if (keyDigit !== null) {
        event.preventDefault();

        if (event.shiftKey) {
          const region = song
            ? resolveRegionShortcut(song.regions, keyDigit)
            : null;
          if (!region) {
            setStatus(
              t("transport.status.noSongForDigit", { digit: keyDigit }),
            );
            return;
          }

          void runAction(async () => {
            await scheduleRegionJumpWithOptions(region.id, region.name);
          });
          return;
        }

        const marker = song
          ? resolveMarkerShortcut(song.sectionMarkers, keyDigit)
          : null;
        if (!marker) {
          setStatus(
            t("transport.status.noMarkerForDigit", { digit: keyDigit }),
          );
          return;
        }

        void runAction(async () => {
          const pendingJump = snapshotRef.current?.pendingMarkerJump;
          if (pendingJump && pendingJump.targetMarkerId === marker.id) {
            const nextSnapshot = await cancelMarkerJump();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(
              t("transport.status.jumpCancelledDigit", { digit: keyDigit }),
            );
            return;
          }

          await scheduleMarkerJumpWithGlobalMode(marker.id, marker.name);
        });

        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();

        if (openTopMenu) {
          setOpenTopMenu(null);
          return;
        }

        if (snapshotRef.current?.pendingMarkerJump) {
          void runAction(async () => {
            const nextSnapshot = await cancelMarkerJump();
            applyPlaybackSnapshot(nextSnapshot);
            setStatus(t("transport.status.jumpCancelled"));
          });
          return;
        }

        clearSelections(t("transport.status.selectionsCleared"));
        return;
      }

      if (event.key === "Delete" || event.key === "Backspace") {
        if (isTextEntryTarget(event.target)) {
          return;
        }

        event.preventDefault();

        if (selectedClipId) {
          void runAction(async () => {
            const nextSnapshot = await deleteClip(selectedClipId);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setStatus(t("transport.status.clipDeleted"));
          });
        } else if (selectedTrackIds.length > 0) {
          void runAction(async () => {
            let lastSnapshot: TransportSnapshot | null = null;
            for (const trackId of selectedTrackIds) {
              lastSnapshot = await deleteTrack(trackId);
            }
            if (lastSnapshot) {
              applyPlaybackSnapshot(lastSnapshot);
            }
            clearSelection();
            setStatus(
              t("transport.status.tracksDeleted", {
                count: selectedTrackIds.length,
              }),
            );
          });
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    applyPlaybackSnapshot,
    clearSelections,
    handleSaveProjectAsClick,
    handleSaveProjectClick,
    openTopMenu,
    runAction,
    scheduleMarkerJumpWithGlobalMode,
    scheduleRegionJumpWithOptions,
    selectedClipId,
    selectedTrackIds,
    song,
    clearSelection,
    setOpenTopMenu,
    setSelectedClipId,
    setStatus,
    snapshotRef,
    t,
  ]);
}
