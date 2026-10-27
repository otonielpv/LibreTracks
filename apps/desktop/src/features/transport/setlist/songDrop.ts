import type { DragEvent as ReactDragEvent } from "react";

import { LIBRARY_ASSET_DRAG_MIME } from "../library/dragDrop";
import type { SongViewBindings } from "../songs/songViewBindings";

/**
 * Class + `data-region-id` that make an element a "drop into this song"
 * target for the app's own drag pipeline (library/libraryDragDrop: native OS
 * drops under Tauri and the library's pointer drag). The HTML5 handlers
 * below cover the browser path.
 */
export const SONG_DROP_CLASS = "lt-setlist-song-drop";

type SongDropDeps = Pick<SongViewBindings, "onDropOsFilesIntoSong" | "onDropLibraryAssetsIntoSong">;

/**
 * HTML5 drop handlers that put audio into a song: library assets (the
 * library's own MIME) or files from the OS. A `.ltpkg` is not audio for a
 * song (it is a new song): it is left to bubble to the song row.
 */
export function songDropHandlers(regionId: string, deps: SongDropDeps) {
  return {
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const types = Array.from(event.dataTransfer.types ?? []);
      if (types.includes(LIBRARY_ASSET_DRAG_MIME)) {
        event.preventDefault();
        event.stopPropagation();
        try {
          const payload = JSON.parse(event.dataTransfer.getData(LIBRARY_ASSET_DRAG_MIME)) as Array<{
            file_path: string;
            durationSeconds?: number;
          }>;
          if (payload.length > 0) {
            deps.onDropLibraryAssetsIntoSong(
              regionId,
              payload.map((item) => ({ filePath: item.file_path, durationSeconds: item.durationSeconds })),
            );
          }
        } catch {
          // Malformed payload: ignore the drop.
        }
        return;
      }
      const files = Array.from(event.dataTransfer.files ?? []);
      if (files.length === 0 || files.some((file) => /\.ltpkg$/i.test(file.name))) return;
      event.preventDefault();
      event.stopPropagation();
      deps.onDropOsFilesIntoSong(regionId, files);
    },
  };
}
