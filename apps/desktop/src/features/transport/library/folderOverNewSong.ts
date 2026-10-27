import type { SongView } from "@libretracks/shared/models";

import type { LibraryAssetDragPayload, LibraryDropLayout } from "../types";
import { resolveFolderSongAnchorSeconds } from "./libraryPlacement";

/**
 * A library FOLDER dropped over «+ New song» (Setlist): the folder becomes a
 * new song at the end of the project, named after the folder, its audio on
 * fresh tracks (what the library menu's «folder as a song» does). A single
 * file there has no name to give the song, so it is not a target. True when
 * the drop was taken.
 */
export function dropFolderOverNewSong(
  element: Element | null | undefined,
  folderName: string | null | undefined,
  payload: LibraryAssetDragPayload[],
  song: SongView | null,
  dropFolder: (args: {
    payload: LibraryAssetDragPayload[];
    folderName: string;
    timelineStartSeconds: number;
    layout: LibraryDropLayout;
  }) => Promise<void>,
  runAction: (action: () => Promise<void>) => unknown,
): boolean {
  if (folderName == null || !element?.closest(".lt-setlist-add-song")) return false;
  void runAction(() =>
    dropFolder({
      payload,
      folderName,
      timelineStartSeconds: song ? resolveFolderSongAnchorSeconds(song) : 0,
      layout: "vertical",
    }),
  );
  return true;
}

/**
 * While a library folder is dragged: the «+ New song» tile under the pointer
 * says what the drop will do («Create "<folder>"»), on both libraries. Written
 * to the tile's data attribute (CSS draws it): no state, no render per move.
 * With no folder (or off the tile) it clears it.
 */
export function previewNewSongDrop(
  element: Element | null | undefined,
  folderName: string | null | undefined,
  t: (key: string, options?: Record<string, unknown>) => string,
) {
  const tile = folderName != null ? element?.closest<HTMLElement>(".lt-setlist-add-song") : null;
  for (const lit of document.querySelectorAll<HTMLElement>(".lt-setlist-add-song[data-drop-label]")) {
    if (lit !== tile) delete lit.dataset.dropLabel;
  }
  if (tile && folderName != null) tile.dataset.dropLabel = t("setlistView.songs.createFromFolder", { name: folderName });
}
