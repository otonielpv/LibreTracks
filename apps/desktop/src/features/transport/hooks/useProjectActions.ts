import type { LibraryAssetSummary, TransportSnapshot } from "@libretracks/shared/models";
import {
  appendDebugLog,
  createSong,
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
}: UseProjectActionsProps) {
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
        setProjectViewHydrating(true);
        void appendDebugLog("[frontend:open] handleOpenProjectClick start").catch(() => {});
        setBusyFeedback({
          message: t("transport.shell.loadingProject", {
            defaultValue: "Opening project...",
          }),
          percent: 2,
        });
        try {
          unlistenProjectProgress = await registerProjectLoadProgressListener();
          void appendDebugLog("[frontend:open] progress listener registered").catch(() => {});
          // openProject() returns null if the user cancels the native dialog.
          // Otherwise it returns only after the backend has finished decoding
          // all sources AND prearmed Bungee voices — see
          // wait_for_project_audio_preparation in state.rs. So by the time we
          // continue, the engine is ready to Play instantly.
          const nextSnapshot = await openProject();
          void appendDebugLog(
            `[frontend:open] openProject resolved hasSnapshot=${Boolean(nextSnapshot)}`,
          ).catch(() => {});
          if (!nextSnapshot) {
            setProjectViewHydrating(false);
            setBusyFeedback(null);
            return;
          }
          setBusyFeedback({
            message: t("transport.shell.loadingProjectView", {
              defaultValue: "Loading project view...",
            }),
            percent: 96,
          });
          const nextSong = await refreshSongView({ sync: true });
          void appendDebugLog(
            `[frontend:open] refreshSongView resolved hasSong=${Boolean(nextSong)}`,
          ).catch(() => {});
          applyPlaybackSnapshot(nextSnapshot);
          setActiveSidebarTab(null);
          // Wait two animation frames so React commits the new SongView and
          // paints the tracks before we tear down the loading overlay —
          // prevents the 1-2s flash of an empty timeline between the
          // overlay closing and the tracks appearing.
          await nextPaint();
          setProjectViewHydrating(false);
        } catch (error) {
          void appendDebugLog(
            `[frontend:open] error=${error instanceof Error ? error.message : String(error)}`,
          ).catch(() => {});
          setProjectViewHydrating(false);
          setBusyFeedback(null);
          throw error;
        } finally {
          void appendDebugLog("[frontend:open] cleanup").catch(() => {});
          unlistenProjectProgress?.();
        }
      },
      { busy: true },
    );
  }

  function handleImportSongClick() {
    void runAction(
      async () => {
        let unlistenProjectProgress: (() => void) | null = null;
        setProjectViewHydrating(true);
        setBusyFeedback({
          message: t("transport.shell.importingProject", {
            defaultValue: "Importing project...",
          }),
          percent: 2,
        });
        try {
          unlistenProjectProgress = await registerProjectLoadProgressListener();
          const nextSnapshot = await pickAndImportSong();
          if (!nextSnapshot) {
            setProjectViewHydrating(false);
            setBusyFeedback(null);
            return;
          }

          setBusyFeedback({
            message: t("transport.shell.loadingProjectView", {
              defaultValue: "Loading project view...",
            }),
            percent: 96,
          });
          const nextSong = await refreshSongView({ sync: true });
          applyPlaybackSnapshot(nextSnapshot);
          await refreshLibraryState();
          setActiveSidebarTab(null);
          setStatus(t("transport.status.songImported"));
          if (nextSong) {
            await nextPaint();
            setProjectViewHydrating(false);
          }
        } catch (error) {
          setProjectViewHydrating(false);
          setBusyFeedback(null);
          throw error;
        } finally {
          unlistenProjectProgress?.();
        }
      },
      { busy: true },
    );
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
