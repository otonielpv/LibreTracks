import { useMemo } from "react";

import { getSong, useSongStore } from "../transport/songStore";
import { createLyricsHandlers, type LyricsApi } from "./lyricsHandlers";

/** The lyrics handlers, built once per component. The song is read when an
 * action runs, never captured. */
export function useLyricsHandlers(api?: LyricsApi, onSnapshot?: (snapshot: unknown) => void) {
  return useMemo(
    () =>
      createLyricsHandlers({
        api,
        onSnapshot,
        getRegionLyrics: (regionId) =>
          getSong()?.regions.find((region) => region.id === regionId)?.lyrics ?? null,
        onRegionSaved: (regionId, lyrics) =>
          useSongStore.getState().setSong((song) =>
            song
              ? {
                  ...song,
                  regions: song.regions.map((region) =>
                    region.id === regionId ? { ...region, lyrics } : region,
                  ),
                }
              : song,
          ),
      }),
    [api, onSnapshot],
  );
}
