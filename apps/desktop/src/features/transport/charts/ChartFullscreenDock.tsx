import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { runRegisteredShortcut } from "../keyboard/shortcutRunnerStore";
import { useTransportStore } from "../store";
import { useNetworkPermissions } from "../../network/useNetworkPermissions";

/** How often the playing song is looked up from the playhead. */
const PLAYING_POLL_MS = 400;

export type ChartSongsControls = {
  /** Show this song's lyrics (the view's own selection). */
  onSelectSong: (regionId: string) => void;
  /** Go to this song and play it (the view's own song action). */
  onPlaySong?: (region: SongRegionSummary) => void;
};

type ChartFullscreenDockProps = ChartSongsControls & {
  song: SongView;
  /** The song whose lyrics are shown. */
  region: SongRegionSummary | null;
  positionSecondsRef: { readonly current: number };
};

/** The song the playhead is in, polled: never subscribes React to 60 fps. */
function usePlayingRegionId(
  regions: readonly SongRegionSummary[],
  positionSecondsRef: { readonly current: number },
): string | null {
  const find = () => {
    const seconds = positionSecondsRef.current;
    return regions.find((region) => seconds >= region.startSeconds && seconds < region.endSeconds)?.id ?? null;
  };
  const [playingId, setPlayingId] = useState<string | null>(find);
  useEffect(() => {
    const tick = () => setPlayingId(find());
    tick();
    const id = window.setInterval(tick, PLAYING_POLL_MS);
    return () => window.clearInterval(id);
    // `find` reads the regions of this render; the timer restarts with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regions, positionSecondsRef]);
  return playingId;
}

/**
 * Lyrics full screen: play, stop, the song before and after, and the setlist
 * to pick another song's lyrics, so the screen is not only words. Upright or
 * on its side: full screen covers the transport bar either way.
 */
export function ChartFullscreenDock({ song, region, positionSecondsRef, onSelectSong, onPlaySong }: ChartFullscreenDockProps) {
  const { t } = useTranslation();
  const { canControl } = useNetworkPermissions();
  const playing = useTransportStore((state) => state.playback?.playbackState === "playing");
  const [listOpen, setListOpen] = useState(false);
  const regions = useMemo(
    () => [...song.regions].sort((left, right) => left.startSeconds - right.startSeconds),
    [song.regions],
  );
  const playingId = usePlayingRegionId(regions, positionSecondsRef);
  const shownIndex = region ? regions.findIndex((candidate) => candidate.id === region.id) : -1;
  const previous = shownIndex > 0 ? regions[shownIndex - 1] : null;
  const next = shownIndex >= 0 && shownIndex < regions.length - 1 ? regions[shownIndex + 1] : null;

  const select = (regionId: string) => {
    onSelectSong(regionId);
    setListOpen(false);
  };

  return (
    <div className="lt-chart-dock">
      {listOpen ? (
        <ul className="lt-chart-dock-songs" aria-label={t("liveChart.dock.songs")}>
          {regions.map((candidate, index) => {
            const isShown = candidate.id === region?.id;
            const isPlaying = candidate.id === playingId;
            return (
              <li key={candidate.id} className={`${isShown ? "is-shown" : ""}${isPlaying ? " is-playing" : ""}`}>
                <button
                  type="button"
                  className="lt-chart-dock-song"
                  aria-current={isShown ? "true" : undefined}
                  onClick={() => select(candidate.id)}
                >
                  <span className="lt-chart-dock-song-index">{index + 1}</span>
                  <span className="lt-chart-dock-song-name">{candidate.name}</span>
                  {isPlaying ? (
                    <span
                      className="material-symbols-outlined lt-chart-dock-song-live"
                      role="img"
                      aria-label={t("liveChart.dock.nowPlaying")}
                    >
                      graphic_eq
                    </span>
                  ) : null}
                </button>
                {onPlaySong && canControl ? (
                  <button
                    type="button"
                    className="lt-chart-dock-song-play"
                    onClick={() => {
                      onPlaySong(candidate);
                      select(candidate.id);
                    }}
                    aria-label={t("liveChart.dock.playSong", { song: candidate.name })}
                    title={t("liveChart.dock.playSong", { song: candidate.name })}
                  >
                    <span className="material-symbols-outlined" aria-hidden="true">play_circle</span>
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="lt-chart-dock-bar lt-bottom-controls" role="toolbar" aria-label={t("liveChart.dock.controls")}>
        <button
          type="button"
          className={`lt-icon-button${listOpen ? " is-active" : ""}`}
          aria-pressed={listOpen}
          aria-expanded={listOpen}
          onClick={() => setListOpen((open) => !open)}
          aria-label={t("liveChart.dock.songs")}
          title={t("liveChart.dock.songs")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">queue_music</span>
        </button>
        <button
          type="button"
          className="lt-icon-button"
          disabled={!previous}
          onClick={() => previous && select(previous.id)}
          aria-label={t("liveChart.dock.previousSong")}
          title={t("liveChart.dock.previousSong")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">skip_previous</span>
        </button>
        <button
          type="button"
          className={`lt-icon-button lt-chart-dock-play${playing ? " is-active" : ""}`}
          disabled={!canControl}
          onClick={() => runRegisteredShortcut("transport.playPause")}
          aria-label={t(playing ? "liveChart.dock.pause" : "liveChart.dock.play")}
          title={t(playing ? "liveChart.dock.pause" : "liveChart.dock.play")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">{playing ? "pause" : "play_arrow"}</span>
        </button>
        <button
          type="button"
          className="lt-icon-button"
          disabled={!canControl}
          onClick={() => runRegisteredShortcut("transport.stop")}
          aria-label={t("liveChart.dock.stop")}
          title={t("liveChart.dock.stop")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">stop</span>
        </button>
        <button
          type="button"
          className="lt-icon-button"
          disabled={!next}
          onClick={() => next && select(next.id)}
          aria-label={t("liveChart.dock.nextSong")}
          title={t("liveChart.dock.nextSong")}
        >
          <span className="material-symbols-outlined" aria-hidden="true">skip_next</span>
        </button>
      </div>
    </div>
  );
}
