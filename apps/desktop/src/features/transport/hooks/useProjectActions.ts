import type {
  LibraryAssetSummary,
  ProjectLoadProgressEvent,
  TransportSnapshot,
} from "@libretracks/shared/models";
import {
  createSong,
  getProjectLoadProgressSnapshot,
  openProject,
  pickAndImportSong,
  saveProject,
  saveProjectAs,
} from "../desktopApi";
import { nextPaint } from "../pendingAudioImports";
import type { SidebarTab } from "../types";

type UseProjectActionsProps = {
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  setProjectViewHydrating: (hydrating: boolean) => void;
  setBusyFeedback: (feedback: {
    message: string;
    percent?: number;
    detail?: string;
  } | null) => void;
  registerProjectLoadProgressListener: () => Promise<() => void>;
  refreshSongView: (options?: { sync?: boolean }) => Promise<unknown>;
  refreshLibraryState: (options?: {
    preserveAssets?: LibraryAssetSummary[];
  }) => Promise<LibraryAssetSummary[]>;
  t: (key: string, options?: Record<string, unknown>) => string;
  setStatus: (status: string) => void;
  setActiveSidebarTab: (tab: SidebarTab | null) => void;
  setPackageUnpackUiState: (
    state: { active: boolean; percent: number },
  ) => void;
};

export function useProjectActions({
  runAction,
  applyPlaybackSnapshot,
  setProjectViewHydrating,
  setBusyFeedback,
  registerProjectLoadProgressListener,
  refreshSongView,
  refreshLibraryState,
  t,
  setStatus,
  setActiveSidebarTab,
  setPackageUnpackUiState,
}: UseProjectActionsProps) {
  function applyProjectProgressFeedback(event: ProjectLoadProgressEvent) {
    const detail =
      event.sourcesTotal > 0
        ? `${event.sourcesReady}/${event.sourcesTotal} fuentes | RAM ${event.ramCacheMb} MB | disco ${event.diskCacheMb} MB`
        : undefined;
    setBusyFeedback({
      message: event.message,
      percent: event.percent,
      detail,
    });
  }

  function startProjectProgressPolling(startedAtUnixMs: number) {
    let stopped = false;
    let timeoutId: number | null = null;
    const poll = async () => {
      try {
        const event = await getProjectLoadProgressSnapshot();
        if (
          event &&
          (!event.emittedAtUnixMs || event.emittedAtUnixMs >= startedAtUnixMs)
        ) {
          applyProjectProgressFeedback(event);
        }
      } catch {
        // Best effort: progress events still update the overlay if polling fails.
      } finally {
        if (!stopped) {
          timeoutId = window.setTimeout(poll, 250);
        }
      }
    };
    timeoutId = window.setTimeout(poll, 0);
    return () => {
      stopped = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
      }
    };
  }

  function handleCreateSongClick() {
    void runAction(
      async () => {
        const nextSnapshot = await createSong();
        if (!nextSnapshot) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);
        setActiveSidebarTab(null);
        setStatus(
          nextSnapshot.songFilePath
            ? t("transport.status.projectCreatedAt", {
                path: nextSnapshot.songFilePath,
              })
            : t("transport.status.projectCreated"),
        );
      },
      { busy: true },
    );
  }

  function handleOpenProjectClick() {
    void runAction(
      async () => {
        let unlistenProjectProgress: (() => void) | null = null;
        let stopProjectProgressPolling: (() => void) | null = null;
        const progressStartedAt = Date.now();
        setProjectViewHydrating(true);
        setBusyFeedback({
          message: t("transport.shell.loadingProject", {
            defaultValue: "Opening project...",
          }),
          percent: 2,
        });
        try {
          unlistenProjectProgress = await registerProjectLoadProgressListener();
          stopProjectProgressPolling = startProjectProgressPolling(progressStartedAt);
          await nextPaint();
          // openProject() returns null if the user cancels the native dialog.
          // Otherwise it returns only after the backend has finished decoding
          // all sources AND prearmed Bungee voices; see
          // wait_for_project_audio_preparation in state.rs. So by the time we
          // continue, the engine is ready to Play instantly.
          const nextSnapshot = await openProject();
          if (!nextSnapshot) {
            setProjectViewHydrating(false);
            setBusyFeedback(null);
            return;
          }
          const nextSong = await refreshSongView({ sync: true });
          applyPlaybackSnapshot(nextSnapshot);
          setActiveSidebarTab(null);
          setBusyFeedback({
            message: t("transport.shell.projectReady", {
              defaultValue: "Proyecto listo para reproducir.",
            }),
            percent: 100,
          });
          // Wait two animation frames so React commits the new SongView and
          // paints the tracks before we tear down the loading overlay;
          // prevents the 1-2s flash of an empty timeline between the
          // overlay closing and the tracks appearing.
          await nextPaint();
          setProjectViewHydrating(false);
        } catch (error) {
          setProjectViewHydrating(false);
          setBusyFeedback(null);
          throw error;
        } finally {
          stopProjectProgressPolling?.();
          unlistenProjectProgress?.();
        }
      },
      { busy: true },
    );
  }

  function handleImportSongClick() {
    // Non-blocking import: the backend returns as soon as the package is
    // unzipped + the song structure is persisted (it no longer waits for every
    // source to finish decoding). So we do NOT raise the blocking shell overlay
    // (no `busy: true`, no setProjectViewHydrating) — the timeline shows the new
    // tracks immediately, waveforms fill in as they decode, and play is
    // progressive (decoded head audible, rest silent). The user can keep using
    // the UI throughout, exactly like the audio-file import.
    void runAction(async () => {
      setStatus(
        t("transport.shell.importingProject", {
          defaultValue: "Importing project...",
        }),
      );
      // Non-modal "Descomprimiendo paquete…" indicator (percent fed by the
      // project:load-progress listener), so the user sees the import is working
      // even though we don't raise the blocking overlay. Cleared in `finally`.
      setPackageUnpackUiState({ active: true, percent: 0 });
      try {
        const nextSnapshot = await pickAndImportSong();
        if (!nextSnapshot) {
          return;
        }
        // Backend emits up to ~50% (decompress + merge); source decode is async
        // and shown by the "Preparing audio…" indicator. The unpack phase is
        // done once the call resolves — show 100% so it doesn't vanish mid-bar.
        setPackageUnpackUiState({ active: true, percent: 100 });
        const nextSong = await refreshSongView({ sync: true });
        applyPlaybackSnapshot(nextSnapshot);
        await refreshLibraryState();
        setActiveSidebarTab(null);
        if (nextSong) {
          setStatus(t("transport.status.songImported"));
        }
      } finally {
        setPackageUnpackUiState({ active: false, percent: 0 });
      }
    });
  }

  function handleSaveProjectClick() {
    void runAction(
      async () => {
        const nextSnapshot = await saveProject();
        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          nextSnapshot.songFilePath
            ? t("transport.status.projectSavedAt", {
                path: nextSnapshot.songFilePath,
              })
            : t("transport.status.projectSaved"),
        );
      },
      { busy: true },
    );
  }

  function handleSaveProjectAsClick() {
    void runAction(
      async () => {
        const nextSnapshot = await saveProjectAs();
        if (!nextSnapshot) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);
        setStatus(
          nextSnapshot.songFilePath
            ? t("transport.status.projectSavedAt", {
                path: nextSnapshot.songFilePath,
              })
            : t("transport.status.projectSavedNewLocation"),
        );
      },
      { busy: true },
    );
  }

  return {
    handleCreateSongClick,
    handleOpenProjectClick,
    handleImportSongClick,
    handleSaveProjectClick,
    handleSaveProjectAsClick,
  };
}
