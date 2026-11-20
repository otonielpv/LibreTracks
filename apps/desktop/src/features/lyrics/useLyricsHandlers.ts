import { useMemo } from "react";

import { getSong } from "../transport/songStore";
import { createLyricsHandlers, type LyricsApi } from "./lyricsHandlers";

/** The lyrics handlers, built once per component. The song is read when an
 * action runs, never captured. */
export function useLyricsHandlers(api?: LyricsApi) {
  return useMemo(
    () =>
      createLyricsHandlers({
        api,
        getRegionLyrics: (regionId) =>
          getSong()?.regions.find((region) => region.id === regionId)?.lyrics ?? null,
      }),
    [api],
  );
}
