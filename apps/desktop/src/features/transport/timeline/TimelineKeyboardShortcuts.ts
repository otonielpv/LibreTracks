import { useEffect, type MutableRefObject } from "react";
import type { SongView, TransportSnapshot } from "@libretracks/shared/models";
import {
  cancelMarkerJump,
  deleteClip,
  deleteClips,
  deleteTracks,
  pauseTransport,
  playTransport,
  redoAction,
  seekTransport,
  stopTransport,
  undoAction,
} from "../desktopApi";
import {
  isTextEntryTarget,
  keyboardDigit,
  resolveMarkerShortcut,
  resolveRegionShortcut,
} from "../helpers";
import type { ShortcutActionId } from "../keyboard/actions";
import { eventToBinding } from "../keyboard/keybinding";
import {
  buildBindingIndex,
  resolveBindings,
  useKeybindingStore,
} from "../keyboard/keybindingStore";

type TimelineKeyboardShortcutsProps = {
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  snapshotRef: MutableRefObject<TransportSnapshot | null>;
  song: SongView | null;
  selectedClipId: string | null;
  /** Full multi-selection of clip ids. Used by Delete/Backspace so the
   * shortcut deletes every selected clip, not just the primary one. */
  selectedClipIds: string[];
  selectedTrackIds: string[];
  openTopMenu: "file" | null;
  setOpenTopMenu: (menu: "file" | null) => void;
  setSelectedClipId: (id: string | null) => void;
  clearSelection: () => void;
  clearSelections: (message: string) => void;
  copySelectedClips: () => boolean;
  duplicateSelectedClips: () => Promise<boolean>;
  pasteCopiedClips: () => Promise<boolean>;
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
  /** Split the song under the playhead in two (Shift+S). No-op if the cursor
   * isn't inside any song. */
  splitSongUnderCursor: () => Promise<void>;
  /** Split the selected clip(s) at the playhead (S). No-op when nothing is
   * selected or the cursor isn't inside the selection. */
  splitSelectedClipsUnderCursor: () => Promise<boolean>;
  /** Select every clip in the project (Ctrl+A). Returns false when empty. */
  selectAllClips: () => boolean;
  /** Nudge the selected clip(s) by one snap subdivision (Arrow keys). Returns
   * false when nothing is selected. */
  nudgeSelectedClips: (direction: -1 | 1) => Promise<boolean>;
  setStatus: (status: string) => void;
  t: (key: string, options?: Record<string, unknown>) => string;
  toggleViewMode: () => void;
};

export function useTimelineKeyboardShortcuts({
  runAction,
  applyPlaybackSnapshot,
  snapshotRef,
  song,
  selectedClipId,
  selectedClipIds,
  selectedTrackIds,
  openTopMenu,
  setOpenTopMenu,
  setSelectedClipId,
  clearSelection,
  clearSelections,
  copySelectedClips,
  duplicateSelectedClips,
  pasteCopiedClips,
  handleSaveProjectClick,
  handleSaveProjectAsClick,
  scheduleMarkerJumpWithGlobalMode,
  scheduleRegionJumpWithOptions,
  splitSongUnderCursor,
  splitSelectedClipsUnderCursor,
  selectAllClips,
  nudgeSelectedClips,
  setStatus,
  t,
  toggleViewMode,
}: TimelineKeyboardShortcutsProps) {
  // Subscribe to the user's binding overrides so a remap in the shortcuts
  // panel takes effect immediately (the effect re-runs when this changes).
  const overrides = useKeybindingStore((state) => state.overrides);

  useEffect(() => {
    // Resolve the effective action → binding map and its reverse index once
    // per override change, not on every keystroke.
    const bindingToAction = buildBindingIndex(resolveBindings(overrides));

    // ---- One handler per configurable action. These wrap exactly the
    // behaviour the app shipped before the keybinding registry existed, so
    // the refactor is behaviour-preserving for the default bindings. The
    // dispatcher looks the pressed chord up in `bindingToAction` and calls
    // the matching entry here. `event` is passed so handlers can read
    // shift/repeat and call preventDefault.
    const handlers: Record<
      ShortcutActionId,
      (event: KeyboardEvent) => void
    > = {
      "transport.playPause": (event) => {
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
      },
      "transport.stop": (event) => {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await stopTransport();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.playbackStopped"));
        });
      },
      "transport.gotoStart": (event) => {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await seekTransport(0);
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.movedToStart"));
        });
      },
      "project.save": (event) => {
        event.preventDefault();
        handleSaveProjectClick();
      },
      "project.saveAs": (event) => {
        event.preventDefault();
        handleSaveProjectAsClick();
      },
      "edit.splitSong": (event) => {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        void splitSongUnderCursor();
      },
      "edit.splitClip": (event) => {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        void splitSelectedClipsUnderCursor();
      },
      "edit.copy": (event) => {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        if (copySelectedClips()) {
          setStatus(t("transport.status.clipsCopied"));
        }
      },
      "edit.paste": (event) => {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        void runAction(async () => {
          if (await pasteCopiedClips()) {
            setStatus(t("transport.status.clipsPasted"));
          }
        });
      },
      "edit.duplicate": (event) => {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        void runAction(async () => {
          if (await duplicateSelectedClips()) {
            setStatus(t("transport.status.clipsDuplicated"));
          }
        });
      },
      "edit.undo": (event) => {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await undoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.actionUndone"));
        });
      },
      "edit.redo": (event) => {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await redoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.actionRedone"));
        });
      },
      "edit.redoAlt": (event) => {
        event.preventDefault();
        void runAction(async () => {
          const nextSnapshot = await redoAction();
          applyPlaybackSnapshot(nextSnapshot);
          setStatus(t("transport.status.actionRedone"));
        });
      },
      "edit.selectAll": (event) => {
        event.preventDefault();
        if (event.repeat) {
          return;
        }
        if (selectAllClips()) {
          setStatus(
            t("transport.status.allClipsSelected", {
              defaultValue: "Seleccionados todos los clips.",
            }),
          );
        }
      },
      "edit.nudgeLeft": (event) => {
        event.preventDefault();
        void nudgeSelectedClips(-1);
      },
      "edit.nudgeRight": (event) => {
        event.preventDefault();
        void nudgeSelectedClips(1);
      },
      "edit.delete": (event) => {
        event.preventDefault();
        if (selectedClipIds.length > 1) {
          // Multi-clip deletion via the batched backend command — a single
          // engine sync + one snapshot reload + one history entry, instead of
          // N round-trips that made the UI feel sluggish on big selections.
          const idsToDelete = [...selectedClipIds];
          void runAction(async () => {
            const nextSnapshot = await deleteClips(idsToDelete);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setStatus(
              t("transport.status.clipsDeleted", {
                count: idsToDelete.length,
                defaultValue: "Deleted {{count}} clips.",
              }),
            );
          });
        } else if (selectedClipId) {
          void runAction(async () => {
            const nextSnapshot = await deleteClip(selectedClipId);
            applyPlaybackSnapshot(nextSnapshot);
            setSelectedClipId(null);
            setStatus(t("transport.status.clipDeleted"));
          });
        } else if (selectedTrackIds.length > 0) {
          // Batched: one backend call deletes the whole selection in a single
          // engine sync + snapshot + history entry.
          const idsToDelete = [...selectedTrackIds];
          void runAction(async () => {
            const nextSnapshot = await deleteTracks(idsToDelete);
            applyPlaybackSnapshot(nextSnapshot);
            clearSelection();
            setStatus(
              t("transport.status.tracksDeleted", {
                count: idsToDelete.length,
              }),
            );
          });
        }
      },
      "view.toggleViewMode": (event) => {
        event.preventDefault();
        toggleViewMode();
      },
      "nav.cancelOrClear": (event) => {
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
      },
      // UI-zoom actions are owned by the app-level handler in App.tsx (they
      // also accept "+"/"_" variants), so they have no dispatcher entry here.
      // They appear in the shortcuts panel as fixed/informational rows.
      "view.zoomIn": () => {},
      "view.zoomOut": () => {},
      "view.zoomReset": () => {},
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const binding = eventToBinding(event);
      if (binding === null) {
        return;
      }

      const typingTarget = isTextEntryTarget(event.target);
      const isSelectTarget =
        (event.target as HTMLElement | null)?.tagName === "SELECT";

      // Tab toggles DAW/Compact view, Ableton-style. We keep the original
      // guard: only the unmodified Tab, and never while typing (so focus
      // traversal still works in inputs). Ctrl/Shift/Alt+Tab fall through to
      // the browser/OS.
      if (binding === "Tab") {
        if (typingTarget) {
          return;
        }
        const action = bindingToAction.get("Tab");
        if (action) {
          handlers[action](event);
        }
        return;
      }

      // Space (play/pause or stop) must work even inside SELECT, but not while
      // typing in a text field — matching the original behaviour.
      if (binding === "Space" || binding === "Shift+Space") {
        if (typingTarget) {
          return;
        }
        const action = bindingToAction.get(binding);
        if (action) {
          handlers[action](event);
        }
        return;
      }

      // Marker (1-9) and region (Shift+1-9) jumps are dynamic — they resolve
      // against the current song's markers/regions, so they live here rather
      // than in the configurable registry. Resolve them before the generic
      // binding lookup. Skip while typing or focused in a SELECT.
      if (!typingTarget && !isSelectTarget) {
        const keyDigit = keyboardDigit(event);
        if (keyDigit !== null && !event.ctrlKey && !event.metaKey && !event.altKey) {
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
      }

      // Generic configurable shortcuts. Everything past this point is ignored
      // while the user is typing or focused in a SELECT.
      if (typingTarget || isSelectTarget) {
        return;
      }

      // Backspace is a permanent alias for the Delete action (clip/track
      // deletion). It isn't a separately bindable row — both keys always
      // delete, matching the app's long-standing behaviour.
      if (binding === "Backspace") {
        handlers["edit.delete"](event);
        return;
      }

      const action = bindingToAction.get(binding);
      if (action) {
        handlers[action](event);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [
    overrides,
    applyPlaybackSnapshot,
    clearSelections,
    handleSaveProjectAsClick,
    handleSaveProjectClick,
    openTopMenu,
    runAction,
    scheduleMarkerJumpWithGlobalMode,
    scheduleRegionJumpWithOptions,
    splitSongUnderCursor,
    splitSelectedClipsUnderCursor,
    selectAllClips,
    nudgeSelectedClips,
    selectedClipId,
    selectedClipIds,
    selectedTrackIds,
    song,
    clearSelection,
    setOpenTopMenu,
    setSelectedClipId,
    setStatus,
    copySelectedClips,
    duplicateSelectedClips,
    pasteCopiedClips,
    snapshotRef,
    t,
    toggleViewMode,
  ]);
}
