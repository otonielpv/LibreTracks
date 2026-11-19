import type { EqBand, TrackEq } from "@libretracks/shared/models";

import { isCut, sanitizeTrackEq } from "./trackEqModel";

/**
 * Respuesta de magnitud del EQ por pista (plan track-eq, D11): port del MISMO
 * diseño de coeficientes que usa el motor (`render/track_eq.cpp`, que a su vez
 * usa signalsmith-dsp `filters.h` v1.7.3). No son fórmulas analógicas
 * aproximadas: la curva que se pinta es lo que suena. Un test la compara con
 * la tabla dorada que vuelca el C++ (`__fixtures__/eqResponseGolden.json`).
 *
 * - Campana y notch: diseño `vicanek`.
 * - Shelves: `oneSided`.
 * - Cortes: `bilinear` (Butterworth con Q 0,71); el de 24 dB/oct son dos
 *   etapas con las Q de un Butterworth de 4.º orden escaladas por la Q.
 *
 * Si cambia el C++ o se actualiza signalsmith, cambia esto y se regenera la
 * tabla con `LT_WRITE_EQ_GOLDEN=1`.
 */

type Coefficients = { b0: number; b1: number; b2: number; a1: number; a2: number };

type FilterType = "highpass" | "lowpass" | "highShelf" | "lowShelf" | "notch" | "peak";
type Design = "bilinear" | "oneSided" | "vicanek";

type FreqSpec = {
  scaledFreq: number;
  w0: number;
  sinW0: number;
  cosW0: number;
  inv2Q: number;
};

const BUTTERWORTH_Q = 0.70710678118654752;
const BUTTERWORTH4_Q1 = 0.54119610014619698;
const BUTTERWORTH4_Q2 = 1.30656296487637653;

function freqSpec(freq: number): FreqSpec {
  const scaledFreq = Math.max(1e-6, Math.min(0.4999, freq));
  const w0 = 2 * Math.PI * scaledFreq;
  return { scaledFreq, w0, cosW0: Math.cos(w0), sinW0: Math.sin(w0), inv2Q: 0 };
}

function oneSidedCompQ(spec: FreqSpec): void {
  const f1Factor = Math.sqrt(spec.inv2Q * spec.inv2Q + 1) - spec.inv2Q;
  const ctF1 = Math.tan(Math.PI * spec.scaledFreq * f1Factor);
  const invCtF0 = (1 + spec.cosW0) / spec.sinW0;
  const ctF1Factor = ctF1 * invCtF0;
  spec.inv2Q = 0.5 / ctF1Factor - 0.5 * ctF1Factor;
}

function qSpec(scaledFreq: number, q: number, design: Design): FreqSpec {
  const spec = freqSpec(scaledFreq);
  spec.inv2Q = 0.5 / q;
  if (design === "oneSided") oneSidedCompQ(spec);
  return spec;
}

function dbToSqrtGain(db: number): number {
  return Math.pow(10, db * 0.025);
}

function configure(
  type: FilterType,
  input: FreqSpec,
  sqrtGain: number,
  inputDesign: Design,
): Coefficients {
  const calc = { ...input };
  let design = inputDesign;
  const w0 = calc.w0;

  if (design === "vicanek" && (type === "notch" || type === "peak")) {
    if (type === "notch") calc.inv2Q *= 1 - calc.scaledFreq * 0.5;
    const q = (type === "peak" ? 1 / sqrtGain : 1) * calc.inv2Q;
    const expmqw = Math.exp(-q * w0);
    const da1 =
      q <= 1
        ? -2 * expmqw * Math.cos(Math.sqrt(1 - q * q) * w0)
        : -2 * expmqw * Math.cosh(Math.sqrt(q * q - 1) * w0);
    const da2 = expmqw * expmqw;
    const sinpd2 = Math.sin(w0 / 2);
    const p0 = 1 - sinpd2 * sinpd2;
    const p1 = sinpd2 * sinpd2;
    const p2 = 4 * p0 * p1;
    let A0 = 1 + da1 + da2;
    let A1 = 1 - da1 + da2;
    const A2 = -4 * da2;
    A0 *= A0;
    A1 *= A1;
    if (type === "notch") {
      const db1 = -2 * Math.cos(w0);
      const scale = Math.sqrt(A0) / (1 + db1 + 1);
      return { b0: scale, b1: db1 * scale, b2: scale, a1: da1, a2: da2 };
    }
    const G2 = sqrtGain * sqrtGain * (sqrtGain * sqrtGain);
    const R1 = (A0 * p0 + A1 * p1 + A2 * p2) * G2;
    const R2 = (-A0 + A1 + 4 * (p0 - p1) * A2) * G2;
    const B0 = A0;
    const B2 = (R1 - R2 * p1 - B0) / (4 * p1 * p1);
    const B1 = R2 + B0 + 4 * (p1 - p0) * B2;
    const W = 0.5 * (Math.sqrt(B0) + Math.sqrt(Math.max(0, B1)));
    const b0 = 0.5 * (W + Math.sqrt(Math.max(0, W * W + B2)));
    const b1 = 0.5 * (Math.sqrt(B0) - Math.sqrt(Math.max(0, B1)));
    const b2 = -B2 / (4 * b0);
    return { b0, b1, b2, a1: da1, a2: da2 };
  }
  if (design === "vicanek") {
    design = "oneSided";
    oneSidedCompQ(calc);
  }

  const alpha = calc.sinW0 * calc.inv2Q;
  const A = sqrtGain;
  const sqrtA2alpha = 2 * Math.sqrt(A) * alpha;
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
  const cosW0 = calc.cosW0;
  switch (type) {
    case "highpass":
      b1 = -1 - cosW0;
      b0 = b2 = (1 + cosW0) * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "lowpass":
      b1 = 1 - cosW0;
      b0 = b2 = b1 * 0.5;
      a0 = 1 + alpha;
      a1 = -2 * cosW0;
      a2 = 1 - alpha;
      break;
    case "highShelf":
      b0 = A * (A + 1 + (A - 1) * cosW0 + sqrtA2alpha);
      b2 = A * (A + 1 + (A - 1) * cosW0 - sqrtA2alpha);
      b1 = -2 * A * (A - 1 + (A + 1) * cosW0);
      a0 = A + 1 - (A - 1) * cosW0 + sqrtA2alpha;
      a2 = A + 1 - (A - 1) * cosW0 - sqrtA2alpha;
      a1 = 2 * (A - 1 - (A + 1) * cosW0);
      break;
    case "lowShelf":
      b0 = A * (A + 1 - (A - 1) * cosW0 + sqrtA2alpha);
      b2 = A * (A + 1 - (A - 1) * cosW0 - sqrtA2alpha);
      b1 = 2 * A * (A - 1 - (A + 1) * cosW0);
      a0 = A + 1 + (A - 1) * cosW0 + sqrtA2alpha;
      a2 = A + 1 + (A - 1) * cosW0 - sqrtA2alpha;
      a1 = -2 * (A - 1 + (A + 1) * cosW0);
      break;
    case "notch":
      b0 = 1;
      b1 = -2 * cosW0;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = b1;
      a2 = 1 - alpha;
      break;
    case "peak":
      b0 = 1 + alpha * A;
      b1 = -2 * cosW0;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = b1;
      a2 = 1 - alpha / A;
      break;
  }
  const invA0 = 1 / a0;
  return { b0: b0 * invA0, b1: b1 * invA0, b2: b2 * invA0, a1: a1 * invA0, a2: a2 * invA0 };
}

/** Coeficientes de cada etapa de una banda (1 o 2 biquads). */
export function bandStageCoefficients(band: EqBand, sampleRate: number): Coefficients[] {
  const scaled = band.frequencyHz / sampleRate;
  const stages = isCut(band.kind) && band.slope >= 24 ? 2 : 1;
  const out: Coefficients[] = [];
  for (let stage = 0; stage < stages; stage += 1) {
    const stageQ =
      stages === 2
        ? band.q * ((stage === 0 ? BUTTERWORTH4_Q1 : BUTTERWORTH4_Q2) / BUTTERWORTH_Q)
        : band.q;
    switch (band.kind) {
      case "lowCut":
        out.push(configure("highpass", qSpec(scaled, stageQ, "bilinear"), 0, "bilinear"));
        break;
      case "highCut":
        out.push(configure("lowpass", qSpec(scaled, stageQ, "bilinear"), 0, "bilinear"));
        break;
      case "lowShelf":
        out.push(
          configure("lowShelf", qSpec(scaled, band.q, "oneSided"), dbToSqrtGain(band.gainDb), "oneSided"),
        );
        break;
      case "highShelf":
        out.push(
          configure("highShelf", qSpec(scaled, band.q, "oneSided"), dbToSqrtGain(band.gainDb), "oneSided"),
        );
        break;
      case "peak":
        out.push(
          configure("peak", qSpec(scaled, band.q, "vicanek"), dbToSqrtGain(band.gainDb), "vicanek"),
        );
        break;
      case "notch":
        out.push(configure("notch", qSpec(scaled, band.q, "vicanek"), 0, "vicanek"));
        break;
    }
  }
  return out;
}

function stageResponseDb(c: Coefficients, scaledFreq: number): number {
  const w = scaledFreq * 2 * Math.PI;
  const zr = Math.cos(w);
  const zi = -Math.sin(w);
  // invZ² = (zr + i zi)²
  const z2r = zr * zr - zi * zi;
  const z2i = 2 * zr * zi;
  const nr = c.b0 + zr * c.b1 + z2r * c.b2;
  const ni = zi * c.b1 + z2i * c.b2;
  const dr = 1 + zr * c.a1 + z2r * c.a2;
  const di = zi * c.a1 + z2i * c.a2;
  const energy = (nr * nr + ni * ni) / (dr * dr + di * di);
  return 10 * Math.log10(energy);
}

/** Respuesta en dB de una banda sola (encendida o no: la curva de la banda). */
export function bandResponseDb(band: EqBand, sampleRate: number, hz: number): number {
  const scaledEval = hz / sampleRate;
  return bandStageCoefficients(band, sampleRate).reduce(
    (sum, stage) => sum + stageResponseDb(stage, scaledEval),
    0,
  );
}

/** Respuesta total en dB: suma de las bandas encendidas; 0 con el EQ apagado. */
export function trackEqResponseDb(eq: TrackEq, sampleRate: number, hz: number): number {
  const clean = sanitizeTrackEq(eq);
  if (!clean.enabled || sampleRate <= 0) return 0;
  return clean.bands.reduce(
    (sum, band) => (band.enabled ? sum + bandResponseDb(band, sampleRate, hz) : sum),
    0,
  );
}
