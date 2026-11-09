import type { TransportSnapshot } from "@libretracks/shared/models";

import {
  importExternalProjectFromPathWithProgress,
  importSongPackageFromPathWithProgress,
  pickAndImportSong,
} from "../desktopApi";
import { formatClock } from "../helpers";
import type { LibraryDragDropDeps } from "./libraryDragDrop";

type SongPackageImportDeps = Pick<
  LibraryDragDropDeps,
  | "t"
  | "setPackageUnpackUiState"
  | "applyPlaybackSnapshot"
  | "refreshLibraryState"
  | "mergeLibraryAssets"
  | "refreshSongView"
  | "setStatus"
  | "formatErrorStatus"
>;

/**
 * Non-blocking song imports (`.ltpkg` and Reaper/Ableton projects) with the
 * "Descomprimiendo paquete…" indicator, library refresh and status line.
 * Split out of `libraryDragDrop.ts`: it only needs these deps, none of the
 * drag state.
 */
export function createSongPackageImport(getDeps: () => SongPackageImportDeps) {
  const deps = getDeps;

  function handleDroppedSongPackagePath(
    packagePath: string,
    dropSeconds: number,
  ) {
    return runSongPackageImportFlow(
      () => importSongPackageFromPathWithProgress(packagePath, dropSeconds),
      dropSeconds,
    );
  }

  // Same flow with the backend's native picker. Mobile goes through here: the
  // WebView dialog hands back a `content://` URI on Android, which the
  // path-based command cannot open ("No such file or directory").
  function pickAndImportSongPackageAt(dropSeconds: number) {
    return runSongPackageImportFlow(
      () => pickAndImportSong(dropSeconds),
      dropSeconds,
    );
  }

  async function runSongPackageImportFlow(
    load: () => Promise<TransportSnapshot | null>,
    dropSeconds: number,
  ) {
    // Non-blocking .ltpkg import for every path-based entry point (compact view
    // picker, compact OS drag, timeline drop from the file explorer). The
    // backend returns as soon as the package is unzipped + the structure is
    // persisted — it no longer waits for source decode — so we do NOT raise the
    // blocking shell overlay. The new tracks appear immediately, waveforms fill
    // in as sources decode, and play is progressive (decoded head audible, rest
    // silent). The user keeps full use of the UI throughout, like the audio
    // import. (Previously this sat behind the busy overlay until every source
    // finished decoding.)
    // Show the non-modal "Descomprimiendo paquete…" indicator for the duration
    // (the percent is fed by the load-progress listener). Cleared in `finally`
    // whether the import succeeds, is cancelled, or throws.
    deps().setPackageUnpackUiState({ active: true, percent: 0 });
    try {
      const snapshot = await load();
      if (!snapshot) {
        return;
      }
      // The backend only emits up to ~50% (decompress + merge); decode of the
      // sources is async and handed off to the "Preparing audio…" indicator. So
      // when the import call resolves the unpack phase is done — show 100% so it
      // doesn't visibly vanish at 40%. The refreshes below give it a frame to
      // paint before `finally` clears it.
      deps().setPackageUnpackUiState({ active: true, percent: 100 });
      deps().applyPlaybackSnapshot(snapshot);
      const refreshedAssets = await deps().refreshLibraryState();
      deps().mergeLibraryAssets(refreshedAssets);
      await deps().refreshSongView();
      deps().setStatus(
        deps().t("transport.status.packageImportedAt", {
          time: formatClock(dropSeconds),
        }),
      );
    } catch (error) {
      deps().setStatus(deps().formatErrorStatus(error));
    } finally {
      deps().setPackageUnpackUiState({ active: false, percent: 0 });
    }
  }

  // A Reaper/Ableton project dropped on the timeline from the OS file explorer.
  // Mirrors handleDroppedSongPackagePath (non-blocking, progress in the status
  // bar). The backend lands it at dropSeconds unless that overlaps an existing
  // song, in which case it appends after the setlist.
  async function handleDroppedExternalProjectPath(
    projectPath: string,
    dropSeconds: number,
  ) {
    deps().setPackageUnpackUiState({ active: true, percent: 0 });
    try {
      const snapshot = await importExternalProjectFromPathWithProgress(
        projectPath,
        dropSeconds,
      );
      if (!snapshot) {
        return;
      }
      deps().setPackageUnpackUiState({ active: true, percent: 100 });
      deps().applyPlaybackSnapshot(snapshot);
      const refreshedAssets = await deps().refreshLibraryState();
      deps().mergeLibraryAssets(refreshedAssets);
      await deps().refreshSongView({ sync: true });
      deps().setStatus(
        deps().t("transport.status.externalProjectImportedAt", {
          time: formatClock(dropSeconds),
          defaultValue: "Proyecto Reaper/Ableton importado en {{time}}.",
        }),
      );
    } catch (error) {
      deps().setStatus(deps().formatErrorStatus(error));
    } finally {
      deps().setPackageUnpackUiState({ active: false, percent: 0 });
    }
  }

  return {
    handleDroppedSongPackagePath,
    pickAndImportSongPackageAt,
    handleDroppedExternalProjectPath,
  };
}
