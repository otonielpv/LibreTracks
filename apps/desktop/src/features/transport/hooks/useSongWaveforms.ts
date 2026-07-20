import { useEffect } from "react";

import type { SongView } from "@libretracks/shared/models";

import {
  getWaveformSummaries,
  type WaveformSummaryDto,
} from "../desktopApi";

/** Max waveform summaries requested per round-trip. */
const WAVEFORM_REQUEST_BATCH_SIZE = 4;
/**
 * Generation after a decode is quick; cap the polling so a genuinely
 * ungeneratable source can't spin forever (~30s of 600ms ticks).
 */
const MAX_POLL_ATTEMPTS = 50;

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
        await new Promise((resolve) => setTimeout(resolve, 600));
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
