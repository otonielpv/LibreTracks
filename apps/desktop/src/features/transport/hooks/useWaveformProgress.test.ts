import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { WaveformProgressEvent, WaveformSummaryDto } from "../desktopApi";
import { useWaveformProgress } from "./useWaveformProgress";

let emit: ((event: WaveformProgressEvent) => void) | undefined;

vi.mock("../desktopApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../desktopApi")>();
  return {
    ...actual,
    isTauriApp: true,
    listenToWaveformProgress: async (
      handler: (event: WaveformProgressEvent) => void,
    ) => {
      emit = handler;
      return () => {
        emit = undefined;
      };
    },
  };
});

function summary(analyzedSeconds?: number): WaveformSummaryDto {
  return {
    waveformKey: "audio/lead.wav",
    version: 1,
    durationSeconds: 30,
    sampleRate: 48_000,
    lods: [],
    ...(analyzedSeconds === undefined ? {} : { analyzedSeconds }),
  };
}

function progressEvent(analyzedSeconds: number): WaveformProgressEvent {
  return {
    songDir: "D:/sessions/demo",
    waveformKey: "audio/lead.wav",
    analyzedSeconds,
    durationSeconds: 30,
    summary: summary(analyzedSeconds),
  };
}

/** Drives the hook and reports what the cache ends up holding. */
async function mountHook(initial: Record<string, WaveformSummaryDto> = {}) {
  let cache = initial;
  const setWaveformCache = (
    update: (
      current: Record<string, WaveformSummaryDto>,
    ) => Record<string, WaveformSummaryDto>,
  ) => {
    cache = update(cache);
  };

  renderHook(() =>
    useWaveformProgress({
      playbackSongDir: "D:\\sessions\\demo",
      setWaveformCache,
    }),
  );
  await waitFor(() => expect(emit).toBeDefined());

  return {
    emit: (event: WaveformProgressEvent) => emit?.(event),
    get cached() {
      return cache["audio/lead.wav"];
    },
  };
}

describe("useWaveformProgress", () => {
  it("feeds partial waveforms into the cache as they arrive", async () => {
    const harness = await mountHook();

    harness.emit(progressEvent(5));
    expect(harness.cached?.analyzedSeconds).toBe(5);

    harness.emit(progressEvent(18));
    expect(harness.cached?.analyzedSeconds).toBe(18);
  });

  // Progress events and the polled get_waveform_summaries response race, so a
  // stale progress event can land after the finished summary. Overwriting it
  // would drop the clip back to a partial waveform after it was already
  // complete — visibly going backwards.
  it("never overwrites a summary that is already complete", async () => {
    const harness = await mountHook({ "audio/lead.wav": summary() });

    harness.emit(progressEvent(12));

    expect(harness.cached?.analyzedSeconds).toBeUndefined();
  });

  it("ignores progress that covers less than what is cached", async () => {
    const harness = await mountHook();

    harness.emit(progressEvent(18));
    harness.emit(progressEvent(5));

    expect(harness.cached?.analyzedSeconds).toBe(18);
  });

  // Events carry the song dir they belong to; one for a session the timeline is
  // not showing (a background load, or a session just closed) must be dropped
  // rather than painted onto whatever clip happens to share the key.
  it("drops events from a different song dir", async () => {
    const harness = await mountHook();

    harness.emit({ ...progressEvent(9), songDir: "D:/sessions/other" });

    expect(harness.cached).toBeUndefined();
  });
});
