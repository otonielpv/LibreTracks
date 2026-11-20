import type { EqBand, EqBandKind, TrackEq } from "../models";

/**
 * Rangos y valores por defecto del EQ por pista (plan track-eq, D2). Son los
 * del core Rust (`crates/libretracks-core/src/track_eq.rs`) y los del motor
 * (`render/track_eq_params.h`): la UI recorta igual que ellos, así que lo que
 * se ve al soltar es lo que se guarda y lo que suena.
 */
export const EQ_MAX_BANDS = 6;
export const EQ_MIN_FREQUENCY_HZ = 20;
export const EQ_MAX_FREQUENCY_HZ = 20_000;
export const EQ_MIN_GAIN_DB = -18;
export const EQ_MAX_GAIN_DB = 18;
export const EQ_MIN_Q = 0.1;
export const EQ_MAX_Q = 18;
export const EQ_DEFAULT_Q = 0.71;

export const EQ_BAND_KINDS: EqBandKind[] = [
  "lowCut",
  "lowShelf",
  "peak",
  "highShelf",
  "highCut",
  "notch",
];

const FALLBACK_FREQUENCY_HZ = 1000;

export function isCut(kind: EqBandKind): boolean {
  return kind === "lowCut" || kind === "highCut";
}

/** Tipos cuya ganancia cuenta (los cortes y el notch no tienen). */
export function hasGain(kind: EqBandKind): boolean {
  return kind === "lowShelf" || kind === "peak" || kind === "highShelf";
}

export function defaultEqBands(): EqBand[] {
  const band = (enabled: boolean, kind: EqBandKind, frequencyHz: number): EqBand => ({
    enabled,
    kind,
    frequencyHz,
    gainDb: 0,
    q: EQ_DEFAULT_Q,
    slope: 12,
  });
  return [
    band(false, "lowCut", 40),
    band(true, "lowShelf", 100),
    band(true, "peak", 400),
    band(true, "peak", 2500),
    band(true, "highShelf", 8000),
    band(false, "highCut", 18000),
  ];
}

export function defaultTrackEq(): TrackEq {
  return { enabled: true, bands: defaultEqBands() };
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampFrequency(hz: number): number {
  return clamp(finiteOr(hz, FALLBACK_FREQUENCY_HZ), EQ_MIN_FREQUENCY_HZ, EQ_MAX_FREQUENCY_HZ);
}

export function clampGain(db: number): number {
  return clamp(finiteOr(db, 0), EQ_MIN_GAIN_DB, EQ_MAX_GAIN_DB);
}

export function clampQ(q: number): number {
  return clamp(finiteOr(q, EQ_DEFAULT_Q), EQ_MIN_Q, EQ_MAX_Q);
}

/** Espejo de `TrackEq::sanitized()`: un EQ válido sale idéntico. */
export function sanitizeTrackEq(eq: TrackEq): TrackEq {
  return {
    enabled: eq.enabled,
    bands: eq.bands.slice(0, EQ_MAX_BANDS).map((band) => ({
      enabled: band.enabled,
      kind: EQ_BAND_KINDS.includes(band.kind) ? band.kind : "peak",
      frequencyHz: clampFrequency(band.frequencyHz),
      gainDb: clampGain(band.gainDb),
      q: clampQ(band.q),
      slope: band.slope >= 18 ? 24 : 12,
    })),
  };
}

/** Una banda encendida que cambia algo. */
export function bandIsAudible(band: EqBand): boolean {
  return band.enabled && (!hasGain(band.kind) || band.gainDb !== 0);
}

/** Lo que ilumina el botón «EQ»: encendido y alguna banda que haga algo. */
export function trackEqIsActive(eq: TrackEq | null | undefined): boolean {
  return Boolean(eq?.enabled && eq.bands.some(bandIsAudible));
}
