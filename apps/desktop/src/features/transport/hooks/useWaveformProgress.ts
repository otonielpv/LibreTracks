import { useEffect } from "react";

import {
  isTauriApp,
  listenToWaveformProgress,
  type WaveformSummaryDto,
} from "../desktopApi";

export type UseWaveformProgressOptions = {
  /** Song dir the timeline is currently showing, so events for a session that
   * was closed (or one being loaded in the background) are ignored. */
  playbackSongDir: string | null | undefined;
  setWaveformCache: (
    update: (
      current: Record<string, WaveformSummaryDto>,
    ) => Record<string, WaveformSummaryDto>,
  ) => void;
};

/**
 * Paint waveforms while they are still being analysed.
 *
 * The backend pushes a `waveform:progress` event every ~150 ms per file being
 * analysed, each carrying the peaks completed so far (zero-filled past that
 * point) plus `analyzedSeconds`. Feeding those into the same cache the finished
 * summaries land in means the renderer draws the part that exists and marks the
 * rest as pending — the clip grows instead of sitting on a static
 * "ANALYZING WAVEFORM..." label with no sign of progress.
 *
 * Two orderings have to be safe, because events and the polled
 * `get_waveform_summaries` responses race:
 *  - a progress event arriving AFTER the finished summary must not overwrite it
 *    (a complete summary has no `analyzedSeconds`), and
 *  - progress events arriving out of order must not move the waveform backwards.
 * Both are handled by only accepting an update that covers strictly more than
 * what is already cached.
 */
export function useWaveformProgress({
  playbackSongDir,
  setWaveformCache,
}: UseWaveformProgressOptions) {
  useEffect(() => {
    if (!isTauriApp) {
      return () => {};
    }

    let active = true;
    let unlisten: (() => void) | undefined;

    void listenToWaveformProgress((event) => {
      if (!active) {
        return;
      }
      if (
        playbackSongDir &&
        event.songDir !== playbackSongDir.replace(/\\/g, "/")
      ) {
        return;
      }

      setWaveformCache((current) => {
        const cached = current[event.waveformKey];
        if (cached && cached.analyzedSeconds === undefined) {
          // Already complete — a late progress event must not undo it.
          return current;
        }
        if (
          cached?.analyzedSeconds !== undefined &&
          cached.analyzedSeconds >= event.analyzedSeconds
        ) {
          return current;
        }
        return { ...current, [event.waveformKey]: event.summary };
      });
    }).then((nextUnlisten) => {
      if (!active) {
        nextUnlisten();
        return;
      }
      unlisten = nextUnlisten;
    });

    return () => {
      active = false;
      unlisten?.();
    };
  }, [playbackSongDir, setWaveformCache]);
}
