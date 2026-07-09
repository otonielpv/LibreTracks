/**
 * Fader scale — Ableton-style logarithmic dB fader mapping.
 *
 * The rest of the system (model, engine, `.ltsession` files) stores volume as a
 * **linear gain multiplier** (`1.0` = unity = 0 dB). Users, however, expect a
 * DAW-style fader: a logarithmic dB scale where the default sits at 0 dB, the
 * top reaches a small positive boost (+10 dB for tracks, +20 dB for the
 * click / voice guide), and the bottom bottoms out at −∞ (silence).
 *
 * This module is the single source of truth for the three coordinate spaces a
 * fader juggles:
 *
 *   • **gain**     — linear amplitude multiplier. What we persist and hand the
 *                    engine. `0` = silence, `1` = unity, `~3.16` = +10 dB.
 *   • **dB**       — decibels, what we show the user. `20·log10(gain)`.
 *   • **position** — the fader travel in `[0, 1]`. `0` = bottom (−∞), `1` = top
 *                    (max boost). This is what the slider thumb and pointer math
 *                    operate on. The mapping position→dB is deliberately
 *                    non-linear so 0 dB lands near the top and the useful range
 *                    (roughly −12…+max) gets most of the travel, exactly like
 *                    Ableton Live's mixer faders.
 *
 * UI code lives in *position* space; it converts to *gain* only when handing a
 * value to the store / engine, and back to *position* to draw the thumb. The
 * engine never learns about dB.
 */

/** dB value we treat as silence (−∞). Anything at/below the floor is gain 0. */
export const DB_FLOOR = -60;

/** dB shown for the silent gain 0 — used by the numeric readouts. */
export const NEG_INF_DB_LABEL = "-inf";

export type FaderScale = {
  /** Maximum boost in dB at the very top of the fader (position 1). */
  maxDb: number;
  /** Fader position (0..1) that corresponds to unity gain / 0 dB. */
  unityPosition: number;
};

/** Track faders: 0 dB default, up to +10 dB. */
export const TRACK_FADER_SCALE: FaderScale = makeScale(10);

/** Click / voice-guide faders: 0 dB default, up to +20 dB extra headroom. */
export const AUX_FADER_SCALE: FaderScale = makeScale(20);

/**
 * Sub-unity taper, as a piecewise-linear-in-dB curve — the shape real DAW
 * faders use. Each segment maps a slice of the *below-unity* travel `u`
 * (`u = position / unityPosition`, so `u = 1` is unity / 0 dB, `u = 0` is the
 * bottom) to a dB range. Devoting a fat slice of travel to the −12…0 dB band
 * (and compressing the deep attenuation toward the bottom) keeps fine control
 * exactly where mixing happens: a small drag below unity is a few dB, not a
 * plunge to silence.
 *
 * Segments run top→bottom; `[uLow, uHigh, dbLow, dbHigh]`, `dbHigh` at `uHigh`.
 */
const SUB_UNITY_SEGMENTS: ReadonlyArray<
  readonly [number, number, number, number]
> = [
  [0.8, 1.0, -12, 0],
  [0.5, 0.8, -30, -12],
  [0.2, 0.5, -48, -30],
  [0.0, 0.2, DB_FLOOR, -48],
];

/**
 * Build a scale for a given max-boost dB. `unityPosition` is fixed regardless
 * of headroom so the +10 dB and +20 dB faders feel identical below unity: 0 dB
 * lands ~75% up the travel, the boost region gets the top ~25%, and everything
 * below unity (0 dB → −∞) fills the lower 75% with the taper above.
 */
function makeScale(maxDb: number): FaderScale {
  const unityPosition = 0.75;
  return { maxDb, unityPosition };
}

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Position (0..1) → dB.
 *   • Above unity: linear in dB from 0 dB (at unityPosition) to +maxDb (at 1).
 *   • Below unity: the piecewise taper in {@link SUB_UNITY_SEGMENTS}; the very
 *     bottom (position 0) is −∞ (silence).
 */
export function positionToDb(position: number, scale: FaderScale): number {
  const p = clamp01(position);
  const { maxDb, unityPosition } = scale;

  if (p >= unityPosition) {
    // Linear dB in the boost region.
    const t = (p - unityPosition) / (1 - unityPosition);
    return t * maxDb;
  }

  if (p <= 0) {
    return Number.NEGATIVE_INFINITY;
  }

  const u = p / unityPosition; // (0,1), 1 = unity
  for (const [uLow, uHigh, dbLow, dbHigh] of SUB_UNITY_SEGMENTS) {
    if (u >= uLow && u <= uHigh) {
      const t = (u - uLow) / (uHigh - uLow);
      return dbLow + t * (dbHigh - dbLow);
    }
  }
  return DB_FLOOR;
}

/** dB → position (0..1). Inverse of {@link positionToDb}. */
export function dbToPosition(db: number, scale: FaderScale): number {
  const { maxDb, unityPosition } = scale;

  if (!Number.isFinite(db)) {
    return db > 0 ? 1 : 0;
  }

  if (db >= 0) {
    const t = maxDb > 0 ? db / maxDb : 0;
    return clamp01(unityPosition + t * (1 - unityPosition));
  }

  if (db <= DB_FLOOR) {
    return 0;
  }

  for (const [uLow, uHigh, dbLow, dbHigh] of SUB_UNITY_SEGMENTS) {
    if (db >= dbLow && db <= dbHigh) {
      const t = (db - dbLow) / (dbHigh - dbLow);
      return clamp01((uLow + t * (uHigh - uLow)) * unityPosition);
    }
  }
  return 0;
}

/** Linear gain → dB. Gain 0 (or below) is −∞. */
export function gainToDb(gain: number): number {
  if (gain <= 0) return Number.NEGATIVE_INFINITY;
  return 20 * Math.log10(gain);
}

/** dB → linear gain. −∞ (or ≤ floor) is 0. */
export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return db > 0 ? Number.POSITIVE_INFINITY : 0;
  if (db <= DB_FLOOR) return 0;
  return Math.pow(10, db / 20);
}

/** Fader position (0..1) → linear gain. What the UI hands the store/engine. */
export function positionToGain(position: number, scale: FaderScale): number {
  return dbToGain(positionToDb(position, scale));
}

/** Linear gain → fader position (0..1). What the UI uses to draw the thumb. */
export function gainToPosition(gain: number, scale: FaderScale): number {
  return dbToPosition(gainToDb(gain), scale);
}

export type FaderTick = {
  /** dB the tick marks; `null` for the silent floor (labelled −inf). */
  db: number | null;
  /** Short label to render, e.g. `+10`, `0`, `-12`, `-inf`. */
  label: string;
  /** Distance of the tick from the TOP of the fader travel, as a fraction
   * `[0,1]` (0 = top = max boost, 1 = bottom = −∞). Ready for CSS `top: X%`. */
  offsetFromTop: number;
};

/**
 * Tick marks for a fader's dB scale, positioned at their TRUE travel offset (so
 * the "0" label sits where 0 dB actually is — ~30% down, not centred). Both the
 * DAW compact mixer and the remote render these instead of evenly-spaced labels.
 */
export function faderTicks(scale: FaderScale): FaderTick[] {
  const marks: number[] = scale.maxDb >= 20 ? [20, 0, -12, -36] : [10, 0, -12, -36];
  const ticks: FaderTick[] = marks.map((db) => ({
    db,
    label: db > 0 ? `+${db}` : `${db}`,
    offsetFromTop: 1 - dbToPosition(db, scale),
  }));
  ticks.push({ db: null, label: NEG_INF_DB_LABEL, offsetFromTop: 1 });
  return ticks;
}

/**
 * Format a dB value for a fader readout, e.g. `+5.0`, `0.0`, `-10.3`, `-inf`.
 * No unit suffix — callers add " dB".
 */
export function formatDb(db: number): string {
  if (!Number.isFinite(db) || db <= DB_FLOOR) return NEG_INF_DB_LABEL;
  const rounded = Math.abs(db) < 0.05 ? 0 : db;
  const text = rounded.toFixed(1);
  return rounded > 0 ? `+${text}` : text;
}

/**
 * Format a linear gain as a dB readout for the fader value label, e.g.
 * `+5.0`, `0.0`, `-10.3`, `-inf`. No unit suffix — callers add " dB".
 */
export function formatGainDb(gain: number): string {
  return formatDb(gainToDb(gain));
}
