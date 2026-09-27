/**
 * Latency calibration by tapping (paso 09 del plan de vídeo).
 *
 * The output flashes on every beat while the metronome clicks. The user taps
 * ten times on what they SEE and ten times on what they HEAR. Each tap is
 * reduced to its phase against the nearest beat; the difference between the
 * two averages is how much later the picture arrives than the sound. Humans
 * tap with a bias, but the same bias on both series, so it cancels out.
 */

/** Signed distance from `time` to the nearest beat, in seconds, within
 * ±interval/2. Beats are at `phase + k·interval`. */
export function beatPhase(time: number, interval: number, phase = 0): number {
  if (!(interval > 0)) return 0;
  const relative = (time - phase) / interval;
  return (relative - Math.round(relative)) * interval;
}

/** Mean after dropping the `trim` fraction of samples furthest from the
 * median (the worst 20 % by default: a missed or double tap). */
export function trimmedMean(values: number[], trim = 0.2): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const keep = Math.max(1, Math.round(values.length * (1 - trim)));
  const closest = [...values]
    .sort((a, b) => Math.abs(a - median) - Math.abs(b - median))
    .slice(0, keep);
  return closest.reduce((sum, value) => sum + value, 0) / closest.length;
}

export type TapCalibration = {
  /** How much later the picture is seen than the click is heard, in ms.
   * Positive: the picture lags (raise the offset to show it earlier). */
  pictureLagMs: number;
  /** Offset to use: the current one plus the measured lag, clamped. */
  suggestedOffsetMs: number;
};

export const MIN_OFFSET_MS = -500;
export const MAX_OFFSET_MS = 500;

/**
 * Estimate from taps taken while the flash and the click both run on the
 * same beat grid (`interval` seconds, first beat at `phase`). Needs at least
 * three taps of each kind.
 */
export function estimateFromTaps(args: {
  flashTaps: number[];
  clickTaps: number[];
  interval: number;
  phase?: number;
  currentOffsetMs: number;
}): TapCalibration | null {
  const { flashTaps, clickTaps, interval, phase = 0, currentOffsetMs } = args;
  if (flashTaps.length < 3 || clickTaps.length < 3) return null;
  const seen = trimmedMean(flashTaps.map((tap) => beatPhase(tap, interval, phase)));
  const heard = trimmedMean(clickTaps.map((tap) => beatPhase(tap, interval, phase)));
  if (seen === null || heard === null) return null;
  const pictureLagMs = Math.round((seen - heard) * 1000);
  return {
    pictureLagMs,
    suggestedOffsetMs: Math.min(
      MAX_OFFSET_MS,
      Math.max(MIN_OFFSET_MS, currentOffsetMs + pictureLagMs),
    ),
  };
}
