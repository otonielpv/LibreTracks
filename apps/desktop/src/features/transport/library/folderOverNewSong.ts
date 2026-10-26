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
