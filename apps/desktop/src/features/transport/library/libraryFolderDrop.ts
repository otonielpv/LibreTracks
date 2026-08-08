import {
  type LibraryAssetSummary,
  type SongView,
  type TransportSnapshot,
} from "@libretracks/shared/models";

import { alertDialog } from "../../../shared/dialog/dialogService";
import { createSongRegion, getSongView, updateSongRegion } from "../desktopApi";
import {
  findOverlappingSongs,
  resolveFolderSongDurationSeconds,
} from "./dragDrop";
import type { LibraryAssetDragPayload, LibraryDropLayout } from "../types";

/** Width given to the song created from an empty library folder. A zero-width
 * region would be invisible in the DAW view; this gives it something to grab
 * and resize, like the empty song the compact view's "+" button creates. */
const EMPTY_SONG_FALLBACK_SECONDS = 2;

export type LibraryFolderDropDeps = {
  t: (key: string, options?: Record<string, unknown>) => string;
  getSong: () => SongView | null;
  resolveAsset: (
    filePath: string,
    durationSeconds: number,
  ) => LibraryAssetSummary;
  placeAssets: (args: {
    payload: LibraryAssetDragPayload[];
    timelineStartSeconds: number;
    targetTrackId: string | null;
    layout: LibraryDropLayout;
  }) => Promise<void>;
  applyPlaybackSnapshot: (snapshot: TransportSnapshot | null) => void;
  refreshSongView: (options?: { sync?: boolean }) => Promise<unknown>;
  setStatus: (message: string) => void;
};

/**
 * Drop of a whole library folder onto the timeline: lay down every asset it
 * holds and wrap them in a song named after the folder. This backs the
 * "organise in the library first, then build the setlist" workflow — one
 * folder becomes one song, in one gesture.
 *
 * Dropping over an existing song is rejected rather than merged. Merging would
 * silently contradict the one-folder-one-song promise, and afterwards the user
 * has no way to tell which tracks came from where — so we stop before touching
 * anything and say why in a modal. The status bar alone is easy to miss on a
 * wide window (the same reason the rejected-audio-drop path grew an alert).
 */
export async function placeLibraryFolderOnTimeline(
  deps: LibraryFolderDropDeps,
  args: {
    payload: LibraryAssetDragPayload[];
    folderName: string;
    timelineStartSeconds: number;
    layout: LibraryDropLayout;
  },
) {
  const assets = args.payload.map((item) =>
    deps.resolveAsset(item.file_path, item.durationSeconds),
  );
  const contentDurationSeconds = resolveFolderSongDurationSeconds(
    assets.map((asset) => asset.durationSeconds),
    args.layout,
  );

  // An empty folder still becomes a song — a named, empty container to fill
  // later — but a zero-width region would be invisible, hence the fallback.
  const songDurationSeconds =
    contentDurationSeconds || EMPTY_SONG_FALLBACK_SECONDS;
  const endSeconds = args.timelineStartSeconds + songDurationSeconds;

  // The whole span has to be free, not just the drop point: a folder dropped
  // in a gap too short for its audio would otherwise run straight through the
  // next song. Edges may touch, so dropping flush against the end of a song is
  // allowed whenever the gap that follows is wide enough.
  const collisions = findOverlappingSongs(
    deps.getSong()?.regions ?? [],
    args.timelineStartSeconds,
    endSeconds,
  );
  if (collisions.length) {
    await alertDialog(
      deps.t("transport.alert.folderDropOverSong", {
        folder: args.folderName,
        song: collisions.map((region) => region.name).join(", "),
        count: collisions.length,
        seconds: Math.ceil(songDurationSeconds),
      }),
    );
    return;
  }

  if (assets.length) {
    await deps.placeAssets({
      payload: args.payload,
      timelineStartSeconds: args.timelineStartSeconds,
      // Always land on fresh tracks: reusing whatever track happened to sit
      // under the cursor would scatter the folder across unrelated tracks.
      targetTrackId: null,
      layout: args.layout,
    });
  }

  deps.applyPlaybackSnapshot(
    await createSongRegion(args.timelineStartSeconds, endSeconds),
  );

  // create_song_region only takes a range, so the name lands in a second call.
  const createdRegion = (await getSongView())?.regions.find(
    (region) => Math.abs(region.startSeconds - args.timelineStartSeconds) < 1e-6,
  );
  if (createdRegion) {
    deps.applyPlaybackSnapshot(
      await updateSongRegion(
        createdRegion.id,
        args.folderName,
        createdRegion.startSeconds,
        createdRegion.endSeconds,
      ),
    );
  }

  await deps.refreshSongView({ sync: true });
  deps.setStatus(
    deps.t("transport.status.folderSongCreated", {
      name: args.folderName,
      count: assets.length,
    }),
  );
}
