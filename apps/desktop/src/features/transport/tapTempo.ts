const TAP_TEMPO_RESET_MS = 2500;
const TAP_TEMPO_MAX_TAPS = 8;

/**
 * Append `nowMs` to the running tap list, resetting it if the gap since the last
 * tap exceeded the reset window, and cap the history at TAP_TEMPO_MAX_TAPS.
 */
export function nextTapTempoTimes(
  previousTapTimesMs: readonly number[],
  nowMs: number,
) {
  const previousTapMs = previousTapTimesMs.at(-1);
  const activeTapTimes =
    typeof previousTapMs === "number" &&
    nowMs - previousTapMs <= TAP_TEMPO_RESET_MS
      ? [...previousTapTimesMs, nowMs]
      : [nowMs];

  return activeTapTimes.slice(-TAP_TEMPO_MAX_TAPS);
}

/**
 * Derive a BPM from tap timestamps by averaging the positive inter-tap
 * intervals. Returns null until there are at least two usable taps.
 */
export function calculateTapTempoBpm(tapTimesMs: readonly number[]) {
  if (tapTimesMs.length < 2) {
    return null;
  }

  const intervalsMs = tapTimesMs
    .slice(1)
    .map((tapMs, index) => tapMs - tapTimesMs[index])
    .filter((intervalMs) => intervalMs > 0);

  if (intervalsMs.length === 0) {
    return null;
  }

  const averageIntervalMs =
    intervalsMs.reduce((totalMs, intervalMs) => totalMs + intervalMs, 0) /
    intervalsMs.length;

  return 60_000 / averageIntervalMs;
}
