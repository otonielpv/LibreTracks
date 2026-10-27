import { getEffectiveBpmAt, type SongRegionSummary, type SongView } from "@libretracks/shared/models";

import { getBeatDurationSeconds, parseTimeSignature } from "../timeline/timelineMath";
import { barSecondsAtFor } from "./songMapModel";

const EPSILON_SECONDS = 1e-3;

export type BarGridTick = {
  seconds: number;
  barIndex: number;
  kind: "bar" | "beat" | "subdivision";
};

/** The downbeat of every bar of the song, from its start (tempo and meter
 * changes included: each bar is as long as the tempo in force says). */
export function barStartsInSong(
  song: SongView,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
): number[] {
  const barSecondsAt = barSecondsAtFor(song);
  const bars: number[] = [];
  let seconds = region.startSeconds;
  while (seconds < region.endSeconds - EPSILON_SECONDS && bars.length < 4000) {
    bars.push(seconds);
    const step = barSecondsAt(seconds);
    if (!(step > 0)) break;
    seconds += step;
  }
  return bars;
}

/** Bar lines plus beat subdivisions when the available zoom makes them legible. */
export function barGridTicksInSong(
  song: SongView,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
  widthPx: number,
): BarGridTick[] {
  const bars = barStartsInSong(song, region);
  const duration = Math.max(EPSILON_SECONDS, region.endSeconds - region.startSeconds);
  const ticks: BarGridTick[] = [];

  for (let barIndex = 0; barIndex < bars.length; barIndex += 1) {
    const start = bars[barIndex];
    const end = bars[barIndex + 1] ?? region.endSeconds;
    ticks.push({ seconds: start, barIndex, kind: "bar" });

    let signature = song.timeSignature;
    for (const marker of song.timeSignatureMarkers ?? []) {
      if (marker.startSeconds > start + EPSILON_SECONDS) break;
      signature = marker.signature;
    }
    const beatsPerBar = parseTimeSignature(signature).beatsPerBar;
    const beatDuration = getBeatDurationSeconds(getEffectiveBpmAt(song, start), signature);
    const beatWidth = (widthPx * beatDuration) / duration;
    const subdivisionsPerBeat =
      beatWidth >= 48 ? 4 : beatWidth >= 24 ? 2 : beatWidth >= 15 ? 1 : 0;
    if (subdivisionsPerBeat === 0 || !(beatDuration > 0)) continue;

    const subdivisionCount = beatsPerBar * subdivisionsPerBeat;
    for (let subdivision = 1; subdivision < subdivisionCount; subdivision += 1) {
      const seconds = start + (subdivision * beatDuration) / subdivisionsPerBeat;
      if (seconds >= end - EPSILON_SECONDS) break;
      ticks.push({
        seconds,
        barIndex,
        kind: subdivision % subdivisionsPerBeat === 0 ? "beat" : "subdivision",
      });
    }
  }

  return ticks;
}

/** Snap a manual seek to the nearest bar when grid snapping is enabled. */
export function snapSecondsToSongBar(
  song: SongView,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
  seconds: number,
): number {
  const bars = barStartsInSong(song, region);
  return bars[nearestBarIndex(bars, seconds)] ?? seconds;
}

export function resolveSongSeekSeconds(
  song: SongView,
  region: Pick<SongRegionSummary, "startSeconds" | "endSeconds">,
  seconds: number,
  snapEnabled: boolean,
): number {
  return snapEnabled ? snapSecondsToSongBar(song, region, seconds) : seconds;
}

/** The bar a moment is on: the nearest downbeat, or with `floor` the bar it
 * falls in (what the bar counter shows). */
export function nearestBarIndex(
  bars: readonly number[],
  seconds: number,
  options: { floor?: boolean } = {},
): number {
  if (bars.length === 0) return 0;
  let index = 0;
  while (index + 1 < bars.length && bars[index + 1] <= seconds + EPSILON_SECONDS) index += 1;
  if (options.floor || index + 1 >= bars.length) return index;
  return seconds - bars[index] > bars[index + 1] - seconds ? index + 1 : index;
}

/** The downbeat one bar before or after a moment (the next one strictly
 * past it), or null past the song's edges. */
export function stepBar(bars: readonly number[], seconds: number, direction: -1 | 1): number | null {
  if (direction === 1) {
    return bars.find((bar) => bar > seconds + EPSILON_SECONDS) ?? null;
  }
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (bars[index] < seconds - EPSILON_SECONDS) return bars[index];
  }
  return null;
}
