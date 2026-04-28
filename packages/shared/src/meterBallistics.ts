export const METER_MIN_DB = -60;
export const METER_MAX_DB = 9;
export const METER_CLIP_THRESHOLD = 1;
export const METER_CLIP_HOLD_MS = 220;
export const METER_ACTIVE_EPSILON_DB = 0.1;
export const DEFAULT_METER_FALLOFF_DB_PER_SECOND = 15;

export function clampPeak(peak: number) {
  return Math.max(0, Math.min(1, peak));
}

export function gainToDb(peak: number) {
  return 20 * Math.log10(Math.max(peak, 0.000_001));
}

export function peakToMeterDb(peak: number) {
  const nextPeak = clampPeak(peak);
  if (nextPeak <= 0.001) {
    return METER_MIN_DB;
  }

  return Math.max(METER_MIN_DB, Math.min(METER_MAX_DB, gainToDb(nextPeak)));
}

export function meterDbToDisplayScale(db: number) {
  return Math.max(0, Math.min(1, (db - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)));
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
    opacity: displayScale > 0 ? "1" : "0.18",
  } as const;
}
