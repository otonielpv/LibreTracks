export const METER_MIN_DB = -60;
export const METER_MAX_DB = 6;
export const METER_CLIP_THRESHOLD = 1;
export const METER_CLIP_HOLD_MS = 220;
export const METER_ACTIVE_EPSILON_DB = 0.1;
export const DEFAULT_METER_FALLOFF_DB_PER_SECOND = 15;
export const METER_PEAK_HOLD_MS = 1500;
export const METER_PEAK_DECAY_DB_PER_SECOND = 30;

export function clampPeak(peak: number) {
  return Math.max(0, Math.min(1, peak));
}

export function gainToDb(peak: number) {
  return 20 * Math.log10(Math.max(peak, 0.000_001));
}

// Linear peak that corresponds to METER_MAX_DB (+6 dBFS). The per-region
// master fader (and track gains) can push the post-mix bus above unity, so
// the peak the engine reports can exceed 1.0. Clamping the *peak* to 1.0
// before converting to dB pinned targetDb at 0 dB whenever the master ran
// hot: the bar stuck at the 0 dB anchor (~85%) and, because targetDb stopped
// moving, the animation loop settled and froze. Clamping in dB-space up to
// METER_MAX_DB instead lets the bar travel into the +6 dB headroom and keep
// animating. Clip detection still triggers at 0 dBFS via METER_CLIP_THRESHOLD.
const METER_MAX_PEAK = 10 ** (METER_MAX_DB / 20);

export function peakToMeterDb(peak: number) {
  const nextPeak = Math.max(0, Math.min(METER_MAX_PEAK, peak));
  if (nextPeak <= 0.001) {
    return METER_MIN_DB;
  }

  return Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, gainToDb(nextPeak)));
}

// Ableton-style non-linear meter scale.
// Anchors map dB values to fractional display height (0 = bottom, 1 = top).
// The top of the meter (0 dB / clip) gets ~15% of the height for headroom,
// and the loud/useful region (-18..0 dB) gets ~half the visible bar.
const METER_SCALE_ANCHORS: ReadonlyArray<readonly [number, number]> = [
  [-60, 0],
  [-48, 0.1],
  [-36, 0.25],
  [-24, 0.45],
  [-18, 0.55],
  [-12, 0.65],
  [-6, 0.75],
  [0, 0.85],
  [6, 1],
];

export function meterDbToDisplayScale(db: number) {
  if (db <= METER_SCALE_ANCHORS[0][0]) {
    return 0;
  }
  if (db >= METER_SCALE_ANCHORS[METER_SCALE_ANCHORS.length - 1][0]) {
    return 1;
  }

  for (let index = 1; index < METER_SCALE_ANCHORS.length; index += 1) {
    const [highDb, highScale] = METER_SCALE_ANCHORS[index];
    if (db <= highDb) {
      const [lowDb, lowScale] = METER_SCALE_ANCHORS[index - 1];
      const t = (db - lowDb) / (highDb - lowDb);
      return lowScale + t * (highScale - lowScale);
    }
  }

  return 1;
}

export function stepMeterDb(
  currentDb: number,
  targetDb: number,
  elapsedMs: number,
  falloffDbPerSecond = DEFAULT_METER_FALLOFF_DB_PER_SECOND,
) {
  if (targetDb >= currentDb) {
    return targetDb;
  }

  const decayAmount = (falloffDbPerSecond * elapsedMs) / 1000;
  return Math.max(targetDb, currentDb - decayAmount);
}

export function meterStyleFromDb(db: number) {
  const displayScale = meterDbToDisplayScale(db);
  return {
    clipPath: `inset(${((1 - displayScale) * 100).toFixed(2)}% 0 0 0)`,
    opacity: displayScale > 0 ? "1" : "0",
  } as const;
}

export function peakHoldStyleFromDb(db: number) {
  const displayScale = meterDbToDisplayScale(db);
  return {
    transform: `translateY(${((1 - displayScale) * 100).toFixed(2)}%)`,
    opacity: displayScale > 0 ? "1" : "0",
  } as const;
}
