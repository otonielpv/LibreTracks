import type { MutableRefObject } from "react";
import type { LibraryAssetSummary, TransportSnapshot } from "@libretracks/shared/models";
import {
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
  refreshSongView: (options?: { sync?: boolean }) => Promise<unknown>;
  refreshLibraryState: (options?: {
    preserveAssets?: LibraryAssetSummary[];
  }) => Promise<LibraryAssetSummary[]>;
  t: (key: string, options?: Record<string, unknown>) => string;
  setStatus: (status: string) => void;
  setActiveSidebarTab: (tab: SidebarTab | null) => void;
  snapshotRef: MutableRefObject<TransportSnapshot | null>;
};

export function useProjectActions({
  runAction,
  applyPlaybackSnapshot,
  setProjectViewHydrating,
  refreshSongView,
  refreshLibraryState,
  t,
  setStatus,
  setActiveSidebarTab,
  snapshotRef,
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
        setProjectViewHydrating(true);
        try {
          // openProject() returns only after the backend has finished decoding
          // all sources AND prearmed Bungee voices — see
          // wait_for_project_audio_preparation in state.rs. So by the time we
          // continue, the engine is ready to Play instantly.
          const nextSnapshot = (await openProject()) ?? snapshotRef.current;
          const nextSong = await refreshSongView({ sync: true });
          applyPlaybackSnapshot(nextSnapshot);
          setActiveSidebarTab(null);
          if (nextSong) {
            // Wait two animation frames so React commits the new SongView and
            // paints the tracks before we tear down the loading overlay —
            // prevents the 1-2s flash of an empty timeline between the
            // overlay closing and the tracks appearing.
            await nextPaint();
            setProjectViewHydrating(false);
          }
        } catch (error) {
          setProjectViewHydrating(false);
          throw error;
        }
      },
      { busy: true },
    );
  }

  function handleImportSongClick() {
    void runAction(
      async () => {
        setProjectViewHydrating(true);
        try {
          const nextSnapshot = await pickAndImportSong();
          if (!nextSnapshot) {
            setProjectViewHydrating(false);
            return;
          }

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
          throw error;
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
