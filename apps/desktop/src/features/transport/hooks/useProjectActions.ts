import type { MutableRefObject } from "react";
import type { LibraryAssetSummary, TransportSnapshot } from "@libretracks/shared/models";
import {
  createSong,
  openProject,
  pickAndImportSong,
  saveProject,
  saveProjectAs,
} from "../desktopApi";
import type { SidebarTab } from "../types";

type UseProjectActionsProps = {
  runAction: (
    work: () => Promise<void>,
    options?: { busy?: boolean },
  ) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
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
        const nextSnapshot = (await openProject()) ?? snapshotRef.current;
        applyPlaybackSnapshot(nextSnapshot);
        setActiveSidebarTab(null);
      },
      { busy: true },
    );
  }

  function handleImportSongClick() {
    void runAction(
      async () => {
        const nextSnapshot = await pickAndImportSong();
        if (!nextSnapshot) {
          return;
        }

        applyPlaybackSnapshot(nextSnapshot);
        await refreshLibraryState();
        setActiveSidebarTab(null);
        setStatus(t("transport.status.songImported"));
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
