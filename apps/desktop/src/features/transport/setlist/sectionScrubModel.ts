import type { SongRegionSummary, SongView } from "@libretracks/shared/models";

import { barSecondsAtFor } from "./songMapModel";

const EPSILON_SECONDS = 1e-3;

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
