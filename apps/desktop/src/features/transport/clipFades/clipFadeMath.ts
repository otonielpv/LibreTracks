import type { ClipSummary, FadeCurve } from "@libretracks/shared/models";

export type { FadeCurve };

/** A clip's fades: lengths in source seconds (0 = none) and the control
 * point of each one's curve ({0.5, 0.5} = straight). */
export type ClipFades = {
  fadeInSeconds: number;
  fadeOutSeconds: number;
  fadeInCurve: FadeCurve;
  fadeOutCurve: FadeCurve;
};

export const LINEAR_FADE_CURVE: FadeCurve = Object.freeze({ x: 0.5, y: 0.5 });

/** Shortest fade a drag keeps: below this the handle snaps back to "none". */
export const MIN_DRAG_FADE_SECONDS = 0.01;

export function clipFadesOf(clip: ClipSummary): ClipFades {
  return {
    fadeInSeconds: Math.max(0, clip.fadeInSeconds ?? 0),
    fadeOutSeconds: Math.max(0, clip.fadeOutSeconds ?? 0),
    fadeInCurve: clampCurve(clip.fadeInCurve),
    fadeOutCurve: clampCurve(clip.fadeOutCurve),
  };
}

const unit = (value: number) => Math.min(1, Math.max(0, value));

/** Inside the unit square; missing or not a number = straight. */
export function clampCurve(curve: FadeCurve | null | undefined): FadeCurve {
  if (!curve || !Number.isFinite(curve.x) || !Number.isFinite(curve.y)) return LINEAR_FADE_CURVE;
  return { x: unit(curve.x), y: unit(curve.y) };
}

export function isLinearCurve(curve: FadeCurve): boolean {
  return Math.abs(curve.x - 0.5) < 1e-4 && Math.abs(curve.y - 0.5) < 1e-4;
}

export function sameCurve(left: FadeCurve, right: FadeCurve): boolean {
  return Math.abs(left.x - right.x) < 1e-6 && Math.abs(left.y - right.y) < 1e-6;
}

/**
 * Gain of a fade at `x` (0 = the silent edge, 1 = full level). Mirror of the
 * engine's `fade_curve_gain` (native/.../render/fade_curve.h): a quadratic
 * Bezier from (0, 0) to (1, 1) through the control point, so the drawing is
 * exactly what plays.
 */
export function fadeCurveGain(x: number, curve: FadeCurve): number {
  const at = unit(x);
  const { x: cx, y: cy } = clampCurve(curve);
  if (cx === 0.5 && cy === 0.5) return at;
  const a = 1 - 2 * cx;
  const b = 2 * cx;
  const t =
    Math.abs(a) < 1e-6 ? at : unit((-b + Math.sqrt(Math.max(0, b * b + 4 * a * at))) / (2 * a));
  return unit((1 - 2 * cy) * t * t + 2 * cy * t);
}

/** The point ON the curve half way along it (Bezier t = 0.5): where its
 * handle is drawn, in the fade's unit square. */
export function curveHandlePoint(curve: FadeCurve): FadeCurve {
  const { x, y } = clampCurve(curve);
  return { x: 0.25 + x / 2, y: 0.25 + y / 2 };
}

/**
 * Fades are stored in source seconds but the clip is drawn at its audible
 * length (`durationSeconds` already includes warp/varispeed). This is the
 * factor from one to the other, so a fade lines up with the waveform it fades.
 */
export function clipViewScale(clip: ClipSummary): number {
  const source = clip.sourceWindowDurationSeconds;
  if (!(source > 0) || !(clip.durationSeconds > 0)) return 1;
  return clip.durationSeconds / source;
}

/** The clip's length in source seconds, the unit its fades are stored in. */
export function clipSourceDuration(clip: ClipSummary): number {
  return clip.sourceWindowDurationSeconds > 0
    ? clip.sourceWindowDurationSeconds
    : clip.durationSeconds;
}

/** Same rule as the backend's `clamp_clip_fades`; curves untouched. */
export function clampClipFades(fades: ClipFades, durationSeconds: number): ClipFades {
  const duration = Math.max(0, durationSeconds);
  const fadeIn = Math.min(Math.max(0, fades.fadeInSeconds), duration);
  const fadeOut = Math.min(Math.max(0, fades.fadeOutSeconds), duration - fadeIn);
  return { ...fades, fadeInSeconds: fadeIn, fadeOutSeconds: fadeOut };
}

/**
 * Fades while a length handle is dragged `deltaViewSeconds` (+ = right). The
 * fade in grows to the right, the fade out to the left; the one being dragged
 * pushes the other back instead of crossing it. Curves are kept.
 */
export function applyClipFadeDrag(
  clip: ClipSummary,
  base: ClipFades,
  edge: "in" | "out",
  deltaViewSeconds: number,
): ClipFades {
  const duration = clipSourceDuration(clip);
  const delta = deltaViewSeconds / clipViewScale(clip);
  const snap = (value: number) => (value < MIN_DRAG_FADE_SECONDS ? 0 : value);
  if (edge === "in") {
    const fadeIn = snap(Math.min(Math.max(0, base.fadeInSeconds + delta), duration));
    return {
      ...base,
      fadeInSeconds: fadeIn,
      fadeOutSeconds: Math.min(base.fadeOutSeconds, duration - fadeIn),
    };
  }
  const fadeOut = snap(Math.min(Math.max(0, base.fadeOutSeconds - delta), duration));
  return {
    ...base,
    fadeInSeconds: Math.min(base.fadeInSeconds, duration - fadeOut),
    fadeOutSeconds: fadeOut,
  };
}

/**
 * A curve whose handle was dragged by (`dx`, `dy`) in the fade's unit square
 * (x towards full level, y up). The handle sits on the curve half way, which
 * moves half as far as the control point, so the point moves twice the drag:
 * the handle stays under the pointer. Near straight it snaps back to it.
 */
export function applyClipCurveDrag(base: FadeCurve, dx: number, dy: number): FadeCurve {
  const start = clampCurve(base);
  const next = clampCurve({ x: start.x + 2 * dx, y: start.y + 2 * dy });
  if (Math.abs(next.x - 0.5) < 0.03 && Math.abs(next.y - 0.5) < 0.03) return LINEAR_FADE_CURVE;
  return { x: Math.round(next.x * 1000) / 1000, y: Math.round(next.y * 1000) / 1000 };
}

/** The value several clips share, or `null` when they differ. */
export function sharedFade(clips: ClipSummary[], edge: "in" | "out"): number | null {
  if (clips.length === 0) return 0;
  const values = clips.map((clip) => {
    const fades = clipFadesOf(clip);
    return edge === "in" ? fades.fadeInSeconds : fades.fadeOutSeconds;
  });
  return values.every((value) => Math.abs(value - values[0]) < 1e-6) ? values[0] : null;
}

/** The curve several clips share, or `null` when they differ. */
export function sharedCurve(clips: ClipSummary[], edge: "in" | "out"): FadeCurve | null {
  if (clips.length === 0) return LINEAR_FADE_CURVE;
  const curves = clips.map((clip) => {
    const fades = clipFadesOf(clip);
    return edge === "in" ? fades.fadeInCurve : fades.fadeOutCurve;
  });
  return curves.every((curve) => sameCurve(curve, curves[0])) ? curves[0] : null;
}
