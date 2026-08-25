import { useEffect } from "react";

import type { SongView } from "@libretracks/shared/models";

import {
  getWaveformSummaries,
  type WaveformSummaryDto,
} from "../desktopApi";

/** Max waveform summaries requested per round-trip. */
const WAVEFORM_REQUEST_BATCH_SIZE = 4;
/**
 * Cap the polling so a genuinely ungeneratable source can't spin forever.
 * With the backoff below, 30 fruitless ticks is a little over a minute — more
 * headroom than the old flat 600 ms × 50 (~30 s), which a large multitrack on a
 * slow disk could genuinely outlast.
 */
const MAX_POLL_ATTEMPTS = 30;

/** First retry delay, and the ceiling the backoff climbs to. */
const POLL_INTERVAL_MS = 600;
const MAX_POLL_INTERVAL_MS = 2_400;

/**
 * Back off while nothing is landing.
 *
 * Every request takes the backend's session lock, and a 25-stem import means
 * seven round-trips per tick for the ~30 s the analysis runs — all of it
 * competing with the transport snapshot that moves the playhead. The waveforms
 * themselves now arrive over `waveform:progress` / `waveform:ready` as they are
 * produced, so this poll is only the safety net for the events being missed
 * (which they can be right after an import, before the frontend knows the new
 * songDir). A net does not need to be checked four times a second.
 *
 * Ticks that DID bring something back reset to the fast interval, so an import
 * still fills in briskly.
 */
function pollDelayMs(consecutiveEmptyPolls: number) {
  return Math.min(
    MAX_POLL_INTERVAL_MS,
    POLL_INTERVAL_MS * 2 ** Math.max(0, consecutiveEmptyPolls - 1),
  );
}

export type UseSongWaveformsOptions = {
  song: SongView | null;
  setWaveformCache: (
    update: (
      current: Record<string, WaveformSummaryDto>,
    ) => Record<string, WaveformSummaryDto>,
  ) => void;
};

/**
 * Drives every waveform this song's clips need to completion.
 *
 * IMPORTANT — this hook deliberately depends on `song` ONLY, never on
 * `waveformCache`. Depending on the cache while also calling `setWaveformCache`
 * inside restarted the effect mid-flight, so two overlapping runs raced on the
 * functional state update and whole batches were dropped (the "only the last N
 * waveforms appear" bug). Instead a single run owns the work start to finish:
 * it requests in batches and polls for keys still being generated in the
 * background, because the live `waveform:ready` event is unreliable right after
 * an import — it can fire before the frontend knows the new session's songDir.
 */
export function useSongWaveforms({
  song,
  setWaveformCache,
}: UseSongWaveformsOptions) {
  useEffect(() => {
    if (!song) {
      return () => {};
    }

    let active = true;

    // Distinct source keys this song needs a waveform for.
    const clipKeys = song.clips
      .map((clip) => clip.waveformKey)
      .filter((waveformKey, index, keys) => keys.indexOf(waveformKey) === index);

    // Seed with waveforms the song already carries (embedded summaries from the
    // snapshot) so we don't re-request those.
    const resolved = new Set<string>(
      (song.waveforms ?? []).map((summary) => summary.waveformKey),
    );
    let pollAttempts = 0;

    async function drainWaveforms() {
      while (active) {
        const missing = clipKeys.filter((key) => !resolved.has(key));
        if (!missing.length) {
          return;
        }

        let progressed = false;
        // Walk the whole missing set in batches in THIS pass.
        for (let i = 0; i < missing.length; i += WAVEFORM_REQUEST_BATCH_SIZE) {
          if (!active) {
            return;
          }
          const batchKeys = missing.slice(i, i + WAVEFORM_REQUEST_BATCH_SIZE);
          const summaries = await getWaveformSummaries(batchKeys);
          if (!active) {
            return;
          }
          if (summaries.length) {
            progressed = true;
            for (const summary of summaries) {
              resolved.add(summary.waveformKey);
            }
            setWaveformCache((current) => ({
              ...current,
              ...Object.fromEntries(
                summaries.map((summary) => [summary.waveformKey, summary]),
              ),
            }));
          }
        }

        // Everything resolved this pass? Done.
        if (clipKeys.every((key) => resolved.has(key))) {
          return;
        }
        // Some keys are still being generated in the background. Wait, then
        // re-request only the ones we don't have yet. If nothing progressed for
        // too many consecutive polls, give up (likely an ungeneratable source).
        if (!progressed) {
          pollAttempts += 1;
          if (pollAttempts >= MAX_POLL_ATTEMPTS) {
            return;
          }
        } else {
          pollAttempts = 0;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, pollDelayMs(pollAttempts)),
        );
      }
    }

    void drainWaveforms();

    return () => {
      active = false;
    };
    // Cache is intentionally absent from the deps — see the note above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song]);
}
